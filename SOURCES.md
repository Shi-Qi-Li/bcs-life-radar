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
- What's there: no public feed or API. The site publishes a **public event sitemap** (`https://www.destinationbryan.com/sitemaps-1-event-default-1-sitemap.xml`, 116 event pages on 2026-11-05, each with a last-modified date) that is a strict superset of the 44-page listing (3 live events were only in the sitemap). Each event page carries the visible date/time, admission, "Upcoming Dates" for repeating events, venue address, map coordinates, a category and schema.org JSON-LD. `robots.txt` allows `/events/` and the sitemaps.
- **Update method:** read the event sitemap (one request), then every event page, **one request at a time** (this host serialises requests: 3 concurrent fetches tripled latency and caused timeouts, while sequential pages take ~0.5 s cached / ~6 s uncached). ~117 requests, 2–4 minutes. If the sitemap is unavailable or lists fewer than 20 pages, the paginated listing is read instead (first 8 pages) and the refresh log says coverage is partial. If more than half of the pages fail, the previous data is kept and the site shows the failure.
- What we keep: every page with at least one date inside the 30-day window. Pages whose dates are all in the past or beyond the window (30 on 2026-11-05) are counted in the stats, not published — ended events stay on the site unchanged, so a past date is the only "ended" signal.
- Known limitations:
  - **Timestamps in JSON-LD are unreliable** (a wrong `Z` on Central wall time on about a third of pages; series start dates instead of the next date). The visible date/time text is used, read as Central Time.
  - "Upcoming Dates" lists dates only. Other dates reuse the series' listed time and are marked "Time copied from the series listing — confirm for this date". The headline date is unioned with that list because the site sometimes omits it.
  - A long, dense date list (e.g. an exhibit open every weekday for months) is published as **one ongoing item** with its listed hours and open days, instead of one card per day.
  - Two venues are published with a positive longitude (a dropped minus sign); coordinates are sign-corrected and anything outside the Brazos Valley is dropped so directions fall back to the address.
  - Some multi-day listings publish odd hours (e.g. an exhibit at "7:00 AM – 11:00 AM"). We show them "as published; confirm with the venue".
  - Most events sit in the site's catch-all "Arts & Culture" category, so that category is only a weak hint; types come mainly from titles and descriptions.
  - An HTML redesign will break this adapter. The refresh then fails loudly, keeps the last good data, and the site shows a banner.

## 3. Regularly open places (hand-curated)

- File: `data/places.json`. Four places from official City of College Station facility pages: Gary Halter Nature Center / Lick Creek Park, Lincoln Recreation Center, Meyer Senior & Community Center, Wolf Pen Creek Park.
- **Update method:** each refresh re-downloads every page and checks that the copied snippets (hours, address) still appear. If not, the card shows "Hours may have changed". If the page can't be reached, the card shows the date the hours were last verified.
- Known limitations: small set. Closure dates appear on the source without a year and are interpreted for 2026–27, so update them yearly. Cost isn't listed on these pages, so it shows as "not listed". Wolf Pen Creek's page lists no hours, so the card says so.

## Demo data

`public/data/demo-events.json` is **fictional** (every title starts with `[DEMO]`). It is built by `npm run demo-data` from `tests/fixtures/` through the real pipeline and only loads with `?demo=1`, where a banner and badges label it.

## Adding a source later

Write `scripts/sources/<name>.mjs` exporting `SOURCE` and `fetchSource(ctx)` returning `{ items, stats, fetchedAt }` in the same item shape, then add it to the list in `scripts/refresh.mjs`. Candidates: Texas A&M event calendars, Bryan + College Station Public Library, Visit College Station.
