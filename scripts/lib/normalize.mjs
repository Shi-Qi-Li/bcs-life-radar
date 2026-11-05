// Shared normalisation helpers for all sources. Rule: never invent missing facts.

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

export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
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

/** Lowest dollar amount mentioned in a price string, or null. */
export function minDollar(s) {
  const nums = [...String(s).matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => parseFloat(m[1]));
  return nums.length ? Math.min(...nums) : null;
}

/**
 * Cost object: { status: 'free'|'paid'|'mixed'|'unknown', label, min }
 *  - min: lowest listed price (0 for free), or null when not stated.
 */
export function costFromText(text) {
  if (!text || !String(text).trim()) return { status: 'unknown', label: 'Cost not listed', min: null };
  const t = String(text).trim();
  const isFree = /\bfree\b/i.test(t);
  const min = minDollar(t);
  if (isFree && min === null) return { status: 'free', label: 'Free', min: 0 };
  if (min !== null) return { status: isFree ? 'mixed' : 'paid', label: t, min };
  return { status: 'unknown', label: `${t} (price not stated)`, min: null };
}

/**
 * Registration object: { status, label, url }
 * status: 'required' | 'tickets' | 'not-required' | 'mentioned' | 'unknown'
 */
export function registrationFrom({ tags = [], description = '', links = [], ticketUrl = null }) {
  const regLink = links.find((l) => /regist|sign ?up|rsvp|reserve|ticket/i.test(`${l.text} ${l.href}`));
  const url = ticketUrl || regLink?.href || null;
  if (tags.some((t) => /registration required/i.test(t))) {
    return { status: 'required', label: 'Registration required', url };
  }
  if (/no (registration|rsvp|tickets?)( is| are)? (required|needed|necessary)|registration is not required|no need to register/i.test(description)) {
    return { status: 'not-required', label: 'No registration required (per description)', url: null };
  }
  if (/registration (is )?required|must register|pre-?registration|registration is (now )?open/i.test(description)) {
    return { status: 'required', label: 'Registration required (per description)', url };
  }
  if (ticketUrl) return { status: 'tickets', label: 'Ticket/booking link provided — see source', url };
  if (/regist|rsvp|sign up|tickets?/i.test(description)) {
    return { status: 'mentioned', label: 'Registration or tickets mentioned — check source', url };
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
export function titleSimilarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * Remove duplicate occurrences (same activity listed twice, possibly by two sources).
 * Two items are duplicates when they start at the same minute and their titles are similar
 * (>= 0.75 token overlap), or when they share an exact id. The richer item is kept and the other
 * source is recorded under `alsoListedBy`.
 */
export function dedupe(items) {
  const richness = (it) => (it.cost.status !== 'unknown') + (it.registration.status !== 'unknown') + !!it.location?.lat + (it.description?.length > 80) + (it.endKnown ? 1 : 0);
  const kept = [];
  const byId = new Map();
  let removed = 0;
  for (const it of items) {
    if (byId.has(it.id)) { removed++; continue; }
    const dup = kept.find((k) => k.kind !== 'place' && it.kind !== 'place' && k.start === it.start && titleSimilarity(k.title, it.title) >= 0.75);
    if (dup) {
      removed++;
      const [win, lose] = richness(it) > richness(dup) ? [it, dup] : [dup, it];
      win.alsoListedBy = [...(win.alsoListedBy || []), { sourceName: lose.sourceName, url: lose.sourceUrl }, ...(lose.alsoListedBy || [])];
      if (win !== dup) { kept[kept.indexOf(dup)] = win; byId.delete(dup.id); byId.set(win.id, win); }
      continue;
    }
    kept.push(it);
    byId.set(it.id, it);
  }
  return { items: kept, removed };
}
