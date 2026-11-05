# Verification report — 2026-11-05

All results below were produced by running the commands in this repository. Re-run them with `npm test` and `npm run test:ui`.

## Real data, end to end

`npm run refresh` on 2026-11-05 (≈5 minutes):

| Source | Result |
| --- | --- |
| City of College Station Calendar (ICS) | OK: 337 feed entries → 31 activity dates in the next 30 days (94 excluded: 57 meetings/closures/notices, 22 cancelled, 15 internal) |
| Destination Bryan (HTML) | OK: 6 listing pages + ~43 event pages → 111 activity dates (2 event pages timed out and were skipped and logged) |
| Places (curated) | OK: 4 places, all hours/address snippets still present on the official pages |
| Total | 145 items after removing 1 ended item. 0 cross-source duplicates found in real data on this day; merging is verified with fixtures. |

The site loads this file on a phone with picks and no console errors (UI check 23).

## Unit tests — `npm test` (20/20 pass)

Run under five machine time zones (UTC, America/Chicago, Asia/Shanghai, America/Los_Angeles, Pacific/Kiritimati) with identical results:

```bash
TZ=Asia/Shanghai npm test
```

A mutation check (disabling expiry) makes the expiry tests fail as expected.

| Area | What is checked |
| --- | --- |
| Time zone | CST/CDT conversion; DST spring-forward gap and fall-back overlap; day boundaries and display in Chicago regardless of machine zone; a UTC (`Z`) event shown as 7 PM CST |
| Recurrence | Weekly series keeps 8 AM wall time across the Nov 1 DST change; EXDATE removes a date; monthly "2nd Tuesday"; "last Thursday"; unsupported rules reported, not guessed |
| Exclusions | Internal and meeting entries dropped |
| Expiry | Ended items removed by the pipeline; boundary exactly at end time; no-end-time items last until the end of their day; live removal as the clock moves |
| Dedupe | The same concert from two sources is merged and both sources are credited |
| Filters | Next 7 days / today / tomorrow / weekend / specific date; budget free / ≤$10 / unknowns only when allowed; type, mood, kind, time of day, time available; walking radius only with a shared location |
| Places | Weekly hours plus closure dates produce correct open windows in CT |
| Picks | 3–5 picks, no repeated series, ≥3 different types, each with a reason; hidden series excluded |
| Calendar | .ics UTC times; no DTEND when the end isn't listed; all-day `VALUE=DATE`; lines folded ≤75 octets; Google Calendar link |
| Destination Bryan parser | Visible "7:00 PM" wins over the wrong JSON-LD `Z`; Dec→Jan year rollover; repeated-date time note |
| Refresh failure | A failing source keeps its last good, non-ended items, records the error and the last success time |

## Browser tests — `npm run test:ui` (23/23 pass, Playwright + Chromium)

| # | Check |
| --- | --- |
| 1–3 | **Phone (iPhone 13), iPad (gen 7), desktop 1366×900**: 3–5 picks, first pick above the fold, no horizontal scrolling on Discover or in the details dialog, no console errors |
| 4 | Every pick shows name, description, when, where, cost, registration, "Why this pick", source link, updated time |
| 5 | Demo data has a banner and badges |
| 6 | The ended event never appears, even in "Browse all"; the concert disappears once the simulated clock passes its end |
| 7 | Duplicate shown once, with "also on" the second source |
| 8 | Unknown end time, cost and registration are labelled "not listed" |
| 9 | All four kinds are labelled |
| 10–12 | **Device time zone Tokyo / Los Angeles / London**: concert still "Fri, Nov 6 · 12–1 PM CST"; "Today" means today in Chicago |
| 13 | "Tomorrow" shows only Sat Nov 7 |
| 14 | "Free only" without missing-info items → every cost shown is "Free" |
| 15 | Type chip, kind select and search narrow the results |
| 16 | Walking + shared (simulated) location → only items within 2.5 km straight-line; the hint says it is not a route or travel time |
| 17 | Details → Directions URL (Google/Apple Maps) and .ics download with `DTSTART:20261106T180000Z` (12 PM CST); Google Calendar link uses `ctz=America/Chicago` |
| 18 | Save survives a reload (localStorage); Not interested hides and Undo restores; Been there badge |
| 19 | After the event ends, Saved shows "Did you go?" and the nav badge flags it; 👍 feedback is stored; no horizontal overflow on Saved, Sources or Discover on a phone |
| 20 | A failed source shows a banner with its last-updated time and a link to the original source |
| 21 | Data file unreachable → the cached copy on the device is used and labelled |
| 22 | 3-day-old data → "may be out of date" banner |
| 23 | Real data on a phone: picks render, Sources page renders, no errors |

Screenshots from the run are in `docs/screenshots/`.

## Issues found and fixed during verification

- Destination Bryan JSON-LD times carry a wrong `Z`. Switched to visible text and added a test.
- Destination Bryan puts nearly every event in "Arts & Culture", so "arts" dominated the filters. Its categories are now weak hints.
- The phone filter panel pushed the picks below the fold. Compacted the layout; a test now checks the first pick is above the fold.
- Header tabs overflowed a phone screen when the Saved badge was long. Shortened the badge, wrapped the header, and added an overflow test on every view.
- A place description had been paraphrased beyond the source ("55+", "hosts City programs"). Replaced it with the page's own wording.

## Not verified

- Real iOS/Android devices and Safari: tested with Chromium device emulation only.
- Opening the downloaded .ics in Apple Calendar or Outlook: the file is checked for correct content only.
- The GitHub Actions workflow hasn't run because nothing was pushed to a GitHub repository.
