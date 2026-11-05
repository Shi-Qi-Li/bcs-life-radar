# BCS Life Radar

Find things to do in Bryan–College Station, Texas, that fit your **time, budget, transportation and mood** — without filling in a questionnaire first.

- Opens straight to the **next 7 days**, with **3–5 varied top picks** (each says *why* it was picked) and a **Browse all** list.
- Filters: date (today / tomorrow / weekend / next 7 days / pick a date), time of day, time you have, budget, activity type, mood, getting there (walk / bike / bus / drive), kind (one-time, recurring, multi-day, regularly-open places), search.
- Every card: name, short description, date & time (Central Time), location, cost, registration, recommendation reason, original source link, last-updated time.
- **Save**, **Not interested**, **Been there**, and “**Did you go?**” feedback after an event ends — stored only in the browser.
- **Directions** (Apple Maps / Google Maps, in your chosen travel mode) and **Add to calendar** (.ics or Google Calendar).
- Works on phones, iPads and desktops. No accounts, no tracking, no paid APIs.

The workflow it supports: **discover an activity → check details → open navigation or add to calendar → leave simple feedback afterward.**

## Quick start

Requires Node.js 20+ (no npm packages needed to run the site or refresh data).

```bash
npm start
```

Open http://localhost:8080. To see the fictional demo data with a fixed clock (Fri Nov 6 2026, 10 AM CST), open http://localhost:8080/?demo=1.

Refresh the real data (takes ~3–6 minutes; requests are spaced 1 second apart to be polite):

```bash
npm run refresh
```

Run the tests:

```bash
npm test
```

```bash
npm run test:ui
```

`npm run test:ui` uses Playwright with Chromium. If you don't have it: `npm i -D playwright && npx playwright install chromium`.

Useful URL options: `?demo=1` (demo data), `?now=2026-11-06T20:00:00Z` (simulate a different time; a banner says so).

## How it works

```
scripts/refresh.mjs ──► reads sources ──► normalises ──► removes ended items & duplicates ──► public/data/events.json
public/ (static site) ──► loads events.json ──► filters, picks & renders in the browser
```

| Path | What it is |
| --- | --- |
| `public/` | The whole website (HTML, CSS, plain ES modules). No build step. |
| `public/js/shared/` | Logic shared by the site, the refresh script and the tests: Central-time helpers, taxonomy, filtering/picks, calendar & map links. |
| `scripts/sources/` | One adapter per source (`cstx.mjs`, `destinationBryan.mjs`, `theatreCompany.mjs`, `places.mjs`, …). |
| `scripts/lib/ics.mjs` | Small iCalendar reader with recurrence expansion (RRULE/RDATE/EXDATE). |
| `data/places.json` | Hand-curated regularly-open places, each fact copied from an official page. |
| `scripts/make-demo.mjs` | Builds the clearly-labelled demo data through the real pipeline. |
| `tests/` | Unit tests (`node --test`) and browser tests (`tests/ui/`). |
| `.github/workflows/refresh-and-deploy.yml` | Scheduled refresh + free hosting on GitHub Pages. |

Data rules the code enforces:

- **One time zone**: everything is computed and shown in America/Chicago (CST/CDT), whatever the device's zone.
- **Kinds**: one-time, recurring (each date is its own entry), multi-day/ongoing (e.g. exhibits), regularly-open places.
- **Ended items are removed** at refresh time *and* hidden live in the browser. An item with no listed end time stays until the end of its day.
- **Duplicates** (same start minute + very similar title, even across sources) are merged; the card credits both sources.
- **Nothing is invented**: missing cost, end time, duration, registration, hours or location are labelled “not listed”. No travel times or accessibility claims.
- **Failures are visible**: if a source can't be refreshed, its last good items are kept, and the site shows a banner with the failure time, when it last worked, and a link to the source. If the data file itself can't load, the last copy saved in the browser is used and labelled.

## Deploying (free) and ongoing costs

Recommended: **GitHub Pages + GitHub Actions**.

1. Push this folder to a GitHub repository (public repos get free Actions minutes and Pages).
2. In the repo: *Settings → Pages → Source: GitHub Actions*.
3. The workflow refreshes data twice a day and deploys `public/`. The "last good copy" is the live site's own `data/events.json` (read back at the start of each run), so nothing is committed back to the repository. A push that only changes the site or docs reuses the live data instead of crawling the sources again. Run a refresh any time from the *Actions* tab ("Run workflow").

| Item | Cost |
| --- | --- |
| Hosting (GitHub Pages, static files) | $0 |
| Scheduled refresh (GitHub Actions, ~10–15 min/day) | $0 for public repos; a private repo would use ~450 of the 2,000 free minutes/month on the Free plan |
| Data sources | $0 — public pages and a public calendar feed; no API keys |
| Paid APIs / AI / database / accounts | None |
| Custom domain (optional) | ~$10–15/year |

Alternatives with the same $0 profile: Netlify or Cloudflare Pages for hosting with the refresh in GitHub Actions, or any machine with `cron` running `npm run refresh` and serving `public/`.

**Maintenance to expect**: the Destination Bryan adapter reads HTML (discovered through the site's public event sitemap), so a site redesign can break it; the Theatre Company adapter reads a Squarespace page and has the same risk. The refresh then reports “layout may have changed”, keeps the last good data, and the site shows the failure banner — fix the selectors in `scripts/sources/destinationBryan.mjs`. Place hours are re-checked each refresh; if a city page changes wording, the card warns “hours may have changed” and `data/places.json` should be updated by hand. Holiday closure dates in `data/places.json` need a yearly update.

See [SOURCES.md](SOURCES.md) for the source-by-source details and [docs/VERIFICATION.md](docs/VERIFICATION.md) for what was tested.
