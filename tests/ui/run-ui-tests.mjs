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
  const ctx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 });
  return { ctx, page, errors };
}
const cardByTitle = (page, t) => page.locator('.card', { has: page.locator('h3', { hasText: t }) });
// Browse all shows compact rows on phones and cards elsewhere; both carry data-id.
const itemByTitle = (page, t) => page.locator('#allResults [data-id]', { hasText: t });
// The document must never be wider than the viewport (compare to clientWidth, which does not grow with the content).
const overflowPx = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const ready = (page) => page.waitForSelector('body[data-ready="1"]');

try {
  console.log('Layouts');
  const layouts = [
    ['phone', devices['iPhone 13']],
    ['tablet', devices['iPad (gen 7)']],
    ['desktop', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 }],
  ];
  for (const [name, dev] of layouts) {
    await check(`${name}: renders 3–5 picks; no view is wider than the screen; no errors`, async () => {
      const { ctx, page, errors } = await open(DEMO, { ...dev, timezoneId: 'America/Chicago' });
      const n = await page.locator('#picks .card').count();
      assert(n >= 3 && n <= 5, `expected 3–5 picks, got ${n}`);
      assert((await overflowPx(page)) <= 0, `discover overflows by ${await overflowPx(page)}px`);
      const firstCardTop = await page.locator('#picks .card').first().boundingBox();
      assert(firstCardTop.y < dev.viewport.height, `first pick starts below the fold (${firstCardTop.y}px)`);
      await page.screenshot({ path: `${SHOTS}/${name}-discover.png` });
      await page.locator('#picks .card').first().locator('[data-act="details"]').first().click();
      await page.waitForSelector('dialog[open]');
      assert((await overflowPx(page)) <= 0, `dialog overflows by ${await overflowPx(page)}px`);
      await page.screenshot({ path: `${SHOTS}/${name}-details.png` });
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog:not([open])', { state: 'attached' });
      await page.click('#toggleAll');
      assert((await overflowPx(page)) <= 0, `browse all overflows by ${await overflowPx(page)}px`);
      await page.screenshot({ path: `${SHOTS}/${name}-browse-all.png` });
      for (const v of ['saved', 'sources']) {
        await page.click(`[data-tab="${v}"]`);
        await page.waitForSelector(`#view-${v}:not([hidden])`);
        assert((await overflowPx(page)) <= 0, `#/${v} overflows by ${await overflowPx(page)}px`);
      }
      assert(!errors.length, `console errors: ${errors.join(' | ')}`);
      await ctx.close();
    });
  }
  await check('phone: Sources tables stay inside their cards; toast Undo is on screen; touch targets ≥ 44 px', async () => {
    const { ctx, page } = await open(`${BASE}/#/sources`, { ...devices['iPhone 13'], timezoneId: 'America/Chicago' });
    await page.waitForSelector('#view-sources:not([hidden])');
    const tbl = await page.evaluate(() => [...document.querySelectorAll('.source-card')].map((c) => c.querySelector('table').getBoundingClientRect().width - c.getBoundingClientRect().width));
    assert(tbl.length && tbl.every((d) => d <= 0), `table wider than card by ${tbl}`);
    const linkText = await page.locator('table.kv a').first().innerText();
    assert(!/^https?:/.test(linkText), `source link should show the hostname, got ${linkText}`);
    await page.goto(DEMO); await ready(page);
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.tabs a, #filters .chip, #picks .btn, .more > summary, #toggleAll')].filter((e) => e.offsetParent).map((e) => [e.tagName + (e.className ? `.${String(e.className).split(' ')[0]}` : ''), Math.round(e.getBoundingClientRect().height)]));
    const small = sizes.filter(([, h]) => h < 44);
    assert(sizes.length > 10 && !small.length, `targets under 44 px: ${JSON.stringify(small.slice(0, 6))}`);
    await page.locator('#picks .card').nth(1).locator('[data-act="hide"]').click();
    const undo = await page.locator('#toast .undo').boundingBox();
    const vh = await page.evaluate(() => (window.visualViewport ? window.visualViewport.height : innerHeight));
    assert(undo && undo.y + undo.height <= vh, `Undo button off screen (${JSON.stringify(undo)} vs ${vh})`);
    await page.click('#toast .dismiss');
    assert(await page.locator('#toast[hidden]').count() === 1, 'toast did not dismiss');
    await ctx.close();
  });

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
      const reason = await c.locator('.reason').innerText();
      assert(reason.replace('Why this pick:', '').split(' · ').length >= 2, `card ${i} reason is a bare when-phrase: ${reason}`);
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
    await page.goto(`${DEMO}&now=2026-11-06T19:30:00Z`); await ready(page);
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
  await check('"Right now" strip: concert starts in 2 h and the nature center is open now (hidden when empty)', async () => {
    const { ctx, page } = await open(DEMO);
    assert(await page.locator('#nowStrip:not([hidden])').count() === 1, 'strip hidden');
    const chips = await page.locator('#nowChips .now-chip').allInnerTexts();
    assert(chips.some((t) => /starts in 2 h/i.test(t) && /Lunchtime Park Concert/.test(t)), `no "starts in 2 h" chip: ${chips}`);
    assert(chips.some((t) => /open now/i.test(t) && /Nature Center/.test(t)), `no "open now" chip: ${chips}`);
    await page.locator('#nowChips .now-chip').first().click();
    await page.waitForSelector('dialog[open]');
    assert((await page.locator('#detailTitle').innerText()).includes('Lunchtime Park Concert'), 'chip did not open details');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !location.hash.startsWith('#/item/')); // the close handler pops its history entry
    // Tue Nov 10, 10 PM: the book club has ended and nothing starts within 3 h → the strip is hidden.
    await page.goto(`${DEMO}&now=2026-11-11T04:00:00Z`); await ready(page);
    assert(await page.locator('#nowStrip[hidden]').count() === 1, 'strip should be hidden on Tue 10 PM');
    await ctx.close();
  });
  await check('recurring series are grouped in Browse all (one card, date chips) unless "show every date" is chosen', async () => {
    const demo = JSON.parse(readFileSync(`${ROOT}public/data/demo-events.json`, 'utf8'));
    const yoga = demo.items.find((i) => i.title === '[DEMO] Saturday Yoga in the Park');
    const shift = (it, days) => ({ ...it, id: `${it.id}-plus${days}`, start: new Date(Date.parse(it.start) + days * 864e5).toISOString(), end: new Date(Date.parse(it.end) + days * 864e5).toISOString() });
    const data = { ...demo, items: [...demo.items, shift(yoga, 2), shift(yoga, 4)] }; // Mon Nov 9 and Wed Nov 11 too
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.route('**/data/demo-events.json', (r) => r.fulfill({ json: data }));
    await page.goto(DEMO); await ready(page);
    assert((await page.locator('#summary').innerText()).includes('2 repeat dates grouped'), await page.locator('#summary').innerText());
    await page.click('#toggleAll');
    const yogaCards = itemByTitle(page, 'Saturday Yoga in the Park');
    assert(await yogaCards.count() === 1, `expected 1 grouped yoga card, got ${await yogaCards.count()}`);
    const chips = await yogaCards.first().locator('.repeats [data-open]').allInnerTexts();
    assert(chips.join(' ') === 'Mon 9 Wed 11', `date chips: ${chips.join(' | ')}`);
    assert(await page.locator('#picks .card h3', { hasText: 'Yoga' }).count() <= 1, 'picks must still show a series once');
    await yogaCards.first().locator('.repeats [data-open]').nth(1).click();
    await page.waitForSelector('dialog[open]');
    assert((await page.locator('#detail .facts').innerText()).includes('Wed, Nov 11'), 'chip should open that date');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.querySelector('#moreFilters').open = true; });
    await page.selectOption('select[name="kind"]', 'every');
    assert(await itemByTitle(page, 'Saturday Yoga in the Park').count() === 3, 'every date should list all three');
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
  await check('day pills show counts and select a date; mood shows its types; filters make a shareable URL', async () => {
    const { ctx, page } = await open(DEMO);
    const pills = await page.locator('#dayStrip .day-pill').allInnerTexts();
    assert(pills.length === 7 && /^Today 6/.test(pills[0].replace(/\s+/g, ' ')) && /^Tmrw 7/.test(pills[1].replace(/\s+/g, ' ')), `pills: ${pills.join(' | ')}`);
    await page.click('#dayStrip .day-pill[data-day="2026-11-10"]');
    const summary = await page.locator('#summary').innerText();
    assert(/Selected date \(Tue, Nov 10\)/.test(summary), summary);
    assert(await page.locator('#dayStrip .day-pill[data-day="2026-11-10"][aria-pressed="true"]').count() === 1, 'pill not highlighted');
    assert((await page.locator('#pickDate').innerText()).includes('Tue, Nov 10'), 'date chip label');
    await page.evaluate(() => { document.querySelector('#moreFilters').open = true; });
    await page.click('[data-mood="social"]');
    assert((await page.locator('#moodHint').innerText()).startsWith('Social = Games & social'), 'mood hint');
    const hash = await page.evaluate(() => location.hash);
    assert(hash.includes('when=date') && hash.includes('date=2026-11-10') && hash.includes('mood=social'), `hash ${hash}`);
    // The URL restores the same filters.
    await page.goto(`${DEMO}${hash}`); await ready(page);
    assert((await page.locator('#summary').innerText()).includes('Tue, Nov 10'), 'deep-linked date lost');
    assert(await page.locator('[data-mood="social"][aria-pressed="true"]').count() === 1, 'deep-linked mood lost');
    await ctx.close();
  });
  await check('late evening: When defaults to Tomorrow with a dismissible note; a thin range suggests other ranges', async () => {
    const { ctx, page } = await open(`${DEMO}&now=2026-11-07T04:00:00Z`); // 10 PM CST Friday
    assert(await page.locator('[data-when="tomorrow"][aria-pressed="true"]').count() === 1, 'When should default to Tomorrow after 9 PM');
    assert((await page.locator('#lateNote').innerText()).includes('after 9 PM'), 'no late note');
    await page.click('#lateNote [data-when="today"]');
    assert(await page.locator('#lateNote[hidden]').count() === 1, 'note should go when the user picks a range');
    const suggest = await page.locator('#suggest').innerText();
    assert(/Not much left tonight/.test(suggest) && /Tomorrow \(\d+\)/.test(suggest), `suggestion row: ${suggest}`);
    await page.click('#suggest [data-when="weekend"]');
    assert((await page.locator('#summary').innerText()).includes('This weekend'), 'suggestion did not switch range');
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
  await check('details dialog is a history entry: Back closes it, focus returns to the opener, #/item/<id> deep-links', async () => {
    const { ctx, page } = await open(DEMO, { ...devices['iPhone 13'], timezoneId: 'America/Chicago' });
    const first = page.locator('#picks .card').first();
    const title = await first.locator('h3').innerText();
    await first.locator('.actions [data-act="details"]').click();
    await page.waitForSelector('dialog[open]');
    const hash = await page.evaluate(() => location.hash);
    assert(/^#\/item\//.test(hash), `hash ${hash}`);
    // Scrolled dialog on a phone: the close button is still on screen.
    await page.evaluate(() => { document.querySelector('.dialog-inner').scrollTop = 600; });
    const close = await page.locator('#closeDetail').boundingBox();
    assert(close && close.y >= 0 && close.y < 100, `close button off screen: ${JSON.stringify(close)}`);
    await page.goBack();
    await page.waitForSelector('dialog:not([open])', { state: 'attached' });
    assert((await page.evaluate(() => location.href)).startsWith(DEMO), 'Back left the site');
    assert(await page.evaluate(() => document.activeElement?.dataset.act) === 'details', 'focus did not return to the opener');
    // × also drops the history entry (Back then leaves normally) and the deep link opens the same item.
    await page.goto(`${DEMO}${hash}`); await ready(page);
    await page.waitForSelector('dialog[open]');
    assert((await page.locator('#detailTitle').innerText()) === title, 'deep link opened the wrong item');
    await page.click('#closeDetail');
    await page.waitForSelector('dialog:not([open])', { state: 'attached' });
    await page.waitForFunction(() => !location.hash.startsWith('#/item/'));
    await ctx.close();
  });
  await check('Save / Been there toggle in place: picks stay, dialog keeps its scroll, focus stays, no self "similar" reason', async () => {
    const { ctx, page } = await open(DEMO, { viewport: { width: 1280, height: 520 } }); // short window so the dialog scrolls
    const before = await page.locator('#picks .card h3').allInnerTexts();
    const first = page.locator('#picks .card').first();
    await first.locator('[data-act="save"]').click();
    assert(await page.evaluate(() => document.activeElement?.dataset.act) === 'save', 'focus lost after Save');
    assert((await first.locator('[data-act="save"]').innerText()) === '★ Saved', 'button not toggled');
    assert(!(await first.locator('.reason').innerText()).includes('Similar to things you saved'), 'self-referential reason');
    await page.locator('#picks .card').nth(1).locator('[data-act="been"]').click();
    const after = await page.locator('#picks .card h3').allInnerTexts();
    assert(JSON.stringify(after) === JSON.stringify(before), `picks changed: ${before} → ${after}`);
    assert((await page.locator('#picks .card').nth(1).locator('[data-act="been"]').innerText()) === '✓ Been there', 'been not toggled in place');
    await first.locator('.actions [data-act="details"]').click();
    await page.waitForSelector('dialog[open]');
    const scrollBefore = await page.evaluate(() => { const d = document.querySelector('.dialog-inner'); d.scrollTop = 150; return d.scrollTop; });
    assert(scrollBefore > 100, `dialog not scrollable (${scrollBefore})`);
    await page.click('[data-detail-act="save"]');
    assert((await page.evaluate(() => document.querySelector('.dialog-inner').scrollTop)) === scrollBefore, 'dialog scroll reset');
    assert(await page.evaluate(() => document.activeElement?.dataset.detailAct) === 'save', 'dialog focus moved');
    assert((await page.locator('[data-detail-act="save"]').innerText()) === '☆ Save', 'dialog save button not toggled');
    assert(await page.locator('[data-detail-act="share"]').count() === 1, 'no Share button');
    await ctx.close();
  });
  await check('Save persists across reloads; Not interested hides with Undo; Been there marks', async () => {
    const { ctx, page } = await open(DEMO);
    const first = page.locator('#picks .card').first();
    const title = await first.locator('h3').innerText();
    await first.locator('[data-act="save"]').click();
    assert((await page.locator('#savedCount').innerText()) === '1', 'saved count');
    await page.reload(); await ready(page);
    await page.click('[data-tab="saved"]');
    await page.waitForSelector('#view-saved:not([hidden])');
    assert((await page.locator('#savedContent').innerText()).includes(title), 'saved item missing after reload');
    await page.click('[data-tab="discover"]');
    await page.waitForSelector('#view-discover:not([hidden])');
    const second = page.locator('#picks .card').nth(1);
    const t2 = await second.locator('h3').innerText();
    await second.locator('[data-act="hide"]').click();
    assert(!(await page.locator('#picks').innerText()).includes(t2), 'hidden item still shown');
    await page.click('#toast .undo');
    assert((await page.locator('#picks').innerText()).includes(t2), 'undo failed');
    await page.locator('#picks .card').first().locator('[data-act="been"]').click();
    assert(await page.locator('#picks .card').first().locator('.badge', { hasText: 'Been there' }).count() === 1, 'been badge');
    await page.screenshot({ path: `${SHOTS}/desktop-after-actions.png` });
    await ctx.close();
  });
  await check('after the event ends, Saved asks "Did you go?" and records feedback', async () => {
    const { ctx, page } = await open(DEMO, { ...devices['iPhone 13'] });
    await page.click('#toggleAll');
    await itemByTitle(page, 'Lunchtime Park Concert').first().locator('[data-act="save"]').click();
    assert((await page.locator('#savedCount').innerText()) === '1', 'saved from the list row');
    await page.goto(`${DEMO}&now=2026-11-06T20:00:00Z#/saved`); await ready(page);
    const saved = page.locator('#savedContent');
    assert((await saved.innerText()).includes('Did you go?'), 'no prompt');
    assert(await page.locator('#savedCount.alert').count() === 1, 'nav badge should flag items to rate');
    for (const v of ['saved', 'sources', '']) {
      await page.goto(`${DEMO}&now=2026-11-06T20:00:00Z#/${v}`); await ready(page);
      const ov = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, ...[...document.querySelectorAll('.tabs a, .brand')].map((e) => e.getBoundingClientRect().right - document.documentElement.clientWidth)));
      assert(ov <= 0, `#/${v}: content overflows the screen by ${ov}px`);
    }
    await page.goto(`${DEMO}&now=2026-11-06T20:00:00Z#/saved`); await ready(page);
    await page.screenshot({ path: `${SHOTS}/phone-saved-feedback.png` });
    await saved.locator('[data-fb="liked"]').first().click();
    assert((await saved.innerText()).includes('👍 Liked it'), 'feedback not recorded');
    assert(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('bcs-life-radar:v1')).feedback)[0].value) === 'liked', 'not in storage');
    await ctx.close();
  });
  await check('phone Browse all: compact list rows by default, Cards/List toggle remembered, sticky day headings sit under the header', async () => {
    const { ctx, page } = await open(DEMO, { ...devices['iPhone 13'], timezoneId: 'America/Chicago' });
    await page.click('[data-browse-all]');
    assert(await page.locator('#allResults .row').count() > 5, 'no list rows');
    assert(await page.locator('#allResults .card').count() === 0, 'cards shown in list mode');
    const rowOver = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#allResults .row, #allResults .row [data-act="save"]')].map((e) => e.getBoundingClientRect().right - document.documentElement.clientWidth)));
    assert(rowOver <= 0, `list rows reach past the screen edge by ${rowOver}px`);
    assert(await page.locator('#viewToggle [data-view="list"][aria-pressed="true"]').count() === 1, 'List not marked active');
    const headerH = await page.evaluate(() => document.querySelector('.site-header').getBoundingClientRect().height);
    const top = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.day-heading')).top));
    assert(Math.abs(top - headerH) < 1.5, `day heading top ${top} vs header ${headerH}`);
    const headings = await page.locator('.day-heading').allInnerTexts();
    assert(headings[0].startsWith('Today · Fri, Nov 6'), `heading format: ${headings[0]}`);
    await page.screenshot({ path: `${SHOTS}/phone-browse-list.png` });
    await page.locator('#allResults .row').first().locator('.row-main').click();
    await page.waitForSelector('dialog[open]');
    await page.keyboard.press('Escape');
    await page.click('[data-view="cards"]');
    assert(await page.locator('#allResults .card').count() > 5, 'cards mode did not render');
    await page.reload(); await ready(page);
    await page.click('#toggleAll');
    assert(await page.locator('#allResults .card').count() > 5, 'layout choice not remembered');
    await ctx.close();
  });

  console.log('Refresh failures & stale data (real data file)');
  const real = JSON.parse(readFileSync(`${ROOT}public/data/events.json`, 'utf8'));
  await check('failed source → banner with last-updated time and link to original source', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const failed = structuredClone(real);
    failed.sources[1] = { ...failed.sources[1], status: 'failed', error: 'HTTP 503', lastAttempt: new Date().toISOString() };
    failed.generatedAt = new Date().toISOString();
    await page.route('**/data/events.json', (r) => r.fulfill({ json: failed }));
    await page.goto(BASE); await ready(page);
    const b = page.locator('.banner.error');
    assert(await b.count() === 1, 'no failure banner');
    const t = await b.innerText();
    assert(/Couldn't refresh Destination Bryan/.test(t) && /last updated/.test(t), t);
    assert((await b.locator('a').getAttribute('href')) === 'https://www.destinationbryan.com/events/', 'source link');
    await page.screenshot({ path: `${SHOTS}/desktop-source-failed.png` });
    await ctx.close();
  });
  await check('data file unreachable → cached copy on device is used and labelled', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE); await ready(page); // caches a copy
    await page.route('**/data/events.json', (r) => r.fulfill({ status: 503, body: 'down' }));
    await page.reload(); await ready(page);
    const t = await page.locator('.banner.error').innerText();
    assert(/Couldn't load the latest information/.test(t) && /copy saved on this device/.test(t), t);
    assert(await page.locator('#picks .card').count() >= 3, 'no cards from cache');
    await ctx.close();
  });
  await check('repeat visit paints picks from the saved copy before the network answers', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE); await ready(page); // caches a copy
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/data/events.json', async (r) => { await gate; await r.continue(); });
    await page.reload();
    await page.waitForSelector('#picks .card:not(.skeleton)', { timeout: 5000 });
    assert(await page.evaluate(() => document.body.dataset.ready) !== '1', 'ready flag should wait for the network copy');
    release();
    await ready(page);
    await ctx.close();
  });
  await check('old data (3 days) → "may be out of date" banner', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const old = structuredClone(real); old.generatedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    await page.route('**/data/events.json', (r) => r.fulfill({ json: old }));
    await page.goto(BASE); await ready(page);
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
