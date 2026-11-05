# Data sources

Verified on **2026-11-05** by inspecting each page and following links to individual event pages. Only public pages are used; no logins, no API keys, nothing behind access controls. Requests identify the app in the User-Agent and are spaced ≥1 second apart. A 401/403 response is treated as "access restricted" and never retried or worked around.

## 1. City of College Station — events → City Calendar

- Starting page: https://www.cstx.gov/parks-recreation-culture/events/
- What's there: two sub-pages ("Community Events", "Special Events") are **descriptive pages without a structured schedule** (several describe events from earlier in the year). The useful source is the **City Calendar** linked from the same site: https://www.cstx.gov/calendar/, which embeds a Timely calendar (id `54735353`).
- **Update method:** the calendar's public **iCalendar (ICS) export** — the same feed its *Subscribe* button offers:
  `https://events.timely.fun/api/calendars/54735353/export?format=ics`
  One request per refresh; ~700 KB; ~340 entries with title, description, start/end with time zone, recurrence (RRULE/RDATE/EXDATE), location + coordinates, cost type/amount, tags (incl. "Registration Required"), and a per-date link.
- What we keep: public activities. We leave out entries tagged Internal, Meeting/Notice categories, City Council/Committee, closures, cancelled entries, and civic-education/planning programmes (Seminar Supper, town halls, public hearings, budget workshops, enrolment periods), counted as 'civic/informational' in the refresh stats (on 2026-11-05: 57 meeting/closure/notice, 22 cancelled, 15 internal, 11 civic).
- Known limitations:
  - The feed marks most entries `free` by default. When no "Free" tag backs it up, the card says "Free (marked free in City calendar)". If tags say both Free and Paid, or Paid without an amount, the card shows the description's own price sentence labelled "(per description)"; it says "unclear" only when the description prices nothing.
  - Department and audience tags (Parks, Program, Adult (18+), Senior (55+), Family Friendly, …) only weakly influence the activity type; descriptive tags (Nature, Fitness, Music, Games, Lecture, …) count fully.
  - Entries without an end time are exported with a placeholder end of 23:59:59 (`X-INSTANT-EVENT`); they are published with "end time not listed" rather than an invented duration. Sold-out entries (`STATUS:SOLD_OUT`) stay listed with their registration line marked sold out.
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
  - **Cost**: the budget filter uses the typical adult/general price in the admission text (e.g. "$12 adults | $5 kids" filters as $12; "Free to watch | $20 to participate" filters as free); the full text is always shown. When the admission line is empty but the description prices the activity, the card says "Price in description: …".
  - **Registration**: sentences about performer, vendor or competitor sign-ups are not treated as attendee registration; RSVP windows and "register by" wording count as required, with the page's register/RSVP link attached.
  - A listed start of 12:00 AM with an afternoon end is treated as "start not listed" with a note; single-day spans over 14 hours get a note; when the description says "every Thursday" but the listed dates are Wednesdays, the card says so.
  - When the page has no venue name, it is taken from the title's "at <Venue>" or the description's "located at …"; if the title names a different venue than the listed address, the card says so.
  - Boilerplate lines ("Click here…", "Sponsored by…", weather notices) are removed from descriptions.
  - An HTML redesign will break this adapter. The refresh then fails loudly, keeps the last good data, and the site shows a banner.

## 3. Regularly open places (hand-curated)

- File: `data/places.json`. Four places from official City of College Station facility pages: Gary Halter Nature Center / Lick Creek Park, Lincoln Recreation Center, Meyer Senior & Community Center, Wolf Pen Creek Park.
- **Update method:** each refresh re-downloads every page and checks that the copied snippets (hours, address) still appear. If not, the card shows "Hours may have changed". If the page can't be reached, the card shows the date the hours were last verified.
- Known limitations: small set. Closure dates appear on the source without a year and are interpreted for 2026–27, so update them yearly. Cost isn't listed on these pages, so it shows as "not listed". Wolf Pen Creek's page lists no hours, so the card says so.

## 4. The Theatre Company of Bryan/College Station — event calendar

- Starting page: https://www.theatrecompany.com/calendar (the community theatre's "2026 Event Calendar", a Squarespace events collection).
- What's there: a server-rendered list of upcoming entries — one `<article>` per performance with the title, a per-event link, a machine-readable date (`<time class="event-date" datetime="YYYY-MM-DD">`), start and end times as rendered in the site's time zone (Central: "7:00 PM"; a narrow no-break space precedes AM/PM), and a "Google Calendar" export link carrying the same instants in UTC. Date-range entries (auditions, work weeks) show two dates and no times. No venue, price, category or description is listed per event (the detail page's JSON-LD had empty `location` name/address and `offers: null` on 2026-11-05, and its body was empty), and the listing contains no ticket links.
- `robots.txt` (Squarespace default) allows `/calendar` and `/calendar/<slug>` but **disallows** `?format=ical`, `?format=json` and the other `?format=`/`?month=`/`?view=` variants for every agent, so the per-event ICS/JSON endpoints are never requested.
- **Update method:** one request per refresh: `https://www.theatrecompany.com/calendar` (~520 KB). The "upcoming" block is parsed; the "past" block is only counted. Dates/times are read as Central wall time and converted with the shared time helpers; each timed entry is cross-checked against its own Google Calendar link (on 2026-11-05: 53 of 53 agreed, CST and CDT alike). Detail pages are not fetched.
- What we keep: every upcoming entry (performances, auditions, work weeks) — 53 entries on 2026-11-05 → 52 items (the site itself lists the Dec 5, 2 PM performance twice; identical production + start collapse into one item). Each performance is a one-time item; performances of one production share a `seriesId` (`theatreco:<title-slug>`). A date-range entry becomes one all-day multi-day item spanning the listed days; the instants from its calendar link are quoted in the time note only.
- Known limitations:
  - **No venue, price or ticket link is listed per event**, so cards say location/cost/registration "not listed". The company's address (3125 S Texas Ave, Ste 500, Bryan) appears only in the site footer and is deliberately not assumed to be the venue; tickets are sold on a separate site (ttcbcs.vbotickets.com) that the calendar does not link to.
  - Descriptions are empty on the listing and on the checked detail page, so items have no description.
  - Types come only from the title plus a weak "Theatre" hint, so everything (including auditions and work weeks) is "Music, film & shows".
  - Volume is seasonal: 3 performances in the 30 days after 2026-11-05; 12–13 per show run otherwise.
  - A Squarespace template change breaks the selectors; the refresh then fails loudly, keeps the last good data and the site shows the banner. The adapter also fails loudly if more than half of the entries' Central-time readings disagree with the page's own calendar links (time-zone setting changed).

## 5. Bryan + College Station Public Library — Activities calendar

- Starting page: https://www.bcslibrary.org/programs/activities/
- What's there: the page embeds the library's public **Tockify** calendar (`data-tockify-calendar="bcslibrary"`, "Bryan + College Station Library System Calendar", time zone America/Chicago). bcslibrary.org itself publishes no events feed or API (its WordPress REST API has no events plugin; `/feed/` is a news feed). The calendar's own public page https://tockify.com/bcslibrary is server-rendered with the viewer's state in `window.tkf = {...};` whose `bootdata.query.monthly.events` holds one record per occurrence: start/end epoch milliseconds with `tzid`, an all-day flag, title, plain-text description, venue name and address, audience tags (Children, Tween, Teen, Adult, All-Ages…), RSVP-form flags and the series id/kind (singleton / repeat / rdate / mod — recurrences are already expanded, no RRULE needed).
- robots.txt: bcslibrary.org allows the page. **tockify.com disallows `/api/` for every agent** — which covers the ICS feed the embed's Subscribe button builds (`/api/feeds/ics/bcslibrary`), RSS and the viewer's JSON endpoint — plus `/e/`, `/em/`, `/p/` and the standalone RSVP route, so none of those are used. Only `/bcslibrary/monthly?startms=…` pages are fetched, and event links point to the public `/bcslibrary/detail/<uid>/<tid>[/<rid>]` pages (the same URLs the page's own JSON-LD uses; verified 2026-11-05).
- **Update method:** one GET per calendar month overlapping the refresh window:
  `https://tockify.com/bcslibrary/monthly?startms=<Chicago midnight of the 1st>` (e.g. `startms=1793509200000` for November 2026, `startms=1796104800000` for December 2026 — computed with the shared `chicagoToUtc`, so DST is handled). Normally **2 requests** per refresh (3 when the 30-day window spans three months; the adapter refuses more than 6). Each page is 85–280 KB and is served without cache headers. The `window.tkf` JSON is extracted and parsed; records seen on two pages are merged by uid/tid/rid. On 2026-11-05: 89 + 22 records → 102 unique → **70 activities in 52 series** for the next 30 days (storytimes, book clubs, crafts, computer/genealogy help, author events) at Clara B. Mounce Public Library, Larry J. Ringer Library, Carnegie History Center and the Meyer Center.
- What we keep: scheduled activities. We leave out closure notices ("LIBRARIES CLOSED FOR THANKSGIVING", "LIBRARIES CLOSING AT 5 PM FOR THANKSGIVING": a title containing closed / closure / holiday hours, or closing with no venue) and any record whose `status.name` is not `scheduled` (none seen on 2026-11-05); both are counted in `stats.excluded`. Branch codes in titles — (CBMPL) Clara B. Mounce Public Library, (LJRL) Larry J. Ringer Library, (CHC) Carnegie History Center — are moved out of the title (kept in `titleRaw` and `sourceTags`) and resolve the venue name when a record lists no place; `, USA` is stripped from addresses. Series occurrences are "recurring", singletons "one-time", and all-day records spanning several days (a holiday donation drive, a word hunt) "multi-day".
- Known limitations:
  - **Third-party page structure**: the data is Tockify's internal viewer state, not a documented feed, so a Tockify release can change it. The adapter fails loudly when `bootdata.query.monthly.events` is missing or the calendar's time zone is not America/Chicago; the last good items are then kept and the site shows the failure banner.
  - **Many records have no end time**: `end.millis === start.millis` (or no `end` at all) means none was entered — 27 of 70 items show "No end time listed by source". All-day ends are exclusive midnights (verified against the Thanksgiving notice's own wording).
  - **Cost is not a field**: only wording about admission such as "Free tickets will be given out…" sets "Free (per description)" (2 of 70); everything else shows "Cost not listed (library programs are usually free — confirm)". Perks like "free prize pack", "free book copies" or "digitize … for free" do not count as the event's cost.
  - **Registration**: "Registration is not required" / "Registration not required" → not required (37 of 70); an RSVP form on the calendar page combined with "Register"/"RSVP" in the title or "Registration required" in the text → required, linking to the Tockify detail page where the form lives (15; "marked full by the library" is appended when the form is marked full); "Registration is suggested" stays a hint. Tockify strips hyperlinks from descriptions, so no external registration URLs exist.
  - **No coordinates**: Tockify provides a Google place_id only, so `lat`/`lng` are null and these items do not take part in the walk/bike distance filter.
  - **100-record cap**: a pre-rendered month holds at most 100 records. When `metaData.hasNext` is true the month is listed in `stats.truncatedMonths` and logged, but the missing events are not fetched (November 2026 had 89, December 22). Busy summer-reading months may be affected.
  - Event links open tockify.com rather than bcslibrary.org.
  - One likely duplicate with Destination Bryan ("Friends of the Library Book Sale (CBMPL)" vs "Fall Book Sale at Clara B. Mounce Library", same start minute) is not merged by the current title-similarity rule (0.44 < 0.75), so it can appear twice.
  - Cancelled events were not observed, so how Tockify represents them is unverified; anything not `scheduled` is excluded defensively.

## 6. Texas A&M University Events Calendar — "* Main University Calendar" (JSON feed)

- Starting page: https://calendar.tamu.edu/ — the university's events calendar (LiveWhale, run by Marketing & Communications; linked from www.tamu.edu). Its **Feeds** page, https://calendar.tamu.edu/feeds, says "You can access the following calendar groups, along with their corresponding RSS, JSON and iCal feed URLs." and lists 164 groups; the homepage shows the "* Main University Calendar" group. `robots.txt` disallows nothing under `/live/`; no login or key.
- What's there: one JSON record per occurrence (recurring events arrive already expanded) with title, HTML description, start `date_iso` with the Central offset, end `date2_iso` (about 1 record in 4), all-day flag, repeats, categories (`event_types`), audience (`event_types_audience`), campus (`event_types_campus`), venue name + coordinates, cost (a number, "Free", pasted HTML or null), contact HTML and a per-event link. About 70% of records are Transportation Services bus notices ("Transit Fall Service", one per day).
- **Update method:** one request per refresh, for the refresh window only:
  `https://calendar.tamu.edu/live/json/events/group/%2A%20Main%20University%20Calendar/start_date/YYYY-MM-DD/end_date/YYYY-MM-DD`
  (`end_date` is exclusive, like the window end; ~245 KB for 31 days). If the body is not a non-empty JSON array of event-shaped records, the refresh fails loudly, keeps the last good items and the site shows the failure banner.
- What we keep: public-facing activities in Bryan–College Station — records whose audience includes **Visitors** or **Residents** and whose campus list is absent or includes **Bryan-College Station**. (The feed's own `/audience/` and `/campus/` URL filters are silently ignored by the server, so this is done after download.) Left out, each counted in the refresh stats: Transportation Services / "Transit…" bus notices (34 of 68 records on 2026-11-05), records typed only "Academic Calendar" (deadlines), titles starting "CANCELLED"/"POSTPONED" (`is_canceled` is never set), online-only events, other-campus events, and the duplicate same-id record the calendar emits for an event that crosses midnight (the full-span record is kept). On 2026-11-05: 68 records → 30 activity dates (18 distinct series) in the next 30 days — OPAS shows, gallery exhibitions, concerts, star parties, lectures, Bonfire Remembrance.
- Known limitations:
  - The Main calendar is curated and selective (no athletics fixtures, few departmental talks). Other group feeds (University Arts, OPAS, Music Activities, Physics & Astronomy) use the same URL grammar at +1 request each; the all-groups feed is capped at 1,000 records (~9 days) and the KAMU Community Calendar / Library groups duplicate Destination Bryan — none of these are used.
  - Ticket and registration links are not in the feed (event pages render them with JavaScript), so OPAS shows read "Cost not listed" and "Registration requirements not listed". `has_registration` is honoured when the calendar sets it.
  - Locations are venue names with coordinates ("Rudder Auditorium"); only a few carry a street address. Cost strings are shown as published ("$11.50; $7 for students at the MSC Box Office.") with the lowest listed price as the minimum.
  - Cancellations can only be detected from the title. Series are grouped by title slug because the feed's `parent` id is not stable across weekly occurrences.
  - Field names are those of LiveWhale 2.21.1; a platform upgrade that renames them makes the adapter throw and the site show the failure banner.

(Also remove "Texas A&M event calendars" from the Candidates sentence under "Adding a source later".)

## Demo data

`public/data/demo-events.json` is **fictional** (every title starts with `[DEMO]`). It is built by `npm run demo-data` from `tests/fixtures/` through the real pipeline and only loads with `?demo=1`, where a banner and badges label it.

## Adding a source later

Write `scripts/sources/<name>.mjs` exporting `SOURCE` and `fetchSource(ctx)` returning `{ items, stats, fetchedAt }` in the same item shape, then add it to the list in `scripts/refresh.mjs`. Candidates: Visit College Station (in progress), City of Bryan (its calendar host blocks automated requests — ask the City for an ICS export first), Lake Walk (feeds currently broken by a calendar-plugin bug).
