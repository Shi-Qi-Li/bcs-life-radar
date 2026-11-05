// City of College Station — public City Calendar (Timely), linked from
// https://www.cstx.gov/parks-recreation-culture/events/ -> "City Calendar" (https://www.cstx.gov/calendar/).
// The calendar publicly offers "Subscribe → ICS"; we read that same export feed.

import { parseICS, unescapeText, occurrences } from '../lib/ics.mjs';
import { htmlToText, truncate, extractLinks, registrationFrom, costFromText } from '../lib/normalize.mjs';
import { classify } from '../../public/js/shared/taxonomy.js';

export const SOURCE = {
  id: 'cstx',
  name: 'City of College Station Calendar',
  homepage: 'https://www.cstx.gov/parks-recreation-culture/events/',
  calendarPage: 'https://www.cstx.gov/calendar/',
  feedUrl: 'https://events.timely.fun/api/calendars/54735353/export?format=ics',
  method: 'Public iCalendar (ICS) export of the City Calendar (Timely), the same feed offered by its "Subscribe" button.',
};

// Not "activities": internal items, council/committee meetings, office closures and notices.
const EXCLUDE_TAGS = /^(closure|city council|committee|informational)$/i;
const EXCLUDE_CATS = /^(meeting|notice)$/i;

const first = (ev, k) => ev[k]?.[0]?.value ?? null;
const all = (ev, k) => (ev[k] || []).map((p) => p.value);
const list = (v) => (v ? unescapeText(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function classifyExclusion(ev) {
  const filters = all(ev, 'X-CUSTOM-FILTER');
  if (filters.some((f) => /^Type:\s*Internal/i.test(f))) return 'internal';
  if (first(ev, 'STATUS') === 'CANCELLED') return 'cancelled';
  const cats = list(first(ev, 'CATEGORIES'));
  const tags = list(first(ev, 'X-TAGS'));
  if (tags.some((t) => EXCLUDE_TAGS.test(t))) return 'meeting/closure/notice';
  if (cats.length && cats.every((c) => EXCLUDE_CATS.test(c))) return 'meeting/closure/notice';
  if (/\b(offices? closed|closed for|council meeting|commission meeting|board meeting)\b/i.test(first(ev, 'SUMMARY') || '')) return 'meeting/closure/notice';
  return null;
}

function costFor(ev, tags) {
  const cost = first(ev, 'X-COST');
  const type = (first(ev, 'X-COST-TYPE') || '').toLowerCase();
  const tagFree = tags.some((t) => /^free$/i.test(t));
  const tagPaid = tags.some((t) => /^paid$/i.test(t));
  if (cost) {
    const c = costFromText(unescapeText(cost));
    return c.status === 'unknown' ? { status: 'paid', label: `${unescapeText(cost)}`, min: null } : c;
  }
  if (type === 'paid') return { status: 'paid', label: 'Paid — amount not listed', min: null };
  if (tagFree && tagPaid) return { status: 'unknown', label: 'Unclear — listed as both free and paid; check source', min: null };
  if (tagPaid) return { status: 'paid', label: 'Paid — amount not listed', min: null };
  if (type === 'free') return { status: 'free', label: tagFree ? 'Free' : 'Free (marked free in City calendar)', min: 0 };
  return { status: 'unknown', label: 'Cost not listed', min: null };
}

function locationFor(ev) {
  const raw = first(ev, 'LOCATION');
  const geo = first(ev, 'GEO');
  if (!raw && !geo) return null;
  let name = null, address = null;
  if (raw) {
    const txt = unescapeText(raw).replace(/,\s*United States$/i, '');
    const at = txt.indexOf(' @ ');
    if (at >= 0) { name = txt.slice(0, at).trim(); address = txt.slice(at + 3).trim(); } else address = txt.trim();
    address = address.replace(/,\s*Texas,\s*(\d{5})$/i, ', TX $1');
  }
  let lat = null, lng = null;
  if (geo) {
    const [a, b] = geo.split(/[;,]/).map(parseFloat);
    if (Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0)) { lat = a; lng = b; }
  }
  return { name, address, lat, lng };
}

const pad = (n) => String(n).padStart(2, '0');
function instanceUrl(url, wall) {
  if (!url) return SOURCE.calendarPage;
  const id = `${wall.y}${pad(wall.m)}${pad(wall.d)}${pad(wall.hh)}${pad(wall.mm)}${pad(wall.ss)}`;
  return url.includes('instance_id=') ? url.replace(/instance_id=\d+/, `instance_id=${id}`) : url;
}

/** Turn ICS text into normalised occurrence items within [fromMs, toMs]. */
export function itemsFromICS(text, { fromMs, toMs, fetchedAt }) {
  const events = parseICS(text);
  const stats = { feedEvents: events.length, excluded: {}, notes: [] };
  const items = [];
  for (const ev of events) {
    const why = classifyExclusion(ev);
    if (why) { stats.excluded[why] = (stats.excluded[why] || 0) + 1; continue; }
    let occ;
    try { occ = occurrences(ev, fromMs, toMs); } catch (e) { stats.notes.push(`${first(ev, 'UID')}: ${e.message}`); continue; }
    if (occ.notes.length) stats.notes.push(`${first(ev, 'SUMMARY')}: ${occ.notes.join('; ')}`);
    if (!occ.occurrences.length) continue;

    const uid = first(ev, 'UID');
    const title = unescapeText(first(ev, 'SUMMARY') || 'Untitled');
    const html = unescapeText(first(ev, 'DESCRIPTION') || '');
    const description = htmlToText(html);
    const tags = [...list(first(ev, 'X-TAGS')), ...list(first(ev, 'CATEGORIES'))];
    const links = extractLinks(html);
    const multiDay = occ.durationDays && occ.durationDays > 1;
    const kind = occ.totalKnown > 1 ? 'recurring' : multiDay ? 'multi-day' : 'one-time';
    const contact = first(ev, 'CONTACT');
    const base = {
      seriesId: `cstx:${uid}`,
      kind,
      title,
      description: truncate(description, 600),
      summary: truncate(description.replace(/\n/g, ' '), 200),
      location: locationFor(ev),
      cost: costFor(ev, tags),
      registration: registrationFrom({ tags, description, links }),
      types: classify({ tags, title, description }),
      sourceTags: tags,
      contact: contact ? unescapeText(contact) : null,
      sourceId: SOURCE.id,
      sourceName: SOURCE.name,
      lastVerified: fetchedAt,
    };
    for (const o of occ.occurrences) {
      items.push({
        ...base,
        id: `${base.seriesId}@${o.startMs}`,
        start: new Date(o.startMs).toISOString(),
        end: o.endMs !== null ? new Date(o.endMs).toISOString() : null,
        endKnown: o.endMs !== null && !(o.allDay && !ev.DTEND),
        allDay: o.allDay,
        timeNote: null,
        sourceUrl: instanceUrl(first(ev, 'URL'), o.wallStart),
      });
    }
  }
  stats.items = items.length;
  return { items, stats };
}

export async function fetchSource({ fetchText, fromMs, toMs }) {
  const fetchedAt = new Date().toISOString();
  const text = await fetchText(SOURCE.feedUrl);
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('Response was not an iCalendar feed');
  return { ...itemsFromICS(text, { fromMs, toMs, fetchedAt }), fetchedAt };
}
