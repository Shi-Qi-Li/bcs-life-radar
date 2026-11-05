import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SOURCE, parseTkf, monthlyEvents, itemsFromRecords, fetchSource, monthsBetween, monthUrl, splitTitle, exclusionReason,
  timing, costFor, registrationFor, typesFor, cleanDescription, COST_NOT_LISTED,
} from '../scripts/sources/bcslibrary.mjs';
import { startOfDay, formatDateTime } from '../public/js/shared/time.js';

// Trimmed real response of https://tockify.com/bcslibrary/monthly?startms=1793509200000 (Nov 2026), 12 records.
const html = readFileSync(new URL('./fixtures/bcslibrary-monthly.html', import.meta.url), 'utf8');
const fetchedAt = '2026-11-05T12:00:00.000Z';
const NOV = { fromMs: startOfDay('2026-11-01'), toMs: startOfDay('2026-12-01') };
const records = () => monthlyEvents(parseTkf(html)).events;
const itemsNov = () => itemsFromRecords(records(), { ...NOV, fetchedAt });
const by = (items, re) => items.find((i) => re.test(i.titleRaw));

test('parses the server-rendered window.tkf state: 12 records, America/Chicago, month start echoed', () => {
  const { events, metaData, startms } = monthlyEvents(parseTkf(html));
  assert.equal(events.length, 12);
  assert.equal(metaData.hasNext, false);
  assert.equal(startms, startOfDay('2026-11-01')); // Nov 1 00:00 Chicago (still CDT) = 05:00Z
  assert.equal(events[0].when.start.tzid, 'America/Chicago');
});

test('fails loudly when the page has no bootdata, no window.tkf, broken JSON or another time zone', () => {
  assert.throws(() => parseTkf('<html><head><title>Calendar</title></head><body>moved</body></html>'), /No window\.tkf state/);
  assert.throws(() => parseTkf('<script>window.tkf = {"bootdata": nope};</script>'), /could not be parsed/);
  assert.throws(() => monthlyEvents(parseTkf('<script>window.tkf = {"bootdata":{"query":{"agenda":{"events":[]}},"calendar":{"tzid":"America/Chicago"}}};</script>')), /monthly\.events is missing/);
  const other = html.replace('"tzid":"America/Chicago","locale"', '"tzid":"America/New_York","locale"');
  assert.throws(() => monthlyEvents(parseTkf(other)), /America\/New_York.*expected America\/Chicago/);
  // A literal "</script>" inside the JSON does not break extraction.
  const tricky = '<script>window.tkf = {"bootdata":{"query":{"monthly":{"events":[],"metaData":{}},"startms":1},"calendar":{"tzid":"America/Chicago","name":"</script>"}}};</script><script>x()</script>';
  assert.deepEqual(monthlyEvents(parseTkf(tricky)).events, []);
});

test('times are real Chicago instants: 9:30 AM CST → 15:30Z; zero-length or missing end → no end', () => {
  const { items } = itemsNov();
  const lapsit = by(items, /^Lapsit Storytime/);
  assert.equal(lapsit.start, '2026-11-04T15:30:00.000Z');
  assert.equal(formatDateTime(Date.parse(lapsit.start)), 'Nov 4, 9:30 AM CST');
  assert.equal(lapsit.end, null, 'end.millis === start.millis means no end was entered');
  assert.equal(lapsit.endKnown, false);
  assert.equal(lapsit.allDay, false);
  assert.equal(lapsit.timeNote, 'No end time listed by source');

  const bilingual = by(items, /^Bilingual Storytime/); // record without any `end` object
  assert.equal(bilingual.end, null);
  assert.equal(bilingual.endKnown, false);

  const sale = by(items, /^Friends of the Library Book Sale/); // real end 9:30 AM – 2:00 PM CST
  assert.equal(sale.start, '2026-11-07T15:30:00.000Z');
  assert.equal(sale.end, '2026-11-07T20:00:00.000Z');
  assert.equal(sale.endKnown, true);
  assert.equal(sale.timeNote, null);
});

test('all-day records: Chicago midnight start, exclusive midnight end, multi-day when spanning days', () => {
  const { items } = itemsNov();
  const drive = by(items, /^Aggieland Humane Society Holiday Drive/);
  assert.equal(drive.allDay, true);
  assert.equal(drive.kind, 'multi-day');
  assert.equal(drive.start, '2026-11-16T06:00:00.000Z'); // Nov 16 00:00 CST
  assert.equal(drive.end, '2026-12-16T06:00:00.000Z'); // exclusive: last day Dec 15
  assert.equal(drive.endKnown, true);
  assert.match(drive.timeNote, /daily hours not listed/);
  // An ongoing item that started before the window is kept because it ends inside it.
  const hunt = by(items, /^Fall Word Hunt/);
  assert.equal(hunt.kind, 'multi-day');
  assert.equal(hunt.start, '2026-10-05T05:00:00.000Z'); // Oct 5 00:00 CDT — real zone rules, not a fixed offset
  assert.equal(hunt.end, '2026-12-01T06:00:00.000Z');
  // Synthetic shapes not present in the fixture: a one-day all-day record and an all-day record without end.
  const oneDay = timing({ when: { start: { millis: startOfDay('2026-11-20') }, end: { millis: startOfDay('2026-11-21') }, allDay: true } });
  assert.equal(oneDay.days, 1);
  assert.equal(oneDay.endKnown, true);
  const noEnd = timing({ when: { start: { millis: startOfDay('2026-11-20') }, allDay: true } });
  assert.equal(noEnd.end, startOfDay('2026-11-21'));
  assert.equal(noEnd.endKnown, false);
  assert.match(noEnd.timeNote, /No end date listed/);
});

test('closure notices are excluded and counted; nothing else is', () => {
  const { items, stats } = itemsNov();
  assert.equal(stats.records, 12);
  assert.deepEqual(stats.excluded, { 'closure/notice': 2 });
  assert.equal(items.length, 10);
  assert.ok(!items.some((i) => /LIBRARIES CLOS/i.test(i.titleRaw)));
  assert.equal(exclusionReason({ status: { name: 'scheduled' }, content: { summary: { text: 'LIBRARIES CLOSED FOR THANKSGIVING' } } }), 'closure/notice');
  assert.equal(exclusionReason({ status: { name: 'scheduled' }, content: { summary: { text: 'LIBRARIES CLOSING AT 5 PM FOR THANKSGIVING' } } }), 'closure/notice');
  assert.equal(exclusionReason({ status: { name: 'scheduled' }, content: { summary: { text: 'Holiday Hours Storytime' } } }), 'closure/notice');
  // A venue-bound activity whose title merely contains "closing" is kept.
  assert.equal(exclusionReason({ status: { name: 'scheduled' }, content: { summary: { text: 'Exhibit Closing Reception (CBMPL)' }, place: 'Clara B. Mounce Public Library' } }), null);
  assert.equal(exclusionReason({ status: { name: 'cancelled' }, content: { summary: { text: 'Ukulele Club (CBMPL)' } } }), 'status: cancelled');
});

test('kinds: series occurrences (repeat/rdate/mod) are recurring, singletons one-time; ids and URLs come from eid', () => {
  const { items } = itemsNov();
  const lapsit = by(items, /^Lapsit Storytime/); // kind "repeat"
  assert.equal(lapsit.kind, 'recurring');
  assert.equal(lapsit.seriesId, 'bcslibrary:5737');
  assert.equal(lapsit.id, 'bcslibrary:5737@1793806200000');
  assert.equal(lapsit.sourceUrl, 'https://tockify.com/bcslibrary/detail/5737/1793806200000');

  const stars = by(items, /^Shooting Stars Storytime/); // kind "rdate", rid 5
  assert.equal(stars.kind, 'recurring');
  assert.equal(stars.sourceUrl, 'https://tockify.com/bcslibrary/detail/5761/1794238200000/5');

  const bilingual = by(items, /^Bilingual Storytime/); // kind "mod": moved occurrence, eid.tid !== start
  assert.equal(bilingual.kind, 'recurring');
  assert.equal(bilingual.start, '2026-11-21T16:30:00.000Z');
  assert.equal(bilingual.id, 'bcslibrary:5747@1795278600000');
  assert.equal(bilingual.sourceUrl, 'https://tockify.com/bcslibrary/detail/5747/1794673800000', 'detail URL uses eid.tid, not the start');

  const snap = by(items, /^Brazos Hunger Solutions/);
  assert.equal(snap.kind, 'one-time');
  assert.equal(snap.seriesId, 'bcslibrary:5748');
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

test('branch codes leave the title and resolve the venue; addresses lose ", USA"; no coordinates are invented', () => {
  assert.deepEqual(splitTitle('Lapsit Storytime (CBMPL)'), { title: 'Lapsit Storytime', branch: 'CBMPL' });
  assert.deepEqual(splitTitle('DigiLab Orientation (CHC) - Register starting November 5 at noon'), { title: 'DigiLab Orientation - Register starting November 5 at noon', branch: 'CHC' });
  assert.deepEqual(splitTitle('Meyer Book Club (Meyer Center, online) - Register'), { title: 'Meyer Book Club (Meyer Center, online) - Register', branch: null });

  const { items } = itemsNov();
  const lapsit = by(items, /^Lapsit Storytime/);
  assert.equal(lapsit.title, 'Lapsit Storytime');
  assert.equal(lapsit.titleRaw, 'Lapsit Storytime (CBMPL)');
  assert.deepEqual(lapsit.location, { name: 'Clara B. Mounce Public Library', address: '201 E 26th St, Bryan, TX 77803', lat: null, lng: null });
  assert.deepEqual(lapsit.sourceTags, ['Children', 'CBMPL']);
  const digi = by(items, /^DigiLab Orientation/);
  assert.deepEqual(digi.location, { name: 'Carnegie History Center', address: '111 S Main St, Bryan, TX 77803', lat: null, lng: null });
  const meyer = by(items, /^Meyer Book Club/);
  assert.equal(meyer.location.name, 'Bob and Wanda Meyer Senior and Community Center');
  assert.equal(meyer.location.address, '2275 Dartmouth St, College Station, TX 77840');
  // Branch code resolves the name when the record has no place; the address is not guessed.
  const [only] = itemsFromRecords([{ eid: { uid: '1', tid: startOfDay('2026-11-20', 0, 10), rid: 0 }, when: { start: { millis: startOfDay('2026-11-20') + 36e6 } }, kind: 'singleton', status: { name: 'scheduled' }, content: { summary: { text: 'Test Craft (LJRL)' }, description: { text: 'Make a thing.' } } }], { ...NOV, fetchedAt }).items;
  assert.deepEqual(only.location, { name: 'Larry J. Ringer Library', address: null, lat: null, lng: null });
});

test('cost: "not listed" unless the description states the event is free or names a price', () => {
  const { items } = itemsNov();
  assert.deepEqual(by(items, /^Lapsit Storytime/).cost, COST_NOT_LISTED);
  assert.deepEqual(by(items, /Stewie's Magic Hat/).cost, { status: 'free', label: 'Free (per description)', min: 0 });
  // "digitize … for free" describes a service, not admission → still not listed.
  assert.equal(by(items, /^DigiLab Orientation/).cost.status, 'unknown');
  assert.equal(costFor('Online registration required to receive one free Pokémon Prize Pack per meeting.').status, 'unknown');
  assert.equal(costFor('Admission is free. Bring a friend.').status, 'free');
  assert.deepEqual(costFor('Join us for a workshop. Materials fee: $5 per person.'), { status: 'paid', label: 'Materials fee: $5 per person.', min: 5 });
});

test('registration: description wording, RSVP form on the calendar page, "suggested" stays a hint', () => {
  const { items } = itemsNov();
  assert.equal(by(items, /^Lapsit Storytime/).registration.status, 'not-required'); // "Registration is not required"
  assert.equal(by(items, /^Brazos Hunger Solutions/).registration.status, 'not-required'); // "Registration not required."
  const digi = by(items, /^DigiLab Orientation/); // rsvpLink form + "Registration required." + title "- Register…"
  assert.equal(digi.registration.status, 'required');
  assert.equal(digi.registration.url, 'https://tockify.com/bcslibrary/detail/5728/1794528000000');
  assert.match(digi.registration.label, /"RSVP" form on the calendar page/);
  const meyer = by(items, /^Meyer Book Club/); // form present but "Registration is suggested"
  assert.equal(meyer.registration.status, 'mentioned');
  assert.match(meyer.registration.label, /suggested/);
  assert.equal(by(items, /^Fall Word Hunt/).registration.status, 'unknown');
  const full = registrationFor({ content: { rsvpLink: { buttonLabel: 'RSVP', markedAsFull: true } } }, 'Kids Cooking (LJRL) - Register', 'Ages 8 to 14.', 'https://tockify.com/bcslibrary/detail/1/2');
  assert.equal(full.status, 'required');
  assert.match(full.label, /marked full/);
});

test('types: audience tags and titles drive the taxonomy, "library" is noise, fallback is learning', () => {
  const { items } = itemsNov();
  assert.deepEqual(by(items, /^Lapsit Storytime/).types, ['learning', 'family']);
  assert.ok(by(items, /^Friends of the Library Book Sale/).types.includes('markets'));
  assert.deepEqual(typesFor({ tags: ['Adult'], title: 'Computer Help - Register', description: 'Get help with your library computer questions. For more information, call the library.' }), ['learning']);
  assert.ok(!typesFor({ tags: ['Adult'], title: 'English Conversation Circle', description: 'Practice English at the library.' }).includes('arts'));
  assert.deepEqual(typesFor({ tags: ['Tween'], title: 'Tween Craft Night', description: '' }), ['family', 'arts']);
});

test('description keeps the source text minus dead calls-to-action; phone becomes contact; shape matches other sources', () => {
  assert.equal(cleanDescription('Fun stories. For more information, call (979) 209-5600. Sign up for our newsletter here.'), 'Fun stories. For more information, call (979) 209-5600.');
  assert.equal(cleanDescription('Click here for more information. Details inside.'), 'Details inside.');
  const { items } = itemsNov();
  const lapsit = by(items, /^Lapsit Storytime/);
  assert.ok(!/newsletter/.test(lapsit.description));
  assert.equal(lapsit.contact, '(979) 209-5600');
  assert.ok(lapsit.summary.length <= 201 && lapsit.description.length <= 601);
  assert.equal(lapsit.websiteUrl, SOURCE.homepage);
  assert.equal(lapsit.sourceId, 'bcslibrary');
  assert.equal(lapsit.sourceName, 'Bryan + College Station Public Library');
  assert.equal(lapsit.lastVerified, fetchedAt);
  const shape = ['id', 'seriesId', 'kind', 'title', 'description', 'summary', 'location', 'cost', 'registration', 'types', 'sourceTags', 'contact', 'websiteUrl', 'sourceId', 'sourceName', 'sourceUrl', 'lastVerified', 'start', 'end', 'endKnown', 'allDay', 'timeNote'];
  for (const it of items) for (const k of shape) assert.ok(k in it, `${it.id} lacks ${k}`);
});

test('window: occurrences outside [fromMs, toMs) are dropped, ongoing multi-day items are kept', () => {
  const win = { fromMs: startOfDay('2026-11-10'), toMs: startOfDay('2026-11-20'), fetchedAt };
  const { items, stats } = itemsFromRecords(records(), win);
  const titles = items.map((i) => i.title);
  assert.ok(!titles.includes('Lapsit Storytime'), 'Nov 4 is before the window');
  assert.ok(!titles.some((t) => /Stewie/.test(t)), 'Nov 22 is after the window');
  assert.ok(titles.includes('Fall Word Hunt'), 'Oct 5 – Nov 30 overlaps the window');
  assert.ok(titles.includes('Aggieland Humane Society Holiday Drive'));
  assert.ok(titles.includes('DigiLab Orientation - Register starting November 5 at noon'));
  // Out: Lapsit (Nov 4), SNAP talk (Nov 5), book sale (Nov 7), Shooting Stars (Nov 9), Bilingual (Nov 21), Stewie (Nov 22).
  assert.equal(stats.outsideWindow, 6);
  assert.equal(items.length, 4);
  assert.equal(items.length + stats.outsideWindow + stats.excluded['closure/notice'], 12);
});

test('fetchSource: one monthly page per Chicago month, deterministic startms, de-duplicated across pages, stats', async () => {
  assert.deepEqual(monthsBetween(startOfDay('2026-11-05'), startOfDay('2026-11-05', 31)), [{ y: 2026, m: 11 }, { y: 2026, m: 12 }]);
  assert.deepEqual(monthsBetween(startOfDay('2026-12-20'), startOfDay('2027-01-20')), [{ y: 2026, m: 12 }, { y: 2027, m: 1 }]);
  assert.equal(monthUrl({ y: 2026, m: 11 }), 'https://tockify.com/bcslibrary/monthly?startms=1793509200000'); // Nov 1 00:00 CDT
  assert.equal(monthUrl({ y: 2026, m: 12 }), 'https://tockify.com/bcslibrary/monthly?startms=1796104800000'); // Dec 1 00:00 CST

  const urls = [], logs = [];
  const fetchText = async (u) => { urls.push(u); return html; }; // the same (Nov) page for both months
  const r = await fetchSource({ fetchText, fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-11-05', 31), log: (m) => logs.push(m) });
  assert.deepEqual(urls, ['https://tockify.com/bcslibrary/monthly?startms=1793509200000', 'https://tockify.com/bcslibrary/monthly?startms=1796104800000']);
  assert.equal(r.stats.requests, 2);
  assert.deepEqual(r.stats.months, ['2026-11', '2026-12']);
  assert.equal(r.stats.records, 12, 'records seen on both pages are merged by uid/tid/rid');
  assert.deepEqual(r.stats.excluded, { 'closure/notice': 2 });
  assert.equal(r.stats.items, r.items.length);
  assert.equal(r.items.length, 9); // 10 activities minus Lapsit on Nov 4
  assert.deepEqual(r.stats.truncatedMonths, []);
  assert.ok(r.stats.notes.some((n) => /2026-12: page reported startms/.test(n)), 'a page for another month is noted');
  assert.ok(Date.parse(r.fetchedAt) > 0);

  // A capped month (metaData.hasNext) is reported, not silently accepted.
  const capped = html.replace('"hasNext":false', '"hasNext":true');
  const r2 = await fetchSource({ fetchText: async () => capped, fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-11-20'), log: (m) => logs.push(m) });
  assert.deepEqual(r2.stats.truncatedMonths, ['2026-11']);
  assert.ok(logs.some((m) => /capped/.test(m)));

  // Failures propagate so refresh keeps the last good data.
  await assert.rejects(() => fetchSource({ fetchText: async () => '<html>maintenance</html>', fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-11-20') }), /No window\.tkf state/);
  await assert.rejects(() => fetchSource({ fetchText: async () => { throw new Error('HTTP 503'); }, fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-11-20') }), /HTTP 503/);
});
