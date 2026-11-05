// The Theatre Company of Bryan/College Station — public event calendar
// https://www.theatrecompany.com/calendar (a Squarespace "events" collection).
//
// One request per refresh: the HTML listing page. Its "Upcoming Events" block holds one <article> per
// performance with a machine-readable date (<time class="event-date" datetime="YYYY-MM-DD">) and the
// start/end times as the site renders them in its own time zone, Central ("7:00 PM", with a narrow
// no-break space before AM/PM). Date-range entries (auditions, work weeks) show two dates and no times.
// Every entry also carries a "Google Calendar" link whose dates=…Z/…Z instants we use only to
// double-check our Central-time reading (on 2026-11-05 all 49 timed entries agreed, CST and CDT alike).
//
// robots.txt disallows the site's ?format=ical and ?format=json endpoints, so they are never requested.
// Detail pages are not fetched: on 2026-11-05 they carried no venue, price or description beyond the
// listing (JSON-LD location name/address were empty), so nothing would be gained.
// The listing names no venue or price per event, so location is null and cost/registration are unknown —
// the company's own address is deliberately not assumed to be the venue.

import { chicagoToUtc, startOfDay, keyFromYmd, dayKey, formatDate, formatTime } from '../../public/js/shared/time.js';
import { htmlToText, decodeEntities, truncate, extractLinks, registrationFrom, slug } from '../lib/normalize.mjs';
import { classify } from '../../public/js/shared/taxonomy.js';

export const SOURCE = {
  id: 'theatreco',
  name: 'The Theatre Company (Bryan/College Station)',
  homepage: 'https://www.theatrecompany.com/calendar',
  method: 'Public HTML calendar listing (Squarespace), one request per refresh; dates and Central times are read from its machine-readable markup and checked against each entry\'s own calendar link. The site\'s ICS/JSON endpoints are disallowed by robots.txt and are not used.',
};

const DAY = 86_400_000;
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? decodeEntities(m[1]) : null; };
const key = (x) => keyFromYmd(x.y, x.m, x.d);
const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
const iso = (ms) => new Date(ms).toISOString();

/** "7:00 PM" (12-hour, as the site renders it; U+202F before AM/PM) or "19:00" → { hh, mm }; otherwise null. */
export function parseTime(text) {
  const t = String(text ?? '').replace(/[  ]/g, ' ').trim();
  let m = /^(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?$/i.exec(t);
  if (m) {
    const h12 = +m[1], mm = m[2] ? +m[2] : 0;
    if (h12 < 1 || h12 > 12 || mm > 59) return null;
    return { hh: (h12 % 12) + (m[3].toUpperCase() === 'P' ? 12 : 0), mm };
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m && +m[1] < 24 && +m[2] < 60) return { hh: +m[1], mm: +m[2] };
  return null;
}

/** Inner HTML of the <div> whose opening tag is the regex match `open`, counting nested divs. */
function divInner(html, open) {
  const from = open.index + open[0].length;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (!depth) return html.slice(from, m.index);
  }
  return html.slice(from);
}

/** UTC instants [startMs, endMs] from the entry's Google Calendar export link, or null (date-only links give none). */
function calendarLinkInstants(article) {
  const m = /google\.com\/calendar\/event\?[^"]*\bdates=(\d{8}T\d{6}Z)(?:\/|%2F)(\d{8}T\d{6}Z)/.exec(article);
  if (!m) return null;
  const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
  return [toMs(m[1]), toMs(m[2])];
}

function parseEntry(article) {
  const a = /<a\b[^>]*class="[^"]*\beventlist-title-link\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(article);
  const title = a ? htmlToText(a[1]).replace(/\s+/g, ' ').trim() : '';
  const href = a ? attr(a[0], 'href') : null;
  const times = [...article.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/g)]
    .map((m) => ({ cls: attr(m[1], 'class') || '', datetime: attr(m[1], 'datetime'), text: htmlToText(m[2]) }));
  const dates = times.filter((t) => /\bevent-date\b/.test(t.cls)).map((t) => ymd(t.datetime)).filter(Boolean);
  const startText = times.find((t) => /\bevent-time-localized-start\b/.test(t.cls))?.text ?? null;
  const endText = times.find((t) => /\bevent-time-localized-end\b/.test(t.cls))?.text ?? null;
  const descOpen = /<div\b[^>]*class="[^"]*\beventlist-description\b[^"]*"[^>]*>/.exec(article);
  const descriptionHtml = descOpen ? divInner(article, descOpen) : '';
  return { title, href, dates, startText, endText, descriptionHtml, link: calendarLinkInstants(article) };
}

/**
 * Parse the calendar page: { found, entries, pastEntries }. `found` says whether the "upcoming" block
 * exists; `entries` are its raw entries { title, href, dates:[{y,m,d}], startText, endText, descriptionHtml,
 * link:[startMs,endMs]|null }; entries under "Past Events" are only counted.
 */
export function parseListing(html) {
  const ARTICLE = /<article\b[^>]*\beventlist-event\b[^>]*>[\s\S]*?<\/article>/g;
  const up = /<div\b[^>]*class="[^"]*\beventlist--upcoming\b[^"]*"[^>]*>/.exec(html);
  if (!up) return { found: false, entries: [], pastEntries: 0 };
  const from = up.index + up[0].length;
  const past = /<div\b[^>]*class="[^"]*\beventlist--past\b[^"]*"[^>]*>/.exec(html.slice(from));
  const block = past ? html.slice(from, from + past.index) : html.slice(from);
  const entries = [...block.matchAll(ARTICLE)].map((m) => parseEntry(m[0]));
  const pastEntries = past ? [...html.slice(from + past.index).matchAll(ARTICLE)].length : 0;
  return { found: true, entries, pastEntries };
}

const fmtClock = (t) => `${(t.hh % 12) || 12}:${String(t.mm).padStart(2, '0')} ${t.hh >= 12 ? 'PM' : 'AM'}`;
/** timeNote for an entry the listing shows without usable times of day. */
function dateOnlyNote(e, start, end) {
  if (start) return `Listed times: ${fmtClock(start)}${end ? ` – ${fmtClock(end)}` : ''} (as published; confirm with the source)`;
  if (e.link) return `No times in the listing; its calendar link runs ${formatDate(e.link[0])}, ${formatTime(e.link[0])} – ${formatDate(e.link[1])}, ${formatTime(e.link[1])} (confirm with the source)`;
  return 'No time listed by source';
}

/** Turn the listing HTML into normalised items within [fromMs, toMs]. Throws when the page shape is not recognised. */
export function itemsFromListing(html, { fromMs, toMs, fetchedAt }) {
  const { found, entries, pastEntries } = parseListing(html);
  if (!found) throw new Error('Calendar page has no "upcoming events" block (layout may have changed)');
  if (!entries.length) throw new Error('No upcoming event entries on the calendar page (layout may have changed, or nothing is scheduled)');
  const stats = { entries: entries.length, pastEntries, items: 0, skipped: {}, timeChecks: { agree: 0, disagree: 0 }, notes: [] };
  const skip = (why) => { stats.skipped[why] = (stats.skipped[why] || 0) + 1; };
  const check = (e, ok, what) => { if (ok) stats.timeChecks.agree++; else { stats.timeChecks.disagree++; stats.notes.push(`${e.title} ${key(e.dates[0])}: ${what}`); } };
  const items = [];
  const seen = new Set();
  let readable = 0;

  for (const e of entries) {
    if (!e.title || !e.href || !e.dates.length) { skip('unreadable entry (no title, link or date)'); continue; }
    const start = e.startText !== null ? parseTime(e.startText) : null;
    const end = e.endText !== null ? parseTime(e.endText) : null;
    if ((e.startText !== null && !start) || (e.endText !== null && !end)) {
      skip('unreadable time'); stats.notes.push(`${e.title}: could not read the time "${e.startText} – ${e.endText}"`); continue;
    }
    readable++;
    const days = [...e.dates].sort((a, b) => key(a).localeCompare(key(b)));
    const first = days[0], last = days[days.length - 1];
    let startMs, endMs, extra;
    if (key(first) !== key(last)) {
      // Date range (auditions, work week): one multi-day item spanning the listed days.
      startMs = startOfDay(key(first)); endMs = startOfDay(key(last), 1);
      extra = { kind: 'multi-day', allDay: true, endKnown: true, timeNote: dateOnlyNote(e, start, end), runStart: key(first), runEnd: key(last) };
      if (e.link) check(e, dayKey(e.link[0]) === key(first), `listed first day differs from the page's calendar link (${iso(e.link[0])})`);
    } else if (start) {
      startMs = chicagoToUtc(first.y, first.m, first.d, start.hh, start.mm);
      endMs = end ? chicagoToUtc(first.y, first.m, first.d, end.hh, end.mm) : null;
      if (endMs !== null && endMs <= startMs) endMs += DAY; // ends after midnight
      extra = { kind: 'one-time', allDay: false, endKnown: endMs !== null, timeNote: null };
      if (e.link) check(e, e.link[0] === startMs, `listed ${e.startText.replace(/[  ]/g, ' ')} read as ${iso(startMs)} but the page's calendar link says ${iso(e.link[0])}`);
    } else {
      startMs = startOfDay(key(first)); endMs = startOfDay(key(first), 1);
      extra = { kind: 'one-time', allDay: true, endKnown: false, timeNote: dateOnlyNote(e, null, null) };
      if (e.link) check(e, dayKey(e.link[0]) === key(first), `listed day differs from the page's calendar link (${iso(e.link[0])})`);
    }
    if ((endMs ?? startMs) < fromMs || startMs > toMs) { skip('outside window'); continue; }

    const seriesId = `theatreco:${slug(e.title)}`; // performances of one production share a series
    const id = `${seriesId}@${startMs}`;
    if (seen.has(id)) { skip('duplicate listing (same show, same start)'); continue; } // the site itself lists some performances twice
    seen.add(id);
    const description = htmlToText(e.descriptionHtml);
    const types = classify({ weakTags: ['Theatre'], title: e.title, description });
    items.push({
      id,
      seriesId,
      kind: extra.kind,
      title: e.title,
      description: truncate(description, 600),
      summary: truncate(description.replace(/\n/g, ' '), 200),
      location: null, // no venue is listed per event; the company's address is not assumed
      cost: { status: 'unknown', label: 'Cost not listed', min: null },
      registration: registrationFrom({ description, links: extractLinks(e.descriptionHtml) }),
      types: types.length ? types : ['shows'],
      sourceTags: [],
      contact: null,
      sourceId: SOURCE.id,
      sourceName: SOURCE.name,
      sourceUrl: new URL(e.href, SOURCE.homepage).href,
      lastVerified: fetchedAt,
      start: iso(startMs),
      end: endMs !== null ? iso(endMs) : null,
      ...extra,
    });
  }
  if (!readable) throw new Error(`None of the ${entries.length} event entries could be read (layout may have changed)`);
  const checked = stats.timeChecks.agree + stats.timeChecks.disagree;
  if (checked && stats.timeChecks.disagree > checked / 2) {
    throw new Error(`Listed times disagree with the page's own calendar links for ${stats.timeChecks.disagree} of ${checked} entries (time zone handling may have changed)`);
  }
  stats.items = items.length;
  return { items, stats };
}

export async function fetchSource({ fetchText, fromMs, toMs, log = () => {} }) {
  const fetchedAt = new Date().toISOString();
  const html = await fetchText(SOURCE.homepage); // the only request; never the robots-disallowed ?format= endpoints
  const { items, stats } = itemsFromListing(html, { fromMs, toMs, fetchedAt });
  for (const n of stats.notes) log(`  ! ${n}`);
  return { items, stats: { requests: 1, ...stats }, fetchedAt };
}
