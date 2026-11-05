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

// Venue and district names whose words look like activity types (Lake, Garden, Park, Expo,
// Historic…) but say nothing about what happens there. They are removed from titles, descriptions
// and tags before matching, so a venue name never creates a type.
export const VENUE_STOP_LIST = [
  'lake walk(?: (?:pavilion|town center))?',
  'hilton garden inn',
  'great escapes rv park',
  'brazos center',
  'brazos county expo(?: complex)?',
  'historic downtown(?: bryan)?',
  'kimbell cultural event center',
];
const VENUE_RE = new RegExp(`\\b(?:${VENUE_STOP_LIST.join('|')})\\b`, 'gi');
export const stripVenues = (s) => String(s || '').replace(VENUE_RE, ' ');

/**
 * Keyword rules. `phrases` are specific compound phrases that name the activity ("card show",
 * "listening party", "run club"); `words` are generic single keywords. Both are matched as whole
 * words, case-insensitively. Phrases are listed first so they win over a generic word at the same
 * position ("trivia night" before "trivia").
 */
const rule = (id, phrases, words) => ({
  id,
  phrases: phrases.length ? new RegExp(`\\b(?:${phrases.join('|')})\\b`, 'i') : null,
  all: new RegExp(`\\b(?:${[...phrases, ...words].join('|')})\\b`, 'gi'),
});

// "show" is a performance only when it is not a card/trade/craft/gun/car/boat/home/RV/bridal/art… show.
const PERFORMANCE_SHOW = '(?<!(?:card|trade|craft|gun|cars?|boat|home|rv|bridal|art|antique|quilt|collectibles?|fashion|dog)\\s+)shows?';
// Kids' age ranges ("ages 7–12", "age 5", "ages 3 to 5") but not adult thresholds ("ages 16 and older", "ages 18+").
const KID_AGES = 'ages? (?:[0-9]|1[0-7])(?!\\d)(?:\\s*(?:–|-|to|through)\\s*\\d+)?(?!\\s*(?:and|&|or)\\s*(?:older|up|above|over))';

export const RULES = [
  rule('outdoors',
    ['night hike', 'star party', 'nature walk', 'bird walk', 'outdoors?', 'open[- ]air', 'under the stars'],
    ['(?:in|at) the park', 'nature', 'trails?', 'hikes?', 'hiking', 'gardens?(?!\\s+inn)', 'gardening', 'bird(?:ing|s)?', 'stargaz\\w*', 'astronomy', 'lakes?(?!\\s+walk)', 'creek', 'river', 'pond',
      'butterfl\\w*', 'wildlife', 'wildflowers?', 'fishing', 'kayak(?:ing|s)?', 'canoe(?:ing)?', 'camping', 'campout', 'campfire', 'picnic']),
  rule('arts',
    ['sip (?:and|&|n) paint', 'paint (?:and|&|n) sip', 'art (?:walk|show|exhibit(?:ion)?|market|demonstrations?|class(?:es)?|studio)', 'open studio'],
    ['arts?', 'artists?', 'artwork', 'culture', 'cultural', 'museums?', 'exhibits?', 'exhibitions?', 'history', 'historic(?:al)?', 'heritage', 'gallery', 'galleries',
      'library', 'libraries', 'crafts?', 'crafting', 'diy', 'paint(?!ball)', 'painting', 'pottery', 'ceramics', 'sewing', 'knit(?:ting)?', 'crochet', 'quilt(?:ing|s)?',
      'jewelry', 'bracelets?', 'sculpture', 'photography', 'poetry', 'murals?', 'books?', 'authors?', 'glassblowing']),
  rule('shows',
    ['live music', 'open mic', 'listening party', 'performing arts', 'dance recital', 'movie night', 'film screening', 'comedy night', 'live band', 'album release', 'record release'],
    ['music', 'musical', 'musicians?', 'concerts?', 'bands?', 'movies?', 'films?', 'screening', 'cinema', 'documentary', 'theat(?:er|re|rical)', PERFORMANCE_SHOW, 'showcase',
      'recitals?', 'performances?', 'performers?', 'symphony', 'orchestra', 'choir', 'chorus', 'comedy', 'comedians?', 'stand-?up', 'improv', 'karaoke', 'mariachi',
      'folklorico', 'dj', 'soundtrack', 'album', 'vinyl', 'ballet', 'opera', 'jazz', 'blues', 'singers?', 'sing-along']),
  rule('food',
    ['happy hour', 'food trucks?', 'wine tasting', 'beer tasting', 'farm to table', 'potluck', 'bake sale'],
    ['foods?', 'drinks?', 'beverages?', 'culinary', 'dinner', 'supper', 'brunch', 'lunch(?:eon|time)?', 'breakfast', 'tasting', 'wines?', 'winery', 'brew(?:ery|eries|ing|s)?',
      'beers?', 'coffee', 'tacos?', 'cook(?:ing|off|out)?', 'bbq', 'barbecue', 'pub', 'cocktails?', 'spirits', 'whiske?y', 'bourbon', 'sips?', 'sipping', 'pour(?:ing)?',
      'bagels?', 'pints?', 'pizza', 'burgers?', 'desserts?', 'bakery', 'baking', 'cider', 'mead', 'margaritas?', 'refreshments']),
  rule('fitness',
    ['run(?:ning)? club', 'walk(?:ing)? club', 'bike ride', 'dance class(?:es)?', 'line danc(?:e|ing)', 'tai chi', 'color run', 'fun run', 'open gym', 'boot ?camp', 'martial arts', 'water aerobics', 'disc golf'],
    ['fitness', 'run', 'running', 'runners?', '5k', '10k', 'marathon', 'yoga', 'zumba', 'pilates', 'pickleball', 'tennis', 'golf', 'swim(?:ming)?', 'aquatics?', 'workout',
      'exercise', 'sports?', 'cycling', 'biking', 'athletic', 'athletes?', 'basketball', 'soccer', 'volleyball', 'softball', 'baseball', 'football', 'skating', 'climbing',
      'karate', 'boxing', 'cardio', 'stretch(?:ing)?', 'health', 'wellness', 'archery']),
  rule('learning',
    ['book club', 'story ?time', 'how[- ]to', 'hands[- ]on', 'author talk', 'guided tour', 'lunch (?:and|&) learn', 'q ?& ?a', 'panel discussion',
      'class(?:es)? (?:is|are|will be) (?:free|held|open|designed|offered|taught|led)'],
    ['class(?:es)?', 'workshops?', 'lectures?', 'talks?', 'seminars?', 'symposium', 'conference', 'presenters?', 'presentations?', 'courses?', 'lessons?', 'training',
      'learn(?:ing)?', 'canning', 'books?', 'tours?', 'beginners?', 'refresher', 'demonstrations?', 'tutorial', 'instruction', 'instructors?', 'teachers?', 'educational?', 'discussion']),
  rule('social',
    ['game night', 'trivia night', 'board games?', 'video ?games?', 'smash bro(?:s|thers)', 'college night', 'run club', 'listening party', 'role[- ]?playing', 'laser tag',
      'speed dating', '(?:bar|pub) crawl', 'dance (?:social|party|night)', 'social danc(?:e|ing)', 'card games?', 'tabletop games?'],
    ['games?', 'gaming', 'trivia', 'bingo', 'bunco', 'mahjong', 'd&d', 'dnd', 'dungeons', 'tabletop', 'karaoke', 'socials?', 'socializ\\w*', 'nightlife', 'meetups?', 'club',
      'tournaments?', 'esports', 'competitions?', 'paintball', 'gellyball', 'arcade', 'salsa', 'bachata', 'dominoes', 'poker', 'chess', 'puzzles?', '(?<!(?:star|third)[- ])party']),
  rule('family',
    ['family[- ]friendly', 'kid[- ]friendly', 'all ages', "kids'? (?:activities|zone|area|crafts?|corner|games|club)", "children'?s (?:activities|area|museum|programs?)",
      'little ones', KID_AGES, 'ages? [a-z]+ to \\d+', 'for (?:kids|children|families|the whole family)', 'grades? (?:k|\\d+)', 'pre-?k'],
    ['family', 'families', 'kids?', 'kiddos', 'children', "children's", 'child', 'youth', 'teens?', 'teenagers?', 'toddlers?', 'newborns?', 'babies', 'baby', 'infants?',
      'preschool(?:ers)?', 'caregivers?', 'parents?', 'grandparents?', 'santa', 'playground', 'puppets?']),
  rule('community',
    ['first friday', 'community event', 'day of the dead', 'd[ií]a de (?:los )?muertos', 'block party', 'street party', 'open house', 'tree lighting', 'fourth of july', '4th of july',
      "new year'?s", 'memorial day', 'veterans day', 'labor day'],
    ['festivals?', '\\w*fests?', 'fairs?', 'celebrat(?:e|es|ed|ion|ions|ing)', 'parades?', 'holidays?', 'christmas', 'halloween', 'thanksgiving', 'easter', 'juneteenth', 'veterans?',
      'fiesta', 'fireworks', 'anniversary', 'ceremony', 'ceremonies', 'carnival', 'homecoming', 'tributes?', 'gala', 'fundraiser', 'volunteer(?:s|ing)?']),
  rule('markets',
    ['card show', 'trading cards?', "farmers'? markets?", 'book fair', 'trade show', 'swap meet', 'comic con', 'craft (?:fair|market|show)', 'art market', 'holiday market',
      'flea market', 'night market', 'pop-?up (?:market|shop|event)', 'vendor market', 'garage sale', 'bake sale', 'book sale', 'collectibles? (?:show|expo)'],
    ['markets?', 'shopping', 'shops?', 'vendors?', 'bazaar', 'sales?', 'boutique', 'collectibles?', 'collectors?', 'comics?', 'expo', 'artisans?', 'pop-?ups?', 'makers?',
      'merchandise', 'booths?']),
];

/** Number of distinct keywords matched (plural/singular count once), so one repeated generic word is not evidence. */
const count = (re, text) => (text ? new Set((text.match(re) || []).map((m) => m.toLowerCase().replace(/s$/, ''))).size : 0);

/** "Trivia At Blackwater Draw Brewing Co." → ["Trivia", "Blackwater Draw Brewing Co."]; the venue after "at" is a weaker hint. */
function splitVenue(title) {
  const m = /^(.*\S)\s+(?:at|At|AT|@)\s+((?:[Tt]he\s+)?[A-Z0-9“"'].*)$/.exec(title);
  return m ? [m[1], m[2]] : [title, ''];
}

/**
 * Score every type. Evidence and weights:
 *  - a strong source tag matches: +3 (`tags` are descriptive tags the publisher applies deliberately);
 *  - each weak tag that matches: +1 (`weakTags` are department, audience or catch-all labels);
 *  - the title: +3 for a specific compound phrase, +2 for a generic keyword in the activity part,
 *    +1 when only the venue after "at …" matches;
 *  - the description (first 600 chars): +2 for a compound phrase or two or more distinct keywords,
 *    +1 for a single keyword (however often it is repeated).
 * Venue names on VENUE_STOP_LIST are removed first.
 */
export function scoreTypes({ tags = [], weakTags = [], title = '', description = '' }) {
  const strongText = stripVenues(tags.join(' | '));
  const weak = weakTags.map((t) => stripVenues(t));
  const fullTitle = stripVenues(title);
  const [activity, venue] = splitVenue(fullTitle);
  const desc = stripVenues(String(description || '').slice(0, 600));
  const scores = new Map();
  for (const r of RULES) {
    let s = 0;
    if (count(r.all, strongText)) s += 3;
    for (const w of weak) if (count(r.all, w)) s += 1;
    if (r.phrases?.test(fullTitle)) s += 3;
    else if (count(r.all, activity)) s += 2;
    else if (count(r.all, venue)) s += 1;
    const mentions = count(r.all, desc);
    if (mentions) s += mentions >= 2 || r.phrases?.test(desc) ? 2 : 1;
    if (s) scores.set(r.id, s);
  }
  return scores;
}

/**
 * Return up to 3 type ids, best first. Only types scoring >= 2 are kept, so a single passing keyword
 * in a long description does not label an item; if nothing reaches 2, the single best guess is kept.
 * Ties keep the TYPES order.
 */
export function classify(input) {
  const ranked = [...scoreTypes(input).entries()].sort((a, b) => b[1] - a[1]);
  const strong = ranked.filter(([, s]) => s >= 2);
  return (strong.length ? strong : ranked.slice(0, 1)).slice(0, 3).map(([id]) => id);
}
