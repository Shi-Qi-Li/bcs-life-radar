#!/usr/bin/env node
// Build public/data/demo-events.json: clearly-labelled FICTIONAL data, pushed through the same
// pipeline (ICS parsing, recurrence, expiry, dedupe) as real data, with a fixed demo clock.
// Open the site with ?demo=1 to view it. Used by the UI tests for deterministic results.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { itemsFromICS } from './sources/cstx.mjs';
import { itemsFromDetail } from './sources/destinationBryan.mjs';
import { finalizeItems } from './refresh.mjs';
import { dayKey, startOfDay } from '../public/js/shared/time.js';

export const DEMO_NOW = '2026-11-06T16:00:00.000Z'; // Fri Nov 6, 2026, 10:00 AM CST

export async function buildDemo() {
  const now = Date.parse(DEMO_NOW);
  const fromMs = startOfDay(dayKey(now));
  const toMs = startOfDay(dayKey(now), 31);
  const fetchedAt = '2026-11-06T12:00:00.000Z';
  const ics = await readFile(new URL('../tests/fixtures/demo.ics', import.meta.url), 'utf8');
  const city = itemsFromICS(ics, { fromMs, toMs, fetchedAt }).items.map((i) => ({ ...i, sourceName: 'City of College Station Calendar (DEMO)' }));

  const bryanBase = { links: [], ticketUrl: null, websiteUrl: null };
  const bryan = [
    // Same concert as the City entry, listed again by the second source -> must be merged as a duplicate.
    { ...bryanBase, url: 'https://www.destinationbryan.com/events/demo-lunch-concert/', title: '[DEMO] Lunchtime Concert in the Park', description: 'Fictional duplicate listing of the lunchtime concert.', dates: [{ y: 2026, m: 11, d: 6 }], times: [{ hh: 12, mm: 0 }, { hh: 13, mm: 0 }], upcoming: [], admission: 'Free', location: { name: 'Demo Amphitheater', address: '200 Example Dr, College Station, TX 77840' } },
    { ...bryanBase, url: 'https://www.destinationbryan.com/events/demo-quilt-exhibit/', title: '[DEMO] Community Quilt Exhibit', description: 'Fictional multi-day exhibit.', dates: [{ y: 2026, m: 11, d: 1 }, { y: 2026, m: 12, d: 31 }], times: [{ hh: 10, mm: 0 }, { hh: 16, mm: 0 }], upcoming: [], admission: '$8 adults | $4 kids | Free under 5', location: { name: 'Demo History Museum', address: '900 Example Pkwy, Bryan, TX 77802' } },
    { ...bryanBase, url: 'https://www.destinationbryan.com/events/demo-open-mic/', title: '[DEMO] Wednesday Open Mic', description: 'Fictional weekly open mic. Sign up at the door.', dates: [{ y: 2026, m: 11, d: 11 }], times: [{ hh: 19, mm: 0 }, { hh: 21, mm: 0 }], upcoming: [{ y: 2026, m: 11, d: 11 }, { y: 2026, m: 11, d: 18 }, { y: 2026, m: 11, d: 25 }], admission: 'Free', location: { name: 'Demo Coffee House', address: '800 Example Main St, Bryan, TX 77803' } },
    { ...bryanBase, url: 'https://www.destinationbryan.com/events/demo-craft-market/', title: '[DEMO] Downtown Craft Market', description: 'Fictional market with no listed time or cost.', dates: [{ y: 2026, m: 11, d: 7 }], times: [], upcoming: [], admission: '', location: { name: null, address: '1000 Example Main St, Bryan, TX 77803' } },
  ];
  const coords = { 'demo-lunch-concert': [30.62, -96.31], 'demo-quilt-exhibit': [30.66, -96.36], 'demo-open-mic': [30.674, -96.371], 'demo-craft-market': [30.675, -96.372] };
  const bryanItems = bryan.flatMap((d) => {
    const k = d.url.split('/events/')[1].replace('/', '');
    const [lat, lng] = coords[k];
    return itemsFromDetail(d, { categories: new Set(), lat, lng }, { fromMs, toMs, fetchedAt }).map((i) => ({ ...i, sourceName: 'Destination Bryan (DEMO)' }));
  });

  const place = {
    id: 'place:demo-nature-center', seriesId: 'place:demo-nature-center', kind: 'place',
    title: '[DEMO] Example Nature Center', description: 'Fictional place with published hours, used to demonstrate “regularly open” entries.',
    summary: 'Fictional place with published hours.', start: null, end: null, allDay: false, endKnown: false, timeNote: null,
    location: { name: 'Demo Nature Center', address: '100 Example Rd, College Station, TX 77845', lat: 30.568, lng: -96.211 },
    cost: { status: 'unknown', label: 'Cost not listed on source page', min: null },
    registration: { status: 'unknown', label: 'Registration requirements not listed', url: null },
    types: ['outdoors', 'learning', 'family'], sourceTags: [],
    hours: [{ days: [0, 1, 2, 3, 4, 5, 6], open: '09:00', close: '17:00' }], hoursText: 'Daily, 9 a.m.–5 p.m. (fictional)',
    closures: [['2026-11-08', '2026-11-08']], closuresText: 'Closed: Nov. 8 (fictional)',
    verification: { status: 'verified', note: null, verifiedOn: '2026-11-06' },
    sourceId: 'places', sourceName: 'Demo facility page', sourceUrl: 'https://www.cstx.gov/parks-recreation-culture/facilities-and-rentals/', lastVerified: fetchedAt,
  };

  const { items, expiredRemoved, duplicatesRemoved } = finalizeItems([...city, ...bryanItems, place], now);
  return {
    schema: 1, isDemo: true, demoNow: DEMO_NOW, generatedAt: fetchedAt, timezone: 'America/Chicago',
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), days: 30 },
    counts: { items: items.length, expiredRemoved, duplicatesRemoved },
    sources: [
      { id: 'cstx', name: 'City of College Station Calendar (DEMO fixture)', homepage: 'https://www.cstx.gov/calendar/', method: 'Fixture ICS file in tests/fixtures/demo.ics', status: 'ok', lastAttempt: fetchedAt, lastSuccess: fetchedAt, itemCount: city.length, error: null },
      { id: 'dbryan', name: 'Destination Bryan (DEMO fixture)', homepage: 'https://www.destinationbryan.com/events/', method: 'Fixture objects in scripts/make-demo.mjs', status: 'ok', lastAttempt: fetchedAt, lastSuccess: fetchedAt, itemCount: bryanItems.length, error: null },
    ],
    items,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await buildDemo();
  const path = fileURLToPath(new URL('../public/data/demo-events.json', import.meta.url));
  await writeFile(path, JSON.stringify(out, null, 1));
  console.log(`Demo data: ${out.items.length} items (${out.counts.expiredRemoved} ended removed, ${out.counts.duplicatesRemoved} duplicates merged) → ${path}`);
}
