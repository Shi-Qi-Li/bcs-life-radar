import { TZ, dayKey, addDaysKey, startOfDay, formatDate, formatTime, formatTimeRange, formatDateTime, tzAbbr, chicagoParts } from './shared/time.js';
import { TYPES, TYPE_LABEL, MOODS } from './shared/taxonomy.js';
import { DEFAULT_FILTERS, filterItems, pickRecommendations, rangeFor, isExpired, whenPhrase, placeWindows, RADIUS_KM, evaluate, nowItems, groupSeries, plural } from './shared/logic.js';
import { buildICS, googleCalendarUrl, mapLinks } from './shared/export.js';

// ---------- boot params ----------
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const parsedNow = Date.parse(params.get('now') || '');
const SIM_NOW = Number.isFinite(parsedNow) ? parsedNow : null;
const BAD_NOW = params.get('now') && SIM_NOW === null ? params.get('now') : null; // an unparseable ?now= is ignored, with a banner
const DATA_URL = params.get('data') || (DEMO ? 'data/demo-events.json' : 'data/events.json');
const USE_CACHE = !DEMO && !params.has('data');
const STALE_HOURS = 36;

let data = null;
let items = [];
let byId = new Map();
let f = { ...DEFAULT_FILTERS, types: [] };
let showEveryDate = false; // "Show every date" in the Show select (otherwise recurring series are grouped in Browse all)
let origin = null;
let showAll = false;
let loadProblem = null;
let lateNote = false; // When was defaulted to Tomorrow because it is late in the evening
let currentView = null;
let booted = false;
let pickCache = { sig: null, picks: [] }; // the pick set stays stable until filters / Not interested change it
let opener = null; // element that opened the details dialog (focus goes back to it on close)
let closingFromHistory = false;

const now = () => (SIM_NOW ?? (data?.isDemo && data.demoNow ? Date.parse(data.demoNow) : Date.now()));

// ---------- local storage (per device) ----------
const STORE_KEY = 'bcs-life-radar:v1';
const PREF_KEY = 'bcs-life-radar:prefs';
const CACHE_KEY = 'bcs-life-radar:lastData';
const memory = {};
function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return memory.store || {}; }
}
let state = Object.assign({ saved: {}, hidden: {}, been: {}, feedback: {} }, readStore());
function persist() {
  memory.store = state;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode: keep in memory */ }
  updateSavedCount();
}
function readPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return memory.prefs || {}; } }
function savePref(k, v) { const p = { ...readPrefs(), [k]: v }; memory.prefs = p; try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* ignore */ } }
let listMode = readPrefs().browseView || (matchMedia('(max-width: 699px)').matches ? 'list' : 'cards');

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const extLink = (u, text, cls = '') => { const s = safeUrl(u); return s ? `<a class="${cls}" href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : esc(text); };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints > 1 || /iPhone|iPod/.test(navigator.userAgent));
const KIND_LABEL = { 'one-time': 'One-time', recurring: 'Recurring', 'multi-day': 'Multi-day / ongoing', place: 'Regularly open place' };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const groupOf = (it) => it.groupKey || it.id;
const shortDay = (t) => { const p = chicagoParts(t); return `${WD[p.dow]} ${p.d}`; };
const sel = (id) => `[data-id="${CSS.escape(id)}"]`;

function timeRange(s, e) {
  const sameDay = dayKey(s) === dayKey(e - 1);
  if (sameDay) return `${formatTimeRange(s, e)} ${tzAbbr(s)}`;
  return `${formatTime(s)} – ${formatDate(e)} · ${formatTime(e)} ${tzAbbr(e)}`;
}

function durationText(it) {
  if (it.kind === 'place' || it.kind === 'multi-day') return '';
  if (it.allDay || !it.endKnown) return '<span class="unknown">Duration not listed</span>';
  const mins = Math.round((Date.parse(it.end) - Date.parse(it.start)) / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h ? `${h} h` : ''}${h && m ? ' ' : ''}${m ? `${m} min` : ''}`;
}

function whenHtml(it, match) {
  if (it.kind === 'place') {
    const w = match?.window;
    const head = w ? esc(whenPhrase(match, now())) : '';
    return `${head ? `${head}<br>` : ''}<span>${esc(it.hoursText)}</span>`;
  }
  const s = Date.parse(it.start);
  if (it.kind === 'multi-day') {
    const endDay = Date.parse(it.end) - 1;
    return `${esc(formatDate(s))} – ${esc(formatDate(endDay))}${it.timeNote ? `<br><span class="unknown">${esc(it.timeNote)}</span>` : ''}`;
  }
  let t;
  if (it.allDay) t = `${esc(formatDate(s))} · <span class="unknown">${esc(it.timeNote || 'All day')}</span>`;
  else if (it.endKnown) t = `${esc(formatDate(s))} · ${esc(timeRange(s, Date.parse(it.end)))}`; // overnight: "Fri, Nov 6 · 6 PM – Sat, Nov 7 · 7 AM CST"
  else t = `${esc(formatDate(s))} · ${esc(formatTime(s))} ${esc(tzAbbr(s))} · <span class="unknown">end time not listed</span>`;
  const d = durationText(it);
  const note = it.timeNote && !it.allDay ? `<br><span class="unknown">${esc(it.timeNote)}</span>` : '';
  return `${t}${d && it.endKnown ? ` <span class="hint">(${d})</span>` : ''}${note}`;
}

function whereHtml(it, match) {
  const l = it.location;
  if (!l || (!l.name && !l.address)) return '<span class="unknown">Location not listed</span>';
  const dist = match?.distance != null ? ` <span class="hint">· ≈${match.distance.toFixed(1)} km straight-line</span>` : '';
  const note = it.locationNote ? `<br><span class="unknown">${esc(it.locationNote)}</span>` : '';
  return `${esc(l.name || '')}${l.name && l.address ? '<br>' : ''}<span class="hint">${esc(l.address || '')}</span>${dist}${note}`;
}

const costHtml = (c) => (c.status === 'unknown' ? `<span class="unknown">${esc(c.label)}</span>` : esc(c.label));
function regHtml(r) {
  const label = r.status === 'unknown' ? `<span class="unknown">${esc(r.label)}</span>` : esc(r.label);
  const link = r.url && safeUrl(r.url) ? ` · ${extLink(r.url, 'Link')}` : '';
  return label + link;
}

function updatedHtml(it) {
  const parts = [`Source: ${extLink(it.sourceUrl, it.sourceName)}`];
  for (const a of it.alsoListedBy || []) parts.push(`also on ${extLink(a.url, a.sourceName)}`);
  if (it.kind === 'place') {
    parts.push(`Hours checked against source: ${esc(formatDateTime(Date.parse(it.lastVerified)))}`);
  } else parts.push(`Updated ${esc(formatDateTime(Date.parse(it.lastVerified)))}`);
  return parts.join(' · ');
}

function windowFor(it, match) {
  if (it.kind !== 'place') return null;
  if (match?.window) return match.window;
  const r = rangeFor('week', now());
  return placeWindows(it, r.from, r.to).find((w) => w.end > now()) || null;
}

const saveLabel = (saved) => (saved ? '★ Saved' : '☆ Save');
const beenLabel = (been) => (been ? '✓ Been there' : 'Been there');

// ---------- card ----------
function repeatsHtml(m) {
  const od = m.otherDates || [];
  if (!od.length) return '';
  const shown = od.slice(0, 3);
  const more = od.length - shown.length;
  return `<div class="repeats"><span class="hint">Also on</span>${shown.map((o) => `<button type="button" class="chip small" data-open="${esc(o.item.id)}" aria-label="Open details for ${esc(formatDate(o.window.start))}">${esc(shortDay(o.window.start))}</button>`).join('')}${more > 0 ? `<button type="button" class="chip small" data-open="${esc(m.item.id)}">+${more} more</button>` : ''}</div>`;
}

function cardHtml(match, { reason = null, compact = false } = {}) {
  const it = match.item;
  const saved = !!state.saved[it.id];
  const been = !!state.been[groupOf(it)];
  const typeBadges = it.types.slice(0, 2).map((t) => `<span class="badge">${esc(TYPE_LABEL[t] || t)}</span>`).join('');
  const warn = it.verification && it.verification.status !== 'verified' ? `<span class="badge warn">Hours may have changed</span>` : '';
  const demo = data?.isDemo ? '<span class="badge demo">Demo data</span>' : '';
  const hasCal = it.kind !== 'place' || !!windowFor(it, match);
  const hasMap = !!mapLinks(it.location);
  return `
  <article class="card${been ? ' is-been' : ''}" data-id="${esc(it.id)}">
    <div class="badges"><span class="badge kind-${esc(it.kind)}">${esc(KIND_LABEL[it.kind])}</span>${typeBadges}${warn}${demo}${been ? '<span class="badge been">Been there</span>' : ''}</div>
    <h3><button type="button" data-act="details">${esc(it.title)}</button></h3>
    ${reason ? `<p class="reason"><b>Why this pick:</b> ${esc(reason)}</p>` : `<p class="reason">${esc(whenPhrase(match, now()))}</p>`}
    ${compact ? '' : `<p class="desc">${esc(it.summary || '') || '<span class="unknown">No description provided by the source.</span>'}</p>`}
    <dl class="facts">
      <div><dt>When</dt><dd>${whenHtml(it, match)}</dd></div>
      <div><dt>Where</dt><dd>${whereHtml(it, match)}</dd></div>
      <div><dt>Cost</dt><dd>${costHtml(it.cost)}</dd></div>
      <div><dt>Registration</dt><dd>${regHtml(it.registration)}</dd></div>
    </dl>
    ${repeatsHtml(match)}
    <p class="meta">${updatedHtml(it)}</p>
    <div class="actions">
      <button type="button" class="btn" data-act="details">Details</button>
      ${hasMap ? '<button type="button" class="btn" data-act="directions">Directions</button>' : ''}
      ${hasCal ? '<button type="button" class="btn" data-act="ics">Add to calendar</button>' : ''}
      <button type="button" class="btn" data-act="save" aria-pressed="${saved}">${saveLabel(saved)}</button>
      <button type="button" class="btn" data-act="hide">Not interested</button>
      <button type="button" class="btn" data-act="been" aria-pressed="${been}">${beenLabel(been)}</button>
    </div>
  </article>`;
}

/** Compact one-line row for Browse all (phones by default). Tapping the row opens Details. */
function rowHtml(m) {
  const it = m.item;
  const saved = !!state.saved[it.id];
  const been = !!state.been[groupOf(it)];
  let time;
  if (it.kind === 'place') time = m.window ? formatTimeRange(m.window.start, m.window.end) : 'Hours not listed';
  else if (it.kind === 'multi-day') time = 'Ongoing';
  else if (it.allDay) time = 'All day';
  else time = formatTime(m.window?.start ?? Date.parse(it.start));
  const sub = [it.location?.name, it.cost.status === 'unknown' ? 'Cost not listed' : it.cost.label].filter(Boolean).join(' · ');
  const rep = m.otherDates?.length ? ` · +${plural(m.otherDates.length, 'more date')}` : '';
  return `<article class="row${been ? ' is-been' : ''}" data-id="${esc(it.id)}">
    <button type="button" class="row-main" data-act="details"><span class="row-time"><span class="dot kind-${esc(it.kind)}" aria-hidden="true"></span>${esc(time)}</span><span class="row-title">${esc(it.title)}</span><span class="row-sub hint">${esc(sub)}${esc(rep)}</span></button>
    <button type="button" class="btn icon" data-act="save" aria-pressed="${saved}" aria-label="${saved ? 'Saved' : 'Save'}">${saved ? '★' : '☆'}</button>
  </article>`;
}

// ---------- prefs from the user's own actions ----------
function prefs() {
  const likedTypes = new Map(), dislikedTypes = new Map();
  const add = (m, types, w) => { for (const t of types || []) m.set(t, (m.get(t) || 0) + w); };
  for (const s of Object.values(state.saved)) add(likedTypes, s.types, 1);
  for (const [id, fb] of Object.entries(state.feedback)) {
    const snap = state.saved[id] || byId.get(id);
    if (!snap) continue;
    if (fb.value === 'liked') add(likedTypes, snap.types, 1);
    if (fb.value === 'meh') add(dislikedTypes, snap.types, 1);
  }
  for (const h of Object.values(state.hidden)) add(dislikedTypes, h.types, 0.5);
  return { likedTypes, dislikedTypes, been: new Set(Object.keys(state.been)), saved: new Set(Object.keys(state.saved)) };
}
const hiddenSet = () => new Set(Object.keys(state.hidden));

// ---------- filters ⇄ URL hash (deep links) ----------
const FILTER_KEYS = ['when', 'date', 'timeOfDay', 'timeAvail', 'budget', 'transport', 'kind', 'mood', 'q'];
const WHENS = ['week', 'today', 'tomorrow', 'weekend', 'date'];
const ITEM_RE = /^#\/item\/(.+)$/;
const itemFromHash = (h = location.hash) => { const m = ITEM_RE.exec(h); return m ? decodeURIComponent(m[1]) : null; };
const itemHash = (id) => `#/item/${encodeURIComponent(id)}`;

function filtersToQuery() {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (f[k] !== DEFAULT_FILTERS[k] && f[k] !== '') p.set(k, f[k]);
  if (f.types.length) p.set('types', f.types.join(','));
  if (!f.includeUnknown) p.set('unknown', '0');
  if (showEveryDate) p.set('every', '1');
  return p.toString();
}
function optionValues(name) { return [...($('#filters').elements[name]?.options || [])].map((o) => o.value); }
function filtersFromQuery(qs) {
  const p = new URLSearchParams(qs);
  const nf = { ...DEFAULT_FILTERS, types: [] };
  for (const k of FILTER_KEYS) if (p.has(k)) nf[k] = p.get(k);
  if (p.has('types')) nf.types = p.get('types').split(',').filter((t) => TYPE_LABEL[t]);
  if (p.has('unknown')) nf.includeUnknown = p.get('unknown') !== '0';
  if (!WHENS.includes(nf.when)) nf.when = 'week';
  if (nf.when === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(nf.date)) { nf.when = 'week'; nf.date = ''; }
  if (nf.when !== 'date') nf.date = '';
  if (nf.mood && !MOODS.some((m) => m.id === nf.mood)) nf.mood = '';
  for (const k of ['timeOfDay', 'timeAvail', 'budget', 'transport', 'kind']) if (!optionValues(k).includes(nf[k]) || nf[k] === 'every') nf[k] = DEFAULT_FILTERS[k];
  nf.q = String(nf.q).slice(0, 80);
  return { f: nf, every: p.get('every') === '1' };
}
function discoverHash() { const q = filtersToQuery(); return `#/${q ? `?${q}` : ''}`; }
const hashForView = (v) => (v === 'saved' ? '#/saved' : v === 'sources' ? '#/sources' : discoverHash());
function writeHash() {
  if (currentView !== 'discover' || itemFromHash() || $('#detail').open) return;
  const h = discoverHash();
  if (location.hash !== h && !(h === '#/' && location.hash === '')) history.replaceState(history.state, '', h);
}
function applyHashFilters() {
  const h = location.hash;
  if (!h.includes('?')) return false;
  const parsed = filtersFromQuery(h.slice(h.indexOf('?') + 1));
  f = parsed.f; showEveryDate = parsed.every;
  return true;
}

// ---------- Discover ----------
function readForm() {
  const fd = new FormData($('#filters'));
  f.timeOfDay = fd.get('timeOfDay');
  f.timeAvail = fd.get('timeAvail');
  f.budget = fd.get('budget');
  f.transport = fd.get('transport');
  const kind = fd.get('kind');
  showEveryDate = kind === 'every';
  f.kind = kind === 'every' ? 'all' : kind;
  f.q = (fd.get('q') || '').trim();
  f.includeUnknown = fd.get('includeUnknown') === 'on';
}

function syncFormUI() {
  const form = $('#filters');
  for (const b of form.querySelectorAll('[data-when]')) b.setAttribute('aria-pressed', String(f.when === b.dataset.when));
  $('#f-date').value = f.when === 'date' ? f.date : '';
  const pd = $('#pickDate');
  pd.setAttribute('aria-pressed', String(f.when === 'date'));
  pd.textContent = f.when === 'date' && f.date ? `📅 ${formatDate(startOfDay(f.date) + 3600_000)}` : '📅 Date';
  for (const b of form.querySelectorAll('[data-type]')) b.setAttribute('aria-pressed', String(f.types.includes(b.dataset.type)));
  for (const b of form.querySelectorAll('[data-mood]')) b.setAttribute('aria-pressed', String(f.mood === b.dataset.mood));
  const mood = f.mood ? MOODS.find((m) => m.id === f.mood) : null;
  const mh = $('#moodHint');
  mh.hidden = !mood;
  mh.textContent = mood ? `${mood.label} = ${mood.types.map((t) => TYPE_LABEL[t]).join(' · ')}` : '';
  for (const k of ['timeOfDay', 'timeAvail', 'budget', 'transport']) form.elements[k].value = f[k];
  form.elements.kind.value = showEveryDate ? 'every' : f.kind;
  form.elements.q.value = f.q;
  form.elements.includeUnknown.checked = f.includeUnknown;
  const active = ['timeOfDay', 'timeAvail', 'budget', 'transport', 'kind'].filter((k) => f[k] !== DEFAULT_FILTERS[k]).length
    + (f.types.length ? 1 : 0) + (f.mood ? 1 : 0) + (f.q ? 1 : 0) + (f.includeUnknown ? 0 : 1);
  const ac = $('#activeCount');
  ac.hidden = !active; ac.textContent = active;
  const hint = $('#transportHint');
  const r = RADIUS_KM[f.transport];
  if (r && !origin) hint.textContent = `Tap “Use my location” to keep results within ≈${r} km straight-line. Without it nothing is filtered. Travel times aren't estimated.`;
  else if (r && origin) hint.textContent = `Showing results within ≈${r} km straight-line of you. That's distance as the crow flies — not a route, travel time or accessibility check.`;
  else if (f.transport === 'transit') hint.textContent = 'Bus routes and schedules aren\'t checked here. Directions open in transit mode so your maps app can check routes.';
  else if (f.transport === 'drive') hint.textContent = 'Parking details aren\'t verified here. Directions open in driving mode.';
  else hint.textContent = 'Directions open in your maps app with the mode you pick. Travel times aren\'t estimated here.';
  $('#useLocation').textContent = origin ? 'Location on ✓ (tap to turn off)' : 'Use my location';
  const ln = $('#lateNote');
  ln.hidden = !lateNote;
  if (lateNote) ln.innerHTML = `<span>It's after 9 PM, so this starts with <strong>Tomorrow</strong>.</span> <button type="button" class="btn link" data-when="today">Show tonight instead</button> <button type="button" class="dismiss" id="dismissLate" aria-label="Dismiss this note">×</button>`;
}

function rangeLabel() {
  const r = rangeFor(f.when, now(), f.date);
  const last = r.to - 1;
  const a = formatDate(Math.max(r.from, startOfDay(r.fromKey)));
  const b = formatDate(last);
  const name = { today: 'Today', tomorrow: 'Tomorrow', weekend: 'This weekend', week: 'Next 7 days', date: 'Selected date' }[f.when];
  return `${name} (${a === b ? a : `${a} – ${b}`})`;
}

function cachedPicks(matches, ctx) {
  const sig = JSON.stringify([f, origin, [...ctx.hidden].sort(), Math.floor(ctx.now / 900_000), data?.generatedAt, items.length]);
  const ids = new Set(matches.map((m) => m.item.id));
  if (pickCache.sig === sig && pickCache.picks.length && pickCache.picks.every((p) => ids.has(p.item.id))) return pickCache.picks;
  const picks = matches.length ? pickRecommendations(matches, { now: ctx.now, prefs: prefs() }, f, 5) : [];
  pickCache = { sig, picks };
  return picks;
}

const WHEN_LABEL = { today: 'Today', tomorrow: 'Tomorrow', weekend: 'This weekend', week: 'Next 7 days' };
function suggestHtml(matches, ctx) {
  if (matches.length >= 3) return '';
  const alts = ['tomorrow', 'weekend', 'week'].filter((w) => w !== f.when)
    .map((w) => [w, filterItems(items, { ...f, when: w, date: '' }, ctx).length])
    .filter(([, n]) => n > matches.length);
  if (!alts.length) return '';
  const lead = f.when === 'today' ? (chicagoParts(ctx.now).hh >= 17 ? 'Not much left tonight' : 'Not much left today') : matches.length ? 'Only a little in this range' : 'Nothing in this range';
  return `<p class="suggest">${lead} — see ${alts.map(([w, n]) => `<button type="button" class="btn link" data-when="${w}">${esc(WHEN_LABEL[w])} (${n})</button>`).join(' · ')}</p>`;
}

function renderNowStrip(ctx) {
  const list = nowItems(filterItems(items, { ...f, when: 'today', date: '' }, ctx), ctx.now, { max: 6 });
  $('#nowStrip').hidden = !list.length;
  $('#nowChips').innerHTML = list.map(({ match: m, label }) => `<button type="button" class="chip now-chip" data-open="${esc(m.item.id)}"><b>${esc(label)}</b><span>${esc(m.item.title)}</span></button>`).join('');
}

function renderDayStrip(ctx) {
  const today = dayKey(ctx.now);
  const html = [];
  for (let i = 0; i < 7; i++) {
    const key = addDaysKey(today, i);
    const n = filterItems(items, { ...f, when: 'date', date: key }, ctx).length;
    const active = f.when === 'date' && f.date === key;
    const d = startOfDay(key) + 3600_000;
    const p = chicagoParts(d);
    html.push(`<button type="button" class="chip day-pill" data-day="${key}" aria-pressed="${active}" aria-label="${esc(formatDate(d))}: ${esc(plural(n, 'result'))}"><span class="dow">${i === 0 ? 'Today' : i === 1 ? 'Tmrw' : WD[p.dow]}</span> ${p.d}<span class="count">${n}</span></button>`);
  }
  $('#dayStrip').innerHTML = html.join('');
}

function renderDiscover() {
  const ctx = { now: now(), origin, hidden: hiddenSet() };
  const matches = filterItems(items, f, ctx);
  const picks = cachedPicks(matches, ctx);
  const shown = showEveryDate ? matches : groupSeries(matches);
  const groupedAway = matches.length - shown.length;
  const unknownCount = matches.filter((m) => m.unknowns.length).length;
  $('#summary').innerHTML = `${esc(plural(shown.length, 'result'))}${groupedAway ? ` <span class="hint">(${esc(plural(groupedAway, 'repeat date'))} grouped)</span>` : ''} · ${esc(rangeLabel())}${unknownCount ? ` · ${unknownCount} with some details not listed` : ''} · times in Central Time${shown.length > picks.length && !showAll ? ` · <button type="button" class="btn link inline" data-browse-all>Browse all ${shown.length}</button>` : ''}`;
  $('#suggest').innerHTML = suggestHtml(matches, ctx);
  renderNowStrip(ctx);
  renderDayStrip(ctx);

  const picksEl = $('#picks');
  if (!matches.length) {
    picksEl.innerHTML = `<div class="empty"><p><strong>Nothing matches these filters.</strong></p><p>Try a wider date range, a higher budget, or turn on “Include items with missing … information”. You can also check the original calendars on the <a href="#/sources">Sources</a> page.</p></div>`;
  } else {
    picksEl.innerHTML = picks.map((p) => cardHtml(p, { reason: p.reason })).join('');
  }
  $('.results').setAttribute('aria-busy', 'false');
  const tg = $('#toggleAll');
  tg.hidden = shown.length <= picks.length && !showAll;
  tg.textContent = showAll ? 'Hide full list' : `Browse all ${plural(shown.length, 'result')}`;
  tg.setAttribute('aria-expanded', String(showAll));
  $('#viewToggle').hidden = !showAll;
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === listMode));
  const all = $('#allResults');
  all.hidden = !showAll;
  all.innerHTML = showAll ? groupedHtml(shown) : '';
  writeHash();
}

function groupedHtml(matches) {
  const ongoing = matches.filter((m) => m.item.kind === 'multi-day');
  const placesM = matches.filter((m) => m.item.kind === 'place');
  const events = matches.filter((m) => m.item.kind !== 'multi-day' && m.item.kind !== 'place');
  const byDay = new Map();
  const t = now();
  for (const m of events) {
    const k = dayKey(Math.max(m.window.start, Math.min(t, m.window.end - 1)));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }
  const block = (list) => (listMode === 'list' ? `<div class="rows">${list.map(rowHtml).join('')}</div>` : `<div class="cards">${list.map((m) => cardHtml(m)).join('')}</div>`);
  const todayKey = dayKey(t), tomorrowKey = addDaysKey(todayKey, 1);
  let html = '';
  for (const [k, list] of byDay) {
    const d = formatDate(startOfDay(k) + 3600_000);
    const label = k === todayKey ? `Today · ${d}` : k === tomorrowKey ? `Tomorrow · ${d}` : d;
    html += `<h2 class="day-heading">${esc(label)} <span class="hint">(${list.length})</span></h2>${block(list)}`;
  }
  if (ongoing.length) html += `<h2 class="day-heading">Ongoing / multi-day <span class="hint">(${ongoing.length})</span></h2>${block(ongoing)}`;
  if (placesM.length) html += `<h2 class="day-heading">Places that are regularly open <span class="hint">(${placesM.length})</span></h2>${block(placesM)}`;
  return html;
}

// ---------- Detail ----------
function findMatch(it) {
  return evaluate(it, { ...DEFAULT_FILTERS, when: 'week', includeUnknown: true }, { now: now(), origin }) || { item: it, window: windowFor(it), distance: null, unknowns: [] };
}

function renderDetailBody(id) {
  const it = byId.get(id) || state.saved[id];
  if (!it) return null;
  const match = findMatch(it);
  const mode = f.transport;
  const maps = mapLinks(it.location, mode);
  const win = windowFor(it, match);
  const gcal = it.kind !== 'place' || win ? googleCalendarUrl(it, { window: win }) : null;
  const t = now();
  const others = items.filter((x) => x.seriesId === it.seriesId && x.id !== it.id && !isExpired(x, t)).slice(0, 12);
  const ended = it.kind !== 'place' && isExpired(it, t);
  const fb = state.feedback[it.id]?.value;
  const saved = !!state.saved[it.id];
  const been = !!state.been[groupOf(it)];
  const modeName = { walk: 'walking', bike: 'biking', transit: 'transit', drive: 'driving' }[mode];
  const placeHours = it.kind === 'place' ? `
      <div class="detail-section"><h3>Opening hours (from the official page)</h3>
        <p>${esc(it.hoursText)}</p>
        ${it.closuresText ? `<p class="hint">${esc(it.closuresText)}${it.closures?.length ? ' (year not stated on source; read as 2026–27)' : ''}</p>` : ''}
        ${it.verification?.note ? `<p class="banner">${esc(it.verification.note)}</p>` : ''}
        ${win ? `<p>Next opening shown here: <strong>${esc(formatDate(win.start))}, ${esc(timeRange(win.start, win.end))}</strong></p>` : ''}
      </div>` : '';

  $('#detailBody').innerHTML = `
    <div class="badges"><span class="badge kind-${esc(it.kind)}">${esc(KIND_LABEL[it.kind])}</span>${it.types.map((x) => `<span class="badge">${esc(TYPE_LABEL[x] || x)}</span>`).join('')}${data?.isDemo ? '<span class="badge demo">Demo data</span>' : ''}${been ? '<span class="badge been">Been there</span>' : ''}</div>
    <h2 id="detailTitle">${esc(it.title)}</h2>
    ${ended ? '<p class="banner info">This has ended. Did you go? Leave quick feedback below.</p>' : ''}
    <dl class="facts">
      <div><dt>When</dt><dd>${whenHtml(it, match)}</dd></div>
      <div><dt>Where</dt><dd>${whereHtml(it, match)}</dd></div>
      <div><dt>Cost</dt><dd>${costHtml(it.cost)}</dd></div>
      <div><dt>Registration</dt><dd>${regHtml(it.registration)}</dd></div>
      ${it.contact ? `<div><dt>Contact</dt><dd>${esc(it.contact)}</dd></div>` : ''}
      ${it.websiteUrl ? `<div><dt>Website</dt><dd>${extLink(it.websiteUrl, 'Organizer website')}</dd></div>` : ''}
    </dl>
    ${placeHours}
    <div class="detail-section"><h3>Go</h3>
      <div class="btn-row">
        ${maps ? `<a class="btn primary" href="${esc(isApple && maps.appleSupportsMode ? maps.apple : maps.google)}" target="_blank" rel="noopener" data-act-link="directions">Directions${modeName ? ` (${modeName})` : ''}</a>
        <a class="btn" href="${esc(isApple ? maps.google : maps.apple)}" target="_blank" rel="noopener">${isApple ? 'Google Maps' : 'Apple Maps'}</a>` : '<span class="unknown">No address listed — check the source for the location.</span>'}
        <button type="button" class="btn" data-detail-act="share">Share</button>
      </div>
      ${maps && mode === 'bike' && isApple ? '<p class="hint">Apple Maps links don\'t support a bike mode; Google Maps does.</p>' : ''}
      <p class="hint">Travel time, routes and accessibility are not checked here — your maps app will show them.</p>
    </div>
    ${gcal ? `<div class="detail-section"><h3>Add to calendar</h3>
      <div class="btn-row">
        <button type="button" class="btn primary" data-detail-act="ics">Download .ics (Apple / Outlook / others)</button>
        <a class="btn" href="${esc(gcal)}" target="_blank" rel="noopener">Google Calendar ↗</a>
      </div>
      ${it.kind !== 'place' && !it.endKnown && !it.allDay ? '<p class="hint">The source lists no end time, so the calendar entry has no end time.</p>' : ''}
      ${it.kind === 'place' ? '<p class="hint">Adds the next opening window shown above as a planned visit.</p>' : ''}
    </div>` : ''}
    <div class="detail-section"><h3>About</h3><p class="desc-full">${esc(it.description || '') || '<span class="unknown">No description provided by the source.</span>'}</p></div>
    ${others.length ? `<div class="detail-section"><h3>Other upcoming dates</h3><ul class="dates">${others.map((o) => `<li><button type="button" class="btn link" data-open="${esc(o.id)}">${esc(formatDate(Date.parse(o.start)))}${o.allDay ? '' : `, ${esc(formatTime(Date.parse(o.start)))}`}</button></li>`).join('')}</ul></div>` : ''}
    <div class="detail-section"><h3>Your notes</h3>
      <div class="btn-row">
        <button type="button" class="btn" data-detail-act="save" aria-pressed="${saved}">${saveLabel(saved)}</button>
        <button type="button" class="btn" data-detail-act="hide">Not interested</button>
        <button type="button" class="btn" data-detail-act="been" aria-pressed="${been}">${beenLabel(been)}</button>
      </div>
      ${(ended || been) ? `<p>How was it?</p><div class="feedback">
        <button type="button" class="btn" data-fb="liked" aria-pressed="${fb === 'liked'}">👍 Liked it</button>
        <button type="button" class="btn" data-fb="meh" aria-pressed="${fb === 'meh'}">👎 Not for me</button>
        ${ended ? `<button type="button" class="btn" data-fb="skipped" aria-pressed="${fb === 'skipped'}">Didn't go</button>` : ''}
      </div>` : ''}
    </div>
    <p class="meta">${updatedHtml(it)}<br>All times are shown in Central Time (${TZ}), regardless of your device's time zone.</p>`;
  return it;
}

/** Open the details dialog. Pushes a '#/item/<id>' history entry so Back closes it (and the URL is a deep link). */
function openDetail(id, { opener: el = null, fromHistory = false } = {}) {
  const dlg = $('#detail');
  if (!renderDetailBody(id)) return;
  if (el && !el.closest('dialog')) opener = el;
  dlg.dataset.id = id;
  if (!fromHistory && location.hash !== itemHash(id)) {
    history.pushState({ item: id, base: location.hash || '#/' }, '', itemHash(id));
  }
  if (!dlg.open) dlg.showModal();
  $('.dialog-inner').scrollTop = 0;
  $('#closeDetail').focus();
}

/** Re-render the open dialog in place, keeping its scroll position and the focused control. */
function refreshDialog() {
  const dlg = $('#detail');
  if (!dlg.open || !dlg.dataset.id) return;
  const inner = $('.dialog-inner');
  const st = inner.scrollTop;
  const fo = document.activeElement;
  const fsel = fo && dlg.contains(fo) ? (fo.dataset.detailAct ? `[data-detail-act="${fo.dataset.detailAct}"]` : fo.dataset.fb ? `[data-fb="${fo.dataset.fb}"]` : fo.id ? `#${fo.id}` : null) : null;
  if (!renderDetailBody(dlg.dataset.id)) { dlg.close(); return; }
  inner.scrollTop = st;
  const nf = fsel && dlg.querySelector(fsel);
  if (nf) nf.focus();
}

$('#detail').addEventListener('close', () => {
  const dlg = $('#detail');
  const viaHistory = closingFromHistory;
  closingFromHistory = false;
  if (!viaHistory) {
    if (history.state?.item) history.back(); // drops the '#/item/…' entry we pushed
    else if (itemFromHash()) history.replaceState(null, '', hashForView(currentView || 'discover')); // opened from a deep link
  }
  const target = opener && document.contains(opener) && !opener.closest('dialog') ? opener : document.querySelector(`${sel(dlg.dataset.id || '')} [data-act="details"]`);
  opener = null;
  if (target) target.focus();
});

// ---------- actions ----------
function snapshot(it) {
  const { description, ...rest } = it;
  return { ...rest, description: (description || '').slice(0, 600), savedAt: new Date().toISOString() };
}

/** Update every rendered card/row/dialog for an item in place (no full re-render, no focus loss). */
function syncItemUI(it) {
  const saved = !!state.saved[it.id];
  const g = groupOf(it);
  const been = !!state.been[g];
  for (const card of document.querySelectorAll('[data-id]')) {
    const cit = byId.get(card.dataset.id) || state.saved[card.dataset.id];
    if (!cit) continue;
    if (cit.id === it.id) {
      for (const b of card.querySelectorAll('[data-act="save"]')) {
        b.setAttribute('aria-pressed', String(saved));
        if (b.classList.contains('icon')) { b.textContent = saved ? '★' : '☆'; b.setAttribute('aria-label', saved ? 'Saved' : 'Save'); } else b.textContent = saveLabel(saved);
      }
    }
    if (groupOf(cit) === g) {
      for (const b of card.querySelectorAll('[data-act="been"]')) { b.setAttribute('aria-pressed', String(been)); b.textContent = beenLabel(been); }
      card.classList.toggle('is-been', been);
      const badges = card.querySelector('.badges');
      if (badges) {
        const ex = badges.querySelector('.badge.been');
        if (been && !ex) badges.insertAdjacentHTML('beforeend', '<span class="badge been">Been there</span>');
        if (!been && ex) ex.remove();
      }
    }
  }
  const dlg = $('#detail');
  if (dlg.open && dlg.dataset.id) {
    const dit = byId.get(dlg.dataset.id) || state.saved[dlg.dataset.id];
    if (dit && dit.id === it.id) {
      const b = dlg.querySelector('[data-detail-act="save"]');
      if (b) { b.setAttribute('aria-pressed', String(saved)); b.textContent = saveLabel(saved); }
    }
    if (dit && groupOf(dit) === g) refreshDialog(); // the feedback block depends on "been"
  }
}

function act(action, id, el = null) {
  const it = byId.get(id) || state.saved[id];
  if (!it) return;
  if (action === 'details') return openDetail(id, { opener: el });
  if (action === 'directions') {
    const m = mapLinks(it.location, f.transport);
    if (m) window.open(isApple && m.appleSupportsMode ? m.apple : m.google, '_blank', 'noopener');
    return;
  }
  if (action === 'ics') return downloadICS(it);
  if (action === 'share') return share(it);
  if (action === 'save') {
    if (state.saved[id]) { delete state.saved[id]; toast('Removed from saved'); } else { state.saved[id] = snapshot(it); toast('Saved on this device'); }
    persist(); syncItemUI(it);
    if (currentView === 'saved') withFocusKept(() => renderSaved());
    return;
  }
  if (action === 'hide') {
    const g = groupOf(it);
    const prev = state.hidden[g];
    state.hidden[g] = { title: it.title, types: it.types, at: new Date().toISOString() };
    persist(); rerender();
    if ($('#detail').open) $('#detail').close();
    toast(`Hidden “${it.title}”${it.kind === 'recurring' ? ' (all dates)' : ''}`, () => { if (prev) state.hidden[g] = prev; else delete state.hidden[g]; persist(); rerender(); });
    return;
  }
  if (action === 'been') {
    const g = groupOf(it);
    if (state.been[g]) delete state.been[g]; else { state.been[g] = { title: it.title, types: it.types, at: new Date().toISOString(), id }; toast('Marked as been there — you can rate it in Details or Saved'); }
    persist(); syncItemUI(it);
    if (currentView === 'saved') withFocusKept(() => renderSaved());
  }
}

/** Run a re-render and put focus back on the equivalent control. */
function withFocusKept(fn) {
  const fo = document.activeElement;
  const card = fo?.closest?.('[data-id]');
  const key = card && fo.dataset.act ? [card.dataset.id, fo.dataset.act] : null;
  fn();
  if (key) document.querySelector(`${sel(key[0])} [data-act="${key[1]}"]`)?.focus();
}

function setFeedback(id, value) {
  const it = byId.get(id) || state.saved[id];
  if (!it) return;
  if (state.feedback[id]?.value === value) delete state.feedback[id];
  else state.feedback[id] = { value, at: new Date().toISOString(), title: it.title };
  if (!state.saved[id] && value !== 'skipped') state.saved[id] = snapshot(it); // keep a record for history
  if (value !== 'skipped') state.been[groupOf(it)] ||= { title: it.title, types: it.types, at: new Date().toISOString(), id };
  persist();
  if (currentView === 'saved') renderSaved(); else syncItemUI(it);
  refreshDialog();
  toast('Thanks — feedback saved on this device');
}

function downloadICS(it) {
  const win = windowFor(it, findMatch(it));
  const ics = buildICS(it, { window: win, now: Date.now() });
  if (!ics) { toast('No upcoming opening time to add'); return; }
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${it.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'event'}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Calendar file downloaded — open it to add the event');
}

async function share(it) {
  const url = `${location.origin}${location.pathname}${location.search}${itemHash(it.id)}`;
  const text = `${it.title} — ${whenPhrase(findMatch(it), now())}${it.location?.name ? ` · ${it.location.name}` : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: it.title, text, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { window.prompt('Copy this link', url); }
}

let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" class="undo">Undo</button>' : ''}<button type="button" class="dismiss" aria-label="Dismiss">×</button>`;
  el.hidden = false;
  if (undo) el.querySelector('.undo').onclick = () => { undo(); el.hidden = true; };
  el.querySelector('.dismiss').onclick = () => { el.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 10_000 : 3000);
}

// ---------- Saved ----------
function renderSaved() {
  const t = now();
  const saved = Object.values(state.saved).map((s) => byId.get(s.id) || s);
  const past = saved.filter((s) => s.kind !== 'place' && isExpired(s, t)).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const awaiting = past.filter((s) => !state.feedback[s.id]);
  const upcoming = saved.filter((s) => s.kind === 'place' || !isExpired(s, t)).sort((a, b) => (a.start || '9').localeCompare(b.start || '9'));
  const fbList = Object.entries(state.feedback);
  const been = Object.entries(state.been);
  const hidden = Object.entries(state.hidden);
  const fbLabel = { liked: '👍 Liked it', meh: '👎 Not for me', skipped: "Didn't go" };
  const section = (title, body, hint = '') => `<section class="list-section"><h2>${title}</h2>${hint ? `<p class="hint">${hint}</p>` : ''}${body}</section>`;

  let html = '';
  html += section(`Did you go? ${awaiting.length ? `<span class="count">${awaiting.length}</span>` : ''}`, awaiting.length
    ? `<div class="cards">${awaiting.map((s) => `<article class="card" data-id="${esc(s.id)}"><h3><button type="button" data-act="details">${esc(s.title)}</button></h3>
        <p class="hint">${esc(formatDate(Date.parse(s.start)))} · ${esc(s.location?.name || '')}</p>
        <div class="feedback"><button type="button" class="btn" data-fb="liked">👍 Went – liked it</button><button type="button" class="btn" data-fb="meh">👎 Went – not for me</button><button type="button" class="btn" data-fb="skipped">Didn't go</button></div></article>`).join('')}</div>`
    : '<p class="empty">Nothing waiting for feedback. Saved activities show up here after they end.</p>');
  html += section('Coming up', upcoming.length
    ? `<div class="cards">${upcoming.map((s) => {
      const live = byId.get(s.id);
      return live ? cardHtml(findMatch(live)) : `<article class="card" data-id="${esc(s.id)}"><h3>${esc(s.title)}</h3><p class="banner info">No longer in the current listings — it may have changed or been removed. ${extLink(s.sourceUrl, 'Check the source')}</p><div class="actions"><button type="button" class="btn" data-act="save" aria-pressed="true">★ Saved</button></div></article>`;
    }).join('')}</div>`
    : '<p class="empty">No upcoming saved items. Tap “☆ Save” on any card.</p>');
  html += section('Your feedback', fbList.length
    ? `<ul>${fbList.map(([id, v]) => `<li>${esc(v.title)} — ${fbLabel[v.value]} <button type="button" class="btn link" data-unfb="${esc(id)}">Undo</button></li>`).join('')}</ul>` : '<p class="hint">None yet.</p>',
    'Liked items gently raise similar types in your top picks; “Not for me” lowers them.');
  html += section('Been there', been.length
    ? `<ul>${been.map(([g, v]) => `<li>${esc(v.title)} <span class="hint">(${esc(formatDate(Date.parse(v.at)))})</span> <button type="button" class="btn link" data-unbeen="${esc(g)}">Remove</button></li>`).join('')}</ul>` : '<p class="hint">None yet.</p>');
  html += section('Hidden (not interested)', hidden.length
    ? `<ul>${hidden.map(([g, v]) => `<li>${esc(v.title)} <button type="button" class="btn link" data-unhide="${esc(g)}">Show again</button></li>`).join('')}</ul>` : '<p class="hint">Nothing hidden.</p>');
  html += `<p><button type="button" class="btn" id="clearAll">Clear all data saved on this device</button></p>`;
  $('#savedContent').innerHTML = html;
}

// ---------- Sources ----------
function renderSources() {
  const srcs = data?.sources || [];
  const fmt = (iso) => (iso ? `${formatDateTime(Date.parse(iso))}` : 'never');
  const statusHtml = (s) => (s.status === 'ok' ? '<span class="status ok">Updated OK</span>' : `<span class="status failed">Last refresh failed</span>`);
  const counts = data?.counts || {};
  $('#sourcesContent').innerHTML = `
    <div class="prose">
      <p>${data?.isDemo ? '<strong>You are viewing demonstration data.</strong> ' : ''}Data file generated <strong>${esc(fmt(data?.generatedAt))}</strong>. It covers ${esc(data?.window?.days ?? '?')} days from that date. ${counts.expiredRemoved != null ? `${esc(plural(counts.expiredRemoved, 'ended item'))} and ${esc(plural(counts.duplicatesRemoved ?? 0, 'duplicate'))} were removed during the last refresh; ended items are also hidden live in your browser.` : ''}</p>
    </div>
    ${srcs.map((s) => `<div class="source-card">
      <h2>${esc(s.name)}</h2>
      <table class="kv">
        <tr><th>Status</th><td>${statusHtml(s)}${s.error ? ` — ${esc(s.error)}` : ''}</td></tr>
        <tr><th>Last successful update</th><td>${esc(fmt(s.lastSuccess))}</td></tr>
        <tr><th>Last attempt</th><td>${esc(fmt(s.lastAttempt))}</td></tr>
        <tr><th>Items in this data</th><td>${esc(s.itemCount)}</td></tr>
        <tr><th>How it's read</th><td>${esc(s.method)}</td></tr>
        <tr><th>Original source</th><td>${extLink(s.homepage, hostOf(s.homepage))}</td></tr>
      </table></div>`).join('')}
    <div class="prose">
      <h2>How to read the information</h2>
      <ul>
        <li><strong>Times</strong> are always Central Time (America/Chicago) and labeled CST/CDT, whatever time zone your device is in.</li>
        <li><strong>One-time</strong> = a single date. <strong>Recurring</strong> = the source lists several dates (each date is its own entry; the full list groups them under the next date unless you choose “show every date”). <strong>Multi-day / ongoing</strong> = one listing spanning several days, like an exhibit. <strong>Regularly open place</strong> = a facility with published opening hours.</li>
        <li>When a source doesn't list the cost, duration, registration, hours or location, the card says <em>not listed</em>. Nothing is guessed.</li>
        <li><strong>Budget</strong> filters use the lowest price the source lists (e.g. “$12 adults | $5 kids” counts as $5) — read the full price on the card.</li>
        <li><strong>Getting there</strong>: travel times, routes and accessibility are not estimated. If you share your location (kept in memory only, never stored or sent), walking and biking limit results by straight-line distance (≈${RADIUS_KM.walk} km / ≈${RADIUS_KM.bike} km). Directions open in your maps app in your chosen mode.</li>
        <li><strong>Top picks</strong> mix soon-starting, well-documented options across different types. No interest is favored by default; only your own Save / Not interested / feedback nudges the mix.</li>
      </ul>
      <h2>Known limitations</h2>
      <ul>
        <li>City calendar: council/committee meetings, closures, notices, internal and cancelled entries are left out on purpose. Its “free” flag is shown as “marked free in City calendar” when no Free tag backs it up.</li>
        <li>Destination Bryan: only the first pages of its listing are read each refresh (to stay polite), so some events may be missing. Its event pages publish machine-readable times with a wrong UTC marker on some pages, so the visible date/time text is used instead. For repeating events, other dates reuse the time shown for the listed date and are marked “confirm for this date”.</li>
        <li>Places are a small hand-picked set. Their hours are re-checked against the official page on every refresh; if the wording changes, the card warns “hours may have changed”. Holiday closure dates on the source have no year.</li>
        <li>Events get added, changed or cancelled after a refresh. Always confirm with the original source.</li>
      </ul>
      <h2>Privacy</h2>
      <p>No accounts and no tracking. Saved items, feedback and hidden items stay in this browser's local storage.</p>
    </div>`;
}

// ---------- banners ----------
function renderBanners() {
  const b = [];
  if (data?.isDemo) b.push(['demo', 'Demonstration data — these are made-up sample entries for testing, not real events.']);
  if (SIM_NOW) b.push(['info', `Simulated time: ${formatDateTime(SIM_NOW)} (from the URL). Remove “?now=” to use the real time.`]);
  if (BAD_NOW) b.push(['info', `The “?now=” value in the URL (${esc(BAD_NOW)}) is not a date and was ignored; using the real time.`]);
  if (loadProblem) b.push(['error', loadProblem]);
  for (const s of data?.sources || []) {
    if (s.status === 'failed') b.push(['error', `Couldn't refresh ${esc(s.name)} at ${esc(formatDateTime(Date.parse(s.lastAttempt)))}. Showing its information as last updated ${s.lastSuccess ? esc(formatDateTime(Date.parse(s.lastSuccess))) : '(never)'}. ${extLink(s.homepage, 'Check the original source')}`]);
  }
  if (data && !data.isDemo && Date.now() - Date.parse(data.generatedAt) > STALE_HOURS * 3600_000) {
    b.push(['', `Information was last updated ${esc(formatDateTime(Date.parse(data.generatedAt)))} and may be out of date. Check the original sources: ${(data.sources || []).filter((s) => s.id !== 'places').map((s) => extLink(s.homepage, s.name)).join(' · ')}`]);
  }
  $('#banners').innerHTML = b.map(([cls, html]) => `<div class="banner ${cls}">${html}</div>`).join('');
}

// ---------- routing ----------
function route(h = location.hash) {
  const x = h.replace(/^#\/?/, '');
  if (x.startsWith('saved')) return 'saved';
  if (x.startsWith('sources')) return 'sources';
  if (x.startsWith('item/')) return currentView || 'discover';
  return 'discover';
}
function rerender() {
  const r = route();
  currentView = r;
  for (const v of ['discover', 'saved', 'sources']) $(`#view-${v}`).hidden = v !== r;
  for (const a of document.querySelectorAll('[data-tab]')) { if (a.dataset.tab === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  if (r === 'discover') { syncFormUI(); renderDiscover(); }
  if (r === 'saved') renderSaved();
  if (r === 'sources') renderSources();
  refreshDialog();
}
function updateSavedCount() {
  const t = now();
  const n = Object.keys(state.saved).length;
  const awaiting = Object.values(state.saved).filter((s) => s.kind !== 'place' && isExpired(byId.get(s.id) || s, t) && !state.feedback[s.id]).length;
  const el = $('#savedCount');
  el.hidden = !n;
  el.textContent = n;
  el.classList.toggle('alert', awaiting > 0);
  el.title = awaiting ? `${plural(awaiting, 'past item')} waiting for your feedback` : `${n} saved`;
  el.setAttribute('aria-label', el.title);
}

function onHashChange() {
  const dlg = $('#detail');
  const itemId = itemFromHash();
  if (itemId) { // deep link, or Forward after Back closed the dialog
    if (!dlg.open || dlg.dataset.id !== itemId) openDetail(itemId, { fromHistory: true });
    return;
  }
  if (dlg.open) { closingFromHistory = true; dlg.close(); } // Back with the dialog open closes it
  const r = route();
  const viewChanged = r !== currentView;
  const hadQuery = applyHashFilters();
  if (viewChanged || hadQuery) rerender(); else if (r === 'discover') writeHash();
  if (viewChanged) window.scrollTo(0, 0);
}

function filtersChanged() { writeHash(); rerender(); }

// ---------- wiring ----------
function setupFilters() {
  $('#typeChips').innerHTML = TYPES.map((t) => `<button type="button" class="chip" data-type="${t.id}" aria-pressed="false">${esc(t.label)}</button>`).join('');
  $('#moodChips').innerHTML = MOODS.map((m) => `<button type="button" class="chip" data-mood="${m.id}" aria-pressed="false" title="${esc(m.types.map((t) => TYPE_LABEL[t]).join(', '))}">${esc(m.label)}</button>`).join('');
  const form = $('#filters');
  form.addEventListener('click', (e) => {
    if (e.target.closest('#dismissLate')) { lateNote = false; try { sessionStorage.setItem('bcs-life-radar:lateNote', '1'); } catch { /* ignore */ } return syncFormUI(); }
    const w = e.target.closest('[data-when]');
    if (w) { f.when = w.dataset.when; f.date = ''; lateNote = false; return filtersChanged(); }
    const dp = e.target.closest('[data-day]');
    if (dp) { f.when = 'date'; f.date = dp.dataset.day; lateNote = false; return filtersChanged(); }
    if (e.target.closest('#pickDate')) {
      const d = $('#f-date');
      try { if (typeof d.showPicker === 'function') d.showPicker(); else d.focus(); } catch { d.focus(); }
      return;
    }
    const ty = e.target.closest('[data-type]');
    if (ty) { const id = ty.dataset.type; f.types = f.types.includes(id) ? f.types.filter((x) => x !== id) : [...f.types, id]; return filtersChanged(); }
    const md = e.target.closest('[data-mood]');
    if (md) { f.mood = f.mood === md.dataset.mood ? '' : md.dataset.mood; return filtersChanged(); }
  });
  form.addEventListener('input', (e) => {
    if (e.target.id === 'f-date') { if (e.target.value) { f.when = 'date'; f.date = e.target.value; } else { f.when = 'week'; f.date = ''; } lateNote = false; }
    readForm(); filtersChanged();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#resetFilters').addEventListener('click', () => { f = { ...DEFAULT_FILTERS, types: [] }; showEveryDate = false; form.reset(); filtersChanged(); });
  $('#useLocation').addEventListener('click', () => {
    if (origin) { origin = null; return rerender(); }
    if (!navigator.geolocation) return toast('Location is not available in this browser');
    navigator.geolocation.getCurrentPosition(
      (p) => { origin = { lat: p.coords.latitude, lng: p.coords.longitude }; toast('Using your location for straight-line distance only'); rerender(); },
      () => toast('Location permission was not granted — nothing is filtered by distance'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });
  if (matchMedia('(min-width: 1000px)').matches) $('#moreFilters').open = true;
}
function updateDateBounds() {
  const today = dayKey(now());
  const d = $('#f-date');
  d.min = today;
  d.max = data?.window ? dayKey(Date.parse(data.window.to) - 1) : addDaysKey(today, 30);
}

document.addEventListener('click', (e) => {
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) { const card = actBtn.closest('[data-id]'); if (card) { e.preventDefault(); return act(actBtn.dataset.act, card.dataset.id, actBtn); } }
  const fbBtn = e.target.closest('[data-fb]');
  if (fbBtn) { const id = fbBtn.closest('[data-id]')?.dataset.id || $('#detail').dataset.id; return setFeedback(id, fbBtn.dataset.fb); }
  const dAct = e.target.closest('[data-detail-act]');
  if (dAct) return act(dAct.dataset.detailAct, $('#detail').dataset.id, dAct);
  const open = e.target.closest('[data-open]');
  if (open) return openDetail(open.dataset.open, { opener: open });
  const w = e.target.closest('[data-when]');
  if (w && !w.closest('#filters')) { f.when = w.dataset.when; f.date = ''; lateNote = false; return filtersChanged(); }
  const view = e.target.closest('[data-view]');
  if (view) { listMode = view.dataset.view; savePref('browseView', listMode); return renderDiscover(); }
  if (e.target.closest('[data-browse-all]')) { showAll = true; renderDiscover(); $('#allResults').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (e.target.closest('[data-unfb]')) { delete state.feedback[e.target.closest('[data-unfb]').dataset.unfb]; persist(); return rerender(); }
  if (e.target.closest('[data-unbeen]')) { delete state.been[e.target.closest('[data-unbeen]').dataset.unbeen]; persist(); return rerender(); }
  if (e.target.closest('[data-unhide]')) { delete state.hidden[e.target.closest('[data-unhide]').dataset.unhide]; persist(); return rerender(); }
  if (e.target.id === 'clearAll') {
    if (confirm('Clear saved items, feedback and hidden items on this device?')) { state = { saved: {}, hidden: {}, been: {}, feedback: {} }; persist(); rerender(); }
    return;
  }
  if (e.target.id === 'toggleAll') { showAll = !showAll; renderDiscover(); if (showAll) $('#allResults').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});
$('#closeDetail').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (e) => { if (e.target === $('#detail')) $('#detail').close(); });
window.addEventListener('hashchange', onHashChange);

// Sticky offsets follow the real header height (it wraps on phones).
{
  const header = $('.site-header');
  const setHeaderH = () => document.documentElement.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`);
  setHeaderH();
  if ('ResizeObserver' in window) new ResizeObserver(setHeaderH).observe(header); else window.addEventListener('resize', setHeaderH);
}

// ---------- load ----------
function applyData(d) {
  data = d;
  items = (data.items || []).map((i) => ({ ...i, groupKey: i.groupKey || i.id }));
  byId = new Map(items.map((i) => [i.id, i]));
}
function boot() {
  if (!booted) {
    setupFilters();
    const fromHash = applyHashFilters();
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('bcs-life-radar:lateNote') === '1'; } catch { /* ignore */ }
    if (!fromHash && !itemFromHash() && route() === 'discover' && f.when === 'week' && chicagoParts(now()).hh >= 21 && !dismissed) { f.when = 'tomorrow'; lateNote = true; }
  }
  updateDateBounds();
  renderBanners();
  updateSavedCount();
  rerender();
  if (!booted) {
    const deep = itemFromHash();
    if (deep) openDetail(deep, { fromHistory: true });
  }
  booted = true;
}
async function load() {
  let cached = null;
  if (USE_CACHE) { try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { /* none */ } }
  if (cached?.items) { applyData(cached); boot(); } // paint right away from the copy saved on this device
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fresh = await res.json();
    // The service worker serves its last good copy with this header when the network is unreachable.
    const swFallback = res.headers.get('X-BCS-Cache') === 'fallback';
    if (USE_CACHE && !swFallback) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(fresh)); } catch { /* storage full or blocked */ } }
    if (!booted || fresh.generatedAt !== data?.generatedAt) { applyData(fresh); boot(); }
    if (swFallback) {
      loadProblem = `Couldn't reach the server (offline?). Showing the last copy saved on this device, from ${esc(formatDateTime(Date.parse(fresh.generatedAt)))}.`;
      renderBanners();
    }
  } catch (e) {
    if (cached?.items) {
      loadProblem = `Couldn't load the latest information (${esc(e.message)}). Showing a copy saved on this device from ${esc(formatDateTime(Date.parse(cached.generatedAt)))}.`;
      renderBanners();
    } else {
      applyData({ items: [], sources: [], generatedAt: new Date().toISOString(), window: null });
      loadProblem = `Couldn't load activity data (${esc(e.message)}). Please check the original calendars: ${extLink('https://www.cstx.gov/calendar/', 'City of College Station')} · ${extLink('https://www.destinationbryan.com/events/', 'Destination Bryan')}`;
      boot();
    }
  }
  document.body.dataset.ready = '1';
}
load();
