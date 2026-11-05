// Visit College Station — https://visit.cstx.gov/events/ (the City of College Station's tourism calendar).
// Same Tempest/Craft template as Destination Bryan, so the parsing is shared (scripts/sources/destinationBryan.mjs)
// and only the site config differs:
//  - discovery: the public event sitemap only. The /events/ listing grid is an Algolia widget that needs the
//    site's API key, so it is never requested and there is no listing fallback — a missing or tiny sitemap fails loudly;
//  - the date/time text is in div.detail__dates-heading (not p.detail__subheading) and may carry a <p> note
//    such as "Every Saturday rain or shine" that is kept as a note, never parsed as a date;
//  - Admission is an <h3>Admission</h3> followed by a div; the address is the spans of div.detail__address
//    (first span = venue name when it is not a street line); the category is main[data-dms-category-name]
//    (the page also lists the venue's own directory categories, which are ignored);
//  - JSON-LD is misleading here (location.name is the event title, startDate is the series' first occurrence,
//    all-day events are 00:00–23:59), so only visible text and data-* attributes are used.
// Verified on 2026-11-05: 61 event pages in the sitemap; robots.txt allows /events/ and the sitemaps.

import { makeTempestSource } from './destinationBryan.mjs';

export const SOURCE = {
  id: 'visitcs',
  name: 'Visit College Station',
  homepage: 'https://visit.cstx.gov/events/',
  sitemapUrl: 'https://visit.cstx.gov/sitemaps-1-event-default-1-sitemap.xml',
  method: 'Public event sitemap for discovery, then every event page (HTML). No feed; the listing widget needs a key and is not used.',
};

// Categories specific enough to count as strong tags; the rest ("Arts & Culture", "Educational", …) are weak hints.
const STRONG_CATEGORIES = ['Live Music', 'Markets', 'Exhibits', 'Holiday', 'Texas A&M Sports', 'Free Events', 'Performing Arts', 'Food & Drink', 'Family Friendly'];

export const CONFIG = {
  ...SOURCE,
  host: 'visit.cstx.gov',
  notEvents: ['submit-event'],
  minSitemapUrls: 10,
  listingFallback: false,
  maxConcurrency: 1, // one request at a time, whatever the refresh context allows
  maxDetailPages: 150,
  selectors: {
    dateText: ['div.detail__dates-heading', 'p.detail__subheading'],
    admission: [/<h3>Admission<\/h3>\s*<div[^>]*>([\s\S]*?)<\/div>/i, /<li><b>Admission<\/b>:?([\s\S]*?)<\/li>/i],
    summary: ['div.detail__summary'],
    upcoming: ['ul.detail__dates'],
  },
  location: 'address',
  categories: 'main',
  strongCategories: STRONG_CATEGORIES,
  freeCategory: 'Free Events', // no Admission text + this category → "Free (listed under Free Events)"
  ticketingWebsiteLink: true, // "Go To Website" → prekindle/eventbrite/etix/… is the ticket link; otherwise the organizer's website
};

const site = makeTempestSource(CONFIG);
export const { parseSitemap, parseDetail, itemsFromDetail, fetchSource } = site;
