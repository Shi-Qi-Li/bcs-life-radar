import { TZ, dayKey, addDaysKey, startOfDay, formatDate, formatDateLong, formatTime, formatTimeRange, formatDateTime, tzAbbr } from './shared/time.js';
import { TYPES, TYPE_LABEL, MOODS } from './shared/taxonomy.js';
import { DEFAULT_FILTERS, filterItems, pickRecommendations, rangeFor, effectiveEnd, isExpired, whenPhrase, placeWindows, RADIUS_KM, evaluate } from './shared/logic.js';
import { buildICS, googleCalendarUrl, mapLinks, addressOf } from './shared/export.js';

// ---------- boot params ----------
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const SIM_NOW = params.get('now') ? Date.parse(params.get('now')) : null;
const DATA_URL = params.get('data') || (DEMO ? 'data/demo-events.json' : 'data/events.json');
const STALE_HOURS = 36;

let data = null;
let items = [];
let byId = new Map();
let f = { ...DEFAULT_FILTERS, types: [] };
let origin = null;
let showAll = false;
let loadProblem = null;

const now = () => (SIM_NOW ?? (data?.isDemo && data.demoNow ? Date.parse(data.demoNow) : Date.now()));

// ---------- local storage (per device) ----------
const STORE_KEY = 'bcs-life-radar:v1';
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

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const extLink = (u, text, cls = '') => { const s = safeUrl(u); return s ? `<a class="${cls}" href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : esc(text); };
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints > 1 || /iPhone|iPod/.test(navigator.userAgent));
const KIND_LABEL = { 'one-time': 'One-time', recurring: 'Recurring', 'multi-day': 'Multi-day / ongoing', place: 'Regularly open place' };
const groupOf = (it) => it.groupKey || it.id;

function timeRange(s, e) {
  const sameDay = dayKey(s) === dayKey(e - 1);
  if (sameDay) return `${formatTimeRange(s, e)} ${tzAbbr(s)}`;
  return `${formatTime(s)} ${formatDate(s)} – ${formatTime(e)} ${formatDate(e)} ${tzAbbr(e)}`;
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
    return `${esc(formatDate(s))} – ${esc(formatDateLong(endDay))}${it.timeNote ? `<br><span class="unknown">${esc(it.timeNote)}</span>` : ''}`;
  }
  let t;
  if (it.allDay) t = `${esc(formatDate(s))} · <span class="unknown">${esc(it.timeNote || 'All day')}</span>`;
  else if (it.endKnown) t = `${esc(formatDate(s))} · ${esc(timeRange(s, Date.parse(it.end)))}`;
  else t = `${esc(formatDate(s))} · ${esc(formatTime(s))} ${esc(tzAbbr(s))} · <span class="unknown">end time not listed</span>`;
  const d = durationText(it);
  const note = it.timeNote && !it.allDay ? `<br><span class="unknown">${esc(it.timeNote)}</span>` : '';
  return `${t}${d && it.endKnown ? ` <span class="hint">(${d})</span>` : ''}${note}`;
}

function whereHtml(it, match) {
  const l = it.location;
  if (!l || (!l.name && !l.address)) return '<span class="unknown">Location not listed</span>';
  const dist = match?.distance != null ? ` <span class="hint">· ≈${match.distance.toFixed(1)} km straight-line</span>` : '';
  return `${esc(l.name || '')}${l.name && l.address ? '<br>' : ''}<span class="hint">${esc(l.address || '')}</span>${dist}`;
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

// ---------- card ----------
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
    <div class="badges"><span class="badge kind-${esc(it.kind)}">${esc(KIND_LABEL[it.kind])}</span>${typeBadges}${warn}${demo}${been ? '<span class="badge">Been there</span>' : ''}</div>
    <h3><button type="button" data-act="details">${esc(it.title)}</button></h3>
    ${reason ? `<p class="reason"><b>Why this pick:</b> ${esc(reason)}</p>` : `<p class="reason">${esc(whenPhrase(match, now()))}</p>`}
    ${compact ? '' : `<p class="desc">${esc(it.summary || '') || '<span class="unknown">No description provided by the source.</span>'}</p>`}
    <dl class="facts">
      <div><dt>When</dt><dd>${whenHtml(it, match)}</dd></div>
      <div><dt>Where</dt><dd>${whereHtml(it, match)}</dd></div>
      <div><dt>Cost</dt><dd>${costHtml(it.cost)}</dd></div>
      <div><dt>Registration</dt><dd>${regHtml(it.registration)}</dd></div>
    </dl>
    <p class="meta">${updatedHtml(it)}</p>
    <div class="actions">
      <button type="button" class="btn" data-act="details">Details</button>
      ${hasMap ? '<button type="button" class="btn" data-act="directions">Directions</button>' : ''}
      ${hasCal ? '<button type="button" class="btn" data-act="ics">Add to calendar</button>' : ''}
      <button type="button" class="btn" data-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button>
      <button type="button" class="btn" data-act="hide">Not interested</button>
      <button type="button" class="btn" data-act="been" aria-pressed="${been}">${been ? '✓ Been there' : 'Been there'}</button>
    </div>
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
  return { likedTypes, dislikedTypes, been: new Set(Object.keys(state.been)) };
}
const hiddenSet = () => new Set(Object.keys(state.hidden));

// ---------- Discover ----------
function readForm() {
  const fd = new FormData($('#filters'));
  f.timeOfDay = fd.get('timeOfDay');
  f.timeAvail = fd.get('timeAvail');
  f.budget = fd.get('budget');
  f.transport = fd.get('transport');
  f.kind = fd.get('kind');
  f.q = (fd.get('q') || '').trim();
  f.includeUnknown = fd.get('includeUnknown') === 'on';
}

function syncFormUI() {
  for (const b of document.querySelectorAll('[data-when]')) b.setAttribute('aria-checked', String(f.when === b.dataset.when));
  for (const b of document.querySelectorAll('[data-when]')) b.setAttribute('role', 'radio');
  $('#f-date').value = f.when === 'date' ? f.date : '';
  for (const b of document.querySelectorAll('[data-type]')) b.setAttribute('aria-pressed', String(f.types.includes(b.dataset.type)));
  for (const b of document.querySelectorAll('[data-mood]')) b.setAttribute('aria-pressed', String(f.mood === b.dataset.mood));
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
}

function rangeLabel() {
  const r = rangeFor(f.when, now(), f.date);
  const last = r.to - 1;
  const a = formatDate(Math.max(r.from, startOfDay(r.fromKey)));
  const b = formatDate(last);
  const name = { today: 'Today', tomorrow: 'Tomorrow', weekend: 'This weekend', week: 'Next 7 days', date: 'Selected date' }[f.when];
  return `${name} (${a === b ? a : `${a} – ${b}`})`;
}

function renderDiscover() {
  const ctx = { now: now(), origin, hidden: hiddenSet() };
  const matches = filterItems(items, f, ctx);
  const picks = matches.length ? pickRecommendations(matches, { now: ctx.now, prefs: prefs() }, f, 5) : [];
  const unknownCount = matches.filter((m) => m.unknowns.length).length;
  $('#summary').textContent = `${matches.length} result${matches.length === 1 ? '' : 's'} · ${rangeLabel()}${unknownCount ? ` · ${unknownCount} with some details not listed` : ''} · times in Central Time`;

  const picksEl = $('#picks');
  if (!matches.length) {
    picksEl.innerHTML = `<div class="empty"><p><strong>Nothing matches these filters.</strong></p><p>Try a wider date range, a higher budget, or turn on “Include items with missing … information”. You can also check the original calendars on the <a href="#/sources">Sources</a> page.</p></div>`;
  } else {
    picksEl.innerHTML = picks.map((p) => cardHtml(p, { reason: p.reason })).join('');
  }
  const tg = $('#toggleAll');
  tg.hidden = matches.length <= picks.length && !showAll;
  tg.textContent = showAll ? 'Hide full list' : `Browse all ${matches.length} results`;
  tg.setAttribute('aria-expanded', String(showAll));
  const all = $('#allResults');
  all.hidden = !showAll;
  if (showAll) all.innerHTML = groupedHtml(matches);
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
  let html = '';
  for (const [k, list] of byDay) {
    const label = k === dayKey(t) ? `Today · ${formatDate(startOfDay(k))}` : k === addDaysKey(dayKey(t), 1) ? `Tomorrow · ${formatDate(startOfDay(k))}` : formatDateLong(startOfDay(k) + 3600_000);
    html += `<h2 class="day-heading">${esc(label)} <span class="hint">(${list.length})</span></h2><div class="cards">${list.map((m) => cardHtml(m)).join('')}</div>`;
  }
  if (ongoing.length) html += `<h2 class="day-heading">Ongoing / multi-day <span class="hint">(${ongoing.length})</span></h2><div class="cards">${ongoing.map((m) => cardHtml(m)).join('')}</div>`;
  if (placesM.length) html += `<h2 class="day-heading">Places that are regularly open <span class="hint">(${placesM.length})</span></h2><div class="cards">${placesM.map((m) => cardHtml(m)).join('')}</div>`;
  return html;
}

// ---------- Detail ----------
function findMatch(it) {
  return evaluate(it, { ...DEFAULT_FILTERS, when: 'week', includeUnknown: true }, { now: now(), origin }) || { item: it, window: windowFor(it), distance: null, unknowns: [] };
}

function openDetail(id) {
  const it = byId.get(id) || state.saved[id];
  if (!it) return;
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
  const modeName = { walk: 'walking', bike: 'biking', transit: 'transit', drive: 'driving' }[mode];
  const placeHours = it.kind === 'place' ? `
      <div class="detail-section"><h3>Opening hours (from the official page)</h3>
        <p>${esc(it.hoursText)}</p>
        ${it.closuresText ? `<p class="hint">${esc(it.closuresText)}${it.closures?.length ? ' (year not stated on source; read as 2026–27)' : ''}</p>` : ''}
        ${it.verification?.note ? `<p class="banner">${esc(it.verification.note)}</p>` : ''}
        ${win ? `<p>Next opening shown here: <strong>${esc(formatDate(win.start))}, ${esc(timeRange(win.start, win.end))}</strong></p>` : ''}
      </div>` : '';

  $('#detailBody').innerHTML = `
    <div class="badges"><span class="badge kind-${esc(it.kind)}">${esc(KIND_LABEL[it.kind])}</span>${it.types.map((x) => `<span class="badge">${esc(TYPE_LABEL[x] || x)}</span>`).join('')}${data?.isDemo ? '<span class="badge demo">Demo data</span>' : ''}</div>
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
        <button type="button" class="btn" data-detail-act="save" aria-pressed="${saved}">${saved ? '★ Saved' : '☆ Save'}</button>
        <button type="button" class="btn" data-detail-act="hide">Not interested</button>
        <button type="button" class="btn" data-detail-act="been" aria-pressed="${!!state.been[groupOf(it)]}">${state.been[groupOf(it)] ? '✓ Been there' : 'Been there'}</button>
      </div>
      ${(ended || state.been[groupOf(it)]) ? `<p>How was it?</p><div class="feedback">
        <button type="button" class="btn" data-fb="liked" aria-pressed="${fb === 'liked'}">👍 Liked it</button>
        <button type="button" class="btn" data-fb="meh" aria-pressed="${fb === 'meh'}">👎 Not for me</button>
        ${ended ? `<button type="button" class="btn" data-fb="skipped" aria-pressed="${fb === 'skipped'}">Didn't go</button>` : ''}
      </div>` : ''}
    </div>
    <p class="meta">${updatedHtml(it)}<br>All times are shown in Central Time (${TZ}), regardless of your device's time zone.</p>`;
  const dlg = $('#detail');
  dlg.dataset.id = id;
  if (!dlg.open) dlg.showModal();
  $('#closeDetail').focus();
}

// ---------- actions ----------
function snapshot(it) {
  const { description, ...rest } = it;
  return { ...rest, description: (description || '').slice(0, 600), savedAt: new Date().toISOString() };
}

function act(action, id) {
  const it = byId.get(id) || state.saved[id];
  if (!it) return;
  if (action === 'details') return openDetail(id);
  if (action === 'directions') {
    const m = mapLinks(it.location, f.transport);
    if (m) window.open(isApple && m.appleSupportsMode ? m.apple : m.google, '_blank', 'noopener');
    return;
  }
  if (action === 'ics') return downloadICS(it);
  if (action === 'save') {
    if (state.saved[id]) { delete state.saved[id]; toast('Removed from saved'); } else { state.saved[id] = snapshot(it); toast('Saved on this device'); }
  } else if (action === 'hide') {
    const g = groupOf(it);
    const prev = state.hidden[g];
    state.hidden[g] = { title: it.title, types: it.types, at: new Date().toISOString() };
    persist(); rerender();
    if ($('#detail').open) $('#detail').close();
    toast(`Hidden “${it.title}”${it.kind === 'recurring' ? ' (all dates)' : ''}`, () => { if (prev) state.hidden[g] = prev; else delete state.hidden[g]; persist(); rerender(); });
    return;
  } else if (action === 'been') {
    const g = groupOf(it);
    if (state.been[g]) delete state.been[g]; else { state.been[g] = { title: it.title, types: it.types, at: new Date().toISOString(), id }; toast('Marked as been there — you can rate it in Details or Saved'); }
  }
  persist(); rerender();
}

function setFeedback(id, value) {
  const it = byId.get(id) || state.saved[id];
  if (!it) return;
  if (state.feedback[id]?.value === value) delete state.feedback[id];
  else state.feedback[id] = { value, at: new Date().toISOString(), title: it.title };
  if (!state.saved[id] && value !== 'skipped') state.saved[id] = snapshot(it); // keep a record for history
  if (value !== 'skipped') state.been[groupOf(it)] ||= { title: it.title, types: it.types, at: new Date().toISOString(), id };
  persist(); rerender();
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

let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  el.hidden = false;
  if (undo) el.querySelector('button').onclick = () => { undo(); el.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 6000 : 2500);
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
      <p>${data?.isDemo ? '<strong>You are viewing demonstration data.</strong> ' : ''}Data file generated <strong>${esc(fmt(data?.generatedAt))}</strong>. It covers ${esc(data?.window?.days ?? '?')} days from that date. ${counts.expiredRemoved != null ? `${counts.expiredRemoved} ended items and ${counts.duplicatesRemoved} duplicates were removed during the last refresh; ended items are also hidden live in your browser.` : ''}</p>
    </div>
    ${srcs.map((s) => `<div class="source-card">
      <h2>${esc(s.name)}</h2>
      <table class="kv">
        <tr><th>Status</th><td>${statusHtml(s)}${s.error ? ` — ${esc(s.error)}` : ''}</td></tr>
        <tr><th>Last successful update</th><td>${esc(fmt(s.lastSuccess))}</td></tr>
        <tr><th>Last attempt</th><td>${esc(fmt(s.lastAttempt))}</td></tr>
        <tr><th>Items in this data</th><td>${esc(s.itemCount)}</td></tr>
        <tr><th>How it's read</th><td>${esc(s.method)}</td></tr>
        <tr><th>Original source</th><td>${extLink(s.homepage, s.homepage)}</td></tr>
      </table></div>`).join('')}
    <div class="prose">
      <h2>How to read the information</h2>
      <ul>
        <li><strong>Times</strong> are always Central Time (America/Chicago) and labeled CST/CDT, whatever time zone your device is in.</li>
        <li><strong>One-time</strong> = a single date. <strong>Recurring</strong> = the source lists several dates (each date is its own entry). <strong>Multi-day / ongoing</strong> = one listing spanning several days, like an exhibit. <strong>Regularly open place</strong> = a facility with published opening hours.</li>
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
function route() { const h = location.hash.replace(/^#\/?/, ''); return h.startsWith('saved') ? 'saved' : h.startsWith('sources') ? 'sources' : 'discover'; }
function rerender() {
  const r = route();
  for (const v of ['discover', 'saved', 'sources']) $(`#view-${v}`).hidden = v !== r;
  for (const a of document.querySelectorAll('[data-tab]')) { if (a.dataset.tab === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  if (r === 'discover') { syncFormUI(); renderDiscover(); }
  if (r === 'saved') renderSaved();
  if (r === 'sources') renderSources();
  const dlg = $('#detail');
  if (dlg.open && dlg.dataset.id) openDetail(dlg.dataset.id);
}
function updateSavedCount() {
  const t = now();
  const n = Object.keys(state.saved).length;
  const awaiting = Object.values(state.saved).filter((s) => s.kind !== 'place' && isExpired(byId.get(s.id) || s, t) && !state.feedback[s.id]).length;
  const el = $('#savedCount');
  el.hidden = !n;
  el.textContent = n;
  el.classList.toggle('alert', awaiting > 0);
  el.title = awaiting ? `${awaiting} past item(s) waiting for your feedback` : `${n} saved`;
  el.setAttribute('aria-label', el.title);
}

// ---------- wiring ----------
function setupFilters() {
  $('#typeChips').innerHTML = TYPES.map((t) => `<button type="button" class="chip" data-type="${t.id}" aria-pressed="false">${esc(t.label)}</button>`).join('');
  $('#moodChips').innerHTML = MOODS.map((m) => `<button type="button" class="chip" data-mood="${m.id}" aria-pressed="false" title="${esc(m.types.map((t) => TYPE_LABEL[t]).join(', '))}">${esc(m.label)}</button>`).join('');
  const form = $('#filters');
  form.addEventListener('click', (e) => {
    const w = e.target.closest('[data-when]');
    if (w) { f.when = w.dataset.when; f.date = ''; return rerender(); }
    const ty = e.target.closest('[data-type]');
    if (ty) { const id = ty.dataset.type; f.types = f.types.includes(id) ? f.types.filter((x) => x !== id) : [...f.types, id]; return rerender(); }
    const md = e.target.closest('[data-mood]');
    if (md) { f.mood = f.mood === md.dataset.mood ? '' : md.dataset.mood; return rerender(); }
  });
  form.addEventListener('input', (e) => {
    if (e.target.id === 'f-date') { if (e.target.value) { f.when = 'date'; f.date = e.target.value; } else { f.when = 'week'; f.date = ''; } }
    readForm(); rerender();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#resetFilters').addEventListener('click', () => { f = { ...DEFAULT_FILTERS, types: [] }; form.reset(); rerender(); });
  $('#useLocation').addEventListener('click', () => {
    if (origin) { origin = null; return rerender(); }
    if (!navigator.geolocation) return toast('Location is not available in this browser');
    navigator.geolocation.getCurrentPosition(
      (p) => { origin = { lat: p.coords.latitude, lng: p.coords.longitude }; toast('Using your location for straight-line distance only'); rerender(); },
      () => toast('Location permission was not granted — nothing is filtered by distance'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  });
  const today = dayKey(now());
  const d = $('#f-date');
  d.min = today;
  d.max = data?.window ? dayKey(Date.parse(data.window.to) - 1) : addDaysKey(today, 30);
  if (matchMedia('(min-width: 1000px)').matches) $('#moreFilters').open = true;
}

document.addEventListener('click', (e) => {
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) { const card = actBtn.closest('[data-id]'); if (card) { e.preventDefault(); return act(actBtn.dataset.act, card.dataset.id); } }
  const fbBtn = e.target.closest('[data-fb]');
  if (fbBtn) { const id = fbBtn.closest('[data-id]')?.dataset.id || $('#detail').dataset.id; return setFeedback(id, fbBtn.dataset.fb); }
  const dAct = e.target.closest('[data-detail-act]');
  if (dAct) return act(dAct.dataset.detailAct, $('#detail').dataset.id);
  const open = e.target.closest('[data-open]');
  if (open) return openDetail(open.dataset.open);
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
window.addEventListener('hashchange', () => { if ($('#detail').open) $('#detail').close(); rerender(); window.scrollTo(0, 0); });

// ---------- load ----------
const CACHE_KEY = 'bcs-life-radar:lastData';
async function load() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (!DEMO) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* storage full or blocked */ } }
  } catch (e) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { /* none */ }
    if (cached && !DEMO) {
      data = cached;
      loadProblem = `Couldn't load the latest information (${esc(e.message)}). Showing a copy saved on this device from ${esc(formatDateTime(Date.parse(cached.generatedAt)))}.`;
    } else {
      data = { items: [], sources: [], generatedAt: new Date().toISOString(), window: null };
      loadProblem = `Couldn't load activity data (${esc(e.message)}). Please check the original calendars: ${extLink('https://www.cstx.gov/calendar/', 'City of College Station')} · ${extLink('https://www.destinationbryan.com/events/', 'Destination Bryan')}`;
    }
  }
  items = (data.items || []).map((i) => ({ ...i, groupKey: i.groupKey || i.id }));
  byId = new Map(items.map((i) => [i.id, i]));
  setupFilters();
  renderBanners();
  updateSavedCount();
  rerender();
  document.body.dataset.ready = '1';
}
load();
