import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsFromICS } from '../scripts/sources/cstx.mjs';
import { startOfDay } from '../public/js/shared/time.js';

const wrap = (body) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR\n`;
const win = { fromMs: startOfDay('2026-12-01'), toMs: startOfDay('2026-12-31'), fetchedAt: 'x' };

test('X-INSTANT-EVENT placeholder end (23:59:59) is published as "end not listed", never as a duration', () => {
  const ics = wrap(`BEGIN:VEVENT\nUID:p\nSUMMARY:Parade\nDTSTART;TZID=CST6CDT:20261205T160000\nDTEND;TZID=CST6CDT:20261205T235959\nX-INSTANT-EVENT:1\nX-COST-TYPE:free\nX-TAGS;LANGUAGE=en-US:Free,Parks\nCATEGORIES;LANGUAGE=en-US:Event\nDESCRIPTION:<p>Annual parade.</p>\nX-CUSTOM-FILTER:Type:Public\nEND:VEVENT`);
  const { items } = itemsFromICS(ics, win);
  assert.equal(items.length, 1);
  assert.equal(items[0].end, null);
  assert.equal(items[0].endKnown, false);
  assert.equal(items[0].timeNote, 'No end time listed by source');
  assert.equal(items[0].kind, 'one-time');
});

test('STATUS:SOLD_OUT keeps the item but marks the registration line', () => {
  const ics = wrap(`BEGIN:VEVENT\nUID:s\nSUMMARY:Holiday Dinner\nDTSTART;TZID=CST6CDT:20261210T180000\nDTEND;TZID=CST6CDT:20261210T200000\nSTATUS:SOLD_OUT\nX-COST:$20\nX-COST-TYPE:paid\nX-TAGS;LANGUAGE=en-US:Paid,Registration Required\nCATEGORIES;LANGUAGE=en-US:Program\nDESCRIPTION:<p>Dinner.</p><a href='https://example.com/reg'>Register</a>\nX-CUSTOM-FILTER:Type:Public\nEND:VEVENT`);
  const { items, stats } = itemsFromICS(ics, win);
  assert.equal(items.length, 1);
  assert.equal(stats.soldOut, 1);
  assert.match(items[0].registration.label, /Sold out/);
  assert.equal(items[0].registration.url, 'https://example.com/reg');
});

test('boilerplate button lines are stripped from City descriptions', () => {
  const ics = wrap(`BEGIN:VEVENT\nUID:b\nSUMMARY:Walk\nDTSTART;TZID=CST6CDT:20261203T090000\nDTEND;TZID=CST6CDT:20261203T100000\nX-COST-TYPE:free\nCATEGORIES;LANGUAGE=en-US:Event\nDESCRIPTION:<p>A guided walk.</p><div class='btn'><a href='https://example.com'>Reserve Your Spot</a></div>\nX-CUSTOM-FILTER:Type:Public\nEND:VEVENT`);
  const { items } = itemsFromICS(ics, win);
  assert.equal(items[0].description, 'A guided walk.');
});
