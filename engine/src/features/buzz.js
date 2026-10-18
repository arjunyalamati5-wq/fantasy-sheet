import { getTrending } from '../sleeper.js';
import { getSubreddit, SUBREDDITS } from '../reddit.js';
import { buildMatcher } from '../mentions.js';

// "Buzz": the crowd's mood about a player, for the Model lab.
//
// This is a VIBE, NOT A PREDICTION. It never feeds a projection or the model;
// it is shown beside the model's number so you can see when the crowd and the
// model disagree.
//
// Inputs: Sleeper's trending adds/drops (48 h) and Reddit posts that mention
// the player (the cached community feeds, same name matcher as everywhere else).

const WINDOW_MS = 48 * 3600 * 1000;
const CACHE_MS = 15 * 60 * 1000;
const NEAR = 120; // characters either side of a mention that count as "near"

// The one place the sentiment words live. Whole words / short phrases, lower case.
export const POSITIVE_WORDS = [
  'breakout', 'smash', 'start', 'league winner', 'must add', 'buy', 'ceiling',
  'beast', 'elite', 'healthy', 'returns',
];
export const NEGATIVE_WORDS = [
  'bust', 'sit', 'drop', 'injured', 'limited', 'out', 'concern', 'avoid',
  'sell', 'benched', 'fade',
];

const wordRe = (words) => new RegExp(`\\b(?:${words.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`, 'g');
const POS_RE = wordRe(POSITIVE_WORDS);
const NEG_RE = wordRe(NEGATIVE_WORDS);

/** Count positive and negative keywords in a piece of text. */
export function tallySentiment(text) {
  const s = String(text || '').toLowerCase();
  return { positive: (s.match(POS_RE) || []).length, negative: (s.match(NEG_RE) || []).length };
}

/** The slice of a post around where the player is named, else the whole post. */
export function nearMention(text, player) {
  const s = String(text || '');
  const low = s.toLowerCase();
  const name = String(player?.name || '').toLowerCase().trim();
  const last = name.split(/\s+/).pop();
  const at = [name, last].filter(Boolean).map((n) => low.indexOf(n)).find((i) => i >= 0);
  if (at == null) return s;
  return s.slice(Math.max(0, at - NEAR), at + NEAR);
}

/**
 * score = netAdds term + sentiment term, clamped to -3..+3.
 *   net = adds - drops
 *   netTerm  = sign(net) * max(0, log10(1 + |net|) - 1.5)
 *              (about 0 under 30 net adds, 1.0 at ~300, 1.5 at 1,000, 2.5 at 10,000)
 *   sentTerm = 0.5 * (positivePosts - negativePosts) / (positivePosts + negativePosts + 1)
 *              (at most +/-0.5, so Reddit alone can never make a player Hot or Cold)
 * label: Hot when score >= 1, Cold when score <= -1, otherwise Quiet.
 */
export function scoreBuzz({ adds = 0, drops = 0, positive = 0, negative = 0 }) {
  const net = adds - drops;
  const netTerm = Math.sign(net) * Math.max(0, Math.log10(1 + Math.abs(net)) - 1.5);
  const sentTerm = (0.5 * (positive - negative)) / (positive + negative + 1);
  const raw = Math.max(-3, Math.min(3, netTerm + sentTerm));
  const score = Math.round(raw * 100) / 100;
  const label = score >= 1 ? 'Hot' : score <= -1 ? 'Cold' : 'Quiet';
  return { score, label };
}

/**
 * Pure assembly, so it can be tested with synthetic inputs.
 * trending: { add: [{player_id,count}]|null, drop: [...]|null }
 * posts: [{ title, excerpt, published }] already from available feeds, or null when Reddit is down
 */
export function buildBuzz({ trending, posts, matchPlayers, now = Date.now() }) {
  const sleeperUp = Array.isArray(trending?.add) || Array.isArray(trending?.drop);
  const available = { sleeper: sleeperUp, reddit: Array.isArray(posts) };
  const out = {};
  const slot = (id) => (out[id] ||= { adds: 0, drops: 0, mentions: 0, positive: 0, negative: 0 });

  for (const r of trending?.add || []) slot(String(r.player_id)).adds += Number(r.count) || 0;
  for (const r of trending?.drop || []) slot(String(r.player_id)).drops += Number(r.count) || 0;

  const match = buildMatcher(matchPlayers || []);
  for (const post of posts || []) {
    const t = Date.parse(post.published);
    if (Number.isFinite(t) && now - t > WINDOW_MS) continue;
    const body = /^submitted by\s/i.test(post.excerpt || '') ? '' : (post.excerpt || '');
    const text = `${post.title || ''}. ${body}`;
    for (const p of match(text)) {
      const s = slot(String(p.player_id));
      s.mentions += 1;
      const { positive, negative } = tallySentiment(nearMention(text, p));
      if (positive > negative) s.positive += 1;
      else if (negative > positive) s.negative += 1;
    }
  }

  for (const id of Object.keys(out)) {
    const s = out[id];
    if (!s.adds && !s.drops && !s.mentions) { delete out[id]; continue; }
    Object.assign(s, scoreBuzz(s));
  }
  return { available, players: out };
}

let cache = null; // { key, at, value }

export async function buzzReport(ctx) {
  const key = String(ctx.league?.league_id ?? '');
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

  const [add, drop, feeds] = await Promise.all([
    getTrending('add', { lookbackHours: 48, limit: 200 }).catch(() => null),
    getTrending('drop', { lookbackHours: 48, limit: 200 }).catch(() => null),
    Promise.all(SUBREDDITS.map((s) => getSubreddit(s.id, { sort: 'hot', limit: 25 }).catch(() => ({ available: false, posts: [] })))),
  ]);
  const up = feeds.filter((f) => f.available);
  const posts = up.length ? up.flatMap((f) => f.posts || []) : null;
  const pool = [...(ctx.candidateIds || [])].map((id) => ctx.playerOf(id)).filter(Boolean);

  const value = buildBuzz({ trending: { add, drop }, posts, matchPlayers: pool });
  cache = { key, at: Date.now(), value };
  return value;
}
