// Parsing rules driven by the 2026-11-05 data-quality audit. Fixtures under tests/fixtures/ are trimmed
// copies of real pages/feeds (content verbatim), so every expected string below is what the source says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { htmlToText, cleanDescription, costFromText, registrationFrom, extractLinks, nameSimilarity, dedupe, duplicateReason } from '../scripts/lib/normalize.mjs';
import { parseICS, unescapeText } from '../scripts/lib/ics.mjs';
import { parseDetail, itemsFromDetail, fetchSource, tidyAddress, venueFromTitle, venueFromDescription, weekdayNote } from '../scripts/sources/destinationBryan.mjs';
import { mapLimit } from '../scripts/refresh.mjs';
import { startOfDay, formatDateTime } from '../public/js/shared/time.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const page = (name, slug) => parseDetail(fx(name), `https://www.destinationbryan.com/events/${slug}/`);
const WIN = { fromMs: startOfDay('2026-11-05'), toMs: startOfDay('2026-12-06'), fetchedAt: '2026-11-05T12:00:00.000Z' };
const items = (name, slug) => itemsFromDetail(page(name, slug), null, WIN);
const PARTICIPANTS_ONLY = 'Sign-up mentioned only for performers/vendors/participants — nothing listed for attendees';

// City feed: real VEVENTs → { title, html, text, links, tags }
const cityEvents = Object.fromEntries(parseICS(fx('city-registration.ics')).map((ev) => {
  const html = unescapeText(ev.DESCRIPTION[0].value);
  const tags = unescapeText(ev['X-TAGS'][0].value).split(',').map((s) => s.trim());
  return [ev.SUMMARY[0].value, { html, text: htmlToText(html), links: extractLinks(html), tags }];
}));

test('costFromText: min is the typical adult price; "free to watch/attend" with other amounts is mixed with min 0', () => {
  const c = (s) => costFromText(s);
  assert.deepEqual(c('Free to Watch | $20 to Participate'), { status: 'mixed', label: 'Free to Watch | $20 to Participate', min: 0 }); // Battle for Bryan
  assert.deepEqual(c('Adults $25, Children $10, Children under 5 are FREE'), { status: 'mixed', label: 'Adults $25, Children $10, Children under 5 are FREE', min: 25 }); // History in Motion
  assert.deepEqual(c('$10 general admission / $5 VFW members'), { status: 'paid', label: '$10 general admission / $5 VFW members', min: 10 }); // Aaron Ricardo
  assert.deepEqual(c('$12 for adults | $5 for kids (6-17) | Free for children (5 and under)'), { status: 'mixed', label: '$12 for adults | $5 for kids (6-17) | Free for children (5 and under)', min: 12 }); // E Pluribus Unum
  assert.equal(c('$20 at the Door; Free for 16 and under').min, 20); // Texas Rails
  assert.equal(c('$20 at the Door; Free for 16 and under').status, 'mixed');
  assert.equal(c('$24 General Admission (w/ Color Run) $19 General Admission (w/o Color Run) $12 Kids Admission').min, 19); // Paint-a-Palooza: "w/" is not a separator
  assert.equal(c('$5 Resident/$6 Non-Resident').min, 5); // Walk Like an Engineer
  assert.equal(c('$32 -$64 depending on section.').min, 32);
  assert.deepEqual(c('$5-$10'), { status: 'paid', label: '$5-$10', min: 5 });
  assert.equal(c('$10 for students').min, 10, 'an audience-only price is still the only price listed');
  // "Attendance is free, with lunch available for $10 …" (Exploring History Luncheon description)
  const lunch = c('Attendance is free, with lunch available for $10 for residents and $12 for non-residents.');
  assert.equal(lunch.status, 'mixed'); assert.equal(lunch.min, 0);
  assert.deepEqual(c('TBD'), { status: 'unknown', label: 'TBD', min: null });
  assert.equal(c('Donations welcome').status, 'unknown');
  assert.deepEqual(c('Suggested donation $5'), { status: 'unknown', label: 'Suggested donation $5', min: null });
  assert.deepEqual(c('$0'), { status: 'free', label: 'Free', min: 0 });
  assert.deepEqual(c('Free'), { status: 'free', label: 'Free', min: 0 });
  assert.deepEqual(c('Free Entry'), { status: 'free', label: 'Free', min: 0 });
  assert.deepEqual(c('$38'), { status: 'paid', label: '$38', min: 38 });
  assert.deepEqual(c(''), { status: 'unknown', label: 'Cost not listed', min: null });
  assert.deepEqual(c('Admission fee'), { status: 'unknown', label: 'Admission fee (price not stated)', min: null });
});

test('htmlToText: inline tags do not split words or pad punctuation; block tags still break lines', () => {
  const firstFriday = (/<div class="detail__summary[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(fx('bryan-first-friday.html')) || [])[1];
  const text = htmlToText(firstFriday);
  assert.match(text, /Sponsored by Baylor Scott & White Health\.\n/);
  assert.match(text, /Click Here To View An Interactive Map Of This Month's Activities\.\n/);
  assert.doesNotMatch(text, / [.,;:!?]/, 'no space before punctuation');
  assert.match(text, /^The streets of Historic Downtown Bryan transform into one big stage/);
  // City (Seminar Supper): "<a>here</a>, or" reads "here, or"; the button label becomes its own line.
  assert.match(cityEvents['Seminar Supper'].text, /subscribe to here, or on the City/);
  assert.match(cityEvents['Seminar Supper'].text, /\nRegister for Seminar Supper\n/);
  assert.equal(htmlToText('<p>7:00 PM <span>–</span> <b>9:00</b> PM</p>'), '7:00 PM – 9:00 PM');
});

test('cleanDescription: button text and publisher boilerplate are dropped, real sentences kept', () => {
  const d = page('bryan-first-friday.html', 'first-friday-event');
  assert.equal(d.description, 'The streets of Historic Downtown Bryan transform into one big stage on the First Friday of each month with live music, performances, art demonstrations, and unique & interactive events and activities! Plus, all your favorite Downtown Bryan shops & restaurants stay open late for the evening. This is the place to be on the First Friday of each month in Aggieland!');
  for (const bad of [/Click Here/, /WEATHER UPDATE/, /meteorologists/, /Sponsored by/]) assert.doesNotMatch(d.description, bad);
  // The links themselves are still collected for the registration/website fields.
  assert.ok(d.links.some((l) => l.text === "Click Here To View An Interactive Map Of This Month's Activities"));
  // City: a bare "Reserve Your Spot" button line goes; the sentence with the requirement stays.
  const walk = cleanDescription(cityEvents['Walk Like an Engineer'].text);
  assert.doesNotMatch(walk, /Reserve Your Spot/);
  assert.match(walk, /The cost is \$5 for residents and \$6 for non-residents\. Registration is required\./);
  assert.doesNotMatch(cleanDescription(cityEvents['Exploring History Luncheon: “College Station: A City Founded with Parks”'].text), /Reserve Your Lunch/);
  // A genuine sentence that merely starts with one of the phrases is not boilerplate.
  const keep = 'Learn more about the exhibit from the curator, who will walk you through every gallery and answer questions about the collection and its history.';
  assert.equal(cleanDescription(keep), keep);
  assert.equal(cleanDescription(''), '');
});

test('registrationFrom: RSVP windows and "register by" are required; the Register/RSVP/Click-here link is the url', () => {
  const supper = cityEvents['Seminar Supper'];
  const r = registrationFrom({ description: supper.text, links: supper.links });
  assert.equal(r.status, 'required');
  assert.equal(r.url, 'https://airtable.com/appXrenPOgMpfJqUH/shriHL0sj7LEiakBa', 'the "Register for Seminar Supper" link, not the newsletter "here" link');
  const walk = cityEvents['Walk Like an Engineer'];
  const w = registrationFrom({ tags: walk.tags, description: walk.text, links: walk.links });
  assert.equal(w.status, 'required');
  assert.match(w.url, /myvscloud\.com/);
  assert.equal(registrationFrom({ description: 'Please register by Friday, Nov. 13.' }).status, 'required');
  assert.equal(registrationFrom({ description: 'Registration closes Nov 5.' }).status, 'required');
  assert.equal(registrationFrom({ description: 'Lunch reservations are required by Friday.' }).status, 'required');
  assert.equal(registrationFrom({ description: 'RSVP to the open house by Friday.' }).status, 'mentioned', '"open house" is not an RSVP window');
  assert.equal(registrationFrom({ description: 'Just show up.' }).status, 'unknown');
  assert.equal(registrationFrom({ description: 'No registration required.' }).status, 'not-required');
});

test('registrationFrom: performer/vendor/participant sign-up is not attendee registration', () => {
  const openMic = items('bryan-open-mic-palace.html', 'open-mic-at-the-palace-theater');
  assert.ok(openMic.length >= 4);
  assert.deepEqual(openMic[0].registration, { status: 'unknown', label: PARTICIPANTS_ONLY, url: null });
  const market = items('bryan-art-market-degallery.html', 'first-saturday-art-market-at-degallery-2');
  assert.equal(market[0].registration.status, 'unknown');
  assert.equal(market[0].registration.label, PARTICIPANTS_ONLY);
  const battle = items('bryan-battle-for-bryan.html', 'battle-for-bryan-at-the-hilton-garden-inn')[0];
  assert.equal(battle.registration.status, 'unknown', 'competitors register; spectators do not');
  assert.equal(battle.registration.label, PARTICIPANTS_ONLY);
  assert.equal(battle.registration.url, 'https://www.start.gg/tournament/battle-for-bryan-9-750-pot-bonus/details', 'the "Click here" sign-up link is kept');
  // An attendee mention survives even when a vendor sentence is dropped.
  assert.equal(registrationFrom({ description: 'Vendors must register by March 1. Attendees can RSVP on Facebook.' }).status, 'mentioned');
});

test('registrationFrom: a booking link that is an RSVP/info page is "mentioned", a ticketing host is "tickets"', () => {
  const party = items('bryan-hunger-games-party.html', 'hunger-games-sunrise-on-the-reaping-early-listening-party-curious-collections-at-the-record-garage')[0];
  assert.equal(party.registration.status, 'mentioned');
  assert.equal(party.registration.label, 'Event page / RSVP link');
  assert.match(party.registration.url, /^https:\/\/curiouscollectionstx\.com\/blogs\//);
  assert.equal(registrationFrom({ description: 'RSVP for the show.', ticketUrl: 'https://www.eventbrite.com/e/x' }).status, 'tickets');
  const palooza = items('bryan-paint-a-palooza.html', 'paint-a-palooza-26')[0];
  assert.equal(palooza.registration.status, 'tickets');
  assert.equal(palooza.registration.url, 'https://aggieoriginals.com/paint-a-palooza');
});

test('Destination Bryan: an empty admission line with prices in the description is "paid", quoting the sentence', () => {
  const zoomz = items('bryan-college-night-zoomz.html', 'college-night-at-zoomz-entertainment');
  assert.ok(zoomz.length >= 4);
  assert.equal(zoomz[0].cost.status, 'paid');
  assert.equal(zoomz[0].cost.min, null);
  assert.equal(zoomz[0].cost.label, 'Price in description: We’re also running Walk-On GellyBall for $30 per person and Walk-On 50cal paintball all night long.');
  // Battle for Bryan: "Free to Watch | $20 to Participate" → attending is free.
  const battle = items('bryan-battle-for-bryan.html', 'battle-for-bryan-at-the-hilton-garden-inn')[0];
  assert.deepEqual(battle.cost, { status: 'mixed', label: 'Free to Watch | $20 to Participate', min: 0 });
  assert.equal(items('bryan-paint-a-palooza.html', 'paint-a-palooza-26')[0].cost.min, 19);
});

test('Destination Bryan: venue name falls back to the title or description; addresses are tidied', () => {
  const battle = page('bryan-battle-for-bryan.html', 'battle-for-bryan-at-the-hilton-garden-inn');
  assert.deepEqual(battle.location, { name: 'The Hilton Garden Inn', address: '3081 University Dr. E, Bryan, TX 77802' });
  const market = page('bryan-farmers-market.html', 'the-farmers-market-in-brazos-county');
  assert.deepEqual(market.location, { name: 'Midtown Park', address: '206 W Villa Maria Road, Bryan, TX 77801' });
  assert.equal(page('bryan-pints-and-pages.html', '2nd-annual-pints-and-pages-book-fair-at-kinderhill-brew-lab').location.address, '505 W 31st St., Bryan, TX 77803'); // was ", 505 W 31st St."
  assert.equal(page('bryan-art-market-degallery.html', 'first-saturday-art-market-at-degallery-2').location.address, '930 North Rosemary Drive, Bryan, TX 77802'); // was "930North"
  assert.equal(tidyAddress(', 505 W 31st St.'), '505 W 31st St.');
  assert.equal(tidyAddress('930North Rosemary Drive'), '930 North Rosemary Drive');
  assert.equal(tidyAddress('202B W 26th Street'), '202B W 26th Street');
  assert.equal(tidyAddress('19124 HWY 6 S'), '19124 HWY 6 S');
  assert.equal(venueFromTitle("Trivia At Murphy's Law"), "Murphy's Law");
  assert.equal(venueFromTitle('Lick Creek Park in the Dark'), null);
  assert.equal(venueFromTitle('Movie in the Park: Jurassic Park (PG-13)'), null);
  assert.equal(venueFromDescription('Located in Midtown Park, The Farmers\' Market in Brazos County is a venue'), 'Midtown Park');
  assert.equal(venueFromDescription('Food trucks will be located at the north entrance.'), null);
});

test('Destination Bryan: a title that names a different venue than the listed address gets a locationNote', () => {
  const expo = items('bryan-cards-expo.html', 'tradingcardsmarketplace-com-cards-comics-collectibles-expo')[0];
  assert.equal(expo.location.name, 'Brazos County Expo Complex');
  assert.equal(expo.locationNote, 'Title names a different venue than the listed address — confirm'); // title: "… at The Brazos Center"
  assert.equal(items('bryan-hunger-games-party.html', 'hunger-games-sunrise-on-the-reaping-early-listening-party-curious-collections-at-the-record-garage')[0].locationNote, undefined);
  assert.equal(items('bryan-battle-for-bryan.html', 'battle-for-bryan-at-the-hilton-garden-inn')[0].locationNote, undefined);
  assert.ok(nameSimilarity('The Brazos Center', 'Brazos County Expo Complex') < 0.5);
  assert.equal(nameSimilarity('The Kimbell', 'Kimbell Cultural Event Center'), 1);
  assert.equal(nameSimilarity('Curious Collections', 'Curious Collections At The Record Garage'), 1);
  assert.equal(nameSimilarity('Wolf Pen Creek Park', 'Lake Walk'), 0);
});

test('Destination Bryan: a 12:00 AM start with an afternoon end is treated as "start not listed"; long spans are flagged', () => {
  const [p] = items('bryan-paint-a-palooza.html', 'paint-a-palooza-26'); // page says "12:00 AM – 4:00 PM"
  assert.equal(p.allDay, true);
  assert.equal(p.endKnown, true);
  assert.equal(p.start, new Date(startOfDay('2026-11-08')).toISOString());
  assert.equal(formatDateTime(Date.parse(p.end)), 'Nov 8, 4:00 PM CST');
  assert.equal(p.timeNote, 'Source lists a 12:00 AM start — likely an error; ends 4:00 PM');
  const base = page('bryan-battle-for-bryan.html', 'battle-for-bryan-at-the-hilton-garden-inn');
  const [long] = itemsFromDetail({ ...base, times: [{ hh: 7, mm: 0 }, { hh: 23, mm: 0 }] }, null, WIN);
  assert.equal(long.allDay, false);
  assert.equal(long.timeNote, 'Listed as 16 hours long (7:00 AM – 11:00 PM) — confirm with the venue');
  const [normal] = itemsFromDetail({ ...base, times: [{ hh: 10, mm: 0 }, { hh: 20, mm: 0 }] }, null, WIN);
  assert.equal(normal.timeNote, null);
  const [lateNight] = itemsFromDetail({ ...base, times: [{ hh: 22, mm: 0 }, { hh: 1, mm: 30 }] }, null, WIN);
  assert.equal(lateNight.timeNote, null, 'ending after midnight is normal');
});

test('Destination Bryan: "every Thursday" in the text vs Wednesdays in the date list is flagged on every date', () => {
  const trivia = items('bryan-trivia-murphys-law.html', 'trivia-night-at-murphys-law-2');
  assert.equal(trivia.length, 4);
  assert.equal(trivia[0].timeNote, 'Listed dates are Wednesdays but the description says every Thursday — confirm with the venue');
  assert.equal(trivia[1].timeNote, 'Time copied from the series listing — confirm for this date · Listed dates are Wednesdays but the description says every Thursday — confirm with the venue');
  // Consistent pages get no note.
  const zoomz = items('bryan-college-night-zoomz.html', 'college-night-at-zoomz-entertainment'); // "College Night is every Friday!" on Fridays
  assert.equal(zoomz[0].timeNote, null);
  const fridays = [{ y: 2026, m: 11, d: 6 }, { y: 2026, m: 11, d: 13 }];
  assert.equal(weekdayNote('Join us every Friday at 6:30 am', fridays), null);
  assert.equal(weekdayNote('Open every Tuesday and Friday', fridays), null);
  assert.match(weekdayNote('Live music every Saturday', fridays), /Listed dates are Fridays but the description says every Saturday/);
  assert.equal(weekdayNote('every Saturday', [{ y: 2026, m: 11, d: 6 }, { y: 2026, m: 11, d: 12 }]), null, 'mixed weekdays: nothing definite to compare');
  assert.equal(weekdayNote('No schedule words here', fridays), null);
});

test('Destination Bryan: an ended event page (served like a live one) is counted as skipped.ended', async () => {
  const sitemap = `<urlset>${Array.from({ length: 20 }, (_, i) => `<url><loc>https://www.destinationbryan.com/events/ev-${i}/</loc></url>`).join('')}</urlset>`;
  const ended = fx('bryan-ended-shawshank.html'); // "Wednesday, November 4, 2026 6:00 PM – 8:00 PM"
  const r = await fetchSource({ fetchText: async (u) => (u.endsWith('.xml') ? sitemap : ended), mapLimit, fromMs: WIN.fromMs, toMs: WIN.toMs });
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.stats.skipped, { 'ended (every listed date is in the past)': 20 });
});

// --- dedupe -------------------------------------------------------------------------------------
let n = 0;
function mkItem(over = {}) {
  const start = over.start || '2026-11-07T18:00:00.000Z';
  return {
    seriesId: `s${n++}`, kind: 'one-time', title: 'Lunchtime Park Concert', description: 'x', summary: 'x',
    location: { name: 'Wolf Pen Creek Park', address: '1015 Colgate Dr', lat: null, lng: null },
    cost: { status: 'unknown', label: 'Cost not listed', min: null }, registration: { status: 'unknown', label: 'n/a', url: null },
    types: [], sourceTags: [], contact: null, sourceId: 'cstx', sourceName: 'City', sourceUrl: 'https://city.example/1', lastVerified: 'x',
    start, end: null, endKnown: false, allDay: false, timeNote: null, ...over, id: over.id || `${over.seriesId || `s${n}`}@${start}`,
  };
}
const bryan = (over = {}) => mkItem({ sourceId: 'dbryan', sourceName: 'Destination Bryan', sourceUrl: 'https://bryan.example/1', title: 'Lunchtime Concert in the Park', ...over });

test('dedupe: across sources, same Chicago day within 30 minutes + similar title + compatible venue merges, with a reason', () => {
  const a = mkItem();
  const b = bryan({ start: '2026-11-07T18:20:00.000Z', location: { name: 'Wolf Pen Creek Amphitheater', address: null, lat: 30.6, lng: -96.3 } });
  const { items: out, removed } = dedupe([a, b]);
  assert.equal(removed, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].alsoListedBy.length, 1);
  assert.match(out[0].alsoListedBy[0].reason, /same day, starts 20 min apart, similar titles \(1\.00\), same venue/);
  assert.equal(out[0].alsoListedBy[0].sourceName, out[0].sourceId === 'cstx' ? 'Destination Bryan' : 'City');
  // Exact same minute still merges, and the reason says so.
  assert.match(duplicateReason(mkItem(), bryan()), /^same start, similar titles/);
  // One side without a venue name is compatible.
  assert.match(duplicateReason(mkItem(), bryan({ start: '2026-11-07T18:25:00.000Z', location: null })), /one venue not listed/);
});

test('dedupe: distinct events are never merged (time window, Chicago day, venue, title, source rules)', () => {
  assert.equal(duplicateReason(mkItem(), bryan({ start: '2026-11-07T18:45:00.000Z' })), null, '45 minutes apart');
  // 11:50 PM and 12:10 AM Central are 20 minutes apart but on different Chicago days.
  assert.equal(duplicateReason(mkItem({ start: '2026-11-08T05:50:00.000Z' }), bryan({ start: '2026-11-08T06:10:00.000Z' })), null);
  assert.equal(duplicateReason(mkItem(), bryan({ location: { name: 'Lake Walk', address: null, lat: null, lng: null } })), null, 'different venues, same title and minute');
  assert.equal(duplicateReason(mkItem({ title: 'Día de los Muertos in Historic Downtown Bryan' }), bryan({ title: 'First Friday in Historic Downtown Bryan' })), null, 'similar venue, different titles');
  // Same source: different series merge only at the exact same minute with a near-identical title.
  assert.match(duplicateReason(mkItem({ title: "Karaoke at Murphy's Law" }), mkItem({ title: "Karaoke Night at Murphy's Law" })), /^same source, same start/);
  assert.equal(duplicateReason(mkItem({ title: "Karaoke at Murphy's Law" }), mkItem({ title: "Karaoke Night at Murphy's Law", start: '2026-11-07T18:10:00.000Z' })), null);
  assert.equal(duplicateReason(mkItem({ title: 'Open Mic Night at The Palace Theater' }), mkItem({ title: 'Open Mic at The 101' })), null);
  assert.equal(duplicateReason(mkItem({ seriesId: 'same' }), mkItem({ seriesId: 'same', start: '2026-11-14T18:00:00.000Z' })), null, 'two dates of one series');
  assert.equal(duplicateReason(mkItem({ kind: 'place', start: null }), mkItem({ kind: 'place', start: null })), null);
  const { items: out, removed } = dedupe([mkItem(), bryan({ start: '2026-11-07T18:45:00.000Z' })]);
  assert.equal(removed, 0); assert.equal(out.length, 2);
});
