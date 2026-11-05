// Texas A&M University Events Calendar adapter (scripts/sources/tamu.mjs).
//
// tests/fixtures/tamu-feed.json holds 18 real records copied on 2026-11-05 from the calendar's public JSON
// feeds (14 from the "* Main University Calendar" group feed, 4 — the CANCELLED title, the Academic-Calendar-only
// deadline, the Dallas-campus seminar and the has_registration record — from the all-groups feed, which has the
// same record shape). Nothing is invented; only the unused "thumbnail:html" field was dropped to keep the file small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCE, feedUrl, classifyExclusion, dedupeById, coords, costFor, itemFromRecord, itemsFromFeed, fetchSource } from '../scripts/sources/tamu.mjs';
import { startOfDay, formatDateTime } from '../public/js/shared/time.js';

const fixtureText = readFileSync(new URL('./fixtures/tamu-feed.json', import.meta.url), 'utf8');
const records = JSON.parse(fixtureText);
const byId = (id, dateIso) => records.find((r) => r.id === id && (!dateIso || r.date_iso === dateIso));
const fetchedAt = '2026-11-05T12:00:00.000Z';
// The refresh window for 2026-11-05 with DAYS=30 (toMs is exclusive), and a wide one that includes the April record.
const win30 = { fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-11-05', 31), fetchedAt };
const wide = { fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2027-06-01'), fetchedAt };
const run = (w = wide) => itemsFromFeed(records, w);
const item = (title, w) => run(w).items.find((i) => i.title.startsWith(title));

test('SOURCE metadata and the feed URL use the window day keys (end_date is exclusive, like toMs)', () => {
  assert.equal(SOURCE.id, 'tamu');
  assert.equal(SOURCE.name, 'Texas A&M University Events Calendar');
  assert.equal(SOURCE.homepage, 'https://calendar.tamu.edu/');
  assert.equal(SOURCE.feedsPage, 'https://calendar.tamu.edu/feeds');
  assert.ok(SOURCE.method.length > 20);
  assert.equal(feedUrl(win30.fromMs, win30.toMs), 'https://calendar.tamu.edu/live/json/events/group/%2A%20Main%20University%20Calendar/start_date/2026-11-05/end_date/2026-12-06');
});

test('Chicago times: an ISO -06:00 start becomes the right UTC instant; no end → null, not invented', () => {
  const veg = item('Vegging Out Gardening Series');
  assert.equal(byId(388847).date_iso, '2026-11-05T15:30:00-06:00');
  assert.equal(veg.start, '2026-11-05T21:30:00.000Z');
  assert.equal(formatDateTime(Date.parse(veg.start)), 'Nov 5, 3:30 PM CST');
  assert.equal(veg.end, null);
  assert.equal(veg.endKnown, false);
  assert.equal(veg.allDay, false);
  assert.equal(veg.timeNote, null);
  assert.equal(veg.kind, 'recurring', 'repeats: "weekly" → recurring; the feed already lists one record per occurrence');
  assert.equal(veg.id, `tamu:388847@${Date.parse('2026-11-05T21:30:00Z')}`);
  assert.equal(veg.seriesId, 'tamu:vegging-out-gardening-series');
  assert.equal(veg.sourceUrl, 'https://calendar.tamu.edu/live/events/388114-vegging-out-gardening-series');
  assert.equal(veg.sourceId, 'tamu');
  assert.equal(veg.lastVerified, fetchedAt);

  const physics = item('Physics Demos at First Friday');
  assert.equal(physics.start, '2026-11-07T00:00:00.000Z'); // 6:00 PM CST
  assert.equal(physics.end, '2026-11-07T02:00:00.000Z'); // date2_iso 8:00 PM CST
  assert.equal(physics.endKnown, true);
  assert.equal(physics.kind, 'one-time');
});

test('each exclusion bucket is counted once per record, and records = excluded + items', () => {
  const { items, stats } = run();
  assert.equal(stats.records, 18);
  assert.deepEqual(stats.excluded, { transit: 2, academicCalendar: 1, cancelled: 1, online: 1, notPublicAudience: 2, otherCampus: 1, duplicateId: 1, outsideWindow: 0, invalid: 0 });
  assert.equal(items.length, 9);
  assert.equal(Object.values(stats.excluded).reduce((a, b) => a + b, 0) + items.length, stats.records);
  const titles = items.map((i) => i.title);
  for (const gone of ['Transit Fall Service', 'Preregistration for Spring 2027', 'CANCELLED: Cultural Cuisine Showcase', 'Faculty Advisory Council Monthly Meeting - November 2026', 'Piece by Piece: Quilted Pillow Workshop', 'Biomedical Sciences Faculty Candidate Seminar', 'Academic Success & Service: Lunch & Learn with OSEP']) {
    assert.ok(!titles.includes(gone), `${gone} must be excluded`);
  }
  // Per-record reasons.
  assert.equal(classifyExclusion(byId(377071, '2026-11-05T00:00:00-06:00')), 'transit');
  assert.equal(classifyExclusion(byId(372151)), 'academicCalendar', 'event_types is only ["Academic Calendar"]');
  assert.equal(classifyExclusion(byId(488988)), 'cancelled', 'is_canceled is never set; the title says CANCELLED:');
  assert.equal(classifyExclusion(byId(395578)), 'online');
  assert.equal(classifyExclusion(byId(487333)), 'notPublicAudience', 'audience Faculty/Researcher/Staff/Students only');
  assert.equal(classifyExclusion(byId(489835)), 'otherCampus', 'campus ["Dallas "] although the audience includes Residents');
  assert.equal(classifyExclusion(byId(388847)), null);
  // "Academic Calendar" mixed with real categories is kept (OPAS shows and concerts carry it).
  assert.ok(byId(386735).event_types.includes('Academic Calendar'));
  assert.equal(classifyExclusion(byId(386735)), null);
  // A record outside the window is counted, not silently dropped.
  const r30 = run(win30);
  assert.equal(r30.stats.excluded.outsideWindow, 1);
  assert.equal(r30.items.length, 8);
  assert.ok(!r30.items.some((i) => i.title.startsWith('150th Celebration')));
});

test('same-id dedupe: an event spanning midnight keeps its full-span record, not the next-day all-day stub', () => {
  const pair = records.filter((r) => r.id === 489788);
  assert.equal(pair.length, 2);
  const items = run().items.filter((i) => i.title.includes('Taiwan'));
  assert.equal(items.length, 1);
  const [conf] = items;
  assert.equal(conf.start, '2026-11-16T19:00:00.000Z'); // 1:00 PM CST
  assert.equal(conf.end, '2026-11-17T17:00:00.000Z'); // 11:00 AM CST next day
  assert.equal(conf.endKnown, true);
  assert.equal(conf.allDay, false);
  assert.equal(conf.kind, 'one-time');
  assert.equal(conf.id, `tamu:489788@${Date.parse('2026-11-16T19:00:00Z')}`);
});

test('same-id dedupe: one-record-per-day all-day stubs collapse into one multi-day run', () => {
  const stubs = records.filter((r) => r.id === 377071);
  assert.equal(stubs.length, 2);
  const { records: out, dropped } = dedupeById(stubs);
  assert.equal(out.length, 1);
  assert.equal(dropped, 1);
  assert.equal(out[0].run.count, 2);
  const it = itemFromRecord(out[0], { fetchedAt, lastWindowDay: '2026-12-05' });
  assert.equal(it.kind, 'multi-day');
  assert.equal(it.allDay, true);
  assert.equal(it.start, '2026-11-05T06:00:00.000Z');
  assert.equal(it.runStart, '2026-11-05');
  assert.equal(it.runEnd, '2026-11-13', 'repeats_end "2026-11-13 06:00:00" (UTC) is the start of the last listed day');
  assert.equal(it.end, '2026-11-14T06:00:00.000Z');
  assert.equal(it.endKnown, true);
  assert.equal(it.timeNote, 'No time listed by source');
});

test('all-day record: Chicago midnight to next Chicago midnight (CDT in April), end not claimed as known', () => {
  const fest = item('150th Celebration Closing Festival');
  assert.equal(byId(384245).date_iso, '2027-04-30T00:00:00-05:00');
  assert.equal(fest.allDay, true);
  assert.equal(fest.start, '2027-04-30T05:00:00.000Z');
  assert.equal(fest.end, '2027-05-01T05:00:00.000Z');
  assert.equal(fest.endKnown, false);
  assert.equal(fest.timeNote, 'No time listed by source');
  assert.equal(fest.kind, 'one-time');
  assert.equal(fest.runStart, undefined);
});

test('cost variants: number, "Free", HTML, bare leading number, null', () => {
  assert.deepEqual(item('University Wind Symphony').cost, { status: 'paid', label: '$5', min: 5 });
  assert.deepEqual(item('Vegging Out').cost, { status: 'paid', label: '$50', min: 50 });
  assert.deepEqual(item('Physics Demos').cost, { status: 'free', label: 'Free', min: 0 });
  const momentum = item('‘Momentum’');
  assert.equal(momentum.cost.status, 'paid');
  assert.equal(momentum.cost.min, 7);
  assert.equal(momentum.cost.label, '$11.50; $7 for students at the MSC Box Office.');
  assert.deepEqual(item('OPAS presents A Beautiful Noise').cost, { status: 'unknown', label: 'Cost not listed', min: null });
  // Strings seen in the feeds on 2026-11-05.
  assert.deepEqual(costFor(0), { status: 'free', label: 'Free', min: 0 });
  assert.deepEqual(costFor('Free'), { status: 'free', label: 'Free', min: 0 });
  assert.deepEqual(costFor(null), { status: 'unknown', label: 'Cost not listed', min: null });
  assert.deepEqual(costFor(''), { status: 'unknown', label: 'Cost not listed', min: null });
  assert.deepEqual(costFor('60-$66'), { status: 'paid', label: '$60-$66', min: 60 });
  assert.deepEqual(costFor('11.50; $6 for students at the MSC Box Office'), { status: 'paid', label: '$11.50; $6 for students at the MSC Box Office', min: 6 });
  assert.deepEqual(costFor('<p>$35 per couple</p>'), { status: 'paid', label: '$35 per couple', min: 35 });
  assert.equal(costFor('<p>\n  This event has been cancelled\n</p>').status, 'unknown');
  assert.equal(costFor('25 per person').status, 'unknown', 'a bare number without any $ is not turned into a price');
});

test('location: venue name, street address only when the source string has one, coordinates sanity-checked', () => {
  assert.deepEqual(item('Vegging Out').location, { name: 'The Gardens at Texas A&M University', address: null, lat: 30.606987, lng: -96.351191 });
  assert.equal(typeof byId(388847).location_longitude, 'string', 'the feed sends longitude as a string');
  assert.deepEqual(item('Sbisa Star Party').location, { name: 'Sbisa Dining Hall', address: '233 Houston St, College Station, TX 77843', lat: null, lng: null });
  assert.deepEqual(item('Physics Demos').location, { name: null, address: 'N Main St, Downtown Bryan, TX 77803', lat: 30.673724, lng: -96.373456 });
  assert.deepEqual(coords(30.606987, '-96.351191'), [30.606987, -96.351191]);
  assert.deepEqual(coords(32.789773, '-96.78158'), [null, null], 'Dallas is outside the Brazos Valley box');
  assert.deepEqual(coords(null, null), [null, null]);
  assert.deepEqual(coords('', ''), [null, null]);
  assert.deepEqual(coords(30.6, '96.35'), [null, null]);
});

test('registration, contact, types, tags and entity decoding', () => {
  const reg = itemFromRecord(byId(488186), { fetchedAt });
  assert.equal(reg.registration.status, 'required');
  assert.equal(reg.registration.label, 'Registration required (per calendar)');
  assert.equal(reg.title, 'Academic Success & Service: Lunch & Learn with OSEP');
  assert.equal(reg.contact, null, 'no contact_info in the record → null, not invented');

  const veg = item('Vegging Out');
  assert.equal(veg.registration.status, 'unknown');
  assert.equal(veg.contact, 'Kathryn Grier · kathryn.grier@ag.tamu.edu · 979-314-2357');
  assert.deepEqual(veg.sourceTags, ['Campus Life', 'General Interest', 'Audience: Faculty', 'Audience: Residents', 'Audience: Staff', 'Audience: Students']);

  const here = item('Here for Good');
  assert.equal(here.title, 'Here for Good: Celebrating 150 Years of Texas A&M University');
  assert.equal(here.seriesId, 'tamu:here-for-good-celebrating-150-years-of-texas-a-and-m-university');
  assert.equal(here.kind, 'recurring');
  assert.equal(here.end, '2026-11-11T02:00:00.000Z');
  assert.ok(here.types.includes('arts'), '"Arts & Entertainment" is a strong tag');
  assert.ok(item('University Wind Symphony').types.includes('shows'));
  assert.ok(item('Physics Demos').types.includes('community'));
  assert.equal(item('OPAS presents A Beautiful Noise').contact, 'MSC Box Office · 979-845-1234 · boxoffice.tamu.edu · boxoffice@tamu.edu');
});

test('nothing is invented: every item has the full shape and unknowns are labelled', () => {
  const KEYS = ['id', 'seriesId', 'kind', 'title', 'description', 'summary', 'location', 'cost', 'registration', 'types', 'sourceTags', 'contact', 'websiteUrl', 'sourceId', 'sourceName', 'sourceUrl', 'lastVerified', 'start', 'end', 'endKnown', 'allDay', 'timeNote'];
  const { items } = run();
  for (const it of items) {
    for (const k of KEYS) assert.ok(k in it, `${it.title} lacks ${k}`);
    if (it.end === null) assert.equal(it.endKnown, false, `${it.title}: no end → endKnown false`);
    if (it.cost.status === 'unknown') assert.equal(it.cost.min, null);
    if (it.registration.status === 'unknown') assert.equal(it.registration.url, null);
    assert.ok(it.location === null || 'lat' in it.location);
    assert.ok(it.summary.length <= 201 && it.description.length <= 601);
    assert.equal(it.sourceName, SOURCE.name);
    assert.match(it.sourceUrl, /^https:\/\/calendar\.tamu\.edu\//);
  }
  const noEnd = items.filter((i) => i.end === null).map((i) => i.title);
  assert.ok(noEnd.includes('Vegging Out Gardening Series') && noEnd.includes('OPAS presents A Beautiful Noise: The Neil Diamond Musical'));
});

test('fetchSource makes exactly one request for the window and fails loudly on an unexpected body', async () => {
  const calls = [];
  const ok = await fetchSource({ fetchText: async (u) => { calls.push(u); return fixtureText; }, fromMs: win30.fromMs, toMs: win30.toMs });
  assert.deepEqual(calls, ['https://calendar.tamu.edu/live/json/events/group/%2A%20Main%20University%20Calendar/start_date/2026-11-05/end_date/2026-12-06']);
  assert.equal(ok.stats.requests, 1);
  assert.equal(ok.stats.records, 18);
  assert.equal(ok.items.length, 8);
  assert.ok(ok.items.every((i) => i.lastVerified === ok.fetchedAt));
  for (const [body, re] of [['<!doctype html><html>maintenance</html>', /not JSON/], ['[]', /non-empty JSON array/], ['{"events":[]}', /non-empty JSON array/], ['[{"foo":1},{"bar":2}]', /shape may have changed/]]) {
    await assert.rejects(() => fetchSource({ fetchText: async () => body, fromMs: win30.fromMs, toMs: win30.toMs }), re, body);
  }
  await assert.rejects(() => fetchSource({ fetchText: async () => { throw new Error('HTTP 403 (access restricted — not retrying)'); }, fromMs: win30.fromMs, toMs: win30.toMs }), /HTTP 403/);
});
