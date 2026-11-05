import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDemo, DEMO_NOW } from '../scripts/make-demo.mjs';
import { parseDetail, itemsFromDetail } from '../scripts/sources/destinationBryan.mjs';
import { dedupe, costFromText, registrationFrom } from '../scripts/lib/normalize.mjs';
import { DEFAULT_FILTERS, filterItems, pickRecommendations, isExpired, rangeFor, placeWindows, startsWithin, nowItems, groupSeries, plural, durationLabel, buildReason } from '../public/js/shared/logic.js';
import { buildICS, googleCalendarUrl, mapLinks } from '../public/js/shared/export.js';
import { formatDateTime, startOfDay, dayKey } from '../public/js/shared/time.js';
import { refresh } from '../scripts/refresh.mjs';

const NOW = Date.parse(DEMO_NOW); // Fri Nov 6 2026, 10:00 AM CST
const demo = await buildDemo();
const items = demo.items;
const titles = (ms) => ms.map((m) => m.item.title);
const run = (over = {}, ctx = {}) => filterItems(items, { ...DEFAULT_FILTERS, types: [], ...over }, { now: NOW, ...ctx });

test('Expired events are removed by the pipeline and hidden live as time passes', () => {
  assert.equal(demo.counts.expiredRemoved, 1);
  assert.ok(!items.some((i) => i.title === '[DEMO] Early Bird Walk'));
  const concert = items.find((i) => i.title === '[DEMO] Lunchtime Park Concert');
  assert.equal(isExpired(concert, Date.parse('2026-11-06T18:59:00Z')), false); // 12:59 PM
  assert.equal(isExpired(concert, Date.parse('2026-11-06T19:00:00Z')), true); // 1:00 PM end
  // No end listed → treated as lasting until the end of its day (never invents a duration).
  const trivia = items.find((i) => i.title === '[DEMO] Evening Trivia Night');
  assert.equal(isExpired(trivia, Date.parse('2026-11-07T05:59:00Z')), false); // 11:59 PM CST
  assert.equal(isExpired(trivia, Date.parse('2026-11-07T06:00:00Z')), true);
  // Live filtering: after the concert ends it no longer appears.
  assert.ok(titles(run({ when: 'today' }, { now: Date.parse('2026-11-06T19:30:00Z') })).every((t) => t !== '[DEMO] Lunchtime Park Concert'));
});

test('Duplicates across sources are merged and both sources kept', () => {
  assert.equal(demo.counts.duplicatesRemoved, 1);
  const c = items.filter((i) => /Lunchtime/.test(i.title));
  assert.equal(c.length, 1);
  assert.equal(c[0].alsoListedBy.length, 1);
  const { items: out, removed } = dedupe([{ ...c[0], id: 'a' }, { ...c[0], id: 'a' }]);
  assert.equal(out.length, 1); assert.equal(removed, 1);
});

test('Default view = next 7 days (Chicago days), clipped to now', () => {
  const r = rangeFor('week', NOW);
  assert.equal(r.from, NOW);
  assert.equal(new Date(r.to).toISOString(), '2026-11-13T06:00:00.000Z'); // midnight CST after Nov 12
  const res = run();
  assert.ok(res.length > 5);
  for (const m of res) if (m.item.kind !== 'place' && m.item.kind !== 'multi-day') assert.ok(Date.parse(m.item.start) < r.to);
  assert.ok(!titles(res).includes('[DEMO] Wednesday Open Mic') || res.filter((m) => m.item.title === '[DEMO] Wednesday Open Mic').length === 1);
});

test('Date filters: today, tomorrow, weekend, specific date', () => {
  const today = titles(run({ when: 'today' }));
  assert.ok(today.includes('[DEMO] Lunchtime Park Concert'));
  assert.ok(!today.includes('[DEMO] Stargazing Night'));
  const tomorrow = run({ when: 'tomorrow' });
  for (const m of tomorrow) if (m.item.start && m.item.kind !== 'multi-day') assert.equal(dayKey(Date.parse(m.item.start)), '2026-11-07');
  assert.ok(titles(tomorrow).includes('[DEMO] Stargazing Night')); // stored as 01:00Z Nov 8 = Nov 7 local
  const weekend = titles(run({ when: 'weekend' }));
  assert.ok(weekend.includes('[DEMO] Harvest Festival') && weekend.includes('[DEMO] Beginner Pottery Workshop'));
  assert.ok(!weekend.includes('[DEMO] Lunchtime Park Concert'));
  assert.deepEqual(titles(run({ when: 'date', date: '2026-11-10', kind: 'events' })).filter((t) => !/Quilt/.test(t)), ['[DEMO] Library Book Club']);
});

test('Budget filter: free, max price, unknown costs only with "include missing info"', () => {
  const free = run({ budget: 'free', includeUnknown: false });
  assert.ok(free.length && free.every((m) => m.item.cost.status === 'free'));
  const ten = run({ budget: '10', includeUnknown: false });
  assert.ok(ten.every((m) => m.item.cost.min !== null && m.item.cost.min <= 10));
  assert.ok(!titles(ten).includes('[DEMO] Beginner Pottery Workshop')); // $15
  assert.ok(titles(ten).includes('[DEMO] Community Quilt Exhibit')); // adult price $8 (kids $4 is not used as min)
  const withUnknown = run({ budget: '10', includeUnknown: true });
  const craft = withUnknown.find((m) => m.item.title === '[DEMO] Downtown Craft Market');
  assert.ok(craft && craft.unknowns.includes('cost'));
  assert.ok(!titles(run({ budget: 'free', includeUnknown: true })).includes('[DEMO] Evening Trivia Night')); // known paid
});

test('Activity type, mood, kind, time of day and time available filters', () => {
  assert.ok(run({ types: ['fitness'] }).every((m) => m.item.types.includes('fitness')));
  assert.ok(run({ mood: 'active' }).every((m) => m.item.types.some((t) => ['fitness', 'outdoors'].includes(t))));
  assert.deepEqual([...new Set(run({ kind: 'place' }).map((m) => m.item.kind))], ['place']);
  assert.ok(run({ kind: 'recurring' }).every((m) => m.item.kind === 'recurring'));
  assert.ok(run({ kind: 'events' }).every((m) => m.item.kind !== 'place'));
  const evening = run({ timeOfDay: 'evening', kind: 'events' }).filter((m) => !m.item.allDay && m.item.kind !== 'multi-day');
  assert.ok(evening.length && evening.every((m) => new Date(m.window.start).getUTCHours() >= 23 || new Date(m.window.start).getUTCHours() < 6));
  const short = run({ timeAvail: '2', includeUnknown: false, kind: 'events' });
  assert.ok(!titles(short).includes('[DEMO] Beginner Pottery Workshop')); // 3 h
  assert.ok(!titles(short).includes('[DEMO] Evening Trivia Night')); // unknown duration excluded
  assert.ok(titles(run({ timeAvail: '2', includeUnknown: true })).includes('[DEMO] Evening Trivia Night'));
});

test('Transportation: distance filter only with a shared location; straight-line only', () => {
  assert.equal(run({ transport: 'walk' }).length, run().length, 'no location → nothing filtered');
  const origin = { lat: 30.674, lng: -96.371 }; // next to the demo open-mic venue
  const walk = run({ transport: 'walk', includeUnknown: false }, { origin });
  assert.ok(walk.length > 0 && walk.every((m) => m.distance <= 2.5));
  assert.ok(titles(walk).includes('[DEMO] Harvest Festival'));
  assert.ok(!titles(walk).includes('[DEMO] Stargazing Night')); // ~17 km away
  const links = mapLinks(items.find((i) => i.title === '[DEMO] Harvest Festival').location, 'walk');
  assert.match(links.google, /travelmode=walking/);
  assert.match(links.apple, /dirflg=w/);
  assert.match(mapLinks({ address: 'x' }, 'transit').google, /travelmode=transit/);
});

test('Places: open windows respect weekly hours and closures, in Chicago time', () => {
  const place = items.find((i) => i.kind === 'place');
  const wins = placeWindows(place, startOfDay('2026-11-07'), startOfDay('2026-11-10'));
  assert.deepEqual(wins.map((w) => w.key), ['2026-11-07', '2026-11-09']); // Nov 8 closed
  assert.equal(formatDateTime(wins[0].start), 'Nov 7, 9:00 AM CST');
  // Today at 10 AM → open now; at 6 PM → no window left today.
  assert.ok(run({ when: 'today', kind: 'place' }).length === 1);
  assert.equal(run({ when: 'today', kind: 'place' }, { now: Date.parse('2026-11-07T00:00:00Z') }).length, 0);
});

test('Picks: 3–5, varied, no repeated series, with a factual reason', () => {
  const res = run();
  const picks = pickRecommendations(res, { now: NOW, prefs: {} }, DEFAULT_FILTERS, 5);
  assert.ok(picks.length >= 3 && picks.length <= 5);
  assert.equal(new Set(picks.map((p) => p.item.groupKey)).size, picks.length);
  assert.ok(new Set(picks.map((p) => p.item.types[0])).size >= 3);
  for (const p of picks) assert.ok(p.reason && p.reason.length > 5);
  // Hiding a series removes it from everything.
  const hidden = new Set([picks[0].item.groupKey]);
  assert.ok(!filterItems(items, { ...DEFAULT_FILTERS, types: [] }, { now: NOW, hidden }).some((m) => m.item.groupKey === picks[0].item.groupKey));
});

test('Right now: startsWithin / nowItems find happening-now, starting-soon and open-now items', () => {
  const concert = items.find((i) => i.title === '[DEMO] Lunchtime Park Concert'); // noon CST
  assert.equal(startsWithin(concert, NOW), true); // 10 AM → starts in 2 h
  assert.equal(startsWithin(concert, NOW, 3600_000), false); // not within 1 h
  assert.equal(startsWithin(concert, Date.parse('2026-11-06T18:30:00Z')), false); // already started
  assert.equal(startsWithin(items.find((i) => i.kind === 'place'), NOW), false);
  const strip = nowItems(run({ when: 'today' }), NOW);
  assert.deepEqual(strip.map((x) => [x.status, x.label, x.match.item.title]), [
    ['soon', 'Starts in 2 h', '[DEMO] Lunchtime Park Concert'],
    ['open', 'Open now · until 5 PM', '[DEMO] Example Nature Center'],
  ]);
  const later = Date.parse('2026-11-06T18:30:00Z'); // 12:30 PM: concert is on
  const strip2 = nowItems(run({ when: 'today' }, { now: later }), later);
  assert.equal(strip2[0].status, 'now');
  assert.equal(strip2[0].label, 'Happening now · until 1 PM');
  assert.deepEqual(nowItems([], NOW), []);
  assert.equal(nowItems(run({ when: 'today' }), NOW, { max: 1 }).length, 1);
  assert.equal(durationLabel(45 * 60_000), '45 min');
  assert.equal(durationLabel(150 * 60_000), '2 h 30 min');
  assert.equal(plural(1, 'result'), '1 result');
  assert.equal(plural(0, 'result'), '0 results');
  assert.equal(plural(2, 'repeat date'), '2 repeat dates');
});

test('groupSeries: one entry per recurring series under its next date, other dates kept', () => {
  const all = run({ when: 'date', date: '2026-11-07' }).concat(run({ when: 'date', date: '2026-11-21' }), run({ when: 'date', date: '2026-11-28' }));
  const yogaDates = all.filter((m) => /Yoga/.test(m.item.title));
  assert.equal(yogaDates.length, 3);
  const grouped = groupSeries(all);
  const yoga = grouped.filter((m) => /Yoga/.test(m.item.title));
  assert.equal(yoga.length, 1);
  assert.equal(dayKey(yoga[0].window.start), '2026-11-07'); // the next date is kept
  assert.deepEqual(yoga[0].otherDates.map((m) => dayKey(m.window.start)), ['2026-11-21', '2026-11-28']);
  // Non-recurring items pass through untouched and order is preserved.
  assert.equal(grouped.length, all.length - 2);
  assert.ok(grouped.every((m) => m.item.kind === 'recurring' || !('otherDates' in m)));
  assert.deepEqual(groupSeries([]), []);
});

test('Reasons are never a bare when-phrase or "Hours not listed"; own save is not "similar to saved"', () => {
  const place = run({ kind: 'place' }, { now: Date.parse('2026-11-07T04:00:00Z') }); // 10 PM: nature center closed
  const placeNoHours = { ...items.find((i) => i.kind === 'place'), hours: null, id: 'x', cost: { status: 'unknown', label: 'Cost not listed', min: null }, registration: { status: 'unknown', label: 'n/a', url: null } };
  const m = { item: placeNoHours, window: null, distance: null, unknowns: ['hours'] };
  const r = buildReason(m, { now: NOW });
  assert.ok(!r.includes('Hours not listed'), r);
  assert.ok(r.includes('Outdoors & nature'), r);
  assert.ok(place.every((x) => x.window), 'closed place has no window');
  // A paid, one-time event with nothing else to say still gets a factual signal.
  const trivia = run().find((x) => x.item.title === '[DEMO] Evening Trivia Night');
  const r2 = buildReason(trivia, { now: NOW });
  assert.ok(r2.split(' · ').length >= 2, r2);
  assert.ok(/Games & social|listed/.test(r2), r2);
  // Saving an item must not make its own reason "Similar to things you saved or liked".
  const res = run();
  const first = pickRecommendations(res, { now: NOW, prefs: {} }, DEFAULT_FILTERS, 5)[0];
  const liked = new Map(first.item.types.map((t) => [t, 1]));
  const again = pickRecommendations(res, { now: NOW, prefs: { likedTypes: liked, saved: new Set([first.item.id]) } }, DEFAULT_FILTERS, 5);
  const self = again.find((p) => p.item.id === first.item.id);
  assert.ok(self && !self.reason.includes('Similar to things you saved'), self?.reason);
  const other = pickRecommendations(res, { now: NOW, prefs: { likedTypes: liked, saved: new Set(['someone-else']) } }, DEFAULT_FILTERS, 5).find((p) => p.item.id === first.item.id);
  assert.ok(other.reason.includes('Similar to things you saved'), other.reason);
});

test('Calendar export: UTC times, no invented end, all-day dates, folded lines', () => {
  const concert = items.find((i) => i.title === '[DEMO] Lunchtime Park Concert');
  const ics = buildICS(concert, { now: NOW });
  assert.match(ics, /DTSTART:20261106T180000Z/);
  assert.match(ics, /DTEND:20261106T190000Z/);
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  const trivia = buildICS(items.find((i) => i.title === '[DEMO] Evening Trivia Night'), { now: NOW });
  assert.match(trivia, /DTSTART:20261107T010000Z/);
  assert.doesNotMatch(trivia, /DTEND/);
  assert.match(trivia.replace(/\r\n /g, ''), /End time not listed/);
  const fest = buildICS(items.find((i) => i.title === '[DEMO] Harvest Festival'), { now: NOW });
  assert.match(fest, /DTSTART;VALUE=DATE:20261108/);
  assert.match(fest, /DTEND;VALUE=DATE:20261109/);
  assert.match(googleCalendarUrl(concert), /dates=20261106T180000Z%2F20261106T190000Z/);
});

test('Destination Bryan page: visible time wins over wrong JSON-LD "Z"; year rollover', () => {
  const html = readFileSync(new URL('./fixtures/bryan-detail.html', import.meta.url), 'utf8');
  const d = parseDetail(html, 'https://www.destinationbryan.com/events/demo-open-mic/');
  assert.deepEqual(d.times, [{ hh: 19, mm: 0 }, { hh: 21, mm: 0 }]);
  assert.deepEqual(d.upcoming.map((x) => `${x.y}-${x.m}-${x.d}`), ['2026-12-30', '2027-1-6', '2027-1-13']);
  const its = itemsFromDetail(d, null, { fromMs: startOfDay('2026-12-01'), toMs: startOfDay('2027-02-01'), fetchedAt: 'x' });
  assert.equal(its.length, 3);
  assert.equal(formatDateTime(Date.parse(its[0].start)), 'Dec 30, 7:00 PM CST'); // JSON-LD would say 1 PM
  assert.equal(its[0].kind, 'recurring');
  assert.equal(its[0].cost.label, 'Free');
  assert.equal(its[1].timeNote, 'Time copied from the series listing — confirm for this date');
  assert.equal(its[0].websiteUrl, 'https://example.com/open-mic');
});

test('Cost and registration text are labelled, not guessed', () => {
  assert.deepEqual(costFromText(''), { status: 'unknown', label: 'Cost not listed', min: null });
  assert.equal(costFromText('Free').status, 'free');
  // min is the typical adult price, not the lowest (kids') price, so the budget filter does not hide a $12 event under "$5".
  assert.deepEqual(costFromText('$12 for adults | $5 for kids | Free for children'), { status: 'mixed', label: '$12 for adults | $5 for kids | Free for children', min: 12 });
  assert.equal(costFromText('Donations welcome').status, 'unknown');
  assert.equal(registrationFrom({ description: 'Just show up.' }).status, 'unknown');
  assert.equal(registrationFrom({ description: 'Registration is required by Nov 5.' }).status, 'required');
});

test('Refresh: a failing source keeps its last good (non-expired) items and is reported', async () => {
  const okSource = { SOURCE: { id: 'ok', name: 'OK', homepage: 'https://ok.example', method: 'm' }, fetchSource: async () => ({ items: [{ ...items[2], sourceId: 'ok' }], stats: {}, fetchedAt: 'now' }) };
  const badSource = { SOURCE: { id: 'bad', name: 'Bad', homepage: 'https://bad.example', method: 'm' }, fetchSource: async () => { throw new Error('HTTP 503'); } };
  const prevItems = [
    { ...items.find((i) => i.title === '[DEMO] Beginner Pottery Workshop'), sourceId: 'bad' },
    { ...items.find((i) => i.title === '[DEMO] Lunchtime Park Concert'), id: 'old', sourceId: 'bad', start: '2026-11-01T18:00:00.000Z', end: '2026-11-01T19:00:00.000Z' },
  ];
  const prev = { sources: [{ id: 'bad', lastSuccess: '2026-11-05T12:00:00.000Z' }], items: prevItems };
  const out = await refresh({ now: NOW, sources: [okSource, badSource], prev, write: false, log: () => {} });
  const bad = out.sources.find((s) => s.id === 'bad');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error, 'HTTP 503');
  assert.equal(bad.lastSuccess, '2026-11-05T12:00:00.000Z');
  assert.equal(bad.itemCount, 1, 'expired previous item dropped');
  assert.ok(out.items.some((i) => i.sourceId === 'bad' && /Pottery/.test(i.title)));
});
