import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSitemap, fetchSource, parseDetail } from '../scripts/sources/destinationBryan.mjs';
import { mapLimit } from '../scripts/refresh.mjs';
import { startOfDay } from '../public/js/shared/time.js';

const detailHtml = readFileSync(new URL('./fixtures/bryan-detail.html', import.meta.url), 'utf8');
const SITEMAP = `<?xml version="1.0"?><urlset>
<url><loc>https://www.destinationbryan.com/events/demo-open-mic/</loc><lastmod>2026-10-01T10:00:00-05:00</lastmod></url>
<url><loc>https://www.destinationbryan.com/events/annual/</loc></url>
<url><loc>https://www.destinationbryan.com/events/second-event/</loc><lastmod>2026-11-02T10:00:00-06:00</lastmod></url>
<url><loc>https://www.destinationbryan.com/things-to-do/not-an-event/</loc></url>
</urlset>`;
const window = { fromMs: startOfDay('2026-12-01'), toMs: startOfDay('2027-02-01') };

test('sitemap parsing keeps only event pages and their lastmod', () => {
  const entries = parseSitemap(SITEMAP);
  assert.deepEqual(entries, [
    { url: 'https://www.destinationbryan.com/events/demo-open-mic/', lastmod: '2026-10-01T10:00:00-05:00' },
    { url: 'https://www.destinationbryan.com/events/second-event/', lastmod: '2026-11-02T10:00:00-06:00' },
  ]);
});

test('detail page supplies coordinates and category when no listing card is available', () => {
  const html = detailHtml.replace('<body>', '<body><button data-marker-lat="30.5" data-marker-lng="-96.3" data-dms-category-name="Live Music"></button>');
  const d = parseDetail(html, 'https://www.destinationbryan.com/events/demo-open-mic/');
  assert.equal(d.lat, 30.5);
  assert.equal(d.lng, -96.3);
  assert.deepEqual(d.categories, ['Live Music']);
});

function fakeFetch({ sitemap = SITEMAP, fail = new Set(), sitemapFails = false, log = [] } = {}) {
  return async (url) => {
    log.push(url);
    if (url.endsWith('sitemap.xml')) { if (sitemapFails) throw new Error('HTTP 503'); return sitemap; }
    if (fail.has(url)) throw new Error('timeout');
    if (url.includes('/events/?page=')) return readFileSync(new URL('./fixtures/bryan-listing.html', import.meta.url), 'utf8');
    return detailHtml;
  };
}

test('sitemap discovery reads every event page, under the concurrency limit', async () => {
  const log = [];
  // 25 URLs so the sitemap is trusted (>= 20).
  const sitemap = `<urlset>${Array.from({ length: 25 }, (_, i) => `<url><loc>https://www.destinationbryan.com/events/ev-${i}/</loc><lastmod>2026-11-01</lastmod></url>`).join('')}</urlset>`;
  let inFlight = 0, maxInFlight = 0;
  const fetchText = async (url) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return fakeFetch({ sitemap, log })(url);
  };
  const { items, stats } = await fetchSource({ fetchText, mapLimit, ...window, concurrency: 3 });
  assert.equal(stats.discovery, 'sitemap');
  assert.equal(stats.detailPages, 25);
  assert.ok(maxInFlight <= 3 && maxInFlight >= 2, `max in flight ${maxInFlight}`);
  assert.equal(items.length, 25 * 3); // each fixture page yields 3 dates
  assert.ok(!log.some((u) => u.includes('?page=')), 'listing pages not needed');
});

test('falls back to listing pages when the sitemap is unavailable, and says coverage is partial', async () => {
  const log = [];
  const { stats } = await fetchSource({ fetchText: fakeFetch({ sitemapFails: true, log }), mapLimit, ...window, maxListingPages: 2 });
  assert.equal(stats.discovery, 'listing');
  assert.ok(stats.notes.some((n) => /Sitemap unavailable/.test(n)));
  assert.ok(stats.notes.some((n) => /coverage is partial/.test(n)));
  assert.equal(log.filter((u) => u.includes('?page=')).length, 2);
});

test('a few failed pages are tolerated and logged; mostly-failed refresh keeps last good data', async () => {
  const sitemap = `<urlset>${Array.from({ length: 20 }, (_, i) => `<url><loc>https://www.destinationbryan.com/events/ev-${i}/</loc></url>`).join('')}</urlset>`;
  const some = new Set(['https://www.destinationbryan.com/events/ev-1/', 'https://www.destinationbryan.com/events/ev-2/']);
  const r = await fetchSource({ fetchText: fakeFetch({ sitemap, fail: some }), mapLimit, ...window });
  assert.equal(r.stats.failedPages, 2);
  assert.equal(r.stats.detailPages, 18);
  const most = new Set(Array.from({ length: 15 }, (_, i) => `https://www.destinationbryan.com/events/ev-${i}/`));
  await assert.rejects(() => fetchSource({ fetchText: fakeFetch({ sitemap, fail: most }), mapLimit, ...window }), /15 of 20 event pages/);
});

test('mapLimit preserves order and never exceeds the limit', async () => {
  let inFlight = 0, max = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, async (x) => {
    inFlight++; max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight--;
    if (x === 4) throw new Error('boom');
    return x * 10;
  });
  assert.equal(max, 2);
  assert.deepEqual(out.map((r) => (r.ok ? r.value : `err:${r.error.message}`)), [10, 20, 30, 'err:boom', 50, 60, 70]);
});

import { fixCoords, itemsFromDetail } from '../scripts/sources/destinationBryan.mjs';

test('coordinates: a dropped minus sign on longitude is repaired; out-of-area points are dropped', () => {
  assert.deepEqual(fixCoords(30.6797, 96.3723), [30.6797, -96.3723]);
  assert.deepEqual(fixCoords(30.6797, -96.3723), [30.6797, -96.3723]);
  assert.deepEqual(fixCoords(0, 0), [null, null]);
  assert.deepEqual(fixCoords(40.7, -74.0), [null, null]);
  assert.deepEqual(fixCoords(NaN, -96), [null, null]);
});

const baseDetail = (over) => ({
  url: 'https://www.destinationbryan.com/events/x/', title: 'X', description: '', dates: [{ y: 2027, m: 2, d: 19 }],
  times: [{ hh: 19, mm: 0 }, { hh: 21, mm: 30 }], upcoming: [], admission: 'Free', ticketUrl: null, websiteUrl: null, links: [],
  location: { name: 'V', address: '1 Main St, Bryan, TX 77803' }, lat: 30.6, lng: -96.3, categories: [], ...over,
});
const win = { fromMs: startOfDay('2026-11-06'), toMs: startOfDay('2027-06-30'), fetchedAt: 'x' };

test('headline date is kept even when the site omits it from its own Upcoming Dates list', () => {
  const its = itemsFromDetail(baseDetail({ upcoming: [{ y: 2027, m: 2, d: 20 }, { y: 2027, m: 2, d: 21 }] }), null, win);
  assert.deepEqual(its.map((i) => i.start.slice(0, 10)), ['2027-02-20', '2027-02-21', '2027-02-22']); // 7 PM CST = next day 01:00Z
  assert.equal(its[0].kind, 'recurring');
  assert.equal(its[0].timeNote, null);
});

test('a dense multi-month date list (exhibit open every weekday) becomes one ongoing item', () => {
  const upcoming = [];
  for (let d = new Date(Date.UTC(2026, 10, 5)); d < Date.UTC(2027, 4, 1); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) upcoming.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
  }
  const its = itemsFromDetail(baseDetail({ dates: [{ y: 2026, m: 11, d: 5 }], times: [{ hh: 8, mm: 0 }, { hh: 17, mm: 0 }], upcoming }), null, win);
  assert.equal(its.length, 1);
  assert.equal(its[0].kind, 'multi-day');
  assert.equal(its[0].runStart, '2026-11-05');
  assert.equal(its[0].runEnd, '2027-04-30');
  assert.match(its[0].timeNote, /Open weekdays through 4\/30\. Listed hours: 8:00 AM – 5:00 PM/);
  // A weekly series is NOT collapsed.
  const weekly = Array.from({ length: 25 }, (_, i) => { const d = new Date(Date.UTC(2026, 10, 11 + 7 * i)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; });
  const w = itemsFromDetail(baseDetail({ dates: [weekly[0]], upcoming: weekly }), null, win);
  assert.ok(w.length >= 20 && w.every((i) => i.kind === 'recurring'));
});
