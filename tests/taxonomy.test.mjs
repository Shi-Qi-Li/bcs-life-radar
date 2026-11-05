// Activity-type classification and City-calendar tagging/exclusions. The examples are the real items named in
// the 2026-11-05 data-quality audit (titles, descriptions and tags copied from the sources as stored in
// public/data/events.json); the ICS fixture holds real VEVENTs copied verbatim from the City feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, scoreTypes, stripVenues, TYPES } from '../public/js/shared/taxonomy.js';
import { itemsFromICS, classifyExclusion, splitTags, priceSentences, WEAK_TAG } from '../scripts/sources/cstx.mjs';
import { parseICS } from '../scripts/lib/ics.mjs';
import { startOfDay } from '../public/js/shared/time.js';

// Destination Bryan passes its categories as weak tags; the City adapter splits its tags with splitTags().
const bryan = (title, description, categories = ['Arts & Culture']) => ({ weakTags: categories, title, description });
const city = (title, description, tags) => { const { strong, weak } = splitTags(tags); return { tags: strong, weakTags: weak, title, description }; };

const CASES = [
  {
    name: 'Dragon Card Show → markets, not a performance',
    input: bryan('Dragon Card Show at the Bryan Ballroom',
      "Dragon Card Show is coming to Bryan/College Station, Texas! Join us for our debut show, featuring 60+ vendors bringing Pokémon, One Piece, Magic: The Gathering, Dragon Ball, and more. Whether you're a collector, a player, or just getting into the hobby, you'll find singles, slabs, sealed product, accessories, and more!\nThere will be giveaways for attendees throughout the event.\nFollow us on Instagram @dragoncardshow for updates.",
      ['Family-Friendly']),
    first: 'markets', has: ['markets'], not: ['shows'],
  },
  {
    name: 'Battle for Bryan (Smash Bros tournament at the Hilton Garden Inn) → social, not outdoors',
    input: bryan('Battle for Bryan at The Hilton Garden Inn',
      'Watch the "Battle for Bryan" tournament at the Hilton Garden Inn! Multiple teams with go head-to-head in this annual Super Smash Brothers competition. It\'s open to the public and free to watch.\nIf you want to participate, registration is open until November 5th at midnight. Click here to sign up and be part of the challenge!'),
    first: 'social', has: ['social'], not: ['outdoors'],
  },
  {
    name: 'Cards, Comics & Collectibles Expo → markets, not shows ("Collectibles Show", "a show built for collectors")',
    input: bryan('Cards, Comics, & Collectibles Expo at The Brazos Center',
      'Step into a show built for true collectors. Our Collectibles Show brings together an incredible mix of sports cards, Pokémon, comics, memorabilia, toys, gaming, vintage treasures, and hard-to-find collectibles all under one roof. Whether you’re chasing grails, hunting deals, trading with fellow collectors, or simply reliving the nostalgia of your favorite era, this is more than just a show — it’s a community experience.\nMeet passionate vendors from across the region, discover rare finds you won’t see anywhere else, and connect with collectors who share the same excitement and passion. From…',
      ['Fairs & Festivals']),
    first: 'markets', has: ['markets'], not: ['shows'],
  },
  {
    name: 'The Fall Pour at 6Whiskey (Lake Walk) → food + shows + markets, not outdoors',
    input: bryan('The Fall Pour at 6Whiskey',
      '6Whiskey is pouring a little extra fall spirit at 6Whiskey this season. Come spend the day with at Lake Walk for the second annual 6Whiskey Fall Pour, a cozy afternoon filled with cocktails, music, and kicking off the Fall season\nHere’s what to look forward to:\nCocktails by Sage Roots – seasonal sips crafted just for the day\nLive Music – the perfect soundtrack for shopping, sipping, and settling into the season\nSeasonal popup by a local artisan',
      ['Lake Walk']),
    exact: ['food', 'shows', 'markets'],
  },
  {
    name: 'Music Play (free music class for babies and caregivers) → family + learning',
    input: bryan("Music Play at St. Andrew's Episcopal Church",
      'Music Play with Ms. Patty is designed for children ages newborn to 5 years and their parents, grandparents, or caregivers. The class is free and open to the community every Friday at 9:30 a.m.\nA typical class included singing songs, keeping rhythm with music sticks, and twirling around with colorful scarves. These activities are a great reminder of the joy of singing, dancing, and playing music.\nFor your first class, RSVP by contacting Ms. Patty at pbcreel@gmail.com .'),
    has: ['family', 'learning'],
  },
  {
    name: 'Día de los Muertos street festival → community + family + shows',
    input: bryan('Día de los Muertos in Historic Downtown Bryan',
      "Celebrate Day of the Dead in Hisotric Downtown Bryan in front of Taco Crave, Burr's Unfinished Furniture and Itza Bip!\nBallet Folklorico\nCatrinas & Catrines contest\nCalaveritas\nMariachi\nKids activities\nAltars\nMusic\nLocal Vendors"),
    first: 'community', set: ['community', 'family', 'shows'],
  },
  {
    name: 'Texas Rails Symposium (day-long conference) → learning first, history keeps arts',
    input: bryan('Texas Rails 2026 Symposium at Kimbell Cultural Event Center',
      '​Learn about the history of the railroad at the Texas Rails 2026 Symposium, a day-long conference in Historic Downtown Bryan.\nPresenters Include\nKen Stavinoha: "Railroad Scenes from Texas: Images of Railroading in the Late 19th and Early 20th Centuries"\nDennis Hogan: "Along the Central: A Journey through Time and Place on the H&TC"\nKen Fitzgerald: "Winding Down a Paid Railroad Photographer Gig"\nBruce Blalock: "MKT Texas Central Branch: The Tin Can"\nThere will be time for lunch on your own from 12-1:30PM, with plenty of restaurants to choose from in Historic Downtown Bryan .\nThe night before…'),
    first: 'learning', has: ['learning', 'arts'],
  },
  {
    name: 'Slumber Party Coffee & Crafts → arts first',
    input: bryan('Slumber Party Coffee & Crafts at Sunbeam Bagels',
      'SLUMBER PARTY COFFEE & CRAFTS ⭐️😴💖\nSo excited to host another coffee & crafts with Sunbeam! This one is going to be extra fun. Not only are we wearing pjs and making friendship bracelets, but we get to sit in the newly added expansion of The Owl!!!\nTickets are live now on my website! 🎟️'),
    first: 'arts', has: ['arts'],
  },
  {
    name: 'D&D Boundless Blue Campaign (City tags Parks, Games, …) → social first, not outdoors',
    input: city('D&D Boundless Blue Campaign',
      'Set sail on a nautical adventure with D&D Boundless Blue Campaign, a beginner-friendly tabletop role-playing campaign where you can explore the golden age of piracy and adventure at the Gary Halter Nature Center.\nCreate your own character or use a premade one as you navigate the high seas. Materials, snacks and supplies are provided, and you can continue playing the same character across sessions or switch characters between dates. No previous D&D experience is required.\nThe program is for ages 13 and older. Admission is $5 for residents and $6 for non-residents per day. Registration is open…',
      ['Parks', 'Games', 'Registration Required', 'Youth', 'Paid', 'Family Friendly', 'Special Event', 'Adult (18+)', 'Program']),
    first: 'social', not: ['outdoors'],
  },
  {
    name: 'Yoga in the Park (Fitness, Nature tags) → fitness + outdoors still works',
    input: city('Yoga in the Park',
      'Start the morning with a free, peaceful yoga session for those 18 and older at the Meyer Senior and Community Center patio. This welcoming community class is open to all experience levels and includes guided breathing, gentle warmups, and variations of Sun Salutation A and B with helpful modifications.\nWhether new to yoga or a seasoned yogi, attendees can enjoy connecting with body, mind, and community. Yoga mats are available while supplies last. Dogs are not allowed.\nFor more information, contact the Meyer Senior and Community Center at 979.764.2670.',
      ['Adult (18+)', 'Fitness', 'Free', 'Nature', 'Parks', 'Senior (55+)', 'Program', 'Event']),
    first: 'fitness', has: ['fitness', 'outdoors'], not: ['family'],
  },
  {
    name: 'Latin Dance Social (indoors; "Parks" is only the department) → social, not outdoors',
    input: city('Latin Dance Social',
      'Put on your dancing shoes and enjoy an evening of Bachata and Salsa with the local dance community. Whether you’re a seasoned dancer or just starting out, the host will guide you on the floor and help you move to the rhythm. The dance is free and open to ages 18 and older.\nFor more information, contact the Southwood Community Center at 979.764.6351.',
      ['Adult (18+)', 'Dance', 'Free', 'Parks', 'Senior (55+)', 'Music', 'Program']),
    first: 'social', not: ['outdoors', 'family'],
  },
  {
    name: 'Hunger Games soundtrack listening party → shows + social',
    input: bryan('Hunger Games Early Listening Party at Curious Collections',
      "Looking to hear The Hunger Games: Sunrise on the Reaping soundtrack early in Aggieland? Head to Curious Collections at The Record Garage (3901 E 29th St, Bryan, TX) on Saturday, November 7, 2026, at 6:00 PM for an official early listening party—nearly a full week before the album's November 13 release date!\nGather with the Bryan/College Station and Texas A&M vinyl community to hear the full atmospheric soundtrack on our high-fidelity speakers, enjoy exclusive official event giveaways, and pre-order your copy on vinyl or CD. Admission is free, but advance RSVPs are requested as no day-of RSVPs…"),
    set: ['shows', 'social'],
  },
  {
    name: 'PVFA Faculty Showcase (performing arts) → shows first, arts kept',
    input: bryan('PVFA Monthly Faculty Showcase at The Kimbell',
      'Make The Kimbell part of your First Friday downtown. Each month, Texas A&M’s College of Performance, Visualization & Fine Arts brings a faculty showcase into our space, creating a chance to discover the creative work happening right here in our community.\nCome curious, bring a friend, and spend a little time with the arts. The featured faculty and format will change from month to month, giving you…'),
    first: 'shows', has: ['shows', 'arts'],
  },
  {
    name: 'Pints and Pages Book Fair → markets + arts (book fair and vendor market)',
    input: bryan('2nd Annual Pints and Pages Book Fair at KinderHill Brew Lab',
      'Do you remember the amazing Book Fairs of your youth? Well, KinderHill is partnering up with Hyperbole Bookstore and Voices For Children to bring back the good times! This is a book fair and vendor market.\nThey will be donating 10% of all beverage sales from this event to Voices For Children to help continue their work in our community. Come find your new favorite book!'),
    first: 'markets', has: ['markets', 'arts'],
  },
  {
    name: 'First Stitches: Sewing for Beginners (adult class tagged Family Friendly) → learning + arts, not family',
    input: city('First Stitches: Sewing for Beginners',
      'Learn the basics of sewing at First Stitches: Sewing for Beginners, a hands-on course led by SEWN by Sisters seamstress Nancy Johnson. The class covers threading a needle, using a sewing machine, understanding fabrics and completing simple projects. No experience is needed. Participants are encouraged to bring their own sewing machine, as access to available machines will be limited.\nThe class wil',
      ['Paid', 'Family Friendly', 'Registration Required', 'Adult (18+)', 'Senior (55+)', 'Event']),
    set: ['learning', 'arts'],
  },
  {
    name: 'Lick Creek Park in the Dark (Nature tag, camping, night hike) → outdoors first',
    input: city('Lick Creek Park in the Dark',
      "You don’t have to travel far to make lasting memories with friends and family. Spend the night camping at Lick Creek Park on Friday, Nov. 13. This family-friendly overnight event begins at 6 p.m. Friday and concludes at 7 a.m. Saturday.\nChoose your adventure or join us for favorites, such as a hot dog dinner, nature presentations, s'mores and a night hike. Learn camping basics and discover the noc",
      ['Family Friendly', 'Registration Required', 'Nature', 'Parks', 'Special Event', 'Paid', 'Event']),
    first: 'outdoors', has: ['outdoors', 'family'],
  },
];

for (const c of CASES) {
  test(`classify: ${c.name}`, () => {
    const types = classify(c.input);
    assert.ok(types.length >= 1 && types.length <= 3, `1–3 types, got ${JSON.stringify(types)}`);
    assert.ok(types.every((t) => TYPES.some((x) => x.id === t)), 'known type ids only');
    if (c.exact) assert.deepEqual(types, c.exact);
    if (c.set) assert.deepEqual([...types].sort(), [...c.set].sort());
    if (c.first) assert.equal(types[0], c.first, `first type of ${JSON.stringify(types)}`);
    for (const t of c.has || []) assert.ok(types.includes(t), `${t} missing from ${JSON.stringify(types)}`);
    for (const t of c.not || []) assert.ok(!types.includes(t), `${t} should not be in ${JSON.stringify(types)}`);
  });
}

test('venue names never create types; compound phrases in the title beat generic words', () => {
  assert.ok(!/garden/i.test(stripVenues('Battle for Bryan at The Hilton Garden Inn')));
  assert.ok(!/lake|expo|historic/i.test(stripVenues('Illuminate at Lake Walk, the Brazos County Expo Complex and Historic Downtown Bryan')));
  assert.deepEqual(classify({ title: 'Happy Hour at Lake Walk' }), ['food']);
  assert.deepEqual(classify({ title: 'Paint-a-Palooza at Great Escapes RV Park' }), ['arts']);
  // "card show" is a specific phrase (3) and "show" after card/trade/craft/gun/car/boat/home/rv/bridal is not a performance.
  const card = scoreTypes({ title: 'Dragon Card Show' });
  assert.equal(card.get('markets'), 3);
  assert.equal(card.get('shows'), undefined);
  for (const t of ['Trade Show', 'Craft Show', 'Gun Show', 'Car Show', 'Boat Show', 'Home Show', 'RV Show', 'Bridal Show']) assert.equal(scoreTypes({ title: t }).get('shows'), undefined, t);
  assert.equal(scoreTypes({ title: 'Puppet Show' }).get('shows'), 2);
  assert.equal(scoreTypes({ title: 'Trivia Night' }).get('social'), 3);
  assert.equal(scoreTypes({ title: 'Lake Walk Run Club' }).get('social'), 3);
  assert.equal(scoreTypes({ title: 'Open Mic Night at The Palace Theater' }).get('shows'), 3);
  // The venue after "at" is only a weak hint (1), so trivia at a brewery is social first.
  const trivia = scoreTypes({ title: 'Trivia At Blackwater Draw Brewing Co.' });
  assert.equal(trivia.get('social'), 2);
  assert.equal(trivia.get('food'), 1);
  assert.deepEqual(classify({ title: 'Trivia At Blackwater Draw Brewing Co.', description: 'Join in weekly trivia at Blackwater Brewing Co.!' }), ['social', 'food']);
});

test('tag weights: strong tags 3, each weak tag 1, admin/department tags create nothing', () => {
  assert.equal(scoreTypes({ tags: ['Nature'] }).get('outdoors'), 3);
  assert.equal(scoreTypes({ tags: ['Music', 'Movie'] }).get('shows'), 3, 'strong tags do not stack');
  assert.equal(scoreTypes({ weakTags: ['Family Friendly', 'Youth'] }).get('family'), 2);
  assert.equal(scoreTypes({ weakTags: ['Parks', 'Program', 'Event', 'Special Event', 'Free', 'Paid', 'Registration Required', 'Adult (18+)', 'Senior (55+)', 'Membership'] }).size, 0);
  assert.equal(scoreTypes({ weakTags: ['Lake Walk'] }).size, 0, 'a venue category is not outdoors');
  // Only a weak hint → still the single best guess (never an empty list when there is any evidence).
  assert.deepEqual(classify({ description: 'Bring a picnic.' }), ['outdoors']);
  assert.deepEqual(classify({ weakTags: ['Arts & Culture'], title: 'Untitled' }), ['arts']);
  assert.deepEqual(classify({ title: 'Untitled' }), []);
});

test('description evidence: one repeated generic word counts once; two distinct keywords or a phrase count 2; kids ages vs adult thresholds', () => {
  assert.equal(scoreTypes({ description: 'Step into a show built for true collectors. This is more than just a show.' }).get('shows'), 1);
  assert.equal(scoreTypes({ description: 'A cozy afternoon of cocktails and seasonal sips.' }).get('food'), 2);
  assert.equal(scoreTypes({ description: 'Ballet Folklorico\nMariachi\nKids activities' }).get('family'), 2, '"Kids activities" is an explicit audience statement');
  assert.equal(scoreTypes({ description: 'Designed for ages 7–12.' }).get('family'), 2);
  assert.equal(scoreTypes({ description: 'designed for children ages newborn to 5 years and their caregivers' }).get('family'), 2);
  assert.equal(scoreTypes({ description: 'This class is open to ages 16 and older.' }).get('family'), undefined);
  assert.equal(scoreTypes({ description: 'The dance is free and open to ages 18 and older.' }).get('family'), undefined);
  assert.equal(scoreTypes({ description: 'The class is free and open to the community every Friday.' }).get('learning'), 2, '"the class is free" says it is a class');
  assert.equal(scoreTypes({ description: 'The class will be held outdoors at the W.A. Tarrow Pavilion.' }).get('outdoors'), 2, 'an explicit "outdoors" counts 2');
});

// ---- City adapter: tag split, civic exclusions, cost fallback — on real VEVENTs copied verbatim from the feed.
const ICS = readFileSync(new URL('./fixtures/cstx-taxonomy-sample.ics', import.meta.url), 'utf8');
const WINDOW = { fromMs: startOfDay('2026-06-01'), toMs: startOfDay('2027-01-01'), fetchedAt: '2026-11-05T12:00:00.000Z' };

test('cstx splitTags: department/audience/admin tags are weak, descriptive tags are strong', () => {
  const { strong, weak } = splitTags(['History', 'Lecture', 'Food/Drinks', 'Paid', 'Free', 'Family Friendly', 'Special Event', 'Registration Required', 'Event']);
  assert.deepEqual(strong, ['History', 'Lecture', 'Food/Drinks']);
  assert.deepEqual(weak, ['Paid', 'Free', 'Family Friendly', 'Special Event', 'Registration Required', 'Event']);
  for (const t of ['Parks', 'Program', 'Event', 'Community Event', 'Adult (18+)', 'Senior (55+)', 'Youth', 'Membership']) assert.ok(WEAK_TAG.test(t), t);
  for (const t of ['Nature', 'Fitness', 'Dance', 'Music', 'Games', 'Books', 'Movie', 'Art', 'Holiday', 'Shop', 'Health', 'Sports']) assert.ok(!WEAK_TAG.test(t), t);
});

test('cstx civic/informational exclusion: Seminar Supper is excluded and counted; existing buckets are unchanged', () => {
  const { items, stats } = itemsFromICS(ICS, WINDOW);
  assert.equal(stats.feedEvents, 17);
  assert.equal(stats.excluded['civic/informational'], 2, 'both "Seminar Supper" and "Seminar Suppers - …"');
  assert.equal(stats.excluded['meeting/closure/notice'], 1, 'Harvey Road Community Scenarios Workshop (tag Informational) stays in its old bucket');
  assert.ok(!items.some((i) => /Seminar Supper/.test(i.title)));
  for (const ev of parseICS(ICS)) {
    const t = ev.SUMMARY[0].value;
    if (/^Seminar Supper/.test(t)) assert.equal(classifyExclusion(ev), 'civic/informational', t);
    if (/^Harvey Road/.test(t)) assert.equal(classifyExclusion(ev), 'meeting/closure/notice', t);
  }
  assert.equal(classifyExclusion({ SUMMARY: [{ value: 'Town Hall Meeting' }] }), 'civic/informational');
  assert.equal(classifyExclusion({ SUMMARY: [{ value: 'Budget Workshop' }], CATEGORIES: [{ value: 'Meeting' }] }), 'meeting/closure/notice', 'meeting category wins first');
  assert.equal(classifyExclusion({ SUMMARY: [{ value: 'Pottery Night' }], DESCRIPTION: [{ value: '<p>Open enrollment for benefits ends Friday.</p>' }] }), 'civic/informational', 'first 200 chars of the description');
  assert.equal(classifyExclusion({ SUMMARY: [{ value: 'Pottery Night' }], DESCRIPTION: [{ value: `<p>${'Clay and glazes provided. '.repeat(10)}Open enrollment for the spring league is separate.</p>` }] }), null, 'beyond 200 chars is ignored');
});

test('cstx types from the real feed: "Parks" alone never makes an item outdoors; Nature/Fitness tags still do', () => {
  const { items } = itemsFromICS(ICS, WINDOW);
  const by = (re) => items.find((i) => re.test(i.title));
  const dnd = by(/^D&D Boundless/);
  assert.equal(dnd.types[0], 'social');
  assert.ok(!dnd.types.includes('outdoors'));
  assert.ok(dnd.sourceTags.includes('Parks'), 'all source tags are still shown on the card');
  assert.ok(!by(/^Latin Dance Social/).types.includes('outdoors'));
  assert.ok(!by(/^Seniors Night Out/).types.includes('outdoors'));
  assert.equal(by(/^Veterans Day Ceremony/).types[0], 'community');
  assert.ok(!by(/^Veterans Day Ceremony/).types.includes('outdoors'));
  const yoga = by(/^Yoga in the Park/);
  assert.equal(yoga.types[0], 'fitness');
  assert.ok(yoga.types.includes('outdoors'));
  assert.equal(by(/^Lick Creek Park in the Dark/).types[0], 'outdoors');
  assert.deepEqual(by(/^First Stitches/).types.slice(0, 2).sort(), ['arts', 'learning']);
  assert.ok(!by(/^First Stitches/).types.includes('family'));
  assert.equal(by(/^Christmas in the Park/).types[0], 'community');
});

test('cstx cost: Free+Paid tags (or Paid without an amount) fall back to the description\'s own price sentences', () => {
  const { items } = itemsFromICS(ICS, WINDOW);
  const by = (re) => items.find((i) => re.test(i.title));
  const lunch = by(/^Exploring History Luncheon/);
  assert.deepEqual(lunch.sourceTags.filter((t) => /^(free|paid)$/i.test(t)).sort(), ['Free', 'Paid'], 'the feed really tags it both ways');
  assert.equal(lunch.cost.status, 'mixed');
  assert.match(lunch.cost.label, /^Attendance is free, with lunch available for \$10 for residents and \$12 for non-residents\..* \(per description\)$/);
  assert.ok(lunch.cost.min !== null && lunch.cost.min <= 10, 'lowest listed amount (0 once costFromText reads "attendance is free" as free entry)');
  const swim = by(/^Sensory-Friendly Swim Night/); // tag Paid, X-COST-TYPE free, no X-COST
  assert.equal(swim.cost.status, 'mixed');
  assert.equal(swim.cost.min, 4);
  assert.match(swim.cost.label, /^Admission is \$4 per person\. Ages 12 and under are free\. \(per description\)$/);
  // Paid without an amount and nothing priced in the description → still "amount not listed", nothing invented.
  assert.deepEqual(by(/^2026 TAAF Games/).cost, { status: 'paid', label: 'Paid — amount not listed', min: null });
  // An explicit X-COST always wins.
  assert.deepEqual(by(/^D&D Boundless/).cost, { status: 'paid', label: '$5', min: 5 });
  assert.equal(by(/^Food Truck Wednesday/).cost.label, 'Free (marked free in City calendar)');
  assert.equal(priceSentences('Take a break for lunch. Attendance is free, with lunch available for $10. Lunch reservations are required by Friday.\nReserve Your Lunch'), 'Attendance is free, with lunch available for $10.');
  assert.equal(priceSentences('No money talk here.'), '');
});
