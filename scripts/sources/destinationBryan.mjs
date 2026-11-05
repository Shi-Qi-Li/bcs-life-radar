// Destination Bryan — https://www.destinationbryan.com/events/
// No public feed is offered. Discovery uses the site's public event sitemap (every event page with a
// last-modified date), with the paginated listing as a fallback; each event page is then read for the
// visible date/time, admission, coordinates, category and schema.org JSON-LD.
//
// Why visible text wins over JSON-LD for times: on 2026-11-05 we observed JSON-LD such as
// "startDate":"2026-11-11T19:00:00.000000Z" on a page whose visible text says "7:00 PM – 10:30 PM".
// The "Z" is wrong (it is Central wall time), while other pages use a correct "-06:00" offset.

import { chicagoToUtc, startOfDay, keyFromYmd } from '../../public/js/shared/time.js';
import { htmlToText, decodeEntities, truncate, costFromText, registrationFrom, extractLinks, slug } from '../lib/normalize.mjs';
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
    const lat = parseFloat((/data-marker-lat="([^"]*)"/.exec(block) || [])[1]);
    const lng = parseFloat((/data-marker-lng="([^"]*)"/.exec(block) || [])[1]);
    const dateHeading = htmlToText((/card__date-heading"[^>]*>([\s\S]*?)<\/span>/.exec(block) || [])[1] || '');
    cards.push({ url, title, categories: new Set(cats), lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, dateHeading });
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
  const description = htmlToText(summaryHtml) || ld?.description || '';
  const upcomingHtml = (/<ul class="[^"]*detail__dates[^"]*">([\s\S]*?)<\/ul>/.exec(html) || [])[1];
  const upcoming = upcomingHtml ? parseUpcoming(upcomingHtml, dates[0]) : [];

  const lat = parseFloat((/data-marker-lat="([^"]*)"/.exec(html) || [])[1]);
  const lng = parseFloat((/data-marker-lng="([^"]*)"/.exec(html) || [])[1]);
  const categories = [...new Set([...html.matchAll(/data-dms-category-name="([^"]*)"/g)].map((x) => decodeEntities(x[1])).filter(Boolean))];

  const addr = ld?.location?.address || {};
  const address = [addr.streetAddress, [addr.addressLocality, addr.addressRegion === 'Texas' ? 'TX' : addr.addressRegion].filter(Boolean).join(', '), addr.postalCode]
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
    location: { name: ld?.location?.name ? decodeEntities(ld.location.name) : null, address: address || null },
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    categories,
  };
}

/** Expand a parsed detail page into occurrence items inside [fromMs, toMs]. */
export function itemsFromDetail(d, card, { fromMs, toMs, fetchedAt }) {
  const [t1, t2] = d.times;
  const mk = (day, t) => chicagoToUtc(day.y, day.m, day.d, t.hh, t.mm);
  const categories = [...new Set([...(card?.categories || []), ...(d.categories || [])])];
  const base = {
    seriesId: `dbryan:${slug(d.url.split('/events/')[1] || d.title)}`,
    title: d.title,
    description: truncate(d.description, 600),
    summary: truncate(d.description.replace(/\n/g, ' '), 200),
    location: { ...d.location, lat: card?.lat ?? d.lat ?? null, lng: card?.lng ?? d.lng ?? null },
    cost: costFromText(d.admission),
    registration: registrationFrom({ description: d.description, links: d.links, ticketUrl: d.ticketUrl }),
    types: classify({ weakTags: categories, title: d.title, description: d.description }),
    sourceTags: categories,
    contact: null,
    websiteUrl: d.websiteUrl,
    sourceId: SOURCE.id,
    sourceName: SOURCE.name,
    sourceUrl: d.url,
    lastVerified: fetchedAt,
  };
  if (!base.location.name && !base.location.address) base.location = null;

  const items = [];
  const push = (startMs, endMs, extra) => {
    if ((endMs ?? startMs) < fromMs || startMs > toMs) return;
    items.push({ ...base, id: `${base.seriesId}@${startMs}`, start: new Date(startMs).toISOString(), end: endMs != null ? new Date(endMs).toISOString() : null, ...extra });
  };
  const span = (day) => {
    if (!t1) {
      const s = startOfDay(keyFromYmd(day.y, day.m, day.d));
      return [s, startOfDay(keyFromYmd(day.y, day.m, day.d), 1), { allDay: true, endKnown: false, timeNote: 'No time listed by source' }];
    }
    const s = mk(day, t1);
    let e = t2 ? mk(day, t2) : null;
    if (e !== null && e <= s) e += 24 * 3600_000; // ends after midnight
    return [s, e, { allDay: false, endKnown: e !== null }];
  };

  if (d.dates.length >= 2 && keyFromYmd(d.dates[0].y, d.dates[0].m, d.dates[0].d) !== keyFromYmd(d.dates[1].y, d.dates[1].m, d.dates[1].d)) {
    // Multi-day run (e.g. an exhibit). One item spanning the whole run; listed daily hours shown as text.
    const [s] = span(d.dates[0]);
    const last = d.dates[1];
    const end = startOfDay(keyFromYmd(last.y, last.m, last.d), 1);
    const hoursText = t1 ? `Listed hours: ${d.times.map((t) => `${(t.hh % 12) || 12}:${String(t.mm).padStart(2, '0')} ${t.hh >= 12 ? 'PM' : 'AM'}`).join(' – ')}` : 'Daily hours not listed';
    push(t1 ? startOfDay(keyFromYmd(d.dates[0].y, d.dates[0].m, d.dates[0].d)) : s, end, {
      kind: 'multi-day', allDay: true, endKnown: true,
      timeNote: `${hoursText} (as published; confirm with the venue)`,
      runStart: keyFromYmd(d.dates[0].y, d.dates[0].m, d.dates[0].d), runEnd: keyFromYmd(last.y, last.m, last.d),
    });
    return items;
  }
  const days = d.upcoming.length >= 2 ? d.upcoming : [d.dates[0]];
  const kind = d.upcoming.length >= 2 ? 'recurring' : 'one-time';
  for (const day of days) {
    const [s, e, extra] = span(day);
    const isFirst = day.y === d.dates[0].y && day.m === d.dates[0].m && day.d === d.dates[0].d;
    if (kind === 'recurring' && !isFirst && t1) extra.timeNote = 'Time copied from the series listing — confirm for this date';
    push(s, e, { kind, ...extra });
  }
  return items;
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

export async function fetchSource({ fetchText, mapLimit, fromMs, toMs, concurrency = 3, maxListingPages = 8, maxDetailPages = 400, log = () => {} }) {
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
    items.push(...itemsFromDetail(d, card, { fromMs, toMs, fetchedAt }));
  });
  // If most pages failed, treat the refresh as failed so the last good data is kept and the failure is shown.
  if (cards.length && stats.failedPages > cards.length / 2) {
    throw new Error(`${stats.failedPages} of ${cards.length} event pages could not be read`);
  }
  stats.items = items.length;
  return { items, stats, fetchedAt };
}
