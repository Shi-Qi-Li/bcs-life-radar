// PWA checks: the web app manifest, the service worker's precache list and caching rules, and js/pwa.js.
// sw.js is run in a node:vm sandbox with stub `caches`/`fetch`, so its routing is tested without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const read = (rel) => readFileSync(join(PUBLIC, rel), 'utf8');
const swSource = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));
const swVersionFile = JSON.parse(read('sw-version.json'));

const extractArray = (name) => {
  const m = swSource.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
  assert.ok(m, `sw.js should declare const ${name} = [...]`);
  return JSON.parse(m[1]);
};
const PRECACHE = extractArray('PRECACHE');
const DATA_FILES = extractArray('DATA_FILES');
const VERSION = swSource.match(/^const VERSION = '([^']+)';$/m)?.[1];

const isRelative = (p) => !/^(\/|https?:|\/\/|data:)/i.test(p);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const pngSize = (rel) => {
  const b = readFileSync(join(PUBLIC, rel));
  assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a', `${rel} should be a PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

test('manifest: installable fields, relative URLs, icons exist with the declared sizes', () => {
  assert.equal(manifest.name, 'BCS Life Radar');
  assert.equal(manifest.short_name, 'Life Radar');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#f8f6f4');
  assert.equal(manifest.theme_color, '#500000'); // Aggie Maroon, same as <meta name="theme-color">
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  const sizes = new Set();
  for (const icon of manifest.icons) {
    assert.ok(isRelative(icon.src), `icon src must be relative: ${icon.src}`);
    assert.equal(icon.type, 'image/png');
    assert.equal(pngSize(icon.src), icon.sizes, `${icon.src} should be ${icon.sizes}`);
    sizes.add(`${icon.sizes}:${icon.purpose || 'any'}`);
  }
  assert.ok(sizes.has('192x192:any') && sizes.has('512x512:any'), 'needs 192 and 512 "any" icons');
  assert.ok(sizes.has('512x512:maskable'), 'needs a maskable icon');
  assert.equal(pngSize('icons/apple-touch-icon.png'), '180x180');
  for (const s of manifest.shortcuts || []) assert.ok(isRelative(s.url), `shortcut url must be relative: ${s.url}`);
});

test('sw.js: version constant matches sw-version.json; no third-party URLs', () => {
  assert.ok(VERSION, 'sw.js should declare const VERSION');
  assert.equal(swVersionFile.version, VERSION, 'public/sw-version.json must carry the same version as sw.js');
  assert.match(VERSION, /^[\w.-]+$/);
  assert.doesNotMatch(swSource, /https?:\/\//, 'sw.js must not reference absolute (third-party) URLs');
  assert.match(swSource, /skipWaiting\(\)/);
  assert.match(swSource, /clients\.claim\(\)/);
});

test('sw.js: precache list is relative, exists on disk and covers every app file', () => {
  for (const rel of [...PRECACHE, ...DATA_FILES]) {
    assert.ok(isRelative(rel), `must be relative: ${rel}`);
    assert.ok(existsSync(join(PUBLIC, rel)), `listed in sw.js but missing: public/${rel}`);
  }
  const must = ['index.html', 'styles.css', 'manifest.webmanifest', ...manifest.icons.map((i) => i.src),
    ...walk(join(PUBLIC, 'js')).map((p) => relative(PUBLIC, p).split('\\').join('/'))];
  for (const rel of must) assert.ok(PRECACHE.includes(rel), `should be precached: ${rel}`);
  assert.deepEqual(DATA_FILES, ['data/events.json', 'data/demo-events.json']);
  for (const rel of ['sw.js', 'sw-version.json']) assert.ok(!PRECACHE.includes(rel), `${rel} must never be cached`);
  assert.equal(new Set(PRECACHE).size, PRECACHE.length, 'no duplicates');
});

test('pwa.js: registers sw.js relatively and exposes window.__bcsSwStatus', () => {
  const src = read('js/pwa.js');
  assert.match(src, /new URL\('\.\.\/sw\.js', import\.meta\.url\)/);
  assert.match(src, /window\.__bcsSwStatus = /);
  assert.match(src, /serviceWorker\.register\(/);
  assert.match(src, /updatefound/);
  assert.doesNotMatch(src, /https?:\/\//);
});

// ---------- sw.js behaviour in a sandbox ----------
const ORIGIN = 'https://example.github.io';
const BASE = `${ORIGIN}/bcs-life-radar/`;

function loadWorker(network) {
  const stores = new Map();
  const keyOf = (r) => (typeof r === 'string' ? r : r.url);
  const caches = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        put: async (req, res) => { m.set(keyOf(req), res); },
        match: async (req) => { const r = m.get(keyOf(req)); return r ? r.clone() : undefined; },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
  };
  const listeners = {};
  const self = {
    location: new URL('sw.js', BASE),
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => { self.skipped = true; },
    clients: { claim: async () => { self.claimed = true; } },
  };
  const calls = [];
  const fetchStub = async (req) => {
    const url = keyOf(req);
    calls.push(url);
    const r = await network(url, req);
    if (r instanceof Error) throw r;
    return r;
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchStub, Request, Response, Headers, URL, setTimeout, clearTimeout, console });
  vm.runInContext(swSource, ctx, { filename: 'sw.js' });
  const waits = [];
  const fire = async (type, request) => {
    const ev = { request, waitUntil: (p) => waits.push(p), respondWith: (p) => { ev.handled = true; ev.p = p; } };
    listeners[type](ev);
    const res = ev.handled ? await ev.p : undefined;
    return { res, handled: !!ev.handled, ev };
  };
  const settle = () => Promise.allSettled(waits.splice(0));
  return { listeners, stores, self, calls, fire, settle, caches, cacheName: `bcs-life-radar-${VERSION}` };
}
const okText = (t) => new Response(t, { status: 200, headers: { 'Content-Type': 'text/plain' } });
const navRequest = (url) => ({ url, method: 'GET', mode: 'navigate', destination: 'document', headers: new Headers() });

async function installed(network = () => okText('shell')) {
  const w = loadWorker(network);
  const ev = { waitUntil: (p) => { ev.p = p; } };
  w.listeners.install(ev);
  await ev.p;
  return w;
}

test('install precaches the app shell (bypassing the HTTP cache), warms the data cache, skips waiting', async () => {
  const w = await installed((url, req) => (url.endsWith('demo-events.json') ? new Response('nope', { status: 404 }) : okText(`body of ${url}`)));
  const store = w.stores.get(w.cacheName);
  for (const rel of PRECACHE) assert.ok(store.has(BASE + rel), `precached ${rel}`);
  assert.ok(store.has(BASE + 'data/events.json'), 'real data warmed');
  assert.ok(!store.has(BASE + 'data/demo-events.json'), 'a failed data warm-up is skipped, not stored');
  assert.ok(w.self.skipped, 'skipWaiting called');
  assert.ok(store.get(BASE + 'index.html').headers.get('X-BCS-Cached-At'));
});

test('install fails (old version stays) when an app-shell file is missing', async () => {
  const w = loadWorker((url) => (url.endsWith('styles.css') ? new Response('', { status: 404 }) : okText('x')));
  const ev = { waitUntil: (p) => { ev.p = p; } };
  w.listeners.install(ev);
  await assert.rejects(ev.p, /styles\.css/);
});

test('activate deletes old versions of our cache only, then claims clients', async () => {
  const w = await installed();
  await w.caches.open('bcs-life-radar-old');
  await w.caches.open('something-else');
  const ev = { waitUntil: (p) => { ev.p = p; } };
  w.listeners.activate(ev);
  await ev.p;
  const names = await w.caches.keys();
  assert.deepEqual(names.sort(), [w.cacheName, 'something-else'].sort());
  assert.ok(w.self.claimed);
});

test('fetch: third-party and unlisted same-origin requests are left alone', async () => {
  const w = await installed();
  for (const url of ['https://maps.apple.com/?daddr=x', 'https://www.google.com/maps', `${BASE}sw-version.json`, `${BASE}sw.js`, `${BASE}data/other.json`]) {
    const { handled } = await w.fire('fetch', new Request(url));
    assert.equal(handled, false, `should not handle ${url}`);
  }
  const post = await w.fire('fetch', new Request(`${BASE}data/events.json`, { method: 'POST', body: 'x' }));
  assert.equal(post.handled, false, 'non-GET is not handled');
});

test('fetch: data is network-first and the network copy is stored', async () => {
  const w = await installed();
  w.calls.length = 0;
  const { res } = await w.fire('fetch', new Request(`${BASE}data/events.json`, { cache: 'no-cache' }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'shell');
  assert.equal(res.headers.get('X-BCS-Cache'), null, 'a network response is not flagged');
  assert.deepEqual(w.calls, [`${BASE}data/events.json`]);
  await w.settle();
  assert.ok(w.stores.get(w.cacheName).get(BASE + 'data/events.json').headers.get('X-BCS-Cached-At'));
});

test('fetch: data falls back to the last good copy when the network fails or errors', async () => {
  let mode = 'ok';
  const w = await installed((url) => {
    if (!url.endsWith('events.json') || mode === 'ok') return okText(url.endsWith('events.json') ? '{"items":[1]}' : 'x');
    return mode === 'throw' ? new TypeError('Failed to fetch') : new Response('down', { status: 503 });
  });
  mode = 'throw';
  const a = await w.fire('fetch', new Request(`${BASE}data/events.json`));
  assert.equal(a.res.status, 200);
  assert.equal(await a.res.text(), '{"items":[1]}');
  assert.equal(a.res.headers.get('X-BCS-Cache'), 'fallback');
  assert.equal(a.res.headers.get('X-BCS-Cache-Reason'), 'network-error');
  assert.ok(a.res.headers.get('X-BCS-Cached-At'), 'tells the app how old the copy is');
  mode = '503';
  const b = await w.fire('fetch', new Request(`${BASE}data/events.json`));
  assert.equal(b.res.headers.get('X-BCS-Cache'), 'fallback');
  assert.equal(b.res.headers.get('X-BCS-Cache-Reason'), 'http-503');
  await w.settle();
});

test('fetch: with no copy at all, a failed data request fails like it would without a worker', async () => {
  const w = await installed((url) => (url.endsWith('events.json') ? new TypeError('Failed to fetch') : okText('x')));
  const { res } = await w.fire('fetch', new Request(`${BASE}data/events.json`));
  assert.equal(res.type, 'error', 'Response.error() makes the page fetch reject → app uses its localStorage copy');
  const w2 = await installed((url) => (url.endsWith('events.json') ? new Response('gone', { status: 404 }) : okText('x')));
  const r2 = await w2.fire('fetch', new Request(`${BASE}data/events.json`));
  assert.equal(r2.res.status, 404, 'a real HTTP error is passed through when nothing is cached');
  await w.settle(); await w2.settle();
});

test('fetch: precached assets are stale-while-revalidate; navigations get index.html whatever the query', async () => {
  let body = 'v1';
  const w = await installed(() => okText(body));
  body = 'v2';
  const asset = await w.fire('fetch', new Request(`${BASE}js/app.js`));
  assert.equal(await asset.res.text(), 'v1', 'served from the cache first');
  await w.settle();
  const refreshed = await w.fire('fetch', new Request(`${BASE}js/app.js`));
  assert.equal(await refreshed.res.text(), 'v2', 'the background refresh updated the cache');
  const first = await w.fire('fetch', navRequest(`${BASE}?demo=1&now=2026-11-06T20:00:00Z`));
  assert.ok(first.handled);
  assert.equal(await first.res.text(), 'v1', 'navigation: install-time index.html served first');
  await w.settle();
  for (const url of [`${BASE}?demo=1&now=2026-11-06T20:00:00Z`, BASE, `${BASE}index.html`]) {
    const nav = await w.fire('fetch', navRequest(url));
    assert.ok(nav.handled, `handles navigation ${url}`);
    assert.equal(nav.res.status, 200);
    assert.equal(await nav.res.text(), 'v2', `index.html refreshed in the background for ${url}`);
  }
  await w.settle();
});

test('fetch: a navigation while offline is answered from the precache', async () => {
  let online = true;
  const w = await installed((url) => (online ? okText('shell') : new TypeError('Failed to fetch')));
  online = false;
  const nav = await w.fire('fetch', navRequest(`${BASE}?demo=1`));
  assert.equal(await nav.res.text(), 'shell');
  await w.settle();
});

test('message GET_VERSION answers on the port with the cache version', async () => {
  const w = await installed();
  const replies = [];
  w.listeners.message({ data: { type: 'GET_VERSION' }, ports: [{ postMessage: (m) => replies.push(m) }] });
  // JSON round-trip: the reply object was created inside the vm realm (different Object.prototype).
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ type: 'VERSION', version: VERSION, cache: w.cacheName }]);
});
