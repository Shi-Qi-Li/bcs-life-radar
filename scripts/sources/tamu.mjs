// Texas A&M University Events Calendar — https://calendar.tamu.edu/ (LiveWhale).
// The calendar's own Feeds page (https://calendar.tamu.edu/feeds) lists public iCal/RSS/JSON feed URLs for
// every calendar group; we read the JSON feed of the "* Main University Calendar" group (the one the
// homepage shows), limited to the refresh window with the feed's own start_date/end_date path segments
// (end_date is exclusive). One request per refresh, ~240 KB.
//
// Observed on 2026-11-05 and handled here:
//  - server-side /audience/ and /campus/ filters are silently ignored, so audience and campus are filtered
//    client-side: only records whose event_types_audience includes "Visitors" or "Residents" (public-facing)
//    and whose event_types_campus is absent or includes "Bryan-College Station" are kept;
//  - ~70% of records are Transportation Services bus notices ("Transit Fall Service", one per day) — excluded;
//  - records typed only "Academic Calendar" are deadlines, not activities — excluded;
//  - is_canceled is never populated; cancellations appear as "CANCELLED: …" titles — excluded;
//  - is_online records are online-only (Zoom/YouTube) — excluded, the product is about going places;
//  - an event spanning midnight is emitted twice under the same id (the full span plus an all-day stub for the
//    next day), and a multi-day all-day event once per day under one id — collapsed by id;
//  - `parent` is not a stable series id, so the series id is a slug of the title;
//  - cost is a number, "Free", pasted HTML, or null; location_longitude is a string; strings carry HTML entities.

import { dayKey, startOfDay } from '../../public/js/shared/time.js';
import { htmlToText, decodeEntities, truncate, costFromText, registrationFrom, extractLinks, slug } from '../lib/normalize.mjs';
import { classify } from '../../public/js/shared/taxonomy.js';

export const SOURCE = {
  id: 'tamu',
  name: 'Texas A&M University Events Calendar',
  homepage: 'https://calendar.tamu.edu/',
  feedsPage: 'https://calendar.tamu.edu/feeds',
  feedBase: 'https://calendar.tamu.edu/live/json/events/group/%2A%20Main%20University%20Calendar',
  method: 'Public JSON feed of the "* Main University Calendar" group, as listed on the calendar\'s own Feeds page, limited to the refresh window; filtered client-side to public-facing (Visitors/Residents) events in Bryan-College Station.',
};

/** Feed URL for the window [fromMs, toMs): the feed's end_date is exclusive, like toMs. */
export function feedUrl(fromMs, toMs) {
  return `${SOURCE.feedBase}/start_date/${dayKey(fromMs)}/end_date/${dayKey(toMs)}`;
}

const WEAK_TYPES = /^(Campus Life|General Interest)$/i;
const CANCELLED_TITLE = /^\s*[[(]?\s*(cancell?ed|postponed)\b|[[(]\s*(cancell?ed|postponed)\s*[\])]\s*$/i;
const ZIP = /\b\d{5}(?:-\d{4})?\b/;
const STREET = /\b\d+\s+(?:[NSEW]\.?\s+)?[A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*\s+(?:St|Street|Ave|Avenue|Dr|Drive|Rd|Road|Blvd|Boulevard|Pkwy|Parkway|Ln|Lane|Way|Hwy|Highway|Loop|Ct|Court|Pl|Place|Cir|Circle|Trl|Trail)\b\.?/i;
const UNKNOWN_COST = { status: 'unknown', label: 'Cost not listed', min: null };
const FREE_COST = { status: 'free', label: 'Free', min: 0 };

const text = (s) => (s == null ? '' : decodeEntities(String(s)).trim());
const list = (v) => (Array.isArray(v) ? v.map((x) => text(x)).filter(Boolean) : null);

/** Reason to leave a record out, or null to keep it. One bucket per record, in this order. */
export function classifyExclusion(r) {
  const title = text(r.title);
  // Bus-service notices: the publishing group is the reliable marker; the title is a backstop ("Transit: No Service",
  // "Transit Fall Service") that leaves astronomy titles such as "Transit of Mercury" alone.
  if (/^Transportation Services$/i.test(text(r.group_title)) || /^Transit\b(?!\s+of\b)/i.test(title)) return 'transit';
  const types = list(r.event_types) || [];
  if (types.length && types.every((t) => /^Academic Calendar$/i.test(t))) return 'academicCalendar';
  if (r.is_canceled || CANCELLED_TITLE.test(title)) return 'cancelled';
  if (r.is_online) return 'online';
  const audience = list(r.event_types_audience) || [];
  if (!audience.some((a) => /^(Visitors|Residents)$/i.test(a))) return 'notPublicAudience';
  const campus = list(r.event_types_campus);
  if (campus && campus.length && !campus.some((c) => /^Bryan-College Station$/i.test(c))) return 'otherCampus';
  return null;
}

const startOf = (r) => {
  const t = Date.parse(r.date_iso || '');
  if (Number.isFinite(t)) return t;
  return Number.isFinite(r.date_ts) ? r.date_ts * 1000 : NaN;
};

/**
 * Collapse records that share an id. LiveWhale emits an event spanning midnight twice (the full span and an
 * all-day stub for the next day) and a multi-day all-day event once per day. The full-span record wins;
 * otherwise all-day stubs become one record carrying the run (`run: {first, last, count}`).
 */
export function dedupeById(records) {
  const groups = new Map();
  for (const r of records) {
    const k = String(r.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  let dropped = 0;
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    dropped += g.length - 1;
    const sorted = [...g].sort((a, b) => startOf(a) - startOf(b));
    const full = sorted.find((r) => r.date2_iso);
    if (full) out.push(full);
    else if (sorted.every((r) => r.is_all_day)) out.push({ ...sorted[0], run: { first: startOf(sorted[0]), last: startOf(sorted[sorted.length - 1]), count: sorted.length } });
    else out.push(sorted[0]);
  }
  return { records: out, dropped };
}

/** "YYYY-MM-DD HH:MM:SS" fields (repeats_start/repeats_end) are UTC despite having no zone marker. */
function parseNaiveUtc(s) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s || '');
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
}

/** Coordinates only when plausible for the Brazos Valley; location_longitude arrives as a string. */
export function coords(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (lat == null || lng == null || lat === '' || lng === '' || !Number.isFinite(a) || !Number.isFinite(b)) return [null, null];
  if (a < 29 || a > 32 || b < -98.5 || b > -94.5) return [null, null];
  return [a, b];
}

/** { name, address, lat, lng } or null. The address is only set when the source string contains one. */
export function locationFor(r) {
  const clean = (s) => text(s).replace(/,\s*(USA|United States)$/i, '').trim();
  const candidates = [...new Set([clean(r.location_title), clean(r.location)].filter(Boolean))];
  const [lat, lng] = coords(r.location_latitude, r.location_longitude);
  if (!candidates.length && lat === null) return null;
  const addrText = candidates.find((s) => ZIP.test(s) || STREET.test(s)) || null;
  let name = candidates.find((s) => s !== addrText) || null;
  let address = null;
  if (addrText) {
    const parts = addrText.split(/,\s*/);
    if (!name && parts.length >= 2 && !/\d/.test(parts[0]) && /^\d+\s/.test(parts[1])) {
      // "Sbisa Dining Hall, 233 Houston St, College Station, TX 77843" → venue + street address
      name = parts[0];
      address = parts.slice(1).join(', ');
    } else address = addrText;
  }
  return { name, address, lat, lng };
}

const fmtAmount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** cost is a number, "Free", a plain or HTML string, or null. */
export function costFor(raw) {
  if (raw === null || raw === undefined || raw === '') return UNKNOWN_COST;
  if (typeof raw === 'number') return raw === 0 ? FREE_COST : { status: 'paid', label: `$${fmtAmount(raw)}`, min: raw };
  let t = htmlToText(String(raw)).replace(/\s*\n\s*/g, ' ').trim();
  if (!t) return UNKNOWN_COST;
  if (/^\$?\d+(\.\d{1,2})?$/.test(t)) {
    const n = parseFloat(t.replace('$', ''));
    return n === 0 ? FREE_COST : { status: 'paid', label: `$${fmtAmount(n)}`, min: n };
  }
  // "60-$66" / "11.50; $6 for students": a leading bare number next to a dollar amount is dollars too.
  if (t.includes('$')) t = t.replace(/^(\d+(?:\.\d{1,2})?)\b/, '$$$1');
  const c = costFromText(t);
  return c.label.length > 160 ? { ...c, label: truncate(c.label, 160) } : c;
}

/** Normalised item for one feed record (already past exclusions and id-collapse), or null if unusable. */
export function itemFromRecord(r, { fetchedAt, lastWindowDay = null }) {
  const title = text(r.title);
  const startMs = startOf(r);
  if (!title || !Number.isFinite(startMs)) return null;

  const html = r.description || '';
  const description = htmlToText(html);
  const contact = htmlToText(r.contact_info || '').replace(/\s*\n\s*/g, ' · ');
  const types = list(r.event_types) || [];
  const audience = list(r.event_types_audience) || [];
  const links = extractLinks(`${html} ${r.contact_info || ''}`);
  if (r.online_url) links.push({ href: text(r.online_url), text: text(r.online_button_label) });
  let registration = registrationFrom({ tags: r.has_registration ? ['Registration Required'] : [], description, links });
  if (r.has_registration) registration = { ...registration, label: 'Registration required (per calendar)' };

  const item = {
    seriesId: `tamu:${slug(title)}`,
    kind: r.repeats ? 'recurring' : 'one-time',
    title,
    description: truncate(description, 600),
    summary: truncate(description.replace(/\n/g, ' '), 200),
    location: locationFor(r),
    cost: costFor(r.cost),
    registration,
    types: classify({ tags: types.filter((t) => !WEAK_TYPES.test(t)), weakTags: types.filter((t) => WEAK_TYPES.test(t)), title, description }),
    sourceTags: [...types, ...audience.map((a) => `Audience: ${a}`)],
    contact: contact ? truncate(contact, 200) : null,
    websiteUrl: r.online_url ? text(r.online_url) : null,
    sourceId: SOURCE.id,
    sourceName: SOURCE.name,
    sourceUrl: text(r.url) || SOURCE.homepage,
    lastVerified: fetchedAt,
  };

  if (r.is_all_day) {
    const firstDay = dayKey(startMs);
    const end2 = Date.parse(r.date2_iso || '');
    let lastDay = firstDay, endKnown = false;
    if (Number.isFinite(end2) && end2 > startMs) { lastDay = dayKey(end2); endKnown = true; }
    else if (r.run) {
      // One record per day under one id: the run covers the listed days; repeats_end (UTC) states the true last day.
      lastDay = dayKey(r.run.last);
      const repEnd = parseNaiveUtc(r.repeats_end);
      if (Number.isFinite(repEnd) && dayKey(repEnd) > lastDay) lastDay = dayKey(repEnd);
      endKnown = Number.isFinite(repEnd) || (lastWindowDay !== null && lastDay < lastWindowDay);
    }
    const multi = lastDay > firstDay;
    return {
      ...item,
      id: `tamu:${r.id}@${startOfDay(firstDay)}`,
      kind: multi ? 'multi-day' : item.kind,
      start: new Date(startOfDay(firstDay)).toISOString(),
      end: new Date(startOfDay(lastDay, 1)).toISOString(),
      endKnown,
      allDay: true,
      timeNote: 'No time listed by source',
      ...(multi ? { runStart: firstDay, runEnd: lastDay } : {}),
    };
  }
  const end2 = Date.parse(r.date2_iso || '');
  const endMs = Number.isFinite(end2) && end2 > startMs ? end2 : null;
  return {
    ...item,
    id: `tamu:${r.id}@${startMs}`,
    start: new Date(startMs).toISOString(),
    end: endMs !== null ? new Date(endMs).toISOString() : null,
    endKnown: endMs !== null,
    allDay: false,
    timeNote: null,
  };
}

const looksLikeEvent = (r) => r && typeof r === 'object' && r.id != null && typeof r.title === 'string' && typeof r.date_iso === 'string';

/** Turn parsed feed records into normalised items within [fromMs, toMs]. Throws when the shape is wrong. */
export function itemsFromFeed(records, { fromMs, toMs, fetchedAt }) {
  if (!Array.isArray(records) || !records.length) throw new Error('Feed did not return a non-empty JSON array (feed may have changed)');
  const plausible = records.filter(looksLikeEvent).length;
  if (plausible < records.length / 2) throw new Error(`Feed records do not look like LiveWhale events (${plausible} of ${records.length} have id/title/date_iso — shape may have changed)`);

  const stats = {
    records: records.length,
    excluded: { transit: 0, academicCalendar: 0, cancelled: 0, online: 0, notPublicAudience: 0, otherCampus: 0, duplicateId: 0, outsideWindow: 0, invalid: 0 },
    notes: [],
  };
  const kept = [];
  for (const r of records) {
    if (!looksLikeEvent(r)) { stats.excluded.invalid++; continue; }
    const why = classifyExclusion(r);
    if (why) { stats.excluded[why]++; continue; }
    kept.push(r);
  }
  const { records: unique, dropped } = dedupeById(kept);
  stats.excluded.duplicateId = dropped;

  const lastWindowDay = dayKey(toMs - 1);
  const items = [];
  for (const r of unique) {
    const it = itemFromRecord(r, { fetchedAt, lastWindowDay });
    if (!it) { stats.excluded.invalid++; stats.notes.push(`${r.id}: no usable title/start`); continue; }
    const s = Date.parse(it.start), e = it.end ? Date.parse(it.end) : s;
    if (e < fromMs || s >= toMs) { stats.excluded.outsideWindow++; continue; }
    items.push(it);
  }
  stats.items = items.length;
  return { items, stats };
}

export async function fetchSource({ fetchText, fromMs, toMs, log = () => {} }) {
  const fetchedAt = new Date().toISOString();
  const url = feedUrl(fromMs, toMs);
  const body = await fetchText(url);
  let records;
  try { records = JSON.parse(body); } catch { throw new Error('Response was not JSON (feed may have changed or moved)'); }
  const { items, stats } = itemsFromFeed(records, { fromMs, toMs, fetchedAt });
  const ex = stats.excluded;
  log(`  ${stats.records} feed records → ${items.length} items (excluded: ${Object.entries(ex).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`);
  return { items, stats: { requests: 1, url, ...stats }, fetchedAt };
}
