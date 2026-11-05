import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, occurrences } from '../scripts/lib/ics.mjs';

const iso = (t) => new Date(t).toISOString();
const ev = (body) => parseICS(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\n${body}\nEND:VEVENT\nEND:VCALENDAR`)[0];

test('occurrence keys are zero-padded: a January EXDATE must not delete a November date', () => {
  const e = ev('DTSTART;TZID=CST6CDT:20260105T180000\nDTEND;TZID=CST6CDT:20260105T190000\nRRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU\nEXDATE;TZID=CST6CDT:20260119T180000');
  const { occurrences: occ } = occurrences(e, Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-12-05T00:00:00Z'));
  assert.deepEqual(occ.map((o) => iso(o.startMs)), [
    '2026-11-10T00:00:00.000Z', // Mon Nov 9, 6 PM CST — would vanish with an unpadded key (2026119 == Jan 19)
    '2026-11-17T00:00:00.000Z', '2026-11-24T00:00:00.000Z', '2026-12-01T00:00:00.000Z',
  ]);
});

test('UNTIL as a date-time is an inclusive bound on the instant', () => {
  // Daily at 6 PM CST; UNTIL = Nov 8 at 12:00Z (6 AM CST) → Nov 8's 6 PM occurrence is excluded, Nov 7's kept.
  const e = ev('DTSTART;TZID=CST6CDT:20261105T180000\nDTEND;TZID=CST6CDT:20261105T190000\nRRULE:FREQ=DAILY;UNTIL=20261108T120000Z');
  const { occurrences: occ } = occurrences(e, Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-11-12T00:00:00Z'));
  assert.deepEqual(occ.map((o) => iso(o.startMs)), ['2026-11-06T00:00:00.000Z', '2026-11-07T00:00:00.000Z', '2026-11-08T00:00:00.000Z']);
  // A date-only UNTIL still includes the whole last day.
  const e2 = ev('DTSTART;TZID=CST6CDT:20261105T180000\nDTEND;TZID=CST6CDT:20261105T190000\nRRULE:FREQ=DAILY;UNTIL=20261108');
  assert.equal(occurrences(e2, Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-11-12T00:00:00Z')).occurrences.length, 4);
});

test('zero-length all-day event lasts one day; DTEND before DTSTART means end not listed', () => {
  const a = ev('DTSTART;VALUE=DATE:20261107\nDTEND;VALUE=DATE:20261107');
  const ra = occurrences(a, Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(ra.occurrences.length, 1);
  assert.equal(iso(ra.occurrences[0].endMs), '2026-11-08T06:00:00.000Z'); // midnight CST after Nov 7
  const b = ev('DTSTART;TZID=CST6CDT:20261107T180000\nDTEND;TZID=CST6CDT:20261107T170000');
  const rb = occurrences(b, Date.parse('2026-11-05T00:00:00Z'), Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(rb.occurrences[0].endMs, null);
  assert.ok(rb.notes.some((n) => /not after DTSTART/.test(n)));
});
