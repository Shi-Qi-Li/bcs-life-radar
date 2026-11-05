// Shared normalisation helpers for all sources. Rule: never invent missing facts.

import { dayKey } from '../../public/js/shared/time.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', '#039': "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Inline tags wrap words without separating them, so they are removed outright: "<a>Health</a>." must
// read "Health." not "Health .". Every other tag is treated as a separator.
const INLINE_TAGS = /<\/?(a|span|strong|em|b|i|u|small|sup|sub|abbr|mark|font)\b[^>]*>/gi;

export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr|blockquote)>/gi, '\n')
      .replace(INLINE_TAGS, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t  ]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Button labels and site boilerplate that survive as their own line once the HTML is flattened.
const BOILERPLATE_LINE = /^(click here|reserve (your|a)\b|learn more|register here|buy tickets|view (an )?interactive map|sponsored by)\b/i;
const WEATHER_HEADING = /^weather update\b/i;

/**
 * Drop lines that are only link/button text or publisher boilerplate ("Click Here To View An Interactive
 * Map…", "Reserve Your Spot", "Sponsored by …") and a "WEATHER UPDATE" heading with the notice paragraph
 * that follows it. Only short lines (≤ 100 chars) are dropped, so a real sentence that merely starts with
 * one of these phrases is kept. Links themselves are collected separately by extractLinks().
 */
export function cleanDescription(text) {
  if (!text) return '';
  const lines = String(text).split('\n').map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.length <= 100 && BOILERPLATE_LINE.test(line)) continue;
    if (WEATHER_HEADING.test(line)) {
      // A bare heading is followed by the notice paragraph: drop both.
      if (line.length <= 40 && !/[.!?]/.test(line)) i++;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function truncate(s, n) {
  if (!s || s.length <= n) return s || '';
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${cut.slice(0, sp > n * 0.6 ? sp : n).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** Extract links from HTML: [{href, text}] */
export function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || ''))) out.push({ href: decodeEntities(m[1]), text: htmlToText(m[2]) });
  return out;
}

const AMOUNT = /\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g;
/** Every dollar amount in a string, in order of appearance. */
const amountsIn = (s) => [...String(s).matchAll(AMOUNT)].map((m) => parseFloat(m[1].replace(/,/g, '')));

/** Lowest dollar amount mentioned in a price string, or null. */
export function minDollar(s) {
  const nums = amountsIn(s);
  return nums.length ? Math.min(...nums) : null;
}

// Admission wording that says attending itself costs nothing, even when other amounts follow
// ("Free to Watch | $20 to Participate", "Attendance is free, with lunch available for $10").
const FREE_FOR_ALL = /\bfree to (watch|attend|enter|the public|all)\b|\badmission is free\b|\bfree admission\b|\battendance is free\b|\bfree entry\b|\bfree (and|&) open to the public\b|\bno cover\b/i;
// A price that applies to one audience only, not to a typical adult visitor.
const AUDIENCE_PRICE = /\b(members?|membership|kids?|child(ren)?|under \d+|\d+ (and|&) under|students?|seniors?|vfw|youth|teens?|toddlers?|infants?|babies|military|veterans?|participants?|to participate|vendors?|per team|teams?)\b/i;
// Wording that marks the general / adult price explicitly; wins over AUDIENCE_PRICE in the same piece.
const GENERAL_PRICE = /\b(general admission|general|adults?|at the door|per person|regular|standard|non-?members?|public)\b/i;
// Not a fixed price at all.
const NOT_A_PRICE = /\b(tbd|tba|to be (determined|announced)|donations?)\b/i;
// The whole text is just "free" in some spelling.
const JUST_FREE = /^free( entry| admission| event| to attend| to the public)?[!.]?$/i;

/**
 * Split one segment holding several prices into one piece per price. Labels are assumed to follow the
 * amount ("$24 General Admission $19 General Admission $12 Kids Admission") unless the segment starts
 * with a label ("Adults $25 Children $10"), in which case each label precedes its amount.
 */
function priceParts(seg) {
  const ms = [...seg.matchAll(AMOUNT)];
  if (ms.length <= 1) return [seg];
  const labelsLead = /[A-Za-z]/.test(seg.slice(0, ms[0].index));
  const cuts = labelsLead ? ms.slice(0, -1).map((m) => m.index + m[0].length) : ms.slice(1).map((m) => m.index);
  const parts = [];
  let prev = 0;
  for (const c of cuts) { parts.push(seg.slice(prev, c)); prev = c; }
  parts.push(seg.slice(prev));
  return parts;
}

/** Amounts that apply to a general adult visitor: audience-specific prices (members, kids, …) are left out. */
function generalAmounts(t) {
  // "w/" and "w/o" are not separators.
  const norm = t.replace(/\bw\/o\b/gi, 'without').replace(/\bw\//gi, 'with ');
  const out = [];
  for (const seg of norm.split(/\s*[|;,]\s*|\s*\/\s*|\s+[-–—]\s+/)) {
    for (const piece of priceParts(seg)) {
      const amts = amountsIn(piece);
      if (!amts.length) continue;
      if (GENERAL_PRICE.test(piece) || !AUDIENCE_PRICE.test(piece)) out.push(...amts);
    }
  }
  return out;
}

/**
 * Cost object: { status: 'free'|'paid'|'mixed'|'unknown', label, min }
 *  - label keeps the source's full wording whenever it says more than "free".
 *  - min: the typical adult price (0 when attending is free), or null when not stated. Audience-specific
 *    prices (members, kids, students, seniors, …) never set min on their own unless they are the only ones.
 */
export function costFromText(text) {
  if (!text || !String(text).trim()) return { status: 'unknown', label: 'Cost not listed', min: null };
  const t = String(text).trim().replace(/\s+/g, ' ');
  const amounts = amountsIn(t);
  const saysFree = /\bfree\b/i.test(t) || FREE_FOR_ALL.test(t);
  if (!amounts.length) {
    if (saysFree) return { status: 'free', label: JUST_FREE.test(t) ? 'Free' : t, min: 0 };
    if (NOT_A_PRICE.test(t)) return { status: 'unknown', label: t, min: null };
    return { status: 'unknown', label: `${t} (price not stated)`, min: null };
  }
  if (amounts.every((a) => a === 0)) return { status: 'free', label: /^\$\s?0(\.00)?$/.test(t) ? 'Free' : t, min: 0 };
  if (/\bdonations?\b/i.test(t)) return { status: 'unknown', label: t, min: null }; // "Suggested donation $5" is not a price
  if (FREE_FOR_ALL.test(t)) return { status: 'mixed', label: t, min: 0 };
  const general = generalAmounts(t);
  const min = Math.min(...(general.length ? general : amounts));
  const status = saysFree || amounts.some((a) => a === 0) ? 'mixed' : 'paid';
  return { status, label: t, min };
}

// Also "RSVP’s to each Seminar Supper will open on the first day of each month and close the Wednesday before…"
const REQUIRED_RE = /registration (is )?required|must register|pre-?registration|registration is (now )?open|rsvp[’']?s?\b[^.!?\n]{0,60}?\b(will |are |is )?(open|close)s?\b(?! house| to\b)|rsvp (is )?required|reservations? (are |is )?required|register (by|before)\b|registration closes/i;
const NOT_REQUIRED_RE = /no (registration|rsvp|tickets?)( is| are)? (required|needed|necessary)|registration is not required|no need to register/i;
const MENTION_RE = /regist|rsvp|sign ?up|tickets?/i;
// Sentences about performers, vendors, competitors or other participants signing up — not about attending.
const PARTICIPANT_RE = /\bvendors?\b|\bartists? (interested|wishing)\b|\bperform(ers?|ing)?\b|\bget on stage\b|\bopen mic sign|\bbooths?\b|\bto compete\b|\bcompetitors?\b|\bparticipants? (must|should)\b|\bif you (want|wish|would like) to (participate|compete|perform|play)\b|\bbe part of the (challenge|competition|tournament|bracket)\b/i;
const TICKETING_HOST = /eventbrite|ticket|tix|etix|showclix|square|universe|runsignup|exploretock|humanitix|axs\./i;
const PARTICIPANTS_ONLY = 'Sign-up mentioned only for performers/vendors/participants — nothing listed for attendees';

/** Sentences of a description; a "Click here …" sentence belongs to the statement before it. */
function sentences(text) {
  const out = [];
  for (const s of String(text || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean)) {
    if (out.length && /^(click|tap) here\b/i.test(s)) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}

/**
 * Registration object: { status, label, url }
 * status: 'required' | 'tickets' | 'not-required' | 'mentioned' | 'unknown'
 * Sentences that are only about performers/vendors/participants signing up are ignored when judging what
 * an attendee must do; when they are the only mention, the status is 'unknown' with an explanatory label.
 */
export function registrationFrom({ tags = [], description = '', links = [], ticketUrl = null }) {
  const regLink = links.find((l) => /register|rsvp|sign ?up|click here/i.test(l.text || ''))
    || links.find((l) => /regist|sign ?up|rsvp|reserve|ticket/i.test(`${l.text} ${l.href}`));
  const url = ticketUrl || regLink?.href || null;
  if (tags.some((t) => /registration required/i.test(t))) {
    return { status: 'required', label: 'Registration required', url };
  }
  if (NOT_REQUIRED_RE.test(description)) {
    return { status: 'not-required', label: 'No registration required (per description)', url: null };
  }
  const all = sentences(description);
  const attendee = all.filter((s) => !PARTICIPANT_RE.test(s)).join(' ');
  const droppedSome = attendee.length < all.join(' ').length;
  if (REQUIRED_RE.test(attendee)) {
    return { status: 'required', label: 'Registration required (per description)', url };
  }
  if (ticketUrl) {
    if (/\brsvp/i.test(description) && !TICKETING_HOST.test(ticketUrl)) return { status: 'mentioned', label: 'Event page / RSVP link', url };
    return { status: 'tickets', label: 'Ticket/booking link provided — see source', url };
  }
  if (MENTION_RE.test(attendee)) {
    return { status: 'mentioned', label: 'Registration or tickets mentioned — check source', url };
  }
  if (droppedSome && MENTION_RE.test(description)) {
    return { status: 'unknown', label: PARTICIPANTS_ONLY, url: regLink?.href || null };
  }
  return { status: 'unknown', label: 'Registration requirements not listed', url: null };
}

export function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const STOP = new Set(['the', 'a', 'an', 'at', 'in', 'of', 'and', 'for', 'with', 'on', 'to', 'by']);
function tokens(s) {
  return new Set(slug(s).split('-').filter((t) => t && !STOP.has(t)));
}
/** Share of the shorter title's tokens that also appear in the other title (0–1). */
export function titleSimilarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * Token overlap of two venue names (0–1): 1 when one name's tokens all appear in the other
 * ("The Kimbell" vs "Kimbell Cultural Event Center"), otherwise Jaccard
 * ("The Brazos Center" vs "Brazos County Expo Complex" → 0.2).
 */
export function nameSimilarity(a, b) {
  const A = tokens(a || ''), B = tokens(b || '');
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  if (inter === Math.min(A.size, B.size)) return 1;
  return inter / (A.size + B.size - inter);
}

const WINDOW_MS = 30 * 60_000;
const venueName = (it) => it.location?.name || null;
/** Venues are compatible when their names overlap enough or one of them is not listed. */
const venuesCompatible = (a, b) => !venueName(a) || !venueName(b) || nameSimilarity(venueName(a), venueName(b)) >= 0.5;

/** Why `a` and `b` describe the same occurrence, or null when they do not. */
export function duplicateReason(a, b) {
  if (a.kind === 'place' || b.kind === 'place') return null;
  const sim = titleSimilarity(a.title, b.title);
  const sameStart = a.start === b.start;
  if (a.sourceId === b.sourceId) {
    // Two dates of one series are never duplicates; two pages of one source only when they clearly coincide.
    if (a.seriesId === b.seriesId) return null;
    return sameStart && sim >= 0.9 && venuesCompatible(a, b) ? `same source, same start, near-identical titles (${sim.toFixed(2)})` : null;
  }
  if (sim < 0.75 || !venuesCompatible(a, b)) return null;
  if (sameStart) return `same start, similar titles (${sim.toFixed(2)})`;
  const sa = Date.parse(a.start), sb = Date.parse(b.start);
  if (!Number.isFinite(sa) || !Number.isFinite(sb)) return null;
  const diff = Math.abs(sa - sb);
  if (diff > WINDOW_MS || dayKey(sa) !== dayKey(sb)) return null;
  const venue = venueName(a) && venueName(b) ? 'same venue' : 'one venue not listed';
  return `same day, starts ${Math.round(diff / 60_000)} min apart, similar titles (${sim.toFixed(2)}), ${venue}`;
}

/**
 * Remove duplicate occurrences (same activity listed twice, possibly by two sources).
 * Two items are duplicates when they share an exact id, or (see duplicateReason) when their titles are
 * similar and they start at the same minute — or, across sources, on the same Chicago day within 30
 * minutes at a compatible venue. The richer item is kept and the other listing is recorded under
 * `alsoListedBy` with the reason for the merge.
 */
export function dedupe(items) {
  const richness = (it) => (it.cost.status !== 'unknown') + (it.registration.status !== 'unknown') + !!it.location?.lat + (it.description?.length > 80) + (it.endKnown ? 1 : 0);
  const kept = [];
  const byId = new Map();
  let removed = 0;
  for (const it of items) {
    if (byId.has(it.id)) { removed++; continue; }
    let reason = null;
    const dup = kept.find((k) => (reason = duplicateReason(k, it)));
    if (dup) {
      removed++;
      const [win, lose] = richness(it) > richness(dup) ? [it, dup] : [dup, it];
      win.alsoListedBy = [...(win.alsoListedBy || []), { sourceName: lose.sourceName, url: lose.sourceUrl, reason }, ...(lose.alsoListedBy || [])];
      if (win !== dup) { kept[kept.indexOf(dup)] = win; byId.delete(dup.id); byId.set(win.id, win); }
      continue;
    }
    kept.push(it);
    byId.set(it.id, it);
  }
  return { items: kept, removed };
}
