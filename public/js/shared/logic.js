// Pure logic shared by the UI and tests: expiry, date ranges, place hours, filtering, picks.
import { dayKey, startOfDay, addDaysKey, dowOfKey, chicagoParts, chicagoToUtc, formatTime, formatTimeRange, formatDate } from './time.js';
import { MOODS, TYPE_LABEL } from './taxonomy.js';

const HOUR = 3600_000;
const ms = (iso) => (iso ? Date.parse(iso) : null);

/** End of the Chicago day that contains `t`. */
export const endOfDay = (t) => startOfDay(dayKey(t), 1);

/** Effective end used for expiry/overlap: listed end, or end of the start day when no end is listed. */
export function effectiveEnd(item) {
  if (item.end) return ms(item.end);
  return endOfDay(ms(item.start));
}

/** Expired = its (effective) end is at or before now. Places never expire. */
export function isExpired(item, now) {
  if (item.kind === 'place') return false;
  return effectiveEnd(item) <= now;
}

export const isHappeningNow = (item, now) => item.kind !== 'place' && ms(item.start) <= now && effectiveEnd(item) > now;

/** True when a timed event starts after `now` and no later than `now + withinMs` (default 3 h). */
export function startsWithin(item, now, withinMs = 3 * HOUR) {
  if (item.kind === 'place' || item.kind === 'multi-day' || item.allDay || !item.start) return false;
  const s = ms(item.start);
  return s > now && s <= now + withinMs;
}

/** "1 result" / "2 results"; pass an irregular plural as the third argument. */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "45 min", "2 h", "2 h 30 min" for a duration in ms (rounded to minutes). */
export function durationLabel(msDur) {
  const mins = Math.max(0, Math.round(msDur / 60_000));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Items for a "Right now" strip: happening now, starting within `withinMs`, or places open now.
 * Returns [{ match, status: 'now'|'soon'|'open', label }] — at most `max`, in that order. Empty when nothing qualifies.
 */
export function nowItems(matches, now, { withinMs = 3 * HOUR, max = 6 } = {}) {
  const out = [];
  for (const m of matches) {
    const it = m.item;
    if (it.kind === 'place') {
      const w = m.window;
      if (w && w.start <= now && w.end > now) out.push({ match: m, status: 'open', label: `Open now · until ${formatTime(w.end)}`, order: 2, t: w.end });
    } else if (it.kind !== 'multi-day' && isHappeningNow(it, now)) {
      out.push({ match: m, status: 'now', label: it.end ? `Happening now · until ${formatTime(ms(it.end))}` : 'Happening now', order: 0, t: effectiveEnd(it) });
    } else if (startsWithin(it, now, withinMs)) {
      out.push({ match: m, status: 'soon', label: `Starts in ${durationLabel(ms(it.start) - now)}`, order: 1, t: ms(it.start) });
    }
  }
  out.sort((a, b) => a.order - b.order || a.t - b.t);
  return out.slice(0, max).map(({ match, status, label }) => ({ match, status, label }));
}

/**
 * Collapse recurring items that share a seriesId into one match (the earliest, i.e. the next date),
 * carrying the later ones in `otherDates`. Input order (sorted by start) is kept.
 */
export function groupSeries(matches) {
  const out = [], bySeries = new Map();
  for (const m of matches) {
    const sid = m.item.kind === 'recurring' ? m.item.seriesId : null;
    if (!sid) { out.push(m); continue; }
    const g = bySeries.get(sid);
    if (g) { g.otherDates.push(m); continue; }
    const first = { ...m, otherDates: [] };
    bySeries.set(sid, first);
    out.push(first);
  }
  return out;
}

/** Date range [from, to) for a "when" choice, clipped to start at now. */
export function rangeFor(when, now, date) {
  const today = dayKey(now);
  let fromKey = today, days = 7;
  if (when === 'today') days = 1;
  else if (when === 'tomorrow') { fromKey = addDaysKey(today, 1); days = 1; }
  else if (when === 'weekend') {
    const dow = dowOfKey(today);
    if (dow === 0) days = 1; // Sunday: just today
    else if (dow === 6) days = 2;
    else { fromKey = addDaysKey(today, 6 - dow); days = 2; }
  } else if (when === 'date' && date) { fromKey = date; days = 1; }
  const from = Math.max(now, startOfDay(fromKey));
  const to = startOfDay(fromKey, days);
  return { from, to, fromKey, days };
}

const hm = (s) => s.split(':').map(Number);
const inClosure = (key, closures = []) => closures.some(([a, b]) => key >= a && key <= b);

/** Open windows [{start,end,key}] for a place across [from, to). Empty if hours unknown. */
export function placeWindows(place, from, to) {
  if (!place.hours) return [];
  const out = [];
  for (let key = dayKey(from); startOfDay(key) < to; key = addDaysKey(key, 1)) {
    if (inClosure(key, place.closures)) continue;
    const dow = dowOfKey(key);
    const [y, m, d] = key.split('-').map(Number);
    for (const h of place.hours) {
      if (!h.days.includes(dow)) continue;
      const [oh, om] = hm(h.open), [ch, cm] = hm(h.close);
      const s = chicagoToUtc(y, m, d, oh, om), e = chicagoToUtc(y, m, d, ch, cm);
      if (e > from && s < to) out.push({ start: s, end: e, key });
    }
  }
  return out;
}

export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Straight-line radius used for "walk" / "bike" when the user shares a location. Not a travel time.
export const RADIUS_KM = { walk: 2.5, bike: 8 };

export const DEFAULT_FILTERS = Object.freeze({
  when: 'week', date: '', timeOfDay: 'any', timeAvail: 'any', budget: 'any',
  types: [], mood: '', transport: 'any', kind: 'all', includeUnknown: true, q: '',
});

const partOfDay = (t) => { const h = chicagoParts(t).hh; return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };
const PART_HOURS = { morning: [0, 12], afternoon: [12, 17], evening: [17, 24] };

function windowHitsPart(w, part) {
  const [a, b] = PART_HOURS[part];
  const [y, m, d] = w.key.split('-').map(Number);
  const s = chicagoToUtc(y, m, d, a), e = b === 24 ? startOfDay(w.key, 1) : chicagoToUtc(y, m, d, b);
  return w.start < e && w.end > s;
}

/**
 * Evaluate one item against filters. Returns null if excluded, else a "match" object with
 * computed facts used by the UI and reasons: { item, window, distance, unknowns:[] }.
 */
export function evaluate(item, f, ctx) {
  const { now, origin, hidden } = ctx;
  if (hidden?.has(item.groupKey || item.id)) return null;
  const { from, to } = rangeFor(f.when, now, f.date);
  const unknowns = [];
  let window = null;

  if (f.kind !== 'all') {
    if (f.kind === 'events' && item.kind === 'place') return null;
    if (f.kind !== 'events' && item.kind !== f.kind) return null;
  }

  if (item.kind === 'place') {
    const wins = placeWindows(item, from, to).filter((w) => w.end > now);
    if (item.hours) {
      if (!wins.length) return null;
      const okWins = f.timeOfDay === 'any' ? wins
        : f.timeOfDay === 'soon' ? wins.filter((w) => w.start <= now + 3 * HOUR && w.end > now + 30 * 60_000)
          : wins.filter((w) => windowHitsPart(w, f.timeOfDay));
      if (!okWins.length) return null;
      window = okWins[0];
    } else {
      unknowns.push('hours');
    }
  } else {
    const s = ms(item.start), e = effectiveEnd(item);
    if (!(s < to && e > from) || e <= now) return null;
    window = { start: s, end: e };
    if (f.timeOfDay !== 'any') {
      if (f.timeOfDay === 'soon') {
        if (!(s <= now + 3 * HOUR)) return null;
      } else if (!item.allDay && item.kind !== 'multi-day' && partOfDay(s) !== f.timeOfDay) return null;
    }
    if (f.timeAvail !== 'any' && item.kind !== 'multi-day') {
      const limit = +f.timeAvail * HOUR;
      if (item.endKnown && !item.allDay) { if (ms(item.end) - s > limit) return null; } else unknowns.push('duration');
    }
  }

  if (f.budget !== 'any') {
    const c = item.cost;
    if (f.budget === 'free') {
      if (c.status === 'unknown' || (c.status === 'paid' && c.min === null)) { if (c.status === 'unknown') unknowns.push('cost'); else return null; }
      else if (c.status !== 'free') return null;
    } else {
      const lim = +f.budget;
      if (c.min === null) { if (c.status === 'unknown' || c.status === 'paid') unknowns.push('cost'); }
      else if (c.min > lim) return null;
    }
  }

  const wantTypes = new Set([...(f.types || []), ...(f.mood ? MOODS.find((m) => m.id === f.mood)?.types || [] : [])]);
  if (wantTypes.size && !item.types.some((t) => wantTypes.has(t))) return null;

  let distance = null;
  if (origin) distance = distanceKm(origin, item.location);
  if (RADIUS_KM[f.transport] && origin) {
    if (distance === null) unknowns.push('location');
    else if (distance > RADIUS_KM[f.transport]) return null;
  }

  if (f.q) {
    const hay = `${item.title} ${item.summary || ''} ${item.location?.name || ''} ${item.location?.address || ''}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return null;
  }

  if (unknowns.length && !f.includeUnknown) return null;
  return { item, window, distance, unknowns };
}

export function filterItems(items, f, ctx) {
  const out = [];
  for (const it of items) {
    const m = evaluate(it, f, ctx);
    if (m) out.push(m);
  }
  out.sort((a, b) => (a.window?.start ?? Infinity) - (b.window?.start ?? Infinity) || a.item.title.localeCompare(b.item.title));
  return out;
}

/** Human "when" phrase for a match relative to now, Chicago time. */
export function whenPhrase(m, now) {
  const it = m.item;
  if (it.kind === 'place') {
    if (!m.window) return 'Hours not listed';
    const w = m.window;
    if (w.start <= now && w.end > now) return `Open now until ${formatTime(w.end)}`;
    const same = dayKey(w.start) === dayKey(now);
    return `${same ? 'Open today' : `Open ${formatDate(w.start)}`} ${formatTimeRange(w.start, w.end)}`;
  }
  const s = ms(it.start);
  if (it.kind === 'multi-day') return `Ongoing through ${formatDate(effectiveEnd(it) - 1)}`;
  if (isHappeningNow(it, now)) return it.end ? `Happening now until ${formatTime(ms(it.end))}` : 'Happening today';
  const mins = Math.round((s - now) / 60_000);
  if (mins < 90) return `Starts in ${mins} min`;
  const dk = dayKey(s), today = dayKey(now);
  const t = it.allDay ? 'all day' : `at ${formatTime(s)}`;
  if (dk === today) return `${partOfDay(s) === 'evening' ? 'Tonight' : 'Today'} ${t}`;
  if (dk === addDaysKey(today, 1)) return `Tomorrow ${t}`;
  return `${formatDate(s)} ${t}`;
}

/**
 * Pick 3–5 recommendations with variety. Signals only come from the user's own actions
 * (saved / not interested / been there); with no history every type is treated equally.
 */
export function pickRecommendations(matches, ctx, f, max = 5) {
  const { now, prefs = {} } = ctx;
  const likedTypes = prefs.likedTypes || new Map();
  const dislikedTypes = prefs.dislikedTypes || new Map();
  const been = prefs.been || new Set();
  const savedIds = prefs.saved || new Set(); // so an item's own save does not count as "similar to things you saved"

  const scored = matches.map((m) => {
    const it = m.item;
    let s = 1;
    const start = m.window?.start ?? null;
    if (it.kind === 'place' || it.kind === 'multi-day') s += 0.4;
    else if (isHappeningNow(it, now)) s += 1.2;
    else if (start !== null) {
      const h = (start - now) / HOUR;
      s += h <= 24 ? 1.5 : h <= 72 ? 0.8 : 0.3;
    }
    s += 0.25 * ((it.cost.status !== 'unknown') + (it.registration.status !== 'unknown') + (it.location?.lat != null) + !!it.endKnown);
    if (it.kind === 'place' && !m.window) s -= 0.3; // "Hours not listed" is a weak pick; prefer another candidate when there is one
    const self = savedIds.has(it.id) ? 1 : 0;
    const lk = it.types.reduce((a, t) => a + Math.max(0, (likedTypes.get(t) || 0) - self), 0);
    const dk = it.types.reduce((a, t) => a + (dislikedTypes.get(t) || 0), 0);
    if (lk) { s += Math.min(1, 0.4 * lk); }
    if (dk) { s -= Math.min(1, 0.4 * dk); }
    if (been.has(it.groupKey)) s -= 0.8;
    return { m, s, lk };
  });

  const picks = [];
  const usedTypes = new Set(), usedGroups = new Set(), usedVenues = new Set();
  const pool = [...scored];
  while (picks.length < max && pool.length) {
    let best = null, bestScore = -Infinity;
    for (const c of pool) {
      const it = c.m.item;
      let adj = c.s;
      if (usedGroups.has(it.groupKey)) adj -= 3;
      if (it.types[0] && usedTypes.has(it.types[0])) adj -= 1.2;
      const venue = it.location?.name || it.location?.address;
      if (venue && usedVenues.has(venue)) adj -= 0.8;
      if (adj > bestScore || (adj === bestScore && (c.m.window?.start ?? 0) < (best.m.window?.start ?? 0))) { best = c; bestScore = adj; }
    }
    pool.splice(pool.indexOf(best), 1);
    const it = best.m.item;
    if (usedGroups.has(it.groupKey) && pool.some((c) => !usedGroups.has(c.m.item.groupKey))) continue;
    const varietyType = picks.length && it.types[0] && !usedTypes.has(it.types[0]) ? it.types[0] : null;
    picks.push({ ...best.m, reason: buildReason(best.m, { now, f, lk: best.lk, varietyType }) });
    usedGroups.add(it.groupKey);
    if (it.types[0]) usedTypes.add(it.types[0]);
    const venue = it.location?.name || it.location?.address;
    if (venue) usedVenues.add(venue);
  }
  return picks;
}

export function buildReason(m, { now, f = DEFAULT_FILTERS, lk = 0, varietyType = null }) {
  const it = m.item;
  const when = whenPhrase(m, now);
  const r = when === 'Hours not listed' ? [] : [when];
  if (it.cost.status === 'free') r.push('Free');
  else if (f.budget !== 'any' && f.budget !== 'free' && it.cost.min !== null) r.push(`Fits your $${f.budget} budget`);
  if (m.distance != null) r.push(`≈${m.distance < 10 ? m.distance.toFixed(1) : Math.round(m.distance)} km away (straight line)`);
  if (f.mood) {
    const mood = MOODS.find((x) => x.id === f.mood);
    if (mood) r.push(`Fits a ${mood.label.toLowerCase()} mood`);
  } else if (f.types?.length) {
    const t = it.types.find((x) => f.types.includes(x));
    if (t) r.push(`Matches ${TYPE_LABEL[t]}`);
  }
  if (lk > 0) r.push('Similar to things you saved or liked');
  if (varietyType) r.push(`Adds variety: ${TYPE_LABEL[varietyType]}`);
  if (it.kind === 'recurring') r.push('Repeats — other dates available');
  if (r.length <= 1) {
    // Never a bare when-phrase (or nothing): add a factual signal from the listing itself.
    if (it.types[0]) r.push(TYPE_LABEL[it.types[0]] || it.types[0]);
    const listed = [it.cost.status !== 'unknown' && 'cost', it.registration.status !== 'unknown' && 'registration', (it.location?.name || it.location?.address) && 'location'].filter(Boolean);
    if (listed.length >= 2) r.push(`${listed.join(', ').replace(/, ([^,]*)$/, ' and $1')} listed`);
    else if (it.kind === 'place') r.push('Regularly open place — check hours on the source');
    if (!r.length) r.push(`Listed by ${it.sourceName || 'the source'}`);
  }
  return r.slice(0, 4).join(' · ');
}
