// Registers the service worker (sw.js, next to index.html) and reports its state.
// Nothing here is required for the site to work: without service-worker support the module just records that.
//
// window.__bcsSwStatus (read by tests and available to app.js):
//   { supported, state: 'unsupported'|'insecure'|'registering'|'installing'|'active'|'error',
//     controlled, version, liveVersion, updateAvailable, error, scope, lastCheck }
// Events on window: 'bcs:sw-status' whenever the status changes; 'bcs:sw-update' when a new version
// has installed (it takes over immediately — see sw.js — so the next visit uses it).

const UPDATE_CHECK_MS = 15 * 60 * 1000;
const SW_URL = new URL('../sw.js', import.meta.url);
const VERSION_URL = new URL('../sw-version.json', import.meta.url);

const status = {
  supported: 'serviceWorker' in navigator,
  state: 'registering',
  controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  version: null,
  liveVersion: null,
  updateAvailable: false,
  error: null,
  scope: null,
  lastCheck: null,
  // Install state: standalone = opened from the home screen; installPrompt = the browser's deferred
  // BeforeInstallPromptEvent (call .prompt() from a click handler to offer "Install" in the app).
  standalone: !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true,
  canInstall: false,
  installPrompt: null,
  installed: false,
};
window.__bcsSwStatus = status;

// The browser keeps its own install UI (no preventDefault); the event is only kept for an in-app button.
window.addEventListener('beforeinstallprompt', (e) => { status.installPrompt = e; status.canInstall = true; announce(); });
window.addEventListener('appinstalled', () => { status.installed = true; status.canInstall = false; status.installPrompt = null; announce(); });

function announce(name = 'bcs:sw-status') {
  try { window.dispatchEvent(new CustomEvent(name, { detail: { ...status } })); } catch { /* ignore */ }
}
function set(patch, eventName) {
  Object.assign(status, patch);
  announce();
  if (eventName) announce(eventName);
}

async function askVersion() {
  const ctrl = navigator.serviceWorker.controller;
  if (!ctrl) return null;
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const done = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (e) => { clearTimeout(done); resolve(e.data && e.data.version ? e.data.version : null); };
    try { ctrl.postMessage({ type: 'GET_VERSION' }, [ch.port2]); } catch { clearTimeout(done); resolve(null); }
  });
}

async function refreshVersion() {
  const version = await askVersion();
  set({ version, controlled: !!navigator.serviceWorker.controller });
}

// sw-version.json is served straight from the network (never cached by sw.js). When the deployed
// version differs from the controlling worker's, ask the browser to look for the new sw.js now.
async function checkLiveVersion(reg) {
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    set({ liveVersion: version || null, lastCheck: new Date().toISOString() });
    if (version && status.version && version !== status.version) await reg.update();
  } catch { /* offline or blocked: nothing to do */ }
}

function watch(reg) {
  set({ scope: reg.scope });
  const track = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        set({ updateAvailable: true }, 'bcs:sw-update');
      }
      if (worker.state === 'activated') set({ state: 'active' });
      if (worker.state === 'redundant' && status.state === 'installing') set({ state: 'error', error: 'Service worker install failed' });
    });
  };
  if (reg.installing) { set({ state: 'installing' }); track(reg.installing); }
  if (reg.waiting) track(reg.waiting);
  if (reg.active) set({ state: 'active' });
  reg.addEventListener('updatefound', () => track(reg.installing));

  navigator.serviceWorker.addEventListener('controllerchange', () => { refreshVersion(); });
  navigator.serviceWorker.ready.then(() => { set({ state: 'active' }); refreshVersion().then(() => checkLiveVersion(reg)); });

  // Installed (standalone) apps can stay open for days: re-check when the tab becomes visible again.
  let last = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < UPDATE_CHECK_MS) return;
    last = Date.now();
    reg.update().catch(() => {});
    checkLiveVersion(reg);
  });
}

async function register() {
  try {
    const reg = await navigator.serviceWorker.register(SW_URL.href);
    watch(reg);
  } catch (e) {
    set({ state: 'error', error: String(e && e.message || e) });
  }
}

if (!status.supported) {
  set({ state: 'unsupported' });
} else if (!window.isSecureContext) {
  set({ state: 'insecure', error: 'Service workers need HTTPS (or localhost)' });
} else if (document.readyState === 'complete') {
  register();
} else {
  // Let the first paint and the data request go first; the worker is only needed for later visits.
  window.addEventListener('load', register, { once: true });
}
