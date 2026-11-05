// Destination Bryan — https://www.destinationbryan.com/events/ — and the shared "Tempest" event-page parser.
//
// Destination Bryan and Visit College Station (scripts/sources/visitcs.mjs) run the same Tempest/Craft CMS
// template, so the parsing lives here once, driven by a per-site config (see DESTINATION_BRYAN below and
// makeTempestSource()). Discovery uses the site's public event sitemap (every event page with a last-modified
// date) — with the paginated listing as a fallback where the site has a server-rendered one — and each event
// page is then read for the visible date/time, admission, coordinates, category and address.
//
// Why visible text wins over JSON-LD for times: on 2026-11-05 we observed JSON-LD such as
// "startDate":"2026-11-11T19:00:00.000000Z" on a page whose visible text says "7:00 PM – 10:30 PM".
// The "Z" is wrong (it is Central wall time), while other pages use a correct "-06:00" offset. On Visit
// College Station the JSON-LD startDate is the series' first occurrence (January for a weekly market) and
// location.name repeats the event title, so only visible text and data-* attributes are trusted there.

import { chicagoToUtc, startOfDay, keyFromYmd, dowOfKey } from '../../public/js/shared/time.js';
import { htmlToText, decodeEntities, truncate, costFromText, registrationFrom, extractLinks, slug, cleanDescription, nameSimilarity } from '../lib/normalize.mjs';
import { classify } from '../../public/js/shared/taxonomy.js';

/**
 * Site config for makeTempestSource(). Every key is used:
 *  - id/name/homepage/sitemapUrl/method: the SOURCE record (what refresh.mjs and the site show);
 *  - host: event pages are `https://<host>/events/<slug>/`; notEvents: slugs under /events/ that are not events;
 *  - minSitemapUrls: fewer sitemap entries than this means the sitemap is not trusted; listingFallback: whether
 *    the site has a server-rendered `/events/?page=N` listing to fall back on (Visit CS has an Algolia widget
 *    that needs the site's API key, so it must fail loudly instead);
 *  - selectors: ordered alternatives per field — a "tag.class" string (the element's inner HTML) or a RegExp
 *    whose group 1 is the inner HTML;
 *  - location: 'jsonld' (PostalAddress in the page's JSON-LD) or 'address' (the spans of div.detail__address);
 *  - categories: 'page' (every data-dms-category-name on the page) or 'main' (the <main> element's only);
 *  - strongCategories: categories specific enough to count as strong tags (the rest are weak hints);
 *  - freeCategory: a category that states the event is free when no Admission text exists;
 *  - ticketingWebsiteLink: treat the "Website" link as the ticket link when its host looks like ticketing;
 *  - maxConcurrency / maxDetailPages: caps applied on top of the refresh context's values.
 */
export const DESTINATION_BRYAN = {
  id: 'dbryan',
  name: 'Destination Bryan',
  homepage: 'https://www.destinationbryan.com/events/',
  sitemapUrl: 'https://www.destinationbryan.com/sitemaps-1-event-default-1-sitemap.xml',
  method: 'Public event sitemap for discovery (listing pages as fallback), then every event page (HTML + schema.org JSON-LD). No feed/API is published.',
  host: 'www.destinationbryan.com',
  // Section pages that live under /events/ but are not events.
  notEvents: ['annual', 'submit-your-event', 'live-music', 'first-friday', 'first-friday-event-calendar'],
  minSitemapUrls: 20,
  listingFallback: true,
  selectors: {
    dateText: ['p.detail__subheading', 'div.detail__dates-heading'],
    admission: [/<li><b>Admission<\/b>:?([\s\S]*?)<\/li>/i, /<h3>Admission<\/h3>\s*<div[^>]*>([\s\S]*?)<\/div>/i],
    summary: ['div.detail__summary'],
    upcoming: ['ul.detail__dates'],
  },
  location: 'jsonld',
  categories: 'page',
  strongCategories: [],
  freeCategory: null,
  ticketingWebsiteLink: false,
};

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** Sanity-check published coordinates: fix a dropped minus sign on longitude; drop anything outside the area. */
export function fixCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [null, null];
  if (lng > 0 && lat > 25 && lat < 37) lng = -lng; // "+96.37" published for a Bryan venue
  if (lat < 29 || lat > 32 || lng < -98.5 || lng > -94.5) return [null, null]; // not in the Brazos Valley region
  return [lat, lng];
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

// A street line ("217 University Dr", "18898 Hwy 6", "P.O. Box 12") or a city line ("College Station, Texas 77840").
const STREET_LINE = /^(?:\d+[a-z0-9-]*\s|p\.?\s?o\.?\s?box\b)/i;
const CITY_LINE = /,\s*(?:Texas|TX)\b/i;
/**
 * The visible address block (div.detail__address): its <span>s are the venue name (sometimes), the street
 * line(s) and "City, Texas ZIP". The first span is the venue name only when it is not a street or city line.
 * Returns { name, address } with nulls for what is not there; the block's own title div (the event title) is ignored.
 */
export function parseAddressBlock(html) {
  const m = /<div class="detail__address">([\s\S]*?)<\/div>/.exec(String(html || '').replace(/<div class="detail__address-title">[\s\S]*?<\/div>/, ''));
  if (!m) return { name: null, address: null };
  const spans = [...m[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((s) => htmlToText(s[1])).filter(Boolean);
  if (!spans.length) return { name: null, address: null };
  const named = !STREET_LINE.test(spans[0]) && !CITY_LINE.test(spans[0]);
  const lines = (named ? spans.slice(1) : spans).map(tidyAddress).filter(Boolean);
  const address = lines.join(', ').replace(/,\s*Texas\s+(\d{5})/i, ', TX $1').replace(/,\s*Texas$/i, ', TX');
  return { name: named ? spans[0] : null, address: address || null };
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

// Hosts that sell tickets: a "Website" link pointing there is the ticket link (config.ticketingWebsiteLink).
const TICKETING_HOST = /(^|\.)(prekindle|eventbrite|etix|ticketmaster|tix|showclix|universe)\.|ticket/i;
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/** Make a published href absolute: "www.example.com" (scheme dropped by the site) → "https://www.example.com"; "/x" → page-relative. */
export function absoluteUrl(href, pageUrl) {
  if (!href) return null;
  const h = decodeEntities(String(href).trim());
  if (/^https?:\/\//i.test(h)) return h.replace(/^https?:/i, (s) => s.toLowerCase()); // "HTTPS://…" as published on one page
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/|$)/i.test(h)) return `https://${h}`;
  try { return new URL(h, pageUrl).href; } catch { return h; }
}

/** "tag.class" → regex for the first such element's inner HTML (class matched as a whole token); a RegExp is used as given. */
function blockRe(sel) {
  if (sel instanceof RegExp) return sel;
  const m = /^([a-z][a-z0-9]*)\.([\w-]+)$/.exec(sel);
  if (!m) throw new Error(`Unsupported selector "${sel}" (use "tag.class" or a RegExp)`);
  return new RegExp(`<${m[1]}\\s+class="(?:[^"]*\\s)?${m[2]}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)<\\/${m[1]}>`);
}
/** Inner HTML of the first selector that matches, or null. */
function firstBlock(html, selectors) {
  for (const sel of selectors || []) {
    const m = blockRe(sel).exec(html);
    if (m) return m[1];
  }
  return null;
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

/**
 * Build a source module ({ SOURCE, parseSitemap, parseListing, parseDetail, itemsFromDetail, fetchSource })
 * for one Tempest-template site. See DESTINATION_BRYAN for the config keys.
 */
export function makeTempestSource(config) {
  const SOURCE = { id: config.id, name: config.name, homepage: config.homepage, sitemapUrl: config.sitemapUrl, method: config.method };
  const hostRe = config.host.replace(/\./g, '\\.');
  const EVENT_URL = new RegExp(`^https://${hostRe}/events/[a-z0-9-]+/$`);
  const CARD_URL = new RegExp(`href="(https://${hostRe}/events/[a-z0-9-]+/)"`);
  const NOT_EVENTS = new Set(config.notEvents || []);
  const STRONG = new Set((config.strongCategories || []).map((c) => c.toLowerCase()));
  const selectors = config.selectors || DESTINATION_BRYAN.selectors;

  /** Parse the event sitemap into [{url, lastmod}] (event pages only). */
  function parseSitemap(xml) {
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

  /** Parse listing HTML into cards: [{url, title, categories:Set, lat, lng, dateHeading}] */
  function parseListing(html) {
    const cards = [];
    const re = /<article\b[^>]*card--listing[\s\S]*?<\/article>/g;
    let m;
    while ((m = re.exec(html))) {
      const block = m[0];
      const url = (CARD_URL.exec(block) || [])[1];
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

  /** Parse an event page. Returns a "series" description or { skip: reason }. */
  function parseDetail(html, url) {
    let ld = null;
    for (const s of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const j = JSON.parse(s[1]);
        const ev = (j['@graph'] || [j]).find((n) => n['@type'] === 'Event');
        if (ev) { ld = ev; break; }
      } catch { /* ignore malformed blocks */ }
    }
    const mainTag = (/<main\b[^>]*>/.exec(html) || [])[0] || '';
    const title = htmlToText((/<h1 class="detail__heading">([\s\S]*?)<\/h1>/.exec(html) || [])[1] || '')
      || decodeEntities((/data-dms-partner-name="([^"]*)"/.exec(mainTag) || [])[1] || '') || ld?.name;
    if (!title) return { skip: 'no title' };
    if (ld?.eventStatus && /Cancelled|Postponed/i.test(ld.eventStatus)) return { skip: 'cancelled/postponed' };

    // The date/time block may carry a free-text note as a <p> ("Every Saturday rain or shine"); it is kept
    // as a note and never parsed as a date or time.
    const dateNotes = [];
    const dateHtml = (firstBlock(html, selectors.dateText) || '').replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => { const t = htmlToText(inner); if (t) dateNotes.push(t); return ' '; });
    const sub = htmlToText(dateHtml);
    const dates = parseDates(sub);
    const times = parseTimes(sub);
    if (!dates.length) return { skip: 'no date on page' };

    const admission = htmlToText(firstBlock(html, selectors.admission) || '').replace(/^:\s*/, '');
    let ticketUrl = absoluteUrl((/href="([^"]+)"[^>]*data-dms-event-detail-booking-click/.exec(html) || /data-dms-event-detail-booking-click[^>]*href="([^"]+)"/.exec(html) || [])[1], url);
    let websiteUrl = absoluteUrl((/href="([^"]+)"[^>]*data-dms-event-detail-website-click/.exec(html) || /<a\s+href="(https?:[^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?Website<\/a>/.exec(html) || [])[1], url);
    if (config.ticketingWebsiteLink && !ticketUrl && websiteUrl && TICKETING_HOST.test(hostOf(websiteUrl))) { ticketUrl = websiteUrl; websiteUrl = null; }
    const summaryHtml = firstBlock(html, selectors.summary) || '';
    const description = cleanDescription((htmlToText(summaryHtml) || ld?.description || '').replace(/^Overview\n/i, ''));
    const upcomingHtml = firstBlock(html, selectors.upcoming);
    const upcoming = upcomingHtml ? parseUpcoming(upcomingHtml, dates[0]) : [];

    const [lat, lng] = fixCoords(parseFloat((/data-marker-lat="([^"]*)"/.exec(html) || [])[1]), parseFloat((/data-marker-lng="([^"]*)"/.exec(html) || [])[1]));
    // 'main': the event's own category only — the page also lists the venue's directory categories ("Court Spaces").
    const catSource = config.categories === 'main' ? mainTag : html;
    const categories = [...new Set([...catSource.matchAll(/data-dms-category-name="([^"]*)"/g)].map((x) => decodeEntities(x[1])).filter(Boolean))];

    let location;
    if (config.location === 'address') {
      // The JSON-LD location on this template repeats the event title, so only the visible address block counts.
      const block = parseAddressBlock(html);
      location = { name: block.name || venueFromTitle(title) || venueFromDescription(description), address: block.address };
    } else {
      const addr = ld?.location?.address || {};
      const address = [tidyAddress(addr.streetAddress), [addr.addressLocality, addr.addressRegion === 'Texas' ? 'TX' : addr.addressRegion].filter(Boolean).join(', '), addr.postalCode]
        .filter(Boolean).join(', ').replace(/, (\d{5})$/, ' $1');
      // The site sometimes publishes an address with no venue name; the title ("… at The Hilton Garden Inn")
      // or the description ("Located in Midtown Park, …") then names it.
      location = { name: ld?.location?.name ? decodeEntities(ld.location.name) : venueFromTitle(title) || venueFromDescription(description), address: address || null };
    }

    return {
      url,
      title,
      description,
      dates,
      times,
      dateNote: dateNotes.length ? dateNotes.join(' · ') : null,
      upcoming,
      admission,
      ticketUrl: ticketUrl || null,
      websiteUrl: websiteUrl || null,
      links: extractLinks(summaryHtml),
      location,
      lat,
      lng,
      categories,
    };
  }

  /** Expand a parsed detail page into occurrence items inside [fromMs, toMs]. */
  function itemsFromDetail(d, card, { fromMs, toMs, fetchedAt }) {
    const [t1, t2] = d.times;
    const mk = (day, t) => chicagoToUtc(day.y, day.m, day.d, t.hh, t.mm);
    const key = (x) => keyFromYmd(x.y, x.m, x.d);
    const categories = [...new Set([...(card?.categories || []), ...(d.categories || [])])];
    const strongTags = categories.filter((c) => STRONG.has(c.toLowerCase()));
    const weakTags = categories.filter((c) => !STRONG.has(c.toLowerCase()));
    const description = cleanDescription(d.description || '');
    let cost = costFromText(d.admission);
    if (cost.status === 'unknown' && !String(d.admission || '').trim()) {
      if (config.freeCategory && categories.some((c) => c.toLowerCase() === config.freeCategory.toLowerCase())) {
        // No admission line, but the site files the event under its "Free Events" category.
        cost = { status: 'free', label: `Free (listed under ${config.freeCategory})`, min: 0 };
      } else if (/\$\d/.test(description)) {
        // No admission line, but the description itself prices the activity ("Walk-On GellyBall for $30 per person").
        cost = { status: 'paid', label: `Price in description: ${priceSentence(description)}`, min: null };
      }
    }
    const base = {
      seriesId: `${config.id}:${slug(d.url.split('/events/')[1] || d.title)}`,
      title: d.title,
      description: truncate(description, 600),
      summary: truncate(description.replace(/\n/g, ' '), 200),
      location: { ...(d.location || {}), lat: card?.lat ?? d.lat ?? null, lng: card?.lng ?? d.lng ?? null },
      cost,
      registration: registrationFrom({ description, links: d.links, ticketUrl: d.ticketUrl }),
      types: classify({ tags: strongTags, weakTags, title: d.title, description }),
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
    const dateNote = d.dateNote || null; // "Every Saturday rain or shine": shown with the time on every date
    const withNote = (note) => [note, dateNote].filter(Boolean).join(' · ') || null;

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
        timeNote: withNote(`${hoursText} (as published; confirm with the venue)`),
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
        timeNote: withNote(`Open ${openDaysText(days)} through ${last.m}/${last.d}. ${hoursText} (as published; confirm with the venue)`),
        runStart: key(first), runEnd: key(last), occurrenceCount: days.length,
      });
      return items;
    }
    const kind = days.length >= 2 ? 'recurring' : 'one-time';
    const dowNote = weekdayNote([dateNote, description].filter(Boolean).join('\n'), days); // "every Thursday" in the text vs Wednesdays in the list
    for (const day of days) {
      const [s, e, extra] = span(day);
      const notes = extra.timeNote ? [extra.timeNote] : [];
      const isFirst = key(day) === key(d.dates[0]);
      if (kind === 'recurring' && !isFirst && t1) notes.push('Time copied from the series listing — confirm for this date');
      if (dowNote) notes.push(dowNote);
      if (dateNote) notes.push(dateNote);
      push(s, e, { kind, ...extra, timeNote: notes.length ? notes.join(' · ') : null });
    }
    return items;
  }

  /** Discover event URLs: sitemap first (complete, one request), listing pages as a fallback where the site has them. */
  async function discover({ fetchText, maxListingPages, stats }) {
    const cardsByUrl = new Map();
    let entries = null;
    try {
      // The sitemap is usually instant but occasionally stalls (cold cache); give it longer and one more try.
      entries = parseSitemap(await fetchText(SOURCE.sitemapUrl, { tries: 3, timeoutMs: 90_000 }));
    } catch (e) {
      if (!config.listingFallback) throw new Error(`Event sitemap unavailable (${e.message}) — this site has no server-rendered listing to fall back on`);
      stats.notes.push(`Sitemap unavailable (${e.message}) — falling back to listing pages`);
    }
    if (entries) {
      stats.sitemapUrls = entries.length;
      if (entries.length >= config.minSitemapUrls) {
        for (const e of entries) cardsByUrl.set(e.url, { url: e.url, lastmod: e.lastmod, categories: new Set(), lat: null, lng: null });
        stats.discovery = 'sitemap';
        return cardsByUrl;
      }
      if (!config.listingFallback) throw new Error(`Event sitemap listed only ${entries.length} event pages (at least ${config.minSitemapUrls} expected — the site layout may have changed)`);
      stats.notes.push(`Sitemap listed only ${entries.length} event URLs — falling back to listing pages`);
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

  // These hosts serialise requests: 3 concurrent fetches tripled latency and caused timeouts, so 1 at a time.
  async function fetchSource({ fetchText, mapLimit, fromMs, toMs, concurrency = 1, maxListingPages = 8, maxDetailPages = 400, log = () => {} }) {
    const fetchedAt = new Date().toISOString();
    const stats = { discovery: null, sitemapUrls: 0, detailPages: 0, failedPages: 0, skipped: {}, notes: [] };
    const cardsByUrl = await discover({ fetchText, maxListingPages, log, stats });
    let cards = [...cardsByUrl.values()];
    const cap = Math.min(maxDetailPages, config.maxDetailPages ?? Infinity);
    if (cards.length > cap) { stats.notes.push(`Stopped after ${cap} of ${cards.length} event pages`); cards = cards.slice(0, cap); }
    stats.discovered = cards.length;

    const results = await mapLimit(cards, Math.min(concurrency, config.maxConcurrency ?? Infinity), async (card) => {
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
    // Pages that load but show no title or no date mean the template changed, not that the events ended.
    const unparsed = (stats.skipped['no title'] || 0) + (stats.skipped['no date on page'] || 0);
    if (stats.detailPages && unparsed > stats.detailPages / 2) {
      throw new Error(`${unparsed} of ${stats.detailPages} event pages had no title or date (layout may have changed)`);
    }
    stats.items = items.length;
    return { items, stats, fetchedAt };
  }

  return { SOURCE, config, parseSitemap, parseListing, parseDetail, itemsFromDetail, fetchSource };
}

const bryan = makeTempestSource(DESTINATION_BRYAN);
export const SOURCE = bryan.SOURCE;
export const { parseSitemap, parseListing, parseDetail, itemsFromDetail, fetchSource } = bryan;
