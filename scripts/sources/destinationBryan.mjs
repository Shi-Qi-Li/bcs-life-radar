// Destination Bryan — https://www.destinationbryan.com/events/
// No public feed is offered. Discovery uses the site's public event sitemap (every event page with a
// last-modified date), with the paginated listing as a fallback; each event page is then read for the
// visible date/time, admission, coordinates, category and schema.org JSON-LD.
//
// Why visible text wins over JSON-LD for times: on 2026-11-05 we observed JSON-LD such as
// "startDate":"2026-11-11T19:00:00.000000Z" on a page whose visible text says "7:00 PM – 10:30 PM".
// The "Z" is wrong (it is Central wall time), while other pages use a correct "-06:00" offset.

import { chicagoToUtc, startOfDay, keyFromYmd, dowOfKey } from '../../public/js/shared/time.js';
import { htmlToText, decodeEntities, truncate, costFromText, registrationFrom, extractLinks, slug, cleanDescription, nameSimilarity } from '../lib/normalize.mjs';
import { classify } from '../../public/js/shared/taxonomy.js';

export const SOURCE = {
  id: 'dbryan',
  name: 'Destination Bryan',
  homepage: 'https://www.destinationbryan.com/events/',
  sitemapUrl: 'https://www.destinationbryan.com/sitemaps-1-event-default-1-sitemap.xml',
  method: 'Public event sitemap for discovery (listing pages as fallback), then every event page (HTML + schema.org JSON-LD). No feed/API is published.',
};

const EVENT_URL = /^https:\/\/www\.destinationbryan\.com\/events\/[a-z0-9-]+\/$/;
// Section pages that live under /events/ but are not events.
const NOT_EVENTS = new Set(['annual', 'submit-your-event', 'live-music', 'first-friday', 'first-friday-event-calendar']);

/** Parse the event sitemap into [{url, lastmod}] (event pages only). */
export function parseSitemap(xml) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = decodeEntities((/<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]) || [])[1] || '').trim();
    if (!EVENT_URL.test(loc)) continue;
    if (NOT_EVENTS.has(loc.split('/events/')[1].replace(/\/$/, ''))) continue;
    const lastmod = (/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]) || [])[1] || null;
    out.push({ url: loc, lastmod });
  }
  return out;
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** Sanity-check published coordinates: fix a dropped minus sign on longitude; drop anything outside the area. */
export function fixCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [null, null];
  if (lng > 0 && lat > 25 && lat < 37) lng = -lng; // "+96.37" published for a Bryan venue
  if (lat < 29 || lat > 32 || lng < -98.5 || lng > -94.5) return [null, null]; // not in the Brazos Valley region
  return [lat, lng];
}

/** Parse listing HTML into cards: [{url, title, categories:Set, lat, lng, dateHeading}] */
export function parseListing(html) {
  const cards = [];
  const re = /<article\b[^>]*card--listing[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[0];
    const url = (/href="(https:\/\/www\.destinationbryan\.com\/events\/[a-z0-9-]+\/)"/.exec(block) || [])[1];
    if (!url) continue;
    const title = decodeEntities((/data-dms-partner-name="([^"]*)"/.exec(block) || [])[1] || '');
    const cats = [...block.matchAll(/data-dms-category-name="([^"]*)"/g)].map((x) => decodeEntities(x[1]));
    const [lat, lng] = fixCoords(parseFloat((/data-marker-lat="([^"]*)"/.exec(block) || [])[1]), parseFloat((/data-marker-lng="([^"]*)"/.exec(block) || [])[1]));
    const dateHeading = htmlToText((/card__date-heading"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1] || '');
    cards.push({ url, title, categories: new Set(cats), lat, lng, dateHeading });
  }
  const pageNums = [...html.matchAll(/[?&]page=(\d+)/g)].map((x) => +x[1]);
  return { cards, lastPage: pageNums.length ? Math.max(...pageNums) : 1 };
}

function parseTimes(text) {
  return [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?/gi)].map((t) => {
    let h = +t[1] % 12;
    if (t[3].toUpperCase() === 'P') h += 12;
    return { hh: h, mm: t[2] ? +t[2] : 0 };
  });
}

function parseDates(text) {
  return [...text.matchAll(/(?:[A-Za-z]+day,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/g)]
    .filter((d) => MONTHS[d[1].toLowerCase()])
    .map((d) => ({ y: +d[3], m: MONTHS[d[1].toLowerCase()], d: +d[2] }));
}

/** "Friday, November 13" items without a year; infer years moving forward from `base`. */
function parseUpcoming(listHtml, base) {
  const out = [];
  let { y } = base;
  let prevM = base.m;
  for (const li of listHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const t = htmlToText(li[1]);
    const mm = /([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?/.exec(t);
    if (!mm || !MONTHS[mm[1].toLowerCase()]) continue;
    const m = MONTHS[mm[1].toLowerCase()];
    if (mm[3]) y = +mm[3];
    else if (m < prevM) y++;
    prevM = m;
    out.push({ y, m, d: +mm[2] });
  }
  return out;
}

/** Tidy a published street address: ", 505 W 31st St." → "505 W 31st St.", "930North Rosemary Drive" → "930 North Rosemary Drive". */
export function tidyAddress(s) {
  if (!s) return s || '';
  return String(s).replace(/^[\s,]+/, '').replace(/(\d)([A-Z][a-z])/g, '$1 $2').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
}

/** Venue named by the title's trailing "at <Venue>" ("Battle for Bryan at The Hilton Garden Inn"), or null. */
export function venueFromTitle(title) {
  const m = [...String(title || '').matchAll(/\s+at\s+/gi)].pop();
  if (!m) return null;
  const v = title.slice(m.index + m[0].length).trim().replace(/[.!]+$/, '');
  return /^(the\s+)?[A-Z0-9]/.test(v) && v.length >= 3 && v.length <= 60 && !/[:?]/.test(v) ? v : null;
}

/** Venue named by "Located in/at <Place>" in the description, or null. */
export function venueFromDescription(description) {
  const m = /\b[Ll]ocated (?:in|at) (?:the )?([A-Z][^,.;\n]{2,60}?)(?=[,.;\n]|$)/.exec(description || '');
  return m ? m[1].trim() : null;
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_WORD = '(?:mon|tues?|wednes|thurs?|fri|satur|sun)day';
const EVERY_DAY_RE = new RegExp(`\\bevery (?:other )?(${DAY_WORD}s?(?:(?:,| and| &|/) ?(?:${DAY_WORD})s?)*)`, 'i');
/** A caveat when the description's "every Thursday" disagrees with the weekday every listed date falls on. */
export function weekdayNote(description, days) {
  const m = EVERY_DAY_RE.exec(description || '');
  if (!m || !days.length) return null;
  const said = new Set([...m[1].matchAll(new RegExp(DAY_WORD, 'gi'))].map((x) => DOW_NAMES.findIndex((n) => n.toLowerCase().startsWith(x[0].toLowerCase().slice(0, 3)))));
  const listed = new Set(days.map((x) => dowOfKey(keyFromYmd(x.y, x.m, x.d))));
  if (listed.size !== 1) return null; // dates on mixed weekdays: nothing definite to compare against
  const [dow] = listed;
  if (said.has(dow)) return null;
  return `Listed dates are ${DOW_NAMES[dow]}s but the description says every ${[...said].map((i) => DOW_NAMES[i]).join(' and ')} — confirm with the venue`;
}

/** First sentence of a description that quotes a price, preferring a real price over a "$5 off" discount. */
export function priceSentence(description) {
  const withPrice = String(description || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => /\$\d/.test(s));
  const best = withPrice.find((s) => !/\$\s?\d+(?:\.\d+)?\s*off\b/i.test(s)) || withPrice[0];
  return best ? truncate(best, 160) : null;
}

/** Parse an event page. Returns a "series" description or { skip: reason }. */
export function parseDetail(html, url) {
  let ld = null;
  for (const s of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(s[1]);
      const ev = (j['@graph'] || [j]).find((n) => n['@type'] === 'Event');
      if (ev) { ld = ev; break; }
    } catch { /* ignore malformed blocks */ }
  }
  const title = htmlToText((/<h1 class="detail__heading">([\s\S]*?)<\/h1>/.exec(html) || [])[1] || '') || ld?.name;
  if (!title) return { skip: 'no title' };
  if (ld?.eventStatus && /Cancelled|Postponed/i.test(ld.eventStatus)) return { skip: 'cancelled/postponed' };

  const sub = htmlToText((/<p class="detail__subheading">([\s\S]*?)<\/p>/.exec(html) || [])[1] || '');
  const dates = parseDates(sub);
  const times = parseTimes(sub);
  if (!dates.length) return { skip: 'no date on page' };

  const admission = htmlToText((/<li><b>Admission<\/b>:?([\s\S]*?)<\/li>/i.exec(html) || [])[1] || '').replace(/^:\s*/, '');
  const ticketUrl = (/href="([^"]+)"[^>]*data-dms-event-detail-booking-click/.exec(html) || /data-dms-event-detail-booking-click[^>]*href="([^"]+)"/.exec(html) || [])[1];
  const websiteMatch = /<a\s+href="(https?:[^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?Website<\/a>/.exec(html);
  const summaryHtml = (/<div class="detail__summary[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html) || [])[1] || '';
  const description = cleanDescription(htmlToText(summaryHtml) || ld?.description || '');
  const upcomingHtml = (/<ul class="[^"]*detail__dates[^"]*">([\s\S]*?)<\/ul>/.exec(html) || [])[1];
  const upcoming = upcomingHtml ? parseUpcoming(upcomingHtml, dates[0]) : [];

  const [lat, lng] = fixCoords(parseFloat((/data-marker-lat="([^"]*)"/.exec(html) || [])[1]), parseFloat((/data-marker-lng="([^"]*)"/.exec(html) || [])[1]));
  const categories = [...new Set([...html.matchAll(/data-dms-category-name="([^"]*)"/g)].map((x) => decodeEntities(x[1])).filter(Boolean))];

  const addr = ld?.location?.address || {};
  const address = [tidyAddress(addr.streetAddress), [addr.addressLocality, addr.addressRegion === 'Texas' ? 'TX' : addr.addressRegion].filter(Boolean).join(', '), addr.postalCode]
    .filter(Boolean).join(', ').replace(/, (\d{5})$/, ' $1');

  return {
    url,
    title,
    description,
    dates,
    times,
    upcoming,
    admission,
    ticketUrl: ticketUrl ? decodeEntities(ticketUrl) : null,
    websiteUrl: websiteMatch ? decodeEntities(websiteMatch[1]) : null,
    links: extractLinks(summaryHtml),
    // The site sometimes publishes an address with no venue name; the title ("… at The Hilton Garden Inn")
    // or the description ("Located in Midtown Park, …") then names it.
    location: { name: ld?.location?.name ? decodeEntities(ld.location.name) : venueFromTitle(title) || venueFromDescription(description), address: address || null },
    lat,
    lng,
    categories,
  };
}

/** Expand a parsed detail page into occurrence items inside [fromMs, toMs]. */
export function itemsFromDetail(d, card, { fromMs, toMs, fetchedAt }) {
  const [t1, t2] = d.times;
  const mk = (day, t) => chicagoToUtc(day.y, day.m, day.d, t.hh, t.mm);
  const key = (x) => keyFromYmd(x.y, x.m, x.d);
  const categories = [...new Set([...(card?.categories || []), ...(d.categories || [])])];
  const description = cleanDescription(d.description || '');
  let cost = costFromText(d.admission);
  if (cost.status === 'unknown' && !String(d.admission || '').trim() && /\$\d/.test(description)) {
    // No admission line, but the description itself prices the activity ("Walk-On GellyBall for $30 per person").
    cost = { status: 'paid', label: `Price in description: ${priceSentence(description)}`, min: null };
  }
  const base = {
    seriesId: `dbryan:${slug(d.url.split('/events/')[1] || d.title)}`,
    title: d.title,
    description: truncate(description, 600),
    summary: truncate(description.replace(/\n/g, ' '), 200),
    location: { ...(d.location || {}), lat: card?.lat ?? d.lat ?? null, lng: card?.lng ?? d.lng ?? null },
    cost,
    registration: registrationFrom({ description, links: d.links, ticketUrl: d.ticketUrl }),
    types: classify({ weakTags: categories, title: d.title, description }),
    sourceTags: categories,
    contact: null,
    websiteUrl: d.websiteUrl,
    sourceId: SOURCE.id,
    sourceName: SOURCE.name,
    sourceUrl: d.url,
    lastVerified: fetchedAt,
  };
  if (!base.location.name && !base.location.address) base.location = null;
  const titleVenue = venueFromTitle(d.title);
  if (titleVenue && base.location?.name && nameSimilarity(titleVenue, base.location.name) < 0.5) {
    // "… Expo at The Brazos Center" listed at the Brazos County Expo Complex: the page contradicts itself.
    base.locationNote = 'Title names a different venue than the listed address — confirm';
  }

  const items = [];
  const push = (startMs, endMs, extra) => {
    if ((endMs ?? startMs) < fromMs || startMs > toMs) return;
    items.push({ ...base, id: `${base.seriesId}@${startMs}`, start: new Date(startMs).toISOString(), end: endMs != null ? new Date(endMs).toISOString() : null, ...extra });
  };
  const span = (day) => {
    if (!t1) {
      const s = startOfDay(key(day));
      return [s, startOfDay(key(day), 1), { allDay: true, endKnown: false, timeNote: 'No time listed by source' }];
    }
    const s = mk(day, t1);
    let e = t2 ? mk(day, t2) : null;
    if (e !== null && e <= s) e += 24 * 3600_000; // ends after midnight
    if (t1.hh === 0 && t1.mm === 0 && t2 && t2.hh >= 12) {
      // "12:00 AM – 4:00 PM": a midnight start with an afternoon end is almost certainly a data-entry slip,
      // so the start is treated as not listed (all-day style) while the listed end is kept.
      return [s, e, { allDay: true, endKnown: true, timeNote: `Source lists a 12:00 AM start — likely an error; ends ${fmtTime(t2)}` }];
    }
    const extra = { allDay: false, endKnown: e !== null, timeNote: null };
    if (e !== null && e - s > 14 * 3600_000) extra.timeNote = `Listed as ${Math.round((e - s) / 3600_000)} hours long (${fmtTime(t1)} – ${fmtTime(t2)}) — confirm with the venue`;
    return [s, e, extra];
  };

  if (d.dates.length >= 2 && keyFromYmd(d.dates[0].y, d.dates[0].m, d.dates[0].d) !== keyFromYmd(d.dates[1].y, d.dates[1].m, d.dates[1].d)) {
    // Multi-day run (e.g. an exhibit). One item spanning the whole run; listed daily hours shown as text.
    const [s] = span(d.dates[0]);
    const last = d.dates[1];
    const end = startOfDay(keyFromYmd(last.y, last.m, last.d), 1);
    const hoursText = t1 ? `Listed hours: ${d.times.map(fmtTime).join(' – ')}` : 'Daily hours not listed';
    push(t1 ? startOfDay(keyFromYmd(d.dates[0].y, d.dates[0].m, d.dates[0].d)) : s, end, {
      kind: 'multi-day', allDay: true, endKnown: true,
      timeNote: `${hoursText} (as published; confirm with the venue)`,
      runStart: keyFromYmd(d.dates[0].y, d.dates[0].m, d.dates[0].d), runEnd: keyFromYmd(last.y, last.m, last.d),
    });
    return items;
  }
  // The headline date is sometimes missing from the site's own "Upcoming Dates" list, so union them.
  const byKey = new Map([[key(d.dates[0]), d.dates[0]], ...d.upcoming.map((x) => [key(x), x])]);
  const days = [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)));

  if (days.length >= LONG_RUN_MIN_DATES && isDenseRun(days)) {
    // A long, dense date list (e.g. an exhibit open every weekday for months) is one ongoing thing, not
    // dozens of separate events. Publish one multi-day item with the listed hours and the open days.
    const first = days[0], last = days[days.length - 1];
    const hoursText = t1 ? `Listed hours: ${d.times.map(fmtTime).join(' – ')}` : 'Daily hours not listed';
    push(startOfDay(key(first)), startOfDay(key(last), 1), {
      kind: 'multi-day', allDay: true, endKnown: true,
      timeNote: `Open ${openDaysText(days)} through ${last.m}/${last.d}. ${hoursText} (as published; confirm with the venue)`,
      runStart: key(first), runEnd: key(last), occurrenceCount: days.length,
    });
    return items;
  }
  const kind = days.length >= 2 ? 'recurring' : 'one-time';
  const dowNote = weekdayNote(description, days); // "every Thursday" in the text vs Wednesdays in the list
  for (const day of days) {
    const [s, e, extra] = span(day);
    const notes = extra.timeNote ? [extra.timeNote] : [];
    const isFirst = key(day) === key(d.dates[0]);
    if (kind === 'recurring' && !isFirst && t1) notes.push('Time copied from the series listing — confirm for this date');
    if (dowNote) notes.push(dowNote);
    push(s, e, { kind, ...extra, timeNote: notes.length ? notes.join(' · ') : null });
  }
  return items;
}

const LONG_RUN_MIN_DATES = 20;
const fmtTime = (t) => `${(t.hh % 12) || 12}:${String(t.mm).padStart(2, '0')} ${t.hh >= 12 ? 'PM' : 'AM'}`;
const civilDay = (x) => Math.floor(Date.UTC(x.y, x.m - 1, x.d) / 86400000);
/** Dense = on average at least one listed date every two days across the run. */
function isDenseRun(days) {
  const span = civilDay(days[days.length - 1]) - civilDay(days[0]) + 1;
  return span <= days.length * 2;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function openDaysText(days) {
  const dows = new Set(days.map((x) => new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay()));
  if (dows.size === 7) return 'daily';
  if (dows.size === 5 && !dows.has(0) && !dows.has(6)) return 'weekdays';
  return [...dows].sort().map((n) => DOW[n]).join('/');
}

/** Discover event URLs: sitemap first (complete, one request), listing pages as a fallback. */
async function discover({ fetchText, maxListingPages, log, stats }) {
  const cardsByUrl = new Map();
  try {
    const entries = parseSitemap(await fetchText(SOURCE.sitemapUrl));
    stats.sitemapUrls = entries.length;
    if (entries.length >= 20) {
      for (const e of entries) cardsByUrl.set(e.url, { url: e.url, lastmod: e.lastmod, categories: new Set(), lat: null, lng: null });
      stats.discovery = 'sitemap';
      return cardsByUrl;
    }
    stats.notes.push(`Sitemap listed only ${entries.length} event URLs — falling back to listing pages`);
  } catch (e) {
    stats.notes.push(`Sitemap unavailable (${e.message}) — falling back to listing pages`);
  }
  let last = 1;
  for (let page = 1; page <= Math.min(maxListingPages, last); page++) {
    const html = await fetchText(`${SOURCE.homepage}?page=${page}`);
    stats.listingPages = (stats.listingPages || 0) + 1;
    const { cards, lastPage } = parseListing(html);
    if (page === 1) {
      if (!cards.length) throw new Error('Listing page had no event cards (layout may have changed)');
      last = lastPage;
    }
    for (const c of cards) {
      const prev = cardsByUrl.get(c.url);
      if (prev) { for (const x of c.categories) prev.categories.add(x); } else cardsByUrl.set(c.url, c);
    }
  }
  stats.discovery = 'listing';
  stats.totalListingPages = last;
  if (last > maxListingPages) stats.notes.push(`Listing fallback read ${maxListingPages} of ${last} pages — coverage is partial`);
  return cardsByUrl;
}

// This host serialises requests: 3 concurrent fetches tripled latency and caused timeouts, so 1 at a time.
export async function fetchSource({ fetchText, mapLimit, fromMs, toMs, concurrency = 1, maxListingPages = 8, maxDetailPages = 400, log = () => {} }) {
  const fetchedAt = new Date().toISOString();
  const stats = { discovery: null, sitemapUrls: 0, detailPages: 0, failedPages: 0, skipped: {}, notes: [] };
  const cardsByUrl = await discover({ fetchText, maxListingPages, log, stats });
  let cards = [...cardsByUrl.values()];
  if (cards.length > maxDetailPages) { stats.notes.push(`Stopped after ${maxDetailPages} of ${cards.length} event pages`); cards = cards.slice(0, maxDetailPages); }
  stats.discovered = cards.length;

  const results = await mapLimit(cards, concurrency, async (card) => {
    const html = await fetchText(card.url);
    return parseDetail(html, card.url);
  });
  const items = [];
  results.forEach((r, i) => {
    const card = cards[i];
    if (!r.ok) { stats.failedPages++; stats.notes.push(`${card.url}: ${r.error.message}`); log(`  ! ${card.url}: ${r.error.message}`); return; }
    stats.detailPages++;
    const d = r.value;
    if (d.skip) { stats.skipped[d.skip] = (stats.skipped[d.skip] || 0) + 1; return; }
    const produced = itemsFromDetail(d, card, { fromMs, toMs, fetchedAt });
    if (!produced.length) {
      // An ended event is served as a normal page (no marker), so "every listed date is in the past" is the only signal.
      const lastKey = [...d.dates, ...d.upcoming].map((x) => keyFromYmd(x.y, x.m, x.d)).sort().pop();
      const why = lastKey && startOfDay(lastKey, 1) <= fromMs ? 'ended (every listed date is in the past)' : 'no dates in window (far future)';
      stats.skipped[why] = (stats.skipped[why] || 0) + 1;
      return;
    }
    items.push(...produced);
  });
  // If most pages failed, treat the refresh as failed so the last good data is kept and the failure is shown.
  if (cards.length && stats.failedPages > cards.length / 2) {
    throw new Error(`${stats.failedPages} of ${cards.length} event pages could not be read`);
  }
  stats.items = items.length;
  return { items, stats, fetchedAt };
}
