import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chicagoToUtc, dayKey, formatTime, formatDateTime, tzAbbr, startOfDay } from '../public/js/shared/time.js';
import { parseICS, occurrences, expandRRule, parseRRule } from '../scripts/lib/ics.mjs';
import { itemsFromICS } from '../scripts/sources/cstx.mjs';

const iso = (t) => new Date(t).toISOString();

test('Chicago wall time → UTC handles CST and CDT', () => {
  assert.equal(iso(chicagoToUtc(2026, 11, 6, 12, 0)), '2026-11-06T18:00:00.000Z'); // CST = UTC-6
  assert.equal(iso(chicagoToUtc(2026, 7, 4, 12, 0)), '2026-07-04T17:00:00.000Z'); // CDT = UTC-5
});

test('DST edge cases: spring-forward gap and fall-back overlap', () => {
  // 2026-03-08 02:30 does not exist in Chicago; it is shifted forward (03:30 CDT = 08:30Z).
  assert.equal(iso(chicagoToUtc(2026, 3, 8, 2, 30)), '2026-03-08T08:30:00.000Z');
  // 2026-11-01 01:30 happens twice; the first (CDT, UTC-5) is used.
  assert.equal(iso(chicagoToUtc(2026, 11, 1, 1, 30)), '2026-11-01T06:30:00.000Z');
  // Midnight starts of the DST days.
  assert.equal(iso(startOfDay('2026-11-01')), '2026-11-01T05:00:00.000Z');
  assert.equal(iso(startOfDay('2026-11-02')), '2026-11-02T06:00:00.000Z');
});

test('Display and day boundaries use Chicago, not the machine time zone', () => {
  const t = Date.parse('2026-11-06T03:30:00Z'); // Nov 5, 9:30 PM CST
  assert.equal(dayKey(t), '2026-11-05');
  assert.equal(formatTime(t), '9:30 PM');
  assert.equal(tzAbbr(t), 'CST');
  assert.equal(tzAbbr(Date.parse('2026-07-01T17:00:00Z')), 'CDT');
  assert.match(formatDateTime(t), /Nov 5, 9:30 PM CST/);
  // Run this suite under different TZ values (see README) — results must not change.
});

test('Weekly RRULE keeps the wall-clock time across the DST change, honours EXDATE', () => {
  const [ev] = parseICS(readFileSync(new URL('./fixtures/demo.ics', import.meta.url), 'utf8')).filter((e) => e.UID[0].value === 'demo-yoga');
  const { occurrences: occ } = occurrences(ev, Date.parse('2026-10-20T00:00:00Z'), Date.parse('2026-11-30T00:00:00Z'));
  const starts = occ.map((o) => iso(o.startMs));
  assert.deepEqual(starts, [
    '2026-10-24T13:00:00.000Z', // 8 AM CDT
    '2026-10-31T13:00:00.000Z', // 8 AM CDT
    '2026-11-07T14:00:00.000Z', // 8 AM CST (after Nov 1)
    // Nov 14 removed by EXDATE
    '2026-11-21T14:00:00.000Z',
    '2026-11-28T14:00:00.000Z',
  ]);
  assert.ok(occ.every((o) => o.endMs - o.startMs === 3600_000));
});

test('Monthly BYDAY ordinal (2nd Tuesday) and UNTIL', () => {
  const days = expandRRule(parseRRule('FREQ=MONTHLY;BYDAY=2TU;UNTIL=20261231T000000Z'), { y: 2026, m: 7, d: 14 }, 999999).days
    .map((n) => new Date(n * 86400000).toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-07-14', '2026-08-11', '2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08']);
  const last = expandRRule(parseRRule('FREQ=MONTHLY;BYDAY=-1TH'), { y: 2026, m: 1, d: 29 }, Math.floor(Date.UTC(2026, 3, 30) / 86400000)).days
    .map((n) => new Date(n * 86400000).toISOString().slice(0, 10));
  assert.deepEqual(last, ['2026-01-29', '2026-02-26', '2026-03-26', '2026-04-30']);
});

test('Unsupported recurrence is reported, not guessed', () => {
  const r = expandRRule(parseRRule('FREQ=YEARLY;BYMONTH=7'), { y: 2026, m: 7, d: 4 }, 999999);
  assert.equal(r.days.length, 0);
  assert.match(r.unsupported, /BYMONTH|YEARLY/);
});

test('City feed adapter: exclusions, UTC times, all-day, costs, registration, kinds', () => {
  const text = readFileSync(new URL('./fixtures/demo.ics', import.meta.url), 'utf8');
  const fromMs = startOfDay('2026-11-06'), toMs = startOfDay('2026-11-06', 31);
  const { items, stats } = itemsFromICS(text, { fromMs, toMs, fetchedAt: '2026-11-06T12:00:00Z' });
  const by = (t) => items.filter((i) => i.title === t);
  assert.equal(stats.excluded.internal, 1);
  assert.equal(stats.excluded['meeting/closure/notice'], 1);
  assert.equal(by('[DEMO] City Council Meeting').length, 0);
  assert.equal(by('[DEMO] Staff Training').length, 0);

  const stars = by('[DEMO] Stargazing Night')[0];
  assert.equal(formatDateTime(Date.parse(stars.start)), 'Nov 7, 7:00 PM CST');

  const fest = by('[DEMO] Harvest Festival')[0];
  assert.equal(fest.allDay, true);
  assert.equal(stars.kind, 'one-time');
  assert.equal(by('[DEMO] Saturday Yoga in the Park')[0].kind, 'recurring');

  const trivia = by('[DEMO] Evening Trivia Night')[0];
  assert.equal(trivia.end, null, 'no DTEND → no invented end');
  assert.equal(trivia.endKnown, false);
  assert.deepEqual(trivia.cost, { status: 'paid', label: 'Paid — amount not listed', min: null });
  assert.equal(trivia.registration.status, 'unknown');

  const pottery = by('[DEMO] Beginner Pottery Workshop')[0];
  assert.equal(pottery.cost.min, 15);
  assert.equal(pottery.registration.status, 'required');
  assert.equal(pottery.registration.url, 'https://example.com/register');

  const concert = by('[DEMO] Lunchtime Park Concert')[0];
  assert.equal(concert.cost.label, 'Free');
  assert.equal(concert.registration.status, 'not-required');
  assert.match(concert.sourceUrl, /instance_id=20261106120000$/);
  assert.equal(concert.location.address, '200 Example Dr, College Station, TX 77840');
});
