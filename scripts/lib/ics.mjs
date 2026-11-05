// Minimal, dependency-free iCalendar (RFC 5545) reader for the subset used by public calendar feeds:
// VEVENT with DTSTART/DTEND (date or date-time, TZID or UTC), RRULE (DAILY/WEEKLY/MONTHLY with
// BYDAY incl. ordinals, INTERVAL, UNTIL, COUNT), RDATE and EXDATE.
// Times with a TZID are treated as America/Chicago wall time (the only zone our sources use;
// "CST6CDT" follows the same US rules). Unsupported RRULE parts are reported, never guessed.

import { chicagoToUtc, chicagoParts } from '../../public/js/shared/time.js';

const CHICAGO_TZIDS = new Set(['CST6CDT', 'America/Chicago', 'US/Central', 'Central Standard Time']);

export function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

export function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** Parse a content line "NAME;P1=a;P2=b:value". */
function parseLine(line) {
  // The value starts after the first ':' that is not inside a quoted param.
  let inQ = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) break;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...ps] = head.split(';');
  const params = {};
  for (const p of ps) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

/** Returns array of VEVENT objects: { PROP: [{params, value}, ...] } */
export function parseICS(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    if (!raw) continue;
    if (raw === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (raw === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (raw.startsWith('BEGIN:')) { depth++; continue; } // e.g. VALARM
    if (raw.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const { name, params, value } = parseLine(raw);
    (cur[name] ||= []).push({ params, value });
  }
  return events;
}

/**
 * Parse a DATE or DATE-TIME value into a "wall" object:
 * { y,m,d,hh,mm,ss, allDay, utc:boolean }
 */
export function parseDateValue(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) throw new Error(`Bad date value: ${value}`);
  const [, y, mo, d, hh, mi, ss, z] = m;
  const allDay = params.VALUE === 'DATE' || hh === undefined;
  if (params.TZID && !CHICAGO_TZIDS.has(params.TZID)) {
    throw new Error(`Unsupported TZID ${params.TZID}`);
  }
  return { y: +y, m: +mo, d: +d, hh: allDay ? 0 : +hh, mm: allDay ? 0 : +mi, ss: allDay ? 0 : +ss, allDay, utc: !!z };
}

/** Wall object -> epoch ms. UTC values are exact; others are Chicago wall time. */
export function wallToMs(w) {
  if (w.utc) return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss);
  return chicagoToUtc(w.y, w.m, w.d, w.hh, w.mm, w.ss);
}

/** Normalise a UTC wall to Chicago wall (so recurrence happens in local time). */
function toChicagoWall(w) {
  if (!w.utc) return w;
  const p = chicagoParts(wallToMs(w));
  return { y: p.y, m: p.m, d: p.d, hh: p.hh, mm: p.mm, ss: p.ss, allDay: false, utc: false };
}

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Days since epoch for a civil date (calendar arithmetic, zone-free). */
const civil = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const fromCivil = (n) => { const dt = new Date(n * 86400000); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() }; };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseRRule(str) {
  const r = {};
  for (const part of str.split(';')) {
    const [k, v] = part.split('=');
    if (k) r[k.toUpperCase()] = v;
  }
  return r;
}

const SUPPORTED_KEYS = new Set(['FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYDAY', 'WKST', 'BYMONTHDAY']);

/**
 * Expand an RRULE into civil-date day numbers (with the DTSTART time of day kept by caller).
 * Returns { days: number[], unsupported: string|null }.
 * `limitDay` caps expansion (civil day number) to keep work bounded.
 */
export function expandRRule(rule, startWall, limitDay) {
  const unsupportedKeys = Object.keys(rule).filter((k) => !SUPPORTED_KEYS.has(k));
  if (unsupportedKeys.length) return { days: [], unsupported: `RRULE parts not supported: ${unsupportedKeys.join(',')}` };
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10));
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
  let untilDay = Infinity;
  if (rule.UNTIL) {
    const u = parseDateValue(rule.UNTIL, {});
    const uw = toChicagoWall(u);
    untilDay = civil(uw.y, uw.m, uw.d);
  }
  const startDay = civil(startWall.y, startWall.m, startWall.d);
  const end = Math.min(untilDay, limitDay);
  const out = [];
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map((t) => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(t.trim());
    return m ? { n: m[1] ? parseInt(m[1], 10) : 0, dow: DAY_CODES[m[2]] } : null;
  }) : null;
  if (byday && byday.some((b) => b === null)) return { days: [], unsupported: `Bad BYDAY ${rule.BYDAY}` };
  const push = (day) => { if (day >= startDay && day <= end && out.length < count) out.push(day); };

  if (freq === 'DAILY') {
    for (let day = startDay; day <= end && out.length < count; day += interval) {
      if (!byday || byday.some((b) => b.dow === fromCivil(day).dow)) push(day);
    }
  } else if (freq === 'WEEKLY') {
    const dows = byday ? byday.map((b) => b.dow) : [fromCivil(startDay).dow];
    // Weeks anchored on WKST (default MO).
    const wkst = DAY_CODES[rule.WKST || 'MO'];
    const sd = fromCivil(startDay).dow;
    const weekStart0 = startDay - ((sd - wkst + 7) % 7);
    for (let ws = weekStart0; ws <= end && out.length < count; ws += 7 * interval) {
      const inWeek = dows.map((dw) => ws + ((dw - wkst + 7) % 7)).sort((a, b) => a - b);
      for (const day of inWeek) push(day);
    }
  } else if (freq === 'MONTHLY') {
    let { y, m } = startWall;
    for (let guard = 0; guard < 1000 && out.length < count; guard++) {
      if (civil(y, m, 1) > end) break;
      const dim = daysInMonth(y, m);
      let candidates = [];
      if (byday) {
        for (const b of byday) {
          const all = [];
          for (let d = 1; d <= dim; d++) if (fromCivil(civil(y, m, d)).dow === b.dow) all.push(d);
          if (b.n === 0) candidates.push(...all);
          else if (b.n > 0 && all[b.n - 1]) candidates.push(all[b.n - 1]);
          else if (b.n < 0 && all[all.length + b.n]) candidates.push(all[all.length + b.n]);
        }
      } else if (rule.BYMONTHDAY) {
        candidates = rule.BYMONTHDAY.split(',').map(Number).map((n) => (n < 0 ? dim + n + 1 : n)).filter((d) => d >= 1 && d <= dim);
      } else {
        if (startWall.d <= dim) candidates.push(startWall.d);
      }
      for (const d of [...new Set(candidates)].sort((a, b) => a - b)) push(civil(y, m, d));
      m += interval; while (m > 12) { m -= 12; y++; }
    }
  } else {
    return { days: [], unsupported: `FREQ=${freq} not supported` };
  }
  return { days: out, unsupported: null };
}

/**
 * Compute all occurrences of a VEVENT that overlap [fromMs, toMs].
 * Returns { occurrences: [{startMs, endMs|null, allDay, wallStart}], totalKnown, notes: [] }
 * `totalKnown` = number of distinct occurrences we know about across all time (bounded by limit),
 * used to tell one-time from recurring.
 */
export function occurrences(ev, fromMs, toMs) {
  const notes = [];
  const dtstartP = ev.DTSTART?.[0];
  if (!dtstartP) return { occurrences: [], totalKnown: 0, notes: ['No DTSTART'] };
  const start = toChicagoWall(parseDateValue(dtstartP.value, dtstartP.params));
  let durationMs = null, durationDays = null;
  const dtendP = ev.DTEND?.[0];
  if (dtendP) {
    const endW = toChicagoWall(parseDateValue(dtendP.value, dtendP.params));
    if (start.allDay) durationDays = civil(endW.y, endW.m, endW.d) - civil(start.y, start.m, start.d);
    else durationMs = Date.UTC(endW.y, endW.m - 1, endW.d, endW.hh, endW.mm, endW.ss) - Date.UTC(start.y, start.m - 1, start.d, start.hh, start.mm, start.ss);
  } else if (start.allDay) {
    durationDays = 1; // RFC 5545: date-only DTSTART without DTEND lasts one day
  }

  const key = (w) => `${w.y}${w.m}${w.d}T${w.hh}${w.mm}`;
  const walls = new Map();
  const addWall = (w) => walls.set(key(w), w);
  addWall(start);

  for (const rd of ev.RDATE || []) {
    for (const v of rd.value.split(',')) {
      if (!v) continue;
      if (rd.params.VALUE === 'PERIOD') { notes.push('RDATE PERIOD ignored'); continue; }
      const w = toChicagoWall(parseDateValue(v, rd.params));
      // RDATE given as a DATE for a timed event keeps the DTSTART time of day.
      if (w.allDay && !start.allDay) { w.hh = start.hh; w.mm = start.mm; w.ss = start.ss; w.allDay = false; }
      addWall(w);
    }
  }
  const limitDay = Math.floor(toMs / 86400000) + 2;
  for (const rr of ev.RRULE || []) {
    const { days, unsupported } = expandRRule(parseRRule(rr.value), start, limitDay);
    if (unsupported) notes.push(unsupported);
    for (const day of days) {
      const c = fromCivil(day);
      addWall({ ...start, y: c.y, m: c.m, d: c.d });
    }
  }
  for (const ex of ev.EXDATE || []) {
    for (const v of ex.value.split(',')) {
      if (!v) continue;
      const w = toChicagoWall(parseDateValue(v, ex.params));
      if (w.allDay && !start.allDay) { w.hh = start.hh; w.mm = start.mm; w.ss = start.ss; }
      walls.delete(key({ ...w, allDay: start.allDay }));
      walls.delete(key(w));
    }
  }

  const hasRule = (ev.RRULE || []).length > 0;
  const out = [];
  for (const w of walls.values()) {
    const s = wallToMs(w);
    let e = null;
    if (w.allDay) {
      const endCivil = fromCivil(civil(w.y, w.m, w.d) + (durationDays ?? 1));
      e = chicagoToUtc(endCivil.y, endCivil.m, endCivil.d);
    } else if (durationMs !== null) {
      // Duration is applied in wall-clock terms so "6–8 PM" stays 6–8 PM across DST changes.
      const ew = new Date(Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) + durationMs);
      e = chicagoToUtc(ew.getUTCFullYear(), ew.getUTCMonth() + 1, ew.getUTCDate(), ew.getUTCHours(), ew.getUTCMinutes(), ew.getUTCSeconds());
    }
    if ((e ?? s) >= fromMs && s <= toMs) out.push({ startMs: s, endMs: e, allDay: w.allDay, wallStart: w });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return { occurrences: out, totalKnown: hasRule ? Math.max(walls.size, 2) : walls.size, notes, durationDays };
}
