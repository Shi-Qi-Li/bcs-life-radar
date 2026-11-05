// Calendar export (.ics / Google Calendar) and map links. Nothing here invents missing data:
// if an end time is not listed, the calendar entry has no end time and says so in its notes.
import { dayKey, addDaysKey } from './time.js';

const pad = (n) => String(n).padStart(2, '0');
const utcStamp = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
const dateStamp = (key) => key.replace(/-/g, '');
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold content lines at 75 octets (RFC 5545 §3.1). */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', len = 0;
  for (const ch of line) {
    const l = enc.encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export const addressOf = (loc) => (loc ? [loc.name, loc.address].filter(Boolean).join(', ') : '');

/**
 * Decide the calendar span for an item (optionally a specific open window for places).
 * Returns { allDay, start, end|null, startKey, endKeyExclusive }.
 */
export function calendarSpan(item, window) {
  if (item.kind === 'place') return window ? { allDay: false, start: window.start, end: window.end } : null;
  const start = Date.parse(item.start);
  const end = item.end ? Date.parse(item.end) : null;
  if (item.allDay || item.kind === 'multi-day') {
    const startKey = item.runStart || dayKey(start);
    let lastKey = startKey;
    if (item.runEnd) lastKey = item.runEnd;
    else if (end && dayKey(end - 1) > startKey) lastKey = dayKey(end - 1);
    const endKeyExclusive = addDaysKey(lastKey, 1);
    return { allDay: true, start, end, startKey, endKeyExclusive };
  }
  return { allDay: false, start, end: item.endKnown ? end : null };
}

function notesFor(item, span) {
  const lines = [];
  if (item.summary) lines.push(item.summary);
  if (span && !span.allDay && span.end === null) lines.push('End time not listed by the source.');
  if (item.timeNote) lines.push(item.timeNote);
  lines.push(`Cost: ${item.cost.label}`);
  lines.push(`Registration: ${item.registration.label}`);
  lines.push(`Source: ${item.sourceUrl}`);
  lines.push('Times are America/Chicago (Central). Confirm details with the source before going.');
  return lines.join('\n');
}

export function buildICS(item, { window = null, now = Date.now() } = {}) {
  const span = calendarSpan(item, window);
  if (!span) return null;
  const title = item.kind === 'place' ? `Visit: ${item.title}` : item.title;
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BCS Life Radar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${esc(item.id)}${span.allDay ? '' : `-${span.start}`}@bcs-life-radar`,
    `DTSTAMP:${utcStamp(now)}`,
  ];
  if (span.allDay) {
    L.push(`DTSTART;VALUE=DATE:${dateStamp(span.startKey)}`, `DTEND;VALUE=DATE:${dateStamp(span.endKeyExclusive)}`);
  } else {
    L.push(`DTSTART:${utcStamp(span.start)}`);
    if (span.end !== null) L.push(`DTEND:${utcStamp(span.end)}`);
  }
  L.push(`SUMMARY:${esc(title)}`);
  const addr = addressOf(item.location);
  if (addr) L.push(`LOCATION:${esc(addr)}`);
  if (item.location?.lat != null) L.push(`GEO:${item.location.lat};${item.location.lng}`);
  L.push(`DESCRIPTION:${esc(notesFor(item, span))}`, `URL:${item.sourceUrl}`, 'END:VEVENT', 'END:VCALENDAR');
  return `${L.map(fold).join('\r\n')}\r\n`;
}

export function googleCalendarUrl(item, { window = null } = {}) {
  const span = calendarSpan(item, window);
  if (!span) return null;
  let dates;
  if (span.allDay) dates = `${dateStamp(span.startKey)}/${dateStamp(span.endKeyExclusive)}`;
  else dates = `${utcStamp(span.start)}/${utcStamp(span.end ?? span.start)}`;
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: item.kind === 'place' ? `Visit: ${item.title}` : item.title,
    dates,
    ctz: 'America/Chicago',
    details: notesFor(item, span),
    location: addressOf(item.location),
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

const GOOGLE_MODE = { walk: 'walking', bike: 'bicycling', transit: 'transit', drive: 'driving' };
const APPLE_MODE = { walk: 'w', transit: 'r', drive: 'd' };

/** Directions links. Uses the address text when present (shows the venue name), else coordinates. */
export function mapLinks(location, mode = 'any') {
  if (!location) return null;
  const dest = location.address ? addressOf(location) : location.lat != null ? `${location.lat},${location.lng}` : null;
  if (!dest) return null;
  const g = new URLSearchParams({ api: '1', destination: dest });
  if (GOOGLE_MODE[mode]) g.set('travelmode', GOOGLE_MODE[mode]);
  const a = new URLSearchParams({ daddr: dest });
  if (APPLE_MODE[mode]) a.set('dirflg', APPLE_MODE[mode]);
  return {
    google: `https://www.google.com/maps/dir/?${g}`,
    apple: `https://maps.apple.com/?${a}`,
    appleSupportsMode: mode === 'any' || !!APPLE_MODE[mode],
  };
}
