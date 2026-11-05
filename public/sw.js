/* BCS Life Radar service worker — offline support and home-screen install.
 *
 * Caching rules (all paths are relative to this file, so the site works under /bcs-life-radar/ too):
 *   - PRECACHE (the app shell: HTML, CSS, scripts, manifest, icons): stale-while-revalidate.
 *     Served from the cache immediately; the network copy refreshes the cache in the background.
 *   - DATA_FILES (data/events.json, data/demo-events.json): network-first with cache fallback.
 *     The newest file is always preferred; when the network fails (or stalls for DATA_TIMEOUT_MS)
 *     the last good copy is served with an `X-BCS-Cache: fallback` header and `X-BCS-Cached-At`.
 *     If there is no copy, the fetch fails exactly as it would without a worker, so the app's own
 *     "copy saved on this device" (localStorage) fallback keeps working.
 *   - Anything else — other same-origin files (sw.js, sw-version.json, ?data= overrides) and
 *     every third-party URL (maps, calendars, source sites) — is never touched or cached.
 *
 * VERSION names the cache. Bump it (and public/sw-version.json, kept identical by tests/pwa.test.mjs)
 * whenever the precached files change; the deploy workflow can stamp both with one line.
 * Old caches are deleted on activate; skipWaiting + clients.claim make a new version take over at once.
 */
const VERSION = '2026-11-05.1';
const CACHE_PREFIX = 'bcs-life-radar-';
const CACHE = CACHE_PREFIX + VERSION;
const DATA_TIMEOUT_MS = 12000;

const PRECACHE = [
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/pwa.js",
  "js/shared/export.js",
  "js/shared/logic.js",
  "js/shared/taxonomy.js",
  "js/shared/time.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png"
];
const DATA_FILES = ["data/events.json", "data/demo-events.json"];

const abs = (rel) => new URL(rel, self.location.href).href;
const PRECACHE_URLS = new Set(PRECACHE.map(abs));
const DATA_URLS = new Set(DATA_FILES.map(abs));
const INDEX_URL = abs('index.html');
const SCOPE_ROOT = abs('./');

// URL without query string or fragment, for matching.
function plainUrl(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function putInCache(request, response) {
  if (!response || !response.ok) return;
  const cache = await caches.open(CACHE);
  await cache.put(request, withHeaders(response, { 'X-BCS-Cached-At': new Date().toISOString() }));
}

// ---------- install: precache the app shell, warm the data cache (best effort) ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload' bypasses the HTTP cache so a new version never precaches stale files.
    await Promise.all(PRECACHE.map(async (rel) => {
      const res = await fetch(new Request(abs(rel), { cache: 'reload' }));
      if (!res.ok) throw new Error(`Precache failed: ${rel} (HTTP ${res.status})`);
      await cache.put(abs(rel), withHeaders(res, { 'X-BCS-Cached-At': new Date().toISOString() }));
    }));
    // Data is optional at install time: a missing file must not block the update.
    await Promise.allSettled(DATA_FILES.map(async (rel) => {
      const res = await fetch(abs(rel));
      await putInCache(abs(rel), res);
    }));
    await self.skipWaiting();
  })());
});

// ---------- activate: drop old versions, take over open pages ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ---------- fetch ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // never cache third-party URLs
  const plain = plainUrl(url.href);

  if (request.mode === 'navigate' || request.destination === 'document') {
    if (plain.startsWith(SCOPE_ROOT)) event.respondWith(staleWhileRevalidate(INDEX_URL, event));
    return;
  }
  if (DATA_URLS.has(plain)) {
    event.respondWith(networkFirst(request, plain, event));
    return;
  }
  if (PRECACHE_URLS.has(plain)) {
    event.respondWith(staleWhileRevalidate(plain, event, request));
  }
  // everything else: default browser behaviour, nothing stored
});

async function staleWhileRevalidate(cacheUrl, event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheUrl);
  const refresh = (async () => {
    try {
      const res = await fetch(request || new Request(cacheUrl, { cache: 'no-cache' }));
      if (res && res.ok) await cache.put(cacheUrl, withHeaders(res.clone(), { 'X-BCS-Cached-At': new Date().toISOString() }));
      return res;
    } catch (e) {
      return null;
    }
  })();
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  return Response.error();
}

async function networkFirst(request, cacheUrl, event) {
  const cache = await caches.open(CACHE);
  const network = (async () => {
    const res = await fetch(request);
    if (res && res.ok) await cache.put(cacheUrl, withHeaders(res.clone(), { 'X-BCS-Cached-At': new Date().toISOString() }));
    return res;
  })();
  // Keep the worker alive until the network copy has been stored, even if we answer from the cache below.
  event.waitUntil(network.catch(() => {}));

  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), DATA_TIMEOUT_MS); });
  let res = null;
  let reason = 'timeout';
  try {
    res = await Promise.race([network, timeout]);
  } catch (e) {
    reason = 'network-error';
  } finally {
    clearTimeout(timer);
  }
  if (res && res.ok) return res;
  if (res) reason = `http-${res.status}`;

  const cached = await cache.match(cacheUrl);
  if (cached) return withHeaders(cached, { 'X-BCS-Cache': 'fallback', 'X-BCS-Cache-Reason': reason });
  if (res) return res; // a real error status and nothing to fall back on: let the app see it
  if (reason === 'timeout') return network; // still loading, no copy: let the slow request finish
  return Response.error(); // the page's fetch rejects, exactly as it would without a worker
}

// ---------- messages from the page (js/pwa.js) ----------
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'GET_VERSION') {
    const reply = { type: 'VERSION', version: VERSION, cache: CACHE };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source && event.source.postMessage) event.source.postMessage(reply);
  }
});
