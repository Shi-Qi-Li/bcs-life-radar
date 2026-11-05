// Regularly-open places, curated by hand in data/places.json from official pages.
// Each refresh re-downloads every source page and checks the copied snippets are still present.

import { readFile } from 'node:fs/promises';
import { htmlToText } from '../lib/normalize.mjs';
import { costFromText } from '../lib/normalize.mjs';

export const SOURCE = {
  id: 'places',
  name: 'Official facility pages (curated)',
  homepage: 'https://www.cstx.gov/parks-recreation-culture/facilities-and-rentals/',
  method: 'Hand-curated from official facility pages; each refresh re-checks that the copied hours/address text still appears on the page.',
};

const norm = (s) => htmlToText(s).replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').toLowerCase();

export async function fetchSource({ fetchText, file = new URL('../../data/places.json', import.meta.url) }) {
  const fetchedAt = new Date().toISOString();
  const { places } = JSON.parse(await readFile(file, 'utf8'));
  const stats = { places: places.length, changed: [], unreachable: [] };
  const pages = new Map();
  const items = [];
  for (const p of places) {
    let status = 'verified', note = null;
    try {
      if (!pages.has(p.sourceUrl)) pages.set(p.sourceUrl, norm(await fetchText(p.sourceUrl)));
      const page = pages.get(p.sourceUrl);
      const missing = p.verifyText.filter((t) => !page.includes(norm(t)));
      if (missing.length) {
        status = 'changed';
        note = 'The official page no longer shows the text these hours were copied from — hours may have changed. Check the source.';
        stats.changed.push({ id: p.id, missing });
      }
    } catch (e) {
      status = 'unreachable';
      note = `Could not re-check the official page on this refresh (${e.message}). Hours shown were verified on ${p.verifiedOn}.`;
      stats.unreachable.push(p.id);
    }
    items.push({
      id: p.id, seriesId: p.id, kind: 'place',
      title: p.title, description: p.description, summary: p.description.slice(0, 200),
      start: null, end: null, allDay: false, endKnown: false, timeNote: null,
      location: p.location,
      cost: p.costText ? costFromText(p.costText) : { status: 'unknown', label: 'Cost not listed on source page', min: null },
      registration: { status: 'unknown', label: 'Registration requirements not listed', url: null },
      types: p.types, sourceTags: [],
      hours: p.hours, hoursText: p.hoursText, closures: p.closures, closuresText: p.closuresText,
      verification: { status, note, verifiedOn: p.verifiedOn },
      sourceId: SOURCE.id, sourceName: p.sourceName, sourceUrl: p.sourceUrl,
      lastVerified: status === 'verified' ? fetchedAt : `${p.verifiedOn}T12:00:00.000Z`,
    });
  }
  return { items, stats, fetchedAt };
}
