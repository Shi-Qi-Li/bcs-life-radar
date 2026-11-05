// Visit College Station adapter (scripts/sources/visitcs.mjs): the shared Tempest parser driven by the Visit CS
// config. Fixtures under tests/fixtures/visitcs-* are trimmed copies of real pages (content verbatim, saved
// 2026-11-05), so every expected string below is what the site published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCE, CONFIG, parseSitemap, parseDetail, itemsFromDetail, fetchSource } from '../scripts/sources/visitcs.mjs';
import * as bryan from '../scripts/sources/destinationBryan.mjs';
import { parseAddressBlock, absoluteUrl, DESTINATION_BRYAN } from '../scripts/sources/destinationBryan.mjs';
import { mapLimit } from '../scripts/refresh.mjs';
import { startOfDay, formatDateTime } from '../public/js/shared/time.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const url = (slug) => `https://visit.cstx.gov/events/${slug}/`;
const page = (name, slug) => parseDetail(fx(name), url(slug));
const WIN = { fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2027-01-31'), fetchedAt: '2026-11-05T12:00:00.000Z' };
const items = (name, slug, win = WIN) => itemsFromDetail(page(name, slug), null, win);
const iso = (ms) => new Date(ms).toISOString();

test('SOURCE record and config: sitemap-only discovery, one request at a time', () => {
  assert.deepEqual(SOURCE, {
    id: 'visitcs',
    name: 'Visit College Station',
    homepage: 'https://visit.cstx.gov/events/',
    sitemapUrl: 'https://visit.cstx.gov/sitemaps-1-event-default-1-sitemap.xml',
    method: 'Public event sitemap for discovery, then every event page (HTML). No feed; the listing widget needs a key and is not used.',
  });
  assert.equal(CONFIG.maxConcurrency, 1);
  assert.equal(CONFIG.listingFallback, false);
  assert.equal(CONFIG.minSitemapUrls, 10);
  // The Destination Bryan module is unchanged: same id, and its sitemap parser ignores Visit CS URLs.
  assert.equal(bryan.SOURCE.id, 'dbryan');
  assert.equal(DESTINATION_BRYAN.id, 'dbryan');
  assert.deepEqual(bryan.parseSitemap('<urlset><url><loc>https://visit.cstx.gov/events/x/</loc></url></urlset>'), []);
});

test('sitemap: real entries keep url + lastmod; other hosts and the submit-event page are excluded', () => {
  const entries = parseSitemap(fx('visitcs-sitemap.xml'));
  assert.equal(entries.length, 12);
  for (const e of entries) {
    assert.match(e.url, /^https:\/\/visit\.cstx\.gov\/events\/[a-z0-9-]+\/$/);
    assert.match(e.lastmod, /^2026-1[01]-\d\dT\d\d:\d\d:\d\d-0[56]:00$/);
  }
  assert.ok(entries.some((e) => e.url === 'https://visit.cstx.gov/events/aggieland-farmers-market/'));
  const other = `<urlset>
    <url><loc>https://visit.cstx.gov/events/submit-event/</loc></url>
    <url><loc>https://www.destinationbryan.com/events/first-friday/</loc></url>
    <url><loc>https://visit.cstx.gov/things-to-do/parks/</loc></url>
    <url><loc>https://visit.cstx.gov/events/</loc></url>
  </urlset>`;
  assert.deepEqual(parseSitemap(other), []);
});

test('timed one-off (William Beckmann): date text from div.detail__dates-heading, Admission from the h3 block, address spans, ticketing website link', () => {
  const d = page('visitcs-william-beckmann.html', 'william-beckmann');
  assert.equal(d.title, 'William Beckmann');
  assert.deepEqual(d.dates, [{ y: 2026, m: 11, d: 5 }]);
  assert.deepEqual(d.times, [{ hh: 21, mm: 0 }, { hh: 23, mm: 0 }]);
  assert.equal(d.dateNote, null);
  assert.equal(d.admission, '$18.00 General Admission in advance $20.00 General Admission day of show');
  // "Go To Website" points at prekindle (a ticketing host) → it is the ticket link, and there is no separate website.
  assert.equal(d.ticketUrl, 'https://www.prekindle.com/event/59377-william-beckmann-college-station');
  assert.equal(d.websiteUrl, null);
  // Venue from the first address span; the JSON-LD location (which says "William Beckmann") is never used.
  assert.deepEqual(d.location, { name: "Harry's Northgate", address: '217 University Dr, College Station, TX 77840' });
  assert.equal(d.lat, 30.617147);
  assert.equal(d.lng, -96.3473137);
  assert.deepEqual(d.categories, ['Live Music']);
  assert.match(d.description, /^William Beckmann takes the stage at Harry’s Northgate on Thursday, November 5\./);
  assert.doesNotMatch(d.description, /^Overview/, 'the "Overview" heading is not part of the description');

  const its = items('visitcs-william-beckmann.html', 'william-beckmann');
  assert.equal(its.length, 1);
  const [it] = its;
  assert.equal(it.kind, 'one-time');
  assert.equal(formatDateTime(Date.parse(it.start)), 'Nov 5, 9:00 PM CST');
  assert.equal(formatDateTime(Date.parse(it.end)), 'Nov 5, 11:00 PM CST');
  assert.equal(it.allDay, false);
  assert.equal(it.endKnown, true);
  assert.equal(it.timeNote, null);
  assert.deepEqual(it.cost, { status: 'paid', label: '$18.00 General Admission in advance $20.00 General Admission day of show', min: 18 });
  assert.deepEqual(it.registration, { status: 'tickets', label: 'Ticket/booking link provided — see source', url: 'https://www.prekindle.com/event/59377-william-beckmann-college-station' });
  assert.ok(it.types.includes('shows'), `types ${it.types}`);
  assert.deepEqual(it.sourceTags, ['Live Music']);
  assert.deepEqual(it.location, { name: "Harry's Northgate", address: '217 University Dr, College Station, TX 77840', lat: 30.617147, lng: -96.3473137 });
  assert.equal(it.websiteUrl, null);
  assert.equal(it.contact, null);
  assert.equal(it.sourceId, 'visitcs');
  assert.equal(it.sourceName, 'Visit College Station');
  assert.equal(it.sourceUrl, 'https://visit.cstx.gov/events/william-beckmann/');
  assert.equal(it.seriesId, 'visitcs:william-beckmann');
  assert.equal(it.id, `visitcs:william-beckmann@${Date.parse(it.start)}`);
  assert.equal(it.lastVerified, WIN.fetchedAt);
});

test('recurring farmers market: the "Every Saturday" <p> note is kept as a note (never parsed); Upcoming Dates expand with the series time', () => {
  const d = page('visitcs-aggieland-farmers-market.html', 'aggieland-farmers-market');
  assert.deepEqual(d.dates, [{ y: 2026, m: 11, d: 7 }]);
  assert.deepEqual(d.times, [{ hh: 9, mm: 0 }, { hh: 13, mm: 0 }], 'the note added no time');
  assert.equal(d.dateNote, 'Every Saturday rain or shine');
  assert.equal(d.upcoming.length, 8);
  assert.deepEqual(d.upcoming[0], { y: 2026, m: 11, d: 7 });
  assert.deepEqual(d.upcoming[7], { y: 2026, m: 12, d: 26 });
  assert.ok(d.upcoming.every((x) => x.y === 2026), 'November → December needs no year rollover');
  assert.equal(d.admission, 'Free');
  assert.deepEqual(d.categories, ['Family Friendly']);
  assert.deepEqual(d.location, { name: 'Aggieland Farmers Market', address: '1500 Harvey Rd, College Station, TX 77840' });
  assert.equal(d.websiteUrl, 'https://aggielandfarmersmarket.com/', 'not a ticketing host → organizer website');
  assert.equal(d.ticketUrl, null);

  const its = items('visitcs-aggieland-farmers-market.html', 'aggieland-farmers-market');
  assert.equal(its.length, 8);
  assert.ok(its.every((i) => i.kind === 'recurring'));
  assert.equal(formatDateTime(Date.parse(its[0].start)), 'Nov 7, 9:00 AM CST');
  assert.equal(formatDateTime(Date.parse(its[0].end)), 'Nov 7, 1:00 PM CST');
  assert.equal(its[0].timeNote, 'Every Saturday rain or shine');
  assert.equal(its[1].timeNote, 'Time copied from the series listing — confirm for this date · Every Saturday rain or shine');
  assert.equal(its[7].start.slice(0, 10), '2026-12-26');
  // The JSON-LD startDate is the series' first occurrence (2026-01-24); nothing is published for it.
  assert.ok(its.every((i) => i.start >= '2026-11-07'));
  assert.deepEqual(its[0].cost, { status: 'free', label: 'Free', min: 0 });
  assert.deepEqual(its[0].registration, { status: 'unknown', label: 'Registration requirements not listed', url: null });
  assert.ok(its[0].types.includes('markets') && its[0].types.includes('family'), `types ${its[0].types}`);
  assert.equal(its[0].seriesId, 'visitcs:aggieland-farmers-market');
});

test('Upcoming Dates roll the year forward when the month decreases (December → January)', () => {
  // Derived case: the real list ends on December 26; two January Saturdays are appended in the site's own format.
  const html = fx('visitcs-aggieland-farmers-market.html').replace(/<\/ul>/, '<li>Saturday, January 2</li>\n<li>Saturday, January 9</li>\n</ul>');
  const d = parseDetail(html, url('aggieland-farmers-market'));
  assert.deepEqual(d.upcoming.slice(-3), [{ y: 2026, m: 12, d: 26 }, { y: 2027, m: 1, d: 2 }, { y: 2027, m: 1, d: 9 }]);
  const its = itemsFromDetail(d, null, WIN);
  assert.equal(its.length, 10);
  assert.equal(formatDateTime(Date.parse(its[9].start)), 'Jan 9, 9:00 AM CST');
  assert.equal(its[9].id, `visitcs:aggieland-farmers-market@${Date.parse(its[9].start)}`);
});

test('no-time game: all-day with "No time listed by source"; no Admission → cost not listed; category from <main> only; first map marker', () => {
  const html = fx('visitcs-basketball-northern-kentucky.html');
  assert.match(html, /data-dms-category-name="Court Spaces"/, 'the page also carries the venue listing\'s category');
  assert.match(html, /data-marker-lat="30\.605873"/, 'and the venue listing\'s own marker');
  const d = parseDetail(html, url('texas-a-m-basketball-vs-northern-kentucky'));
  assert.equal(d.title, 'Texas A&M Basketball vs. Northern Kentucky');
  assert.deepEqual(d.dates, [{ y: 2026, m: 11, d: 6 }]);
  assert.deepEqual(d.times, []);
  assert.equal(d.admission, '');
  assert.deepEqual(d.categories, ['Texas A&M Sports']);
  assert.equal(d.lat, 30.6059412);
  assert.equal(d.lng, -96.3462161);
  assert.deepEqual(d.location, { name: 'Reed Arena', address: '730 Olsen Blvd, College Station, TX 77843' });
  assert.equal(d.websiteUrl, 'https://12thman.com/sports/mens-basketball/schedule');
  assert.equal(d.ticketUrl, null);

  const [it, ...rest] = items('visitcs-basketball-northern-kentucky.html', 'texas-a-m-basketball-vs-northern-kentucky');
  assert.equal(rest.length, 0);
  assert.equal(it.kind, 'one-time');
  assert.equal(it.allDay, true);
  assert.equal(it.endKnown, false);
  assert.equal(it.start, iso(startOfDay('2026-11-06')));
  assert.equal(it.end, iso(startOfDay('2026-11-06', 1)));
  assert.equal(it.timeNote, 'No time listed by source');
  assert.deepEqual(it.cost, { status: 'unknown', label: 'Cost not listed', min: null });
  assert.deepEqual(it.registration, { status: 'unknown', label: 'Registration requirements not listed', url: null });
  assert.equal(it.websiteUrl, 'https://12thman.com/sports/mens-basketball/schedule');
  assert.ok(it.types.includes('fitness'), `"Texas A&M Sports" is a strong tag: ${it.types}`);
  assert.deepEqual(it.sourceTags, ['Texas A&M Sports']);
});

test('multi-day run "November 13, 2026 to January 3, 2027": one item; "Ticket prices vary" is not a price; scheme-less Buy Tickets href made absolute', () => {
  const d = page('visitcs-santas-wonderland.html', 'santas-wonderland1-2');
  assert.equal(d.title, "Santa's Wonderland");
  assert.deepEqual(d.dates, [{ y: 2026, m: 11, d: 13 }, { y: 2027, m: 1, d: 3 }]);
  assert.deepEqual(d.times, []);
  assert.equal(d.admission, 'Ticket prices vary');
  assert.match(fx('visitcs-santas-wonderland.html'), /href="www\.santas-wonderland\.com"/, 'the site dropped the scheme');
  assert.equal(d.ticketUrl, 'https://www.santas-wonderland.com');
  assert.equal(d.websiteUrl, 'https://www.santas-wonderland.com');
  assert.deepEqual(d.location, { name: "Santa's Wonderland", address: '18898 Hwy 6, College Station, TX 77845' });
  assert.deepEqual(d.categories, ['Holiday']);

  const its = items('visitcs-santas-wonderland.html', 'santas-wonderland1-2');
  assert.equal(its.length, 1);
  const [it] = its;
  assert.equal(it.kind, 'multi-day');
  assert.equal(it.runStart, '2026-11-13');
  assert.equal(it.runEnd, '2027-01-03');
  assert.equal(it.start, iso(startOfDay('2026-11-13')));
  assert.equal(it.end, iso(startOfDay('2027-01-03', 1)));
  assert.equal(it.allDay, true);
  assert.equal(it.endKnown, true);
  assert.equal(it.timeNote, 'Daily hours not listed (as published; confirm with the venue)');
  assert.deepEqual(it.cost, { status: 'unknown', label: 'Ticket prices vary (price not stated)', min: null });
  assert.deepEqual(it.registration, { status: 'tickets', label: 'Ticket/booking link provided — see source', url: 'https://www.santas-wonderland.com' });
  assert.ok(it.types.includes('community'), `"Holiday" is a strong tag: ${it.types}`);
});

test('Admission variants: text wins over the "Free Events" category; the category alone gives a labelled free cost', () => {
  const d = page('visitcs-december-vendor-market.html', 'december-vendor-market');
  assert.deepEqual(d.categories, ['Free Events']);
  assert.equal(d.admission, 'Free');
  assert.equal(d.ticketUrl, 'https://www.facebook.com/share/1Fzqkxwhbj/', '"Buy Tickets" booking link, as published');
  assert.deepEqual(d.location, { name: 'Hotel McCoy College Station', address: '3702 Highway 6 South, College Station, TX 77840' });
  const win = { ...WIN, toMs: startOfDay('2027-01-31') };
  const [it] = itemsFromDetail(d, null, win);
  assert.equal(formatDateTime(Date.parse(it.start)), 'Dec 11, 6:00 PM CST');
  assert.deepEqual(it.cost, { status: 'free', label: 'Free', min: 0 });
  assert.equal(it.registration.status, 'tickets');
  assert.ok(it.types.includes('markets'), `types ${it.types}`);
  // Same page without its Admission text: the category is the only statement, and the label says so.
  const [noText] = itemsFromDetail({ ...d, admission: '' }, null, win);
  assert.deepEqual(noText.cost, { status: 'free', label: 'Free (listed under Free Events)', min: 0 });
  // A different category without Admission text stays unknown (no guessing).
  const [other] = itemsFromDetail({ ...d, admission: '', categories: ['Markets'] }, null, win);
  assert.deepEqual(other.cost, { status: 'unknown', label: 'Cost not listed', min: null });
  // An Admission line that is not a price is labelled as such.
  const [vary] = itemsFromDetail({ ...d, admission: 'Ticket prices vary' }, null, win);
  assert.deepEqual(vary.cost, { status: 'unknown', label: 'Ticket prices vary (price not stated)', min: null });
});

test('website vs ticket link: the "Go To Website" link is the ticket link only for ticketing hosts; a Buy Tickets link always wins', () => {
  const beckmann = fx('visitcs-william-beckmann.html');
  const prekindle = 'https://www.prekindle.com/event/59377-william-beckmann-college-station';
  const withSite = (href) => parseDetail(beckmann.replace(prekindle, href), url('william-beckmann'));
  for (const host of ['www.eventbrite.com', 'www.etix.com', 'www.ticketmaster.com', 'www.showclix.com', 'www.universe.com', 'tix.com', 'www.prekindle.com']) {
    const d = withSite(`https://${host}/x`);
    assert.equal(d.ticketUrl, `https://${host}/x`, host);
    assert.equal(d.websiteUrl, null, host);
  }
  for (const host of ['12thman.com', 'www.facebook.com', 'www.harrysnorthgate.com', 'matrix.example']) {
    const d = withSite(`https://${host}/x`);
    assert.equal(d.ticketUrl, null, host);
    assert.equal(d.websiteUrl, `https://${host}/x`, host);
    const [it] = itemsFromDetail(d, null, WIN);
    assert.equal(it.registration.status, 'unknown', host);
    assert.equal(it.websiteUrl, `https://${host}/x`);
  }
  // A Buy Tickets (booking) link is the ticket link even when the website is a ticketing host.
  const both = parseDetail(beckmann.replace('<main ', '<a class="btn" href="https://boxoffice.example/show" data-dms-event-detail-booking-click>Buy Tickets</a><main '), url('william-beckmann'));
  assert.equal(both.ticketUrl, 'https://boxoffice.example/show');
  assert.equal(both.websiteUrl, prekindle);
  // Published hrefs are tidied, never invented: scheme-less and upper-case schemes, entities, page-relative paths.
  assert.equal(absoluteUrl('www.santas-wonderland.com', url('x')), 'https://www.santas-wonderland.com');
  assert.equal(absoluteUrl('HTTPS://www.therangecollegestation.com', url('x')), 'https://www.therangecollegestation.com');
  assert.equal(absoluteUrl('https://a.example/t?x=1&amp;y=2', url('x')), 'https://a.example/t?x=1&y=2');
  assert.equal(absoluteUrl('/events/other/', url('x')), 'https://visit.cstx.gov/events/other/');
  assert.equal(absoluteUrl('', url('x')), null);
  assert.equal(absoluteUrl(undefined, url('x')), null);
});

test('parseAddressBlock: the first span is the venue only when it is not a street or city line', () => {
  assert.deepEqual(parseAddressBlock(fx('visitcs-william-beckmann.html')), { name: "Harry's Northgate", address: '217 University Dr, College Station, TX 77840' });
  const block = (spans) => `<div class="detail__address"><div class="detail__address-title"> Some Event</div>\n${spans.map((s) => `<span>${s}</span>`).join('\n')}</div>`;
  assert.deepEqual(parseAddressBlock(block(['217 University Dr', 'College Station, Texas 77840'])), { name: null, address: '217 University Dr, College Station, TX 77840' });
  assert.deepEqual(parseAddressBlock(block(['College Station, Texas 77840'])), { name: null, address: 'College Station, TX 77840' });
  assert.deepEqual(parseAddressBlock(block(['P.O. Box 12', 'Bryan, TX 77805'])), { name: null, address: 'P.O. Box 12, Bryan, TX 77805' });
  assert.deepEqual(parseAddressBlock(block(['Kyle Field', 'College Station, Texas 77840'])), { name: 'Kyle Field', address: 'College Station, TX 77840' });
  assert.deepEqual(parseAddressBlock(block(['Rudder Complex', '401 Joe Routt Blvd Suite 205', 'College Station, Texas 77843'])), { name: 'Rudder Complex', address: '401 Joe Routt Blvd Suite 205, College Station, TX 77843' });
  assert.deepEqual(parseAddressBlock(block([])), { name: null, address: null });
  assert.deepEqual(parseAddressBlock('<main></main>'), { name: null, address: null });
  // The event title in the block's own title div is never mistaken for a venue.
  assert.equal(parseAddressBlock(block(['730 Olsen Blvd'])).name, null);
});

const SITEMAP = fx('visitcs-sitemap.xml');
const SITEMAP_URLS = parseSitemap(SITEMAP).map((e) => e.url);
function fakeFetch({ sitemap = SITEMAP, page = fx('visitcs-william-beckmann.html'), fail = new Set(), sitemapFails = false, log = [] } = {}) {
  return async (u) => {
    log.push(u);
    if (u.endsWith('sitemap.xml')) { if (sitemapFails) throw new Error('HTTP 503'); return sitemap; }
    if (fail.has(u)) throw new Error('timeout');
    return typeof page === 'function' ? page(u) : page;
  };
}
const FWIN = { fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-12-06') };

test('fetchSource: sitemap discovery, every page read one at a time even when the context allows more', async () => {
  const log = [];
  let inFlight = 0, maxInFlight = 0;
  const fetchText = async (u) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight--;
    return fakeFetch({ log })(u);
  };
  const { items: its, stats, fetchedAt } = await fetchSource({ fetchText, mapLimit, ...FWIN, concurrency: 3 });
  assert.equal(stats.discovery, 'sitemap');
  assert.equal(stats.sitemapUrls, 12);
  assert.equal(stats.discovered, 12);
  assert.equal(stats.detailPages, 12);
  assert.equal(stats.failedPages, 0);
  assert.equal(maxInFlight, 1, 'pinned to one request at a time');
  assert.equal(its.length, 12, 'each fixture page yields one item in the window');
  assert.equal(stats.items, 12);
  assert.ok(its.every((i) => i.sourceId === 'visitcs' && i.sourceUrl.startsWith('https://visit.cstx.gov/events/')));
  assert.ok(!log.some((u) => u.includes('?page=')), 'the Algolia-backed listing is never requested');
  assert.deepEqual(log.slice(1), SITEMAP_URLS);
  assert.ok(Date.parse(fetchedAt) > 0);
});

test('fetchSource fails loudly: tiny sitemap, missing sitemap, mostly failed pages, mostly unparsable pages', async () => {
  const urls = SITEMAP.match(/<url>[\s\S]*?<\/url>/g);
  const tiny = `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls.slice(0, 3).join('')}</urlset>`;
  let log = [];
  await assert.rejects(() => fetchSource({ fetchText: fakeFetch({ sitemap: tiny, log }), mapLimit, ...FWIN }), /listed only 3 event pages \(at least 10 expected/);
  assert.equal(log.length, 1, 'no event page or listing page is requested after a tiny sitemap');

  log = [];
  await assert.rejects(() => fetchSource({ fetchText: fakeFetch({ sitemapFails: true, log }), mapLimit, ...FWIN }), /Event sitemap unavailable \(HTTP 503\)/);
  assert.equal(log.length, 1, 'no listing fallback');

  const most = new Set(SITEMAP_URLS.slice(0, 7));
  await assert.rejects(() => fetchSource({ fetchText: fakeFetch({ fail: most }), mapLimit, ...FWIN }), /7 of 12 event pages could not be read/);
  // A few failures are tolerated and logged.
  const some = new Set(SITEMAP_URLS.slice(0, 2));
  const r = await fetchSource({ fetchText: fakeFetch({ fail: some }), mapLimit, ...FWIN });
  assert.equal(r.stats.failedPages, 2);
  assert.equal(r.stats.detailPages, 10);
  assert.equal(r.items.length, 10);
  assert.ok(r.stats.notes.some((n) => n.includes('timeout')));

  // Pages that load but have no date block (template changed) are not "ended" events.
  const noDates = fx('visitcs-william-beckmann.html').replace(/<div class="detail__dates-heading">[\s\S]*?<\/div>/, '');
  await assert.rejects(() => fetchSource({ fetchText: fakeFetch({ page: noDates }), mapLimit, ...FWIN }), /12 of 12 event pages had no title or date \(layout may have changed\)/);
});

test('fetchSource: detail-page cap, ended pages and far-future pages are counted, not published', async () => {
  const r = await fetchSource({ fetchText: fakeFetch(), mapLimit, ...FWIN, maxDetailPages: 5 });
  assert.equal(r.stats.detailPages, 5);
  assert.ok(r.stats.notes.includes('Stopped after 5 of 12 event pages'));
  // Window after the event: the page is served like a live one, so "every listed date is in the past" is the signal.
  const past = await fetchSource({ fetchText: fakeFetch(), mapLimit, fromMs: startOfDay('2026-12-01'), toMs: startOfDay('2026-12-31') });
  assert.equal(past.items.length, 0);
  assert.equal(past.stats.skipped['ended (every listed date is in the past)'], 12);
  const future = await fetchSource({ fetchText: fakeFetch(), mapLimit, fromMs: startOfDay('2026-10-01'), toMs: startOfDay('2026-10-31') });
  assert.equal(future.stats.skipped['no dates in window (far future)'], 12);
});

test('Visit CS items have exactly the Destination Bryan item shape', () => {
  const keys = (it) => Object.keys(it).sort();
  const [cs] = items('visitcs-william-beckmann.html', 'william-beckmann');
  const [db] = bryan.itemsFromDetail(bryan.parseDetail(fx('bryan-farmers-market.html'), 'https://www.destinationbryan.com/events/the-farmers-market-in-brazos-county/'), null, WIN);
  assert.deepEqual(keys(cs), keys(db));
  assert.deepEqual(keys(cs), ['allDay', 'contact', 'cost', 'description', 'end', 'endKnown', 'id', 'kind', 'lastVerified', 'location', 'registration', 'seriesId',
    'sourceId', 'sourceName', 'sourceTags', 'sourceUrl', 'start', 'summary', 'timeNote', 'title', 'types', 'websiteUrl']);
  assert.deepEqual(Object.keys(cs.location).sort(), ['address', 'lat', 'lng', 'name']);
  assert.deepEqual(Object.keys(cs.cost).sort(), ['label', 'min', 'status']);
  assert.deepEqual(Object.keys(cs.registration).sort(), ['label', 'status', 'url']);
  // Multi-day items carry the same extra keys on both sites (a Bryan run built from a detail object, as the Bryan tests do).
  const [csRun] = items('visitcs-santas-wonderland.html', 'santas-wonderland1-2');
  const [dbRun] = bryan.itemsFromDetail({
    url: 'https://www.destinationbryan.com/events/x/', title: 'X', description: '', dates: [{ y: 2026, m: 11, d: 13 }, { y: 2027, m: 1, d: 3 }], times: [], upcoming: [],
    admission: '', ticketUrl: null, websiteUrl: null, links: [], location: { name: 'V', address: '1 Main St, Bryan, TX 77803' }, lat: 30.6, lng: -96.3, categories: [],
  }, null, WIN);
  assert.equal(dbRun.kind, 'multi-day');
  assert.deepEqual(keys(csRun), keys(dbRun));
  assert.deepEqual(keys(csRun), [...keys(cs), 'runEnd', 'runStart'].sort());
});
