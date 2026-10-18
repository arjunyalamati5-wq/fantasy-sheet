import { getNews } from '../espn.js';
import { getSubreddit, SUBREDDITS } from '../reddit.js';
import { buildMatcher } from '../mentions.js';
import { sourceTier, redditTier } from '../credibility.js';

// The latest stories about ONE player, for the Model lab's "why" panel.
// Reuses the cached ESPN news and Reddit feeds and the roster name matcher;
// nothing here is a new source, and nothing feeds a prediction.

const COACHY = /\b(coach|coordinator|said|says|according to|told reporters)\b/i;
const QUOTE = /[“"]([^“”"]{20,})[”"]/g;

/** A quoted sentence near a coach-like word, trimmed to 240 chars, else null. */
export function coachQuote(text) {
  const s = String(text || '');
  for (const m of s.matchAll(QUOTE)) {
    const from = Math.max(0, m.index - 200);
    const to = Math.min(s.length, m.index + m[0].length + 200);
    const near = s.slice(from, m.index) + ' ' + s.slice(m.index + m[0].length, to);
    if (COACHY.test(near)) {
      const q = m[1].trim();
      return q.length > 240 ? `${q.slice(0, 239).trimEnd()}…` : q;
    }
  }
  return null;
}

export async function playerNewsReport(ctx, playerId, { limit = 5 } = {}) {
  const player = ctx.playerOf(playerId);
  if (!player) return { items: [] };
  const matches = buildMatcher([player]);
  const items = [];

  const { available, articles } = await getNews({ limit: 50 });
  if (available) {
    for (const a of articles) {
      const text = `${a.headline} ${a.description} ${a.tags.join(' ')}`;
      if (!matches(text).length) continue;
      items.push({
        title: a.headline, url: a.link, published: a.published, source: 'ESPN',
        credibility: sourceTier(a.link), quote: coachQuote(`${a.description}`),
      });
    }
  }

  const feeds = await Promise.all(SUBREDDITS.map(async (s) => ({
    ...s, ...(await getSubreddit(s.id, { sort: 'hot', limit: 25 }).catch(() => ({ available: false, posts: [] }))),
  })));
  for (const feed of feeds) {
    if (!feed.available) continue;
    for (const post of feed.posts) {
      const body = /^submitted by\s/i.test(post.excerpt || '') ? '' : (post.excerpt || '');
      if (!matches(`${post.title} ${body}`).length) continue;
      items.push({
        title: post.title, url: post.url, published: post.published,
        source: `r/${post.subreddit}`, credibility: redditTier(post.url, post.linkUrl),
        quote: coachQuote(body),
      });
    }
  }

  items.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  return { items: items.slice(0, limit) };
}
