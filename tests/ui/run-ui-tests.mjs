#!/usr/bin/env node
// End-to-end checks in a real browser (Playwright + Chromium).
//   npm run test:ui              (needs: npm i -D playwright && npx playwright install chromium)
// Uses the fictional demo data (?demo=1, fixed clock: Fri Nov 6 2026, 10:00 AM CST) for
// deterministic results, plus the real data file for failure-banner checks.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHOTS = `${ROOT}docs/screenshots`;
mkdirSync(SHOTS, { recursive: true });
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const DEMO = `${BASE}/?demo=1`;

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); } catch (e) { results.push([false, name, e.message]); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };

const server = spawn(process.execPath, [`${ROOT}scripts/serve.mjs`, String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch(executablePathOpt());
function executablePathOpt() { return process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}; }

async function open(url, ctxOpts = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
  return { ctx, page, errors };
}
const cardByTitle = (page, t) => page.locator('.card', { has: page.locator('h3', { hasText: t }) });

try {
  console.log('Layouts');
  const layouts = [
    ['phone', devices['iPhone 13']],
    ['tablet', devices['iPad (gen 7)']],
    ['desktop', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 }],
  ];
  for (const [name, dev] of layouts) {
    await check(`${name}: renders 3–5 picks with no horizontal scrolling or errors`, async () => {
      const { ctx, page, errors } = await open(DEMO, { ...dev, timezoneId: 'America/Chicago' });
      const n = await page.locator('#picks .card').count();
      assert(n >= 3 && n <= 5, `expected 3–5 picks, got ${n}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 0, `horizontal overflow ${overflow}px`);
      const firstCardTop = await page.locator('#picks .card').first().boundingBox();
      assert(firstCardTop.y < dev.viewport.height, `first pick starts below the fold (${firstCardTop.y}px)`);
      await page.screenshot({ path: `${SHOTS}/${name}-discover.png` });
      await page.locator('#picks .card').first().locator('[data-act="details"]').first().click();
      await page.waitForSelector('dialog[open]');
      const dOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(dOverflow <= 0, `dialog overflow ${dOverflow}px`);
      await page.screenshot({ path: `${SHOTS}/${name}-details.png` });
      assert(!errors.length, `console errors: ${errors.join(' | ')}`);
      await ctx.close();
    });
  }

  console.log('Cards & data reliability');
  await check('every card shows name, description, when, where, cost, registration, reason, source link, updated time', async () => {
    const { ctx, page } = await open(DEMO);
    const cards = page.locator('#picks .card');
    for (let i = 0; i < await cards.count(); i++) {
      const c = cards.nth(i);
      const txt = await c.innerText();
      for (const label of ['When', 'Where', 'Cost', 'Registration', 'Why this pick', 'Source', 'Updated']) assert(txt.includes(label) || (label === 'Updated' && txt.includes('Hours checked')), `card ${i} missing "${label}"`);
      assert(await c.locator('.desc').count() === 1, `card ${i} missing description`);
      const href = await c.locator('.meta a').first().getAttribute('href');
      assert(/^https:\/\//.test(href), `card ${i} source link ${href}`);
    }
    await ctx.close();
  });
  await check('demo data is labelled as demonstration data', async () => {
    const { ctx, page } = await open(DEMO);
    assert(await page.locator('.banner.demo').count() === 1, 'no demo banner');
    assert(await page.locator('#picks .badge.demo').count() >= 3, 'cards lack demo badge');
    await ctx.close();
  });
  await check('expired event (ended 8 AM) never appears, even in "Browse all"', async () => {
    const { ctx, page } = await open(DEMO);
    await page.click('#toggleAll');
    const body = await page.locator('main').innerText();
    assert(!body.includes('Early Bird Walk'), 'expired event visible');
    assert(body.includes('Lunchtime Park Concert'), 'current event missing');
    // Same page, later clock: concert is over → gone.
    await page.goto(`${DEMO}&now=2026-11-06T19:30:00Z`); await page.waitForSelector('body[data-ready="1"]');
    await page.click('[data-when="today"]');
    assert(!(await page.locator('main').innerText()).includes('Lunchtime Park Concert'), 'ended concert still listed');
    await ctx.close();
  });
  await check('duplicates merged: concert listed once, both sources credited', async () => {
    const { ctx, page } = await open(DEMO);
    await page.click('#toggleAll');
    assert(await page.locator('#allResults h3', { hasText: /Lunchtime/ }).count() === 1, 'duplicate visible');
    assert((await cardByTitle(page, 'Lunchtime Park Concert').first().innerText()).includes('also on'), 'second source not credited');
    await ctx.close();
  });
  await check('unknown cost / end time / registration are labelled, not invented', async () => {
    const { ctx, page } = await open(DEMO);
    await page.click('#toggleAll');
    const trivia = await cardByTitle(page, 'Evening Trivia Night').first().innerText();
    assert(/end time not listed/i.test(trivia), 'missing end-time label');
    assert(/Paid — amount not listed/.test(trivia), 'missing cost label');
    assert(/Registration requirements not listed/.test(trivia), 'missing registration label');
    const craft = await cardByTitle(page, 'Downtown Craft Market').first().innerText();
    assert(/Cost not listed/.test(craft) && /No time listed/.test(craft), 'craft market labels');
    await ctx.close();
  });
  await check('one-time / recurring / multi-day / place are distinguished', async () => {
    const { ctx, page } = await open(DEMO);
    await page.click('#toggleAll');
    const kinds = await page.locator('#allResults .badge[class*="kind-"]').allInnerTexts();
    for (const k of ['ONE-TIME', 'RECURRING', 'MULTI-DAY / ONGOING', 'REGULARLY OPEN PLACE']) assert(kinds.map((x) => x.toUpperCase()).includes(k), `missing kind ${k}`);
    await ctx.close();
  });

  console.log('Time zone');
  for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'Europe/London']) {
    await check(`device in ${tz} still sees Central Time (concert 12–1 PM CST, stargazing 7 PM)`, async () => {
      const { ctx, page } = await open(DEMO, { timezoneId: tz });
      await page.click('#toggleAll');
      const concert = await cardByTitle(page, 'Lunchtime Park Concert').first().innerText();
      assert(/Fri, Nov 6 · 12–1 PM CST/.test(concert), `concert time wrong: ${JSON.stringify(concert.split('Where')[0])}`);
      const stars = await cardByTitle(page, 'Stargazing Night').first().innerText();
      assert(/Sat, Nov 7 · 7–9 PM CST/.test(stars), 'stargazing time wrong');
      // "Today" means today in Chicago.
      await page.click('[data-when="today"]');
      assert((await page.locator('#summary').innerText()).includes('Fri, Nov 6'), 'today range not Chicago');
      await ctx.close();
    });
  }

  console.log('Filters (through the UI)');
  await check('Tomorrow shows only Sat Nov 7 items', async () => {
    const { ctx, page } = await open(DEMO);
    await page.click('[data-when="tomorrow"]');
    await page.click('#toggleAll');
    const whens = await page.locator('#allResults .card .facts div:first-child dd').allInnerTexts();
    assert(whens.length > 0, 'no results');
    for (const w of whens) assert(/Sat, Nov 7|Open Sat, Nov 7|through/.test(w) || /Nov 1 –/.test(w), `unexpected date: ${w}`);
    await ctx.close();
  });
  await check('Budget "Free only" without missing-info items → every cost is Free', async () => {
    const { ctx, page } = await open(DEMO);
    await page.evaluate(() => { document.querySelector('#moreFilters').open = true; });
    await page.selectOption('select[name="budget"]', 'free');
    await page.uncheck('input[name="includeUnknown"]');
    await page.click('#toggleAll').catch(() => {});
    const costs = await page.locator('.results .card .facts div:nth-child(3) dd').allInnerTexts();
    assert(costs.length > 0 && costs.every((c) => c === 'Free'), `costs: ${[...new Set(costs)].join(', ')}`);
    await ctx.close();
  });
  await check('Activity type chip + kind select + search narrow the results', async () => {
    const { ctx, page } = await open(DEMO);
    await page.evaluate(() => { document.querySelector('#moreFilters').open = true; });
    await page.click('[data-type="fitness"]');
    const titles = await page.locator('#picks .card h3').allInnerTexts();
    assert(titles.length && titles.every((t) => /Yoga/.test(t)), `fitness → ${titles}`);
    await page.click('[data-type="fitness"]');
    await page.selectOption('select[name="kind"]', 'place');
    assert((await page.locator('#picks .card h3').allInnerTexts()).join() === '[DEMO] Example Nature Center', 'place filter');
    await page.selectOption('select[name="kind"]', 'all');
    await page.fill('input[name="q"]', 'pottery');
    assert((await page.locator('#picks .card h3').allInnerTexts()).join() === '[DEMO] Beginner Pottery Workshop', 'search');
    await ctx.close();
  });
  await check('Walking + shared location keeps only items within 2.5 km straight-line', async () => {
    const { ctx, page } = await open(DEMO, { geolocation: { latitude: 30.674, longitude: -96.371 }, permissions: ['geolocation'] });
    await page.evaluate(() => { document.querySelector('#moreFilters').open = true; });
    await page.selectOption('select[name="transport"]', 'walk');
    await page.click('#useLocation');
    await page.waitForFunction(() => document.querySelector('#useLocation').textContent.includes('on'));
    await page.uncheck('input[name="includeUnknown"]');
    const txt = await page.locator('.results').innerText();
    assert(!txt.includes('Stargazing'), 'far item shown');
    const d = [...txt.matchAll(/≈([\d.]+) km/g)].map((m) => +m[1]);
    assert(d.length && d.every((x) => x <= 2.5), `distances ${d}`);
    assert((await page.locator('#transportHint').innerText()).includes('not a route'), 'hint should disclaim travel time');
    await ctx.close();
  });

  console.log('Discover → details → navigate / calendar → feedback');
  await check('details dialog: directions link + .ics download with correct UTC time', async () => {
    const { ctx, page } = await open(DEMO);
    await page.click('#toggleAll');
    await cardByTitle(page, 'Lunchtime Park Concert').first().locator('h3 button').click();
    await page.waitForSelector('dialog[open]');
    const dir = await page.locator('dialog a', { hasText: 'Directions' }).getAttribute('href');
    assert(/google\.com\/maps\/dir\/\?api=1&destination=Demo\+Amphitheater/.test(dir), `directions ${dir}`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-detail-act="ics"]')]);
    const ics = readFileSync(await dl.path(), 'utf8');
    assert(ics.includes('DTSTART:20261106T180000Z') && ics.includes('DTEND:20261106T190000Z'), 'ics times');
    const gcal = await page.locator('dialog a', { hasText: 'Google Calendar' }).getAttribute('href');
    assert(gcal.includes('ctz=America%2FChicago'), 'gcal tz');
    await ctx.close();
  });
  await check('Save persists across reloads; Not interested hides with Undo; Been there marks', async () => {
    const { ctx, page } = await open(DEMO);
    const first = page.locator('#picks .card').first();
    const title = await first.locator('h3').innerText();
    await first.locator('[data-act="save"]').click();
    assert((await page.locator('#savedCount').innerText()) === '1', 'saved count');
    await page.reload(); await page.waitForSelector('body[data-ready="1"]');
    await page.click('[data-tab="saved"]');
    await page.waitForSelector('#view-saved:not([hidden])');
    assert((await page.locator('#savedContent').innerText()).includes(title), 'saved item missing after reload');
    await page.click('[data-tab="discover"]');
    await page.waitForSelector('#view-discover:not([hidden])');
    const second = page.locator('#picks .card').nth(1);
    const t2 = await second.locator('h3').innerText();
    await second.locator('[data-act="hide"]').click();
    assert(!(await page.locator('#picks').innerText()).includes(t2), 'hidden item still shown');
    await page.click('#toast button');
    assert((await page.locator('#picks').innerText()).includes(t2), 'undo failed');
    await page.locator('#picks .card').first().locator('[data-act="been"]').click();
    assert(await page.locator('#picks .card').first().locator('.badge', { hasText: 'Been there' }).count() === 1, 'been badge');
    await page.screenshot({ path: `${SHOTS}/desktop-after-actions.png` });
    await ctx.close();
  });
  await check('after the event ends, Saved asks "Did you go?" and records feedback', async () => {
    const { ctx, page } = await open(DEMO, { ...devices['iPhone 13'] });
    await page.click('#toggleAll');
    await cardByTitle(page, 'Lunchtime Park Concert').first().locator('[data-act="save"]').click();
    await page.goto(`${DEMO}&now=2026-11-06T20:00:00Z#/saved`); await page.waitForSelector('body[data-ready="1"]');
    const saved = page.locator('#savedContent');
    assert((await saved.innerText()).includes('Did you go?'), 'no prompt');
    assert(await page.locator('#savedCount.alert').count() === 1, 'nav badge should flag items to rate');
    for (const v of ['saved', 'sources', '']) {
      await page.goto(`${DEMO}&now=2026-11-06T20:00:00Z#/${v}`); await page.waitForSelector('body[data-ready="1"]');
      const ov = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll('.tabs a, .brand')].map((e) => e.getBoundingClientRect().right - innerWidth)));
      assert(ov <= 0, `#/${v}: content overflows the screen by ${ov}px`);
    }
    await page.goto(`${DEMO}&now=2026-11-06T20:00:00Z#/saved`); await page.waitForSelector('body[data-ready="1"]');
    await page.screenshot({ path: `${SHOTS}/phone-saved-feedback.png` });
    await saved.locator('[data-fb="liked"]').first().click();
    assert((await saved.innerText()).includes('👍 Liked it'), 'feedback not recorded');
    assert(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('bcs-life-radar:v1')).feedback)[0].value) === 'liked', 'not in storage');
    await ctx.close();
  });

  console.log('Refresh failures & stale data (real data file)');
  const real = JSON.parse(readFileSync(`${ROOT}public/data/events.json`, 'utf8'));
  await check('failed source → banner with last-updated time and link to original source', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const failed = structuredClone(real);
    failed.sources[1] = { ...failed.sources[1], status: 'failed', error: 'HTTP 503', lastAttempt: new Date().toISOString() };
    failed.generatedAt = new Date().toISOString();
    await page.route('**/data/events.json', (r) => r.fulfill({ json: failed }));
    await page.goto(BASE); await page.waitForSelector('body[data-ready="1"]');
    const b = page.locator('.banner.error');
    assert(await b.count() === 1, 'no failure banner');
    const t = await b.innerText();
    assert(/Couldn't refresh Destination Bryan/.test(t) && /last updated/.test(t), t);
    assert((await b.locator('a').getAttribute('href')) === 'https://www.destinationbryan.com/events/', 'source link');
    await page.screenshot({ path: `${SHOTS}/desktop-source-failed.png` });
    await ctx.close();
  });
  await check('data file unreachable → cached copy on device is used and labelled', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE); await page.waitForSelector('body[data-ready="1"]'); // caches a copy
    await page.route('**/data/events.json', (r) => r.fulfill({ status: 503, body: 'down' }));
    await page.reload(); await page.waitForSelector('body[data-ready="1"]');
    const t = await page.locator('.banner.error').innerText();
    assert(/Couldn't load the latest information/.test(t) && /copy saved on this device/.test(t), t);
    assert(await page.locator('#picks .card').count() >= 3, 'no cards from cache');
    await ctx.close();
  });
  await check('old data (3 days) → "may be out of date" banner', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const old = structuredClone(real); old.generatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    await page.route('**/data/events.json', (r) => r.fulfill({ json: old }));
    await page.goto(BASE); await page.waitForSelector('body[data-ready="1"]');
    assert((await page.locator('#banners').innerText()).includes('may be out of date'), 'no stale banner');
    await ctx.close();
  });
  await check('real data loads on a phone with picks and no errors', async () => {
    const { ctx, page, errors } = await open(BASE, { ...devices['iPhone 13'] });
    assert(await page.locator('#picks .card').count() >= 3, 'too few picks from real data');
    await page.screenshot({ path: `${SHOTS}/phone-real-data.png` });
    await page.click('[data-tab="sources"]');
    await page.screenshot({ path: `${SHOTS}/phone-sources.png`, fullPage: false });
    assert(!errors.length, errors.join('|'));
    await ctx.close();
  });
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed. Screenshots: docs/screenshots/`);
process.exit(failed.length ? 1 : 0);
