# Verification report — 2026-11-05 (updated 06:30 UTC)

All results below were produced by running the commands in this repository or by the scheduled GitHub Actions job. Re-run them with `npm test` and `npm run test:ui`.

## Real data, end to end (GitHub Actions run 41982146182, 06:42 UTC)

| Source | Method | Result |
| --- | --- | --- |
| City of College Station Calendar | public ICS feed, 1 request | OK: 34 activity dates in the next 30 days (meetings, closures, notices, internal, cancelled and civic programmes excluded) |
| Destination Bryan | event sitemap + 116 event pages, 1 request at a time | OK: 189 activity dates in the 06:24 run (0 failed pages, exhibits collapsed into ongoing items). In the 06:42 run the sitemap request timed out and the adapter fell back to the listing as designed (12 pages → 64 event pages → 153 dates, flagged "coverage is partial" in its stats); the sitemap fetch now gets a longer timeout and an extra retry. |
| Visit College Station | event sitemap + 63 event pages, 1 request at a time | OK: 63/63 pages, 50 activity dates (17 pages are beyond the 30-day window) |
| Bryan + College Station Public Library | public Tockify calendar state, 2 requests | OK: 70 activity dates (closure notices excluded) |
| Texas A&M University Events Calendar | official JSON feed, 1 request | OK: 68 feed records → 30 public-facing in-person activity dates (34 bus notices, 1 online, 2 not public-facing, 1 same-id duplicate excluded) |
| The Theatre Company | one listing page | OK: 3 performances in the next 30 days (52 across the season) |
| Places (curated) | 4 official facility pages re-checked | OK: all hours/address snippets still present |
| **Total** | ~190 polite requests, 5 min 1 s | **335 items**, 9 cross-source duplicates merged (e.g. Winter Wine Premiere ← Visit College Station; Fall Book Sale at Clara B. Mounce Library ← the library calendar), 0 ended items |

The live site (https://shi-qi-li.github.io/bcs-life-radar/) was loaded with Playwright on an emulated iPhone 13 and a 1366×900 desktop right after the deploy: 101 results for the next 7 days (7 repeat dates grouped), 5 top picks, day pills with per-day counts, the "Right now" strip hidden at a quiet hour, service worker active, Aggie Maroon accent, no horizontal overflow, no console errors.

## Unit tests — `npm test` (124 pass)

Run under five machine time zones (UTC, America/Chicago, Asia/Shanghai, America/Los_Angeles, Pacific/Kiritimati) with identical results, e.g. `TZ=Asia/Shanghai npm test`.

| File | What is checked |
| --- | --- |
| `time-and-ics.test.mjs`, `ics-edge.test.mjs` | CST/CDT conversion; DST spring-forward gap and fall-back overlap; day boundaries and display in Chicago regardless of machine zone; weekly series across the DST change with EXDATE; monthly ordinals; unsupported rules reported, not guessed; zero-padded occurrence keys (a January EXDATE no longer deletes a November date); UNTIL as an instant; zero-length and negative durations |
| `cstx-edge.test.mjs`, `taxonomy.test.mjs` | City feed: placeholder 23:59:59 ends → "end not listed"; sold-out marking; boilerplate stripped; department tags only nudge types; civic programmes excluded; cost from the description's own price sentence; 16 real items classified as the audit expected |
| `bryan-discovery.test.mjs` | Sitemap parsing; concurrency limit; listing fallback reports partial coverage; mostly-failed crawl keeps last good data; coordinate sign repair; headline date unioned with the upcoming list; dense multi-month lists collapse into one ongoing item while weekly series do not |
| `normalize.test.mjs`, `logic.test.mjs` | Adult/general price as the budget value; "free to watch" is free entry; `$0`, `$5-$10`, `$1,200`; performer/vendor sign-ups are not attendee registration; RSVP windows are required; description cleanup; 12:00 AM start caveat; weekday-mismatch note; venue-vs-title note; dedupe within ±30 min with matching venues and never across different venues; expiry; date ranges; budget/type/mood/kind/time filters; walking radius only with a shared location; place hours and closures; picks (3–5, varied, reasons never a bare when-phrase); "Right now" helpers; series grouping; calendar export; refresh failure keeps last good items |
| `bcslibrary.test.mjs`, `tamu.test.mjs`, `theatreCompany.test.mjs`, `pwa.test.mjs` | Each new source from a trimmed real response: Chicago times, every exclusion bucket, no invented fields, loud failure on a changed layout; the manifest and the service worker's precache list match real files |

## Browser tests — `npm run test:ui` (32 pass, Playwright + Chromium)

Phone (iPhone 13), iPad (gen 7) and desktop 1366×900: 3–5 picks above the fold; no horizontal overflow on Discover, the dialog, Browse all, Saved and Sources (document width and per-element right edges); every card shows name, description, when, where, cost, registration, reason, source link and updated time; demo data labelled; ended events never appear and disappear live as the simulated clock passes; duplicates shown once with both sources; unknown cost/end/registration labelled; all four kinds labelled; device time zones Tokyo / Los Angeles / London still show Central Time; date, budget, type, kind, search and walking-radius filters; details → Directions URL and `.ics` download with the right UTC instants; Google Calendar link in `America/Chicago`; Save survives reload, Not interested + Undo, Been there; "Did you go?" after an event ends with feedback stored; failed-source banner with last-updated time and source link; cached copy used when the data file is unreachable; stale-data banner; real data on a phone; Sources table fits a phone; 44 px touch targets; toast Undo reachable; "Right now" strip; repeating series grouped; day pills, mood hint and shareable filter URL; late-evening default and suggestion row; Back closes the dialog, `#/item/<id>` deep links, focus returns; in-place Save with dialog scroll preserved; List/Cards toggle and sticky offsets; repeat visit paints from the saved copy. The service worker is blocked in these contexts; it is covered by `pwa.test.mjs` and an offline check (page still renders picks with the network off).

## Investigation and fixes in this round

Nine investigator agents (Destination Bryan coverage measurements, five candidate sources, an adversarial code review, a UX walkthrough, a data-quality audit) and eight implementer agents worked on disjoint files; every finding below was reproduced with a command before it was fixed.

- **Coverage**: Destination Bryan went from 6 of 44 listing pages (45 event pages) to all 116 event pages via the site's public event sitemap; measured that the host serialises requests (3-concurrent fetches tripled latency and caused timeouts) so pages are fetched one at a time.
- **Correctness**: a positive longitude on two venues (directions would have pointed to China); an exhibit expanded into 137 "recurring" cards; the headline date dropped from upcoming lists; an EXDATE collision from unpadded occurrence keys; placeholder 23:59:59 ends; `$0` as paid; `$1,200` as $1; `?now=garbage` blanking the page; dedupe merging different venues.
- **Data quality**: 26 audit findings on real items (mis-typed card shows and tournaments, "free to watch" events hidden by the budget filter, performer sign-ups mistaken for attendee registration, boilerplate in descriptions, missing venue names, a 12:00 AM start typo) → rule-level fixes with tests.
- **UX**: phone overflow from a hidden label, Sources table overflow, 0.6–0.8 layout shift on load, sticky offsets, Back leaving the site, re-renders losing focus/scroll, weak "why this pick" reasons, late-evening dead end, sub-44 px targets, keyboard focus, toast — all fixed; plus the "Right now" strip, day pills, series grouping, share links, List view and the installable offline app.
- **Sources evaluated and deferred**: City of Bryan (its calendar host blocks identified bots and its robots.txt could not be read — ask the City for an ICS export), Lake Walk (its feeds are broken by a calendar-plugin bug and most items already arrive via Destination Bryan), Brazos County Expo and the Arts Council (client-rendered or dateless listings), several venue sites with no machine-readable data.

## Not verified

- Real iOS/Android devices and Safari: Chromium device emulation only. Add to Home Screen was not exercised on a real phone.
- Opening the downloaded `.ics` in Apple Calendar or Outlook: the file content is checked, not the import.
- The `X-INSTANT-EVENT`/sold-out and theatre date-range cases were verified against the feeds of 2026-11-05 only.
