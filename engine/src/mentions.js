// Matching free text against a roster. Surnames alone are too blunt: a post
// about Kyren Williams should not tag Kyle Williams, and "Washington" is a
// team as often as it is a player.

/** NFL place and team words that collide with common surnames. */
const TEAM_WORDS = new Set([
  'washington', 'houston', 'jackson', 'carolina', 'buffalo', 'denver', 'dallas',
  'miami', 'cleveland', 'chicago', 'detroit', 'green', 'bay', 'york', 'jets',
  'giants', 'eagles', 'bears', 'lions', 'packers', 'vikings', 'falcons',
  'panthers', 'saints', 'buccaneers', 'cardinals', 'rams', 'niners', 'seahawks',
  'cowboys', 'commanders', 'bills', 'dolphins', 'patriots', 'ravens', 'bengals',
  'browns', 'steelers', 'colts', 'jaguars', 'titans', 'broncos', 'chiefs',
  'raiders', 'chargers', 'phoenix', 'baltimore', 'kansas', 'city', 'angeles',
  'francisco', 'england', 'orleans', 'tampa', 'vegas', 'seattle', 'atlanta',
  'arizona', 'indianapolis', 'philadelphia', 'pittsburgh', 'cincinnati',
  'minnesota', 'tennessee', 'jacksonville', 'love', 'brown', 'smith', 'allen',
]);

/**
 * Words that may legitimately sit in front of a surname. Anything else that
 * looks like a name probably IS a name — "Travis Etienne" is not Trevor.
 */
const HARMLESS_BEFORE = new Set([
  '', 'the', 'a', 'an', 'and', 'or', 'but', 'is', 'was', 'are', 'be',
  'for', 'with', 'on', 'in', 'at', 'to', 'of', 'from', 'about', 'over',
  'start', 'sit', 'bench', 'drop', 'add', 'trade', 'start/sit', 'keep', 'cut',
  'if', 'should', 'would', 'will', 'can', 'did', 'does', 'has', 'have', 'had',
  'my', 'your', 'his', 'their', 'our', 'that', 'this', 'it', 'he', 'they',
  'how', 'why', 'what', 'when', 'who', 'vs', 'versus', 'than', 'like',
  'rb', 'wr', 'te', 'qb', 'k', 'def', 'dst', 'flex',
]);

/**
 * Build a matcher for one roster.
 * A surname only counts when it is unique on the roster and is not a team word.
 */
export function buildMatcher(players) {
  const entries = [];
  const surnameCount = new Map();

  for (const p of players) {
    if (!p?.name) continue;
    const full = p.name.toLowerCase().trim();
    const parts = full.split(/\s+/);
    const last = parts[parts.length - 1].replace(/[^a-z]/g, '');
    surnameCount.set(last, (surnameCount.get(last) || 0) + 1);
    entries.push({ player: p, full, last, first: parts[0] });
  }

  for (const e of entries) {
    e.surnameUsable = surnameCount.get(e.last) === 1
      && e.last.length > 4
      && !TEAM_WORDS.has(e.last);
  }

  /** @returns {Array} the players this text mentions */
  return function match(text) {
    const hay = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
    const hits = [];
    for (const e of entries) {
      // Whole-word full name is always good enough.
      if (hay.includes(` ${e.full} `)) { hits.push(e.player); continue; }
      // First initial plus surname, e.g. "K. Williams".
      if (hay.includes(` ${e.first[0]} ${e.last} `)) { hits.push(e.player); continue; }
      // Bare surname only when it cannot be confused with a team-mate or a team,
      // and only when the word in front of it is not somebody else's first name.
      if (e.surnameUsable) {
        const at = hay.indexOf(` ${e.last} `);
        if (at >= 0) {
          const before = hay.slice(0, at).trim().split(' ').pop() || '';
          if (HARMLESS_BEFORE.has(before) || /[0-9]/.test(before)) hits.push(e.player);
        }
      }
    }
    return hits;
  };
}
