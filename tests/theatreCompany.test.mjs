import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCE, parseListing, parseTime, itemsFromListing, fetchSource } from '../scripts/sources/theatreCompany.mjs';
import { startOfDay } from '../public/js/shared/time.js';

// Trimmed real copy of https://www.theatrecompany.com/calendar (2026-11-05): five upcoming entries + one past.
const fixture = readFileSync(new URL('./fixtures/theatre-listing.html', import.meta.url), 'utf8');
const ARTICLE = /<article\b[^>]*\beventlist-event\b[^>]*>[\s\S]*?<\/article>/g;
const wide = { fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-11-05', 301), fetchedAt: '2026-11-05T12:00:00.000Z' };
const month = { ...wide, toMs: startOfDay('2026-11-05', 31) }; // DAYS=30 as refresh.mjs computes it: through Dec 5

test('SOURCE names the public calendar page and a one-request HTML method', () => {
  assert.equal(SOURCE.id, 'theatreco');
  assert.equal(SOURCE.homepage, 'https://www.theatrecompany.com/calendar');
  assert.match(SOURCE.method, /one request per refresh/i);
});

test('listing: upcoming entries carry machine-readable dates and localized times; past entries are only counted', () => {
  const { found, entries, pastEntries } = parseListing(fixture);
  assert.equal(found, true);
  assert.equal(entries.length, 5);
  assert.equal(pastEntries, 1);
  const [first] = entries;
  assert.equal(first.title, 'Rudolph The Red Nosed Reindeer');
  assert.equal(first.href, '/calendar/rudolph-the-red-nosed-reindeer');
  assert.deepEqual(first.dates, [{ y: 2026, m: 12, d: 4 }]);
  assert.match(first.startText, /^7:00[\s ]PM$/); // the site puts a narrow no-break space before AM/PM
  assert.match(first.endText, /^9:00[\s ]PM$/);
  assert.deepEqual(first.link, [Date.UTC(2026, 11, 5, 1), Date.UTC(2026, 11, 5, 3)]); // its Google Calendar link, UTC
  const auditions = entries[3];
  assert.equal(auditions.title, 'Oliver Auditions');
  assert.deepEqual(auditions.dates, [{ y: 2027, m: 1, d: 9 }, { y: 2027, m: 1, d: 10 }]);
  assert.equal(auditions.startText, null);
  assert.equal(auditions.endText, null);
  assert.ok(!entries.some((e) => /rocky horror/i.test(e.title)), 'entries under "Past Events" are not returned');
});

test('time text: 12-hour with the narrow no-break space, 24-hour, and unreadable values', () => {
  assert.deepEqual(parseTime('7:00 PM'), { hh: 19, mm: 0 });
  assert.deepEqual(parseTime('12:00 PM'), { hh: 12, mm: 0 });
  assert.deepEqual(parseTime('12:30 AM'), { hh: 0, mm: 30 });
  assert.deepEqual(parseTime('2 pm'), { hh: 14, mm: 0 });
  assert.deepEqual(parseTime('19:00'), { hh: 19, mm: 0 });
  assert.equal(parseTime('13:00 PM'), null);
  assert.equal(parseTime('Doors open'), null);
  assert.equal(parseTime(''), null);
});

test('items: Central wall times become UTC instants (CST in December, CDT in April) with the listed end time', () => {
  const { items, stats } = itemsFromListing(fixture, wide);
  assert.equal(stats.entries, 5);
  assert.equal(stats.items, 4);
  assert.equal(stats.pastEntries, 1);
  assert.equal(stats.skipped['duplicate listing (same show, same start)'], 1); // the site lists Dec 5, 2 PM twice
  assert.deepEqual(stats.timeChecks, { agree: 5, disagree: 0 });
  assert.deepEqual(stats.notes, []);
  const dec4 = items.find((i) => i.sourceUrl === 'https://www.theatrecompany.com/calendar/rudolph-the-red-nosed-reindeer');
  assert.equal(dec4.start, '2026-12-05T01:00:00.000Z'); // 7:00 PM CST
  assert.equal(dec4.end, '2026-12-05T03:00:00.000Z'); // 9:00 PM CST
  assert.equal(dec4.endKnown, true);
  assert.equal(dec4.allDay, false);
  assert.equal(dec4.timeNote, null);
  assert.equal(dec4.kind, 'one-time');
  assert.equal(dec4.id, 'theatreco:rudolph-the-red-nosed-reindeer@1796432400000');
  const apr9 = items.find((i) => i.title === 'Jesus Christ Superstar');
  assert.equal(apr9.start, '2027-04-10T00:00:00.000Z'); // 7:00 PM CDT
  assert.equal(apr9.end, '2027-04-10T02:00:00.000Z');
  assert.equal(apr9.seriesId, 'theatreco:jesus-christ-superstar');
});

test('items: performances of one production share a seriesId, and nothing the page does not list is invented', () => {
  const { items } = itemsFromListing(fixture, wide);
  const rudolph = items.filter((i) => i.seriesId === 'theatreco:rudolph-the-red-nosed-reindeer');
  assert.deepEqual(rudolph.map((i) => i.start), ['2026-12-05T01:00:00.000Z', '2026-12-05T20:00:00.000Z']);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  for (const it of items) {
    assert.equal(it.location, null); // no venue listed per event; the company's address is not assumed
    assert.deepEqual(it.cost, { status: 'unknown', label: 'Cost not listed', min: null });
    assert.deepEqual(it.registration, { status: 'unknown', label: 'Registration requirements not listed', url: null });
    assert.deepEqual(it.types, ['shows']);
    assert.equal(it.description, '');
    assert.equal(it.summary, '');
    assert.deepEqual(it.sourceTags, []);
    assert.equal(it.contact, null);
    assert.equal(it.sourceId, 'theatreco');
    assert.equal(it.sourceName, SOURCE.name);
    assert.equal(it.lastVerified, wide.fetchedAt);
    assert.match(it.sourceUrl, /^https:\/\/www\.theatrecompany\.com\/calendar\/[a-z0-9-]+$/);
    assert.equal(it.title.trim(), it.title);
  }
});

test('a date-range entry with no times becomes one all-day multi-day item spanning the listed days', () => {
  const { items } = itemsFromListing(fixture, wide);
  const aud = items.find((i) => i.title === 'Oliver Auditions');
  assert.equal(aud.kind, 'multi-day');
  assert.equal(aud.allDay, true);
  assert.equal(aud.start, '2027-01-09T06:00:00.000Z'); // Chicago midnight, CST
  assert.equal(aud.end, '2027-01-11T06:00:00.000Z'); // end of Jan 10
  assert.equal(aud.endKnown, true);
  assert.equal(aud.runStart, '2027-01-09');
  assert.equal(aud.runEnd, '2027-01-10');
  assert.equal(aud.seriesId, 'theatreco:oliver-auditions');
  // The listing shows dates only; the entry's own calendar link carries the instants, so they are quoted, not applied.
  assert.equal(aud.timeNote, 'No times in the listing; its calendar link runs Sat, Jan 9, 6 PM – Sun, Jan 10, 8 PM (confirm with the source)');
});

test('all-day fallback: a single-day entry with no time at all is all-day, end unknown, "No time listed by source"', () => {
  const [dec4] = fixture.match(ARTICLE);
  const stripped = dec4
    .replace(/<li class="eventlist-meta-item eventlist-meta-time event-meta-item">[\s\S]*?<\/li>/, '')
    .replace(/<li class="eventlist-meta-item eventlist-meta-export event-meta-item">[\s\S]*?<\/li>/, '');
  assert.ok(stripped.length < dec4.length - 300, 'both rows were removed');
  const { items, stats } = itemsFromListing(fixture.replace(dec4, () => stripped), wide);
  const it = items.find((i) => i.sourceUrl.endsWith('/calendar/rudolph-the-red-nosed-reindeer'));
  assert.equal(it.kind, 'one-time');
  assert.equal(it.allDay, true);
  assert.equal(it.start, '2026-12-04T06:00:00.000Z');
  assert.equal(it.end, '2026-12-05T06:00:00.000Z');
  assert.equal(it.endKnown, false);
  assert.equal(it.timeNote, 'No time listed by source');
  assert.deepEqual(stats.timeChecks, { agree: 4, disagree: 0 }); // nothing left to check for that entry
});

test('window filtering keeps only entries that overlap [fromMs, toMs]', () => {
  const { items, stats } = itemsFromListing(fixture, month);
  assert.deepEqual(items.map((i) => i.start), ['2026-12-05T01:00:00.000Z', '2026-12-05T20:00:00.000Z']);
  assert.equal(stats.skipped['outside window'], 2); // Oliver Auditions (Jan 2027), Jesus Christ Superstar (Apr 2027)
  assert.equal(stats.skipped['duplicate listing (same show, same start)'], 1);
  const summer = itemsFromListing(fixture, { ...wide, fromMs: startOfDay('2027-07-01'), toMs: startOfDay('2027-08-01') });
  assert.equal(summer.items.length, 0);
  assert.equal(summer.stats.skipped['outside window'], 5);
});

test('fetchSource makes exactly one request, to the listing page, and reports stats', async () => {
  const urls = [];
  const r = await fetchSource({ fetchText: async (u) => { urls.push(u); return fixture; }, fromMs: month.fromMs, toMs: month.toMs });
  assert.deepEqual(urls, ['https://www.theatrecompany.com/calendar']);
  assert.ok(!urls.some((u) => /format=/.test(u)), 'the robots-disallowed ?format= endpoints are never requested');
  assert.equal(r.stats.requests, 1);
  assert.equal(r.stats.entries, 5);
  assert.equal(r.stats.items, 2);
  assert.equal(r.items.length, 2);
  assert.ok(Date.parse(r.fetchedAt) > 0);
});

test('fails loudly on an empty or unrecognised page instead of returning zero items', async () => {
  const fetchFrom = (html) => fetchSource({ fetchText: async () => html, fromMs: month.fromMs, toMs: month.toMs });
  await assert.rejects(() => fetchFrom('<!doctype html><html><body><h1>Maintenance</h1></body></html>'), /no "upcoming events" block/);
  const upStart = fixture.indexOf('<article class="eventlist-event');
  const pastStart = fixture.indexOf('<!-- Past Events -->');
  const emptyUpcoming = `${fixture.slice(0, upStart)}</div>\n${fixture.slice(pastStart)}`;
  assert.equal(parseListing(emptyUpcoming).pastEntries, 1);
  await assert.rejects(() => fetchFrom(emptyUpcoming), /No upcoming event entries/);
  const noDates = fixture.replace(/<time class="event-date"/g, '<time class="x"');
  await assert.rejects(() => fetchFrom(noDates), /None of the 5 event entries could be read/);
});

test('self-check against the page\'s own calendar links: one disagreement is noted, a systematic one fails loudly', () => {
  const shiftHour = (m, a, hh) => `${a}${String((+hh + 1) % 24).padStart(2, '0')}`;
  const one = fixture.replace(/(dates=\d{8}T)(\d{2})/, shiftHour); // first entry's link only
  const r = itemsFromListing(one, wide);
  assert.deepEqual(r.stats.timeChecks, { agree: 4, disagree: 1 });
  assert.equal(r.items[0].start, '2026-12-05T01:00:00.000Z', 'the listed Central time is still what is published');
  assert.equal(r.stats.notes[0], "Rudolph The Red Nosed Reindeer 2026-12-04: listed 7:00 PM read as 2026-12-05T01:00:00.000Z but the page's calendar link says 2026-12-05T02:00:00.000Z");
  const all = fixture.replace(/(dates=\d{8}T)(\d{2})/g, shiftHour);
  assert.throws(() => itemsFromListing(all, wide), /disagree with the page's own calendar links for 4 of 5 entries/);
});
