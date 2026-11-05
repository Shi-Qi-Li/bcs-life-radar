// Neutral activity taxonomy. No type is weighted above another by default.
export const TYPES = [
  { id: 'outdoors', label: 'Outdoors & nature' },
  { id: 'arts', label: 'Arts, culture & history' },
  { id: 'shows', label: 'Music, film & shows' },
  { id: 'food', label: 'Food & drink' },
  { id: 'fitness', label: 'Fitness & sports' },
  { id: 'learning', label: 'Classes & talks' },
  { id: 'social', label: 'Games & social' },
  { id: 'family', label: 'Kids & family' },
  { id: 'community', label: 'Festivals & community' },
  { id: 'markets', label: 'Markets & shopping' },
];
export const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));

// Optional "mood" shortcuts map to sets of types. Purely user-driven.
export const MOODS = [
  { id: 'relaxed', label: 'Relaxed', types: ['outdoors', 'arts', 'shows', 'learning', 'markets'] },
  { id: 'active', label: 'Active', types: ['fitness', 'outdoors'] },
  { id: 'social', label: 'Social', types: ['social', 'food', 'community', 'shows'] },
  { id: 'curious', label: 'Curious', types: ['learning', 'arts', 'outdoors'] },
];

// Keyword rules: [typeId, regex]. Matched against source tags/categories + title + description.
const RULES = [
  ['outdoors', /\b(nature|outdoor|parks?|trail|hike|hiking|garden|bird(ing)?|star ?party|stargaz|lake|creek|butterfl|wildlife|fishing|kayak)\b/i],
  ['arts', /\b(arts?|culture|museum|exhibit(ion)?|history|historic|heritage|gallery|library|craft|painting|pottery|sip ?(and|&) ?paint)\b/i],
  ['shows', /\b(music|concert|live music|band|open mic|movie|film|theat(er|re)|show|performance|symphony|choir|comedy|dance recital|karaoke)\b/i],
  ['food', /\b(food|drinks?|culinary|dinner|brunch|lunch|tasting|wine|winery|brew(ery|ing)?|beer|coffee|taco|cook(ing)?|bbq|barbecue|pub)\b/i],
  ['fitness', /\b(fitness|run(ning)? club|\brun\b|5k|yoga|zumba|pickleball|tennis|golf|swim|aquatic|workout|exercise|sports?|cycling|bike ride|athletic|dance class|line dance|tai chi|walk(ing)? club)\b/i],
  ['learning', /\b(class(es)?|workshop|lecture|talk|seminar|course|lesson|training|learn|canning|book club|books|story ?time|tour)\b/i],
  ['social', /\b(games?|trivia|bingo|bunco|mahjong|board game|d&d|dungeons|karaoke|social|nightlife|college night|meetup|club)\b/i],
  ['family', /\b(family|families|kids?|children|youth|teens?|toddler|all ages|family-friendly)\b/i],
  ['community', /\b(festival|fair|celebration|parade|holiday|christmas|halloween|thanksgiving|veterans|first friday|community event|special event|day of the dead|fireworks|open house)\b/i],
  ['markets', /\b(market|farmers'? market|shopping|shop|vendors?|bazaar|sale|boutique)\b/i],
];

/**
 * Return up to 3 type ids. `tags` are trusted source tags (weight 3); `weakTags` are broad source
 * categories applied loosely by the publisher (weight 1). Only types scoring >= 2 are kept, so a
 * single passing keyword in a long description does not label an item; if nothing reaches 2, the
 * single best guess is kept.
 */
export function classify({ tags = [], weakTags = [], title = '', description = '' }) {
  const scores = new Map();
  const tagText = tags.join(' | ');
  const weakText = weakTags.join(' | ');
  for (const [id, re] of RULES) {
    let s = 0;
    if (re.test(tagText)) s += 3;
    if (re.test(weakText)) s += 1;
    if (re.test(title)) s += 2;
    if (re.test(description.slice(0, 600))) s += 1;
    if (s) scores.set(id, s);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const strong = ranked.filter(([, s]) => s >= 2);
  return (strong.length ? strong : ranked.slice(0, 1)).slice(0, 3).map(([id]) => id);
}
