#!/usr/bin/env node
// Refresh public/data/events.json from all sources.
//   node scripts/refresh.mjs
//   DAYS=30 BRYAN_PAGES=6 BRYAN_DETAILS=45 node scripts/refresh.mjs
// If a source fails, its previous items are kept (minus ended ones) and the failure is recorded,
// so the site can say "last updated at …" and link to the original source.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as cstx from './sources/cstx.mjs';
import * as dbryan from './sources/destinationBryan.mjs';
import * as places from './sources/places.mjs';
import { dedupe, slug } from './lib/normalize.mjs';
import { isExpired } from '../public/js/shared/logic.js';
import { dayKey, startOfDay } from '../public/js/shared/time.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_OUT = `${ROOT}/public/data/events.json`;
const UA = process.env.USER_AGENT || 'BCSLifeRadar/1.0 (personal, non-commercial local events digest; max 1 request/second)';
const DELAY = +(process.env.REQUEST_DELAY_MS ?? 1000);
const CACHE_DIR = process.env.HTTP_CACHE_DIR || null; // dev only: reuse downloaded pages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
export async function politeFetchText(url, { tries = 2 } = {}) {
  const cacheFile = CACHE_DIR && join(CACHE_DIR, createHash('sha1').update(url).digest('hex'));
  if (cacheFile) { try { return await readFile(cacheFile, 'utf8'); } catch { /* miss */ } }
  for (let attempt = 1; ; attempt++) {
    const wait = lastReq + DELAY - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/calendar,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
      // Respect access restrictions: never retry or work around 401/403.
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status} (access restricted — not retrying)`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (cacheFile) { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(cacheFile, text); }
      return text;
    } catch (e) {
      if (e.fatal || attempt >= tries) throw e;
      await sleep(2000 * attempt);
    }
  }
}

/** Expiry + dedupe + groupKey. Shared by refresh, demo-data builder and tests. */
export function finalizeItems(all, now) {
  const fresh = all.filter((i) => !isExpired(i, now));
  for (const i of fresh) i.groupKey = slug(i.title);
  const sorted = fresh.sort((a, b) => (a.start || '~').localeCompare(b.start || '~') || a.id.localeCompare(b.id));
  const { items, removed } = dedupe(sorted);
  return { items, expiredRemoved: all.length - fresh.length, duplicatesRemoved: removed };
}

export async function refresh({
  now = Date.now(), log = console.log, sources = [cstx, dbryan, places], fetchText = politeFetchText,
  days = +(process.env.DAYS || 30), prev, outPath = DEFAULT_OUT, write = true,
} = {}) {
  if (prev === undefined) { try { prev = JSON.parse(await readFile(outPath, 'utf8')); } catch { prev = null; } }
  const today = dayKey(now);
  const fromMs = startOfDay(today);
  const toMs = startOfDay(today, days + 1);
  const ctx = { fetchText, fromMs, toMs, log, maxListingPages: +(process.env.BRYAN_PAGES || 6), maxDetailPages: +(process.env.BRYAN_DETAILS || 45) };

  const all = [];
  const sourceMeta = [];
  for (const mod of sources) {
    const S = mod.SOURCE;
    const prevMeta = prev?.sources?.find((s) => s.id === S.id);
    const attemptAt = new Date(now).toISOString();
    log(`→ ${S.name}`);
    try {
      const { items, stats, fetchedAt } = await mod.fetchSource(ctx);
      if (!items.length && S.id !== 'places') throw new Error('Source returned zero activities (the feed or page layout may have changed)');
      all.push(...items);
      sourceMeta.push({ id: S.id, name: S.name, homepage: S.homepage, method: S.method, status: 'ok', lastAttempt: attemptAt, lastSuccess: fetchedAt, itemCount: items.length, error: null, stats });
      log(`  ✓ ${items.length} items`);
    } catch (e) {
      const kept = (prev?.items || []).filter((i) => i.sourceId === S.id && !isExpired(i, now));
      all.push(...kept);
      sourceMeta.push({ id: S.id, name: S.name, homepage: S.homepage, method: S.method, status: 'failed', lastAttempt: attemptAt, lastSuccess: prevMeta?.lastSuccess || null, itemCount: kept.length, error: String(e.message || e), stats: null });
      log(`  ✗ failed: ${e.message} — kept ${kept.length} previous items`);
    }
  }

  const { items, expiredRemoved, duplicatesRemoved } = finalizeItems(all, now);
  const out = {
    schema: 1,
    isDemo: false,
    generatedAt: new Date(now).toISOString(),
    timezone: 'America/Chicago',
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), days },
    counts: { items: items.length, expiredRemoved, duplicatesRemoved },
    sources: sourceMeta,
    items,
  };
  if (write) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(out, null, 1));
    log(`Wrote ${items.length} items (${expiredRemoved} ended removed, ${duplicatesRemoved} duplicates merged) → ${outPath}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  refresh().then((o) => {
    // Exit non-zero only if every source failed, so a scheduled job surfaces a total outage
    // while partial failures still publish (with the failure shown on the site).
    if (o.sources.every((s) => s.status === 'failed')) process.exit(2);
  }).catch((e) => { console.error(e); process.exit(1); });
}
