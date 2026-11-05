// Bryan + College Station Public Library — Activities calendar.
// https://www.bcslibrary.org/programs/activities/ embeds the library's public Tockify calendar
// ("bcslibrary"). Its public page https://tockify.com/bcslibrary is server-rendered with the viewer's
// state in `window.tkf = {...};` — bootdata.query.monthly.events holds one record per occurrence
// (recurrences already expanded) with start/end epoch ms + tzid America/Chicago, an all-day flag, title,
// plain-text description, venue name/address, audience tags and RSVP-form flags. We read that state from
// one monthly page per calendar month in the refresh window (normally 2–3 requests).
//
// tockify.com/robots.txt disallows /api/ (which covers the ICS, RSS and the viewer's JSON endpoint),
// /e/, /em/, /p/ and the standalone RSVP route for every agent, so only /bcslibrary/monthly?startms=…
// pages are fetched and event links point to the public /bcslibrary/detail/<uid>/<tid>[/<rid>] pages
// (pattern verified against the page's own JSON-LD and a live detail page on 2026-11-05).
//
// Pitfalls handled (observed 2026-11-05): end.millis === start.millis means "no end time entered";
// some records have no `end` at all; a modified occurrence ("mod") can have eid.tid !== start.millis, so
// URLs are built from eid; all-day records store Chicago midnight with an exclusive midnight end; closure
// notices ("LIBRARIES CLOSED FOR THANKSGIVING") are listed as events; the pre-rendered month is capped at
// 100 records (metaData.hasNext); Tockify gives a Google place_id but no coordinates (none are invented).

import { chicagoParts, chicagoToUtc, dayKey, startOfDay } from '../../public/js/shared/time.js';
import { htmlToText, truncate, costFromText, registrationFrom, slug } from '../lib/normalize.mjs';
import { classify } from '../../public/js/shared/taxonomy.js';

export const SOURCE = {
  id: 'bcslibrary',
  name: 'Bryan + College Station Public Library',
  homepage: 'https://www.bcslibrary.org/programs/activities/',
  calendarPage: 'https://tockify.com/bcslibrary',
  method: "Public Tockify calendar page of the library's Activities calendar: the server-rendered viewer state (window.tkf.bootdata) shipped with the page itself, one monthly page per month in the window. No API, feed or login.",
};

/** Branch codes the library appends to titles, e.g. "Lapsit Storytime (CBMPL)". */
export const BRANCHES = {
  CBMPL: 'Clara B. Mounce Public Library',
  LJRL: 'Larry J. Ringer Library',
  CHC: 'Carnegie History Center',
};

const TZ = 'America/Chicago';
const DAY = 86400_000;
const MAX_MONTHS = 6;
const pad = (n) => String(n).padStart(2, '0');
const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

// ---------------------------------------------------------------------------------------------------
// Page parsing

/** Index of the `}` matching the first `{` at or after `start`, skipping string contents; -1 if none. */
function matchBrace(s, start) {
  const open = s.indexOf('{', start);
  if (open < 0) return -1;
  let depth = 0, inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Extract and parse the `window.tkf = {...};` state from a Tockify page. Throws when it is absent. */
export function parseTkf(html) {
  const marker = 'window.tkf = ';
  const at = String(html || '').indexOf(marker);
  if (at < 0) throw new Error('No window.tkf state on the calendar page (layout may have changed)');
  const from = at + marker.length;
  const close = html.indexOf('</script>', from);
  const text = html.slice(from, close < 0 ? undefined : close).trim().replace(/;$/, '');
  try {
    return JSON.parse(text);
  } catch (first) {
    // The JSON itself might contain "</script>"; fall back to matching the outer braces.
    const end = matchBrace(html, from);
    try {
      if (end < 0) throw first;
      return JSON.parse(html.slice(html.indexOf('{', from), end + 1));
    } catch (e) {
      throw new Error(`window.tkf state could not be parsed (layout may have changed): ${e.message}`);
    }
  }
}

/** The monthly event records of a parsed page. Throws when the shape or time zone is not what we expect. */
export function monthlyEvents(tkf) {
  const bd = tkf?.bootdata;
  const monthly = bd?.query?.monthly;
  if (!Array.isArray(monthly?.events)) throw new Error('bootdata.query.monthly.events is missing from the calendar page (layout may have changed)');
  const tzid = bd.calendar?.tzid;
  if (tzid !== TZ) throw new Error(`Calendar time zone is ${tzid ? `"${tzid}"` : 'missing'}; expected ${TZ}`);
  return { events: monthly.events, metaData: monthly.metaData || {}, startms: bd.query.startms ?? null };
}

// ---------------------------------------------------------------------------------------------------
// Record interpretation

const BRANCH_RE = /\s*\((CBMPL|LJRL|CHC)\)/g;

/** "Lapsit Storytime (CBMPL)" → { title: "Lapsit Storytime", branch: "CBMPL" }. Only known codes are removed. */
export function splitTitle(raw) {
  const text = String(raw || '').trim();
  const codes = [...text.matchAll(BRANCH_RE)].map((m) => m[1]);
  if (!codes.length) return { title: text, branch: null };
  return { title: text.replace(BRANCH_RE, '').replace(/\s{2,}/g, ' ').trim(), branch: codes[0] };
}

/** Why a record is not an activity we list, or null. */
export function exclusionReason(rec) {
  const status = rec?.status?.name;
  if (status && status !== 'scheduled') return `status: ${status}`;
  const title = rec?.content?.summary?.text || '';
  if (!title.trim()) return 'untitled';
  if (/\b(closed|closure|holiday hours)\b/i.test(title)) return 'closure/notice';
  if (/\bclos(e|ing)\b/i.test(title) && !rec.content?.place) return 'closure/notice'; // "LIBRARIES CLOSING AT 5 PM…" has no venue
  return null;
}

const civil = (key) => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };

/**
 * Start/end instants of a record. All-day records store Chicago midnight and an exclusive midnight end
 * (verified: "closed Thursday, November 26 through Sunday, November 29" ends at Nov 30 00:00). A missing end
 * or one equal to the start means no end was entered.
 */
export function timing(rec) {
  const w = rec?.when || {};
  const startRaw = w.start?.millis;
  if (!Number.isFinite(startRaw)) return null;
  const endRaw = Number.isFinite(w.end?.millis) && w.end.millis > startRaw ? w.end.millis : null;
  if (w.allDay) {
    const start = startOfDay(dayKey(startRaw));
    const end = endRaw ?? startOfDay(dayKey(startRaw), 1);
    const days = civil(dayKey(end - 1)) - civil(dayKey(start)) + 1;
    return { start, end, endKnown: endRaw !== null, allDay: true, days, timeNote: endRaw === null ? 'No end date listed by source' : days > 1 ? 'Dates only — daily hours not listed by source' : null };
  }
  return { start: startRaw, end: endRaw, endKnown: endRaw !== null, allDay: false, days: 1, timeNote: endRaw === null ? 'No end time listed by source' : null };
}

// Dangling calls-to-action whose hyperlinks Tockify strips from the plain-text description.
const BOILERPLATE = [/\s*Sign up for our newsletter here\.?(?=\s|$)/gi, /\s*Click here for more information\.(?=\s|$)/gi];

export function cleanDescription(text) {
  let t = htmlToText(String(text || ''));
  for (const re of BOILERPLATE) t = t.replace(re, '');
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

const sentences = (text) => text.split(/(?<=[.!?])\s+/);
// Only wording about the event's own admission counts as "free"; "free prize pack", "free book copies" or
// "digitize … for free" describe perks or services, not the cost of attending.
const FREE_ADMISSION = /\b(free (admission|entry|event|program|class|workshop|concert|show|performance|to attend|to the public|and open to the public|of charge)|free tickets?\b(?! to\b)|(admission|entry|event|program|class|workshop|concert|show|performance|tickets? (is|are)) free|no (cost|charge|fee)s?\b|(is|are) free\b)/i;

export const COST_NOT_LISTED = { status: 'unknown', label: 'Cost not listed (library programs are usually free — confirm)', min: null };

/** Cost from the description: only when it states the event is free or names a price. */
export function costFor(description) {
  for (const s of sentences(description || '')) {
    if (/\$\s?\d/.test(s)) return costFromText(truncate(s, 160));
    if (FREE_ADMISSION.test(s)) { const c = costFromText(s); if (c.status === 'free') return { ...c, label: 'Free (per description)' }; }
  }
  return { ...COST_NOT_LISTED };
}

// The library's wording "Registration not required." (no "is") is not caught by registrationFrom.
const NOT_REQUIRED = /\b(registration|rsvp|sign-?up|tickets?) (is |are )?not (required|needed|necessary)\b|\bno (registration|rsvp)( is)? (required|needed|necessary)\b|\bno need to (register|rsvp)\b/i;

/** Registration from the description/title, plus the record's RSVP form or flag when present. */
export function registrationFor(rec, titleRaw, description, detailUrl) {
  let text = registrationFrom({ description: `${titleRaw}. ${description}` });
  if (text.status !== 'not-required' && NOT_REQUIRED.test(description)) text = { status: 'not-required', label: 'No registration required (per description)', url: null };
  const form = rec?.content?.rsvpLink || null;
  if (!form && rec?.content?.rsvp !== true) return text;
  if (text.status === 'not-required') return text; // the library's own words win
  const button = form?.buttonLabel || 'RSVP';
  const full = form?.markedAsFull ? ' — marked full by the library' : '';
  if (/registration (is )?(suggested|encouraged|recommended|optional)/i.test(description)) {
    return { status: 'mentioned', label: `Registration suggested (per description) — "${button}" form on the calendar page${full}`, url: detailUrl };
  }
  if (text.status === 'required' || /\b(register|registration|rsvp)\b/i.test(titleRaw)) {
    return { status: 'required', label: `Registration required — "${button}" form on the calendar page${full}`, url: detailUrl };
  }
  return { status: 'mentioned', label: `"${button}" form on the calendar page — check whether it is required${full}`, url: detailUrl };
}

// Audience tags as the taxonomy understands them (classification hints only; sourceTags keep the originals).
const TAG_HINTS = { Children: 'children', Tween: 'tweens (kids)', Teen: 'teens', 'All-Ages': 'all ages', 'All Ages': 'all ages', Adult: 'adults', 'Community-Events': 'community event', SRP: 'summer reading program' };

/** Taxonomy types; "library" is scrubbed first (the whole source is a library, so it would label everything "arts"). */
export function typesFor({ tags = [], title = '', description = '' }) {
  const scrub = (s) => s.replace(/\blibrar(y|ies)\b/gi, ' ').replace(/\bBCSPLS\b/g, ' ');
  const types = classify({
    tags: tags.map((t) => TAG_HINTS[t] || t),
    title: scrub(title.replace(/\s[-–]\s(Register|RSVP)\b.*$/i, '')),
    description: scrub(description),
  });
  return types.length ? types : ['learning'];
}

export function detailUrl(eid) {
  if (eid?.uid == null || !Number.isFinite(eid?.tid)) return SOURCE.calendarPage;
  return `${SOURCE.calendarPage}/detail/${eid.uid}/${eid.tid}${eid.rid ? `/${eid.rid}` : ''}`;
}

const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/;
export const recordKey = (rec) => `${rec?.eid?.uid}:${rec?.eid?.tid}:${rec?.eid?.rid ?? 0}`;

/** Turn monthly records into normalised items within [fromMs, toMs). Pure; shared by fetchSource and tests. */
export function itemsFromRecords(records, { fromMs, toMs, fetchedAt }) {
  const stats = { records: records.length, excluded: {}, outsideWindow: 0, notes: [] };
  const seenUid = new Map();
  for (const r of records) { const u = r?.eid?.uid; if (u != null) seenUid.set(u, (seenUid.get(u) || 0) + 1); }

  const items = [];
  for (const rec of records) {
    const why = exclusionReason(rec);
    if (why) { bump(stats.excluded, why); continue; }
    const t = timing(rec);
    if (!t) { bump(stats.excluded, 'no start time'); continue; }
    if (!(t.start < toMs && (t.end !== null ? t.end > fromMs : t.start >= fromMs))) { stats.outsideWindow++; continue; }

    const c = rec.content || {};
    const titleRaw = c.summary.text.trim();
    const { title, branch } = splitTitle(titleRaw);
    let description = cleanDescription(c.description?.text);
    if (c.directions && !description.includes(c.directions)) description = `${description}\nWhere: ${c.directions}`.trim();
    const tags = Array.isArray(c.tagset?.tags?.default) ? c.tagset.tags.default.filter((x) => typeof x === 'string') : [];
    const uid = rec.eid?.uid ?? rec._id ?? slug(titleRaw);
    const seriesId = `bcslibrary:${uid}`;
    const url = detailUrl(rec.eid);
    const isSeries = ['repeat', 'rdate', 'mod'].includes(rec.kind) || (seenUid.get(rec.eid?.uid) || 0) > 1;
    const kind = t.allDay && t.days > 1 ? 'multi-day' : isSeries ? 'recurring' : 'one-time';
    const name = (c.place || '').trim() || (branch ? BRANCHES[branch] : null) || null;
    const address = String(c.address || '').replace(/,\s*USA$/i, '').trim() || null;
    const phone = PHONE.exec(description);

    items.push({
      id: `${seriesId}@${t.start}`,
      seriesId,
      kind,
      title,
      titleRaw,
      description: truncate(description, 600),
      summary: truncate(description.replace(/\n/g, ' '), 200),
      location: name || address ? { name, address, lat: null, lng: null } : null,
      cost: costFor(description),
      registration: registrationFor(rec, titleRaw, description, url),
      types: typesFor({ tags, title, description }),
      sourceTags: branch ? [...tags, branch] : tags,
      contact: phone ? phone[0] : null,
      websiteUrl: SOURCE.homepage,
      sourceId: SOURCE.id,
      sourceName: SOURCE.name,
      sourceUrl: url,
      lastVerified: fetchedAt,
      start: new Date(t.start).toISOString(),
      end: t.end !== null ? new Date(t.end).toISOString() : null,
      endKnown: t.endKnown,
      allDay: t.allDay,
      timeNote: t.timeNote,
    });
  }
  items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  stats.items = items.length;
  stats.series = new Set(items.map((i) => i.seriesId)).size;
  return { items, stats };
}

// ---------------------------------------------------------------------------------------------------
// Fetching

/** Calendar months (Chicago) touched by [fromMs, toMs). */
export function monthsBetween(fromMs, toMs) {
  const a = chicagoParts(fromMs), b = chicagoParts(Math.max(fromMs, toMs - 1));
  const out = [];
  for (let y = a.y, m = a.m; y < b.y || (y === b.y && m <= b.m); m === 12 ? (y++, m = 1) : m++) out.push({ y, m });
  return out;
}

/** The public monthly page; startms must be Chicago midnight of the 1st (DST-aware). */
export const monthUrl = ({ y, m }) => `${SOURCE.calendarPage}/monthly?startms=${chicagoToUtc(y, m, 1)}`;

export async function fetchSource({ fetchText, fromMs, toMs, log = () => {} }) {
  const fetchedAt = new Date().toISOString();
  const months = monthsBetween(fromMs, toMs);
  if (months.length > MAX_MONTHS) throw new Error(`Refresh window spans ${months.length} months; refusing to fetch more than ${MAX_MONTHS} pages`);
  const stats = { requests: 0, months: [], records: 0, excluded: {}, items: 0, truncatedMonths: [], notes: [] };
  const byKey = new Map();
  for (const mo of months) {
    const label = `${mo.y}-${pad(mo.m)}`;
    const url = monthUrl(mo);
    stats.requests++;
    const { events, metaData, startms } = monthlyEvents(parseTkf(await fetchText(url)));
    stats.months.push(label);
    if (startms !== null && startms !== chicagoToUtc(mo.y, mo.m, 1)) stats.notes.push(`${label}: page reported startms ${startms}, not the requested month start`);
    if (metaData.hasNext === true) {
      stats.truncatedMonths.push(label);
      const msg = `${label}: the pre-rendered month is capped (${events.length} records, hasNext) — later events of this month are missing`;
      stats.notes.push(msg);
      log(`  ! ${msg}`);
    }
    for (const rec of events) { const k = recordKey(rec); if (!byKey.has(k)) byKey.set(k, rec); }
  }
  const { items, stats: s } = itemsFromRecords([...byKey.values()], { fromMs, toMs, fetchedAt });
  Object.assign(stats, { records: s.records, excluded: s.excluded, outsideWindow: s.outsideWindow, items: s.items, series: s.series });
  stats.notes.push(...s.notes);
  return { items, stats, fetchedAt };
}
