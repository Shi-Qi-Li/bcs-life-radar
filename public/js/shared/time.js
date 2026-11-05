// Time helpers pinned to America/Chicago, independent of the device's own time zone.
// Shared by the browser app and the Node refresh scripts (plain ES module, no deps).

export const TZ = 'America/Chicago';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant (ms since epoch) in Chicago. */
export function chicagoParts(ms) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    y: +p.year, m: +p.month, d: +p.day,
    hh: +p.hour % 24, mm: +p.minute, ss: +p.second,
    dow: WEEKDAYS[p.weekday],
  };
}

/** Offset (ms) of Chicago from UTC at a given instant, e.g. -5h in CDT, -6h in CST. */
export function chicagoOffset(ms) {
  const p = chicagoParts(ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Convert a Chicago wall-clock time to an instant (ms). Handles DST:
 * nonexistent spring-forward times shift forward; ambiguous fall-back times pick the first (CDT) one.
 */
export function chicagoToUtc(y, m, d, hh = 0, mm = 0, ss = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let off = chicagoOffset(guess);
  let t = guess - off;
  const off2 = chicagoOffset(t);
  if (off2 !== off) {
    const t2 = guess - off2;
    // If t2 maps back to the requested wall time, prefer it.
    const p = chicagoParts(t2);
    if (p.hh === hh && p.mm === mm) t = t2;
  }
  // Ambiguous (fall-back) hour: prefer the earlier instant.
  const earlier = t - 3600_000;
  const pe = chicagoParts(earlier);
  if (pe.y === y && pe.m === m && pe.d === d && pe.hh === hh && pe.mm === mm) t = earlier;
  return t;
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for the Chicago calendar day containing the instant. */
export function dayKey(ms) {
  const p = chicagoParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Instant of Chicago midnight starting the given day key, offset by `addDays`. */
export function startOfDay(key, addDays = 0) {
  const [y, m, d] = key.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + addDays));
  return chicagoToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

/** Add whole calendar days to a day key. */
export function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Day of week (0=Sun) for a day key. */
export function dowOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const fmtCache = new Map();
function fmt(opts) {
  const k = JSON.stringify(opts);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }));
  return fmtCache.get(k);
}

// Newer ICU versions put U+202F (narrow no-break space) before AM/PM; normalise to a plain space.
const clean = (s) => s.replace(/[\u202f\u00a0]/g, ' ');
export const formatDate = (ms) => clean(fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(ms));
export const formatDateLong = (ms) => clean(fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(ms));
export const formatTime = (ms) => clean(fmt({ hour: 'numeric', minute: '2-digit' }).format(ms)).replace(':00', '');
export const formatDateTime = (ms) => clean(fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(ms));

/** "12–1 PM", "11 AM–2:30 PM" for two instants on the same Chicago day. */
export function formatTimeRange(a, b) {
  const x = formatTime(a), y = formatTime(b);
  const mx = x.slice(-2), my = y.slice(-2);
  return mx === my ? `${x.slice(0, -3)}–${y}` : `${x}–${y}`;
}
/** "CST" or "CDT" for that instant. */
export const tzAbbr = (ms) => fmt({ timeZoneName: 'short' }).formatToParts(ms).find((p) => p.type === 'timeZoneName').value;

/** Day key of an all-day / date-only value "YYYY-MM-DD" is itself. */
export function keyFromYmd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
