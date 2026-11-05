# Data sources

Verified on **2026-11-05** by inspecting each page and following links to individual event pages. Only public pages are used; no logins, no API keys, nothing behind access controls. Requests identify the app in the User-Agent and are spaced ≥1 second apart. A 401/403 response is treated as "access restricted" and never retried or worked around.

## 1. City of College Station — events → City Calendar

- Starting page: https://www.cstx.gov/parks-recreation-culture/events/
- What's there: two sub-pages ("Community Events", "Special Events") are **descriptive pages without a structured schedule** (several describe events from earlier in the year). The useful source is the **City Calendar** linked from the same site: https://www.cstx.gov/calendar/, which embeds a Timely calendar (id `54735353`).
- **Update method:** the calendar's public **iCalendar (ICS) export** — the same feed its *Subscribe* button offers:
  `https://events.timely.fun/api/calendars/54735353/export?format=ics`
  One request per refresh; ~700 KB; ~340 entries with title, description, start/end with time zone, recurrence (RRULE/RDATE/EXDATE), location + coordinates, cost type/amount, tags (incl. "Registration Required"), and a per-date link.
- What we keep: public activities. We leave out entries tagged Internal, Meeting/Notice categories, City Council/Committee, closures, and cancelled entries (on 2026-11-05: 57 meeting/closure/notice, 22 cancelled, 15 internal).
- Known limitations:
  - The feed marks most entries `free` by default. When no "Free" tag backs it up, the card says "Free (marked free in City calendar)". If tags say both Free and Paid, the card says the cost is unclear.
  - The "Registration Required" tag sometimes applies to part of an event (e.g. a costume contest at a free movie night); the description on the card shows the details.
  - Timely event links open a JavaScript calendar page.
  - Recurrence types beyond DAILY/WEEKLY/MONTHLY (with BYDAY/BYMONTHDAY) are reported in the refresh log and not guessed. None were present on 2026-11-05.

## 2. Destination Bryan — events

- Starting page: https://www.destinationbryan.com/events/
- What's there: no public feed or API. The listing pages are server-rendered cards (title, category, address, coordinates, date), linking to event pages with visible date/time, admission, ticket/website links, "Upcoming Dates" for repeating events, and schema.org JSON-LD. `robots.txt` allows `/events/`.
- **Update method:** read the first N listing pages (default 6, `BRYAN_PAGES`), then each linked event page (default max 45, `BRYAN_DETAILS`). About 50 requests, 3–6 minutes because the site responds slowly.
- Known limitations:
  - **Partial coverage**: the full listing was 44 pages on 2026-11-05 (one card per date) and isn't strictly date-ordered, so reading the first 6 pages misses some events. Raise `BRYAN_PAGES`/`BRYAN_DETAILS` for more coverage at the cost of more requests.
  - **Timestamps in JSON-LD are unreliable**: e.g. `"startDate":"2026-11-11T19:00:00.000000Z"` on a page whose visible text says "7:00 PM – 10:30 PM". The `Z` is wrong. We use the visible date/time text, read as Central Time.
  - "Upcoming Dates" lists dates only. Other dates reuse the series' listed time and are marked "Time copied from the series listing — confirm for this date".
  - Some multi-day listings publish odd hours (e.g. an exhibit at "7:00 AM – 11:00 AM"). We show them "as published; confirm with the venue".
  - The site puts most events in "Arts & Culture", so that category is a weak hint; types come mainly from titles and descriptions.
  - The date-range filter in the site's URL (`date-from`/`date-to`) did not restrict results reliably, so it isn't used.
  - An HTML redesign will break this adapter. The refresh then fails loudly, keeps the last good data, and the site shows a banner.

## 3. Regularly open places (hand-curated)

- File: `data/places.json`. Four places from official City of College Station facility pages: Gary Halter Nature Center / Lick Creek Park, Lincoln Recreation Center, Meyer Senior & Community Center, Wolf Pen Creek Park.
- **Update method:** each refresh re-downloads every page and checks that the copied snippets (hours, address) still appear. If not, the card shows "Hours may have changed". If the page can't be reached, the card shows the date the hours were last verified.
- Known limitations: small set. Closure dates appear on the source without a year and are interpreted for 2026–27, so update them yearly. Cost isn't listed on these pages, so it shows as "not listed". Wolf Pen Creek's page lists no hours, so the card says so.

## Demo data

`public/data/demo-events.json` is **fictional** (every title starts with `[DEMO]`). It is built by `npm run demo-data` from `tests/fixtures/` through the real pipeline and only loads with `?demo=1`, where a banner and badges label it.

## Adding a source later

Write `scripts/sources/<name>.mjs` exporting `SOURCE` and `fetchSource(ctx)` returning `{ items, stats, fetchedAt }` in the same item shape, then add it to the list in `scripts/refresh.mjs`. Candidates: Texas A&M event calendars, Bryan + College Station Public Library, Visit College Station.
