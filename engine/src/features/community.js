import { getSubreddit, SUBREDDITS } from '../reddit.js';
import { displayTeam } from '../teams.js';
import { buildMatcher } from '../mentions.js';
import { redditTier } from '../credibility.js';

// What the fantasy community is talking about, with anything touching your
// roster pulled to the top.
//
// This is comment from strangers on the internet. It is shown as chatter and
// nothing more: it never feeds a projection, a ranking or a recommendation.

/** Link posts carry only Reddit's own boilerplate as a body. */
const BOILERPLATE = /^submitted by\s+\/u\/\S+\s*(\[link\])?\s*(\[comments\])?$/i;

export async function communityReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const feeds = await Promise.all(
    SUBREDDITS.map(async (s) => ({ ...s, ...(await getSubreddit(s.id, { sort: 'hot', limit: 25 })) }))
  );

  const available = feeds.some((f) => f.available);
  if (!available) {
    return {
      available: false, posts: [], subreddits: SUBREDDITS,
      emptyMessage: 'Reddit is rate-limiting this app at the moment — it allows only a couple of anonymous requests at a time. It usually clears within a few minutes; nothing else on this page is affected.',
    };
  }

  const mine = new Set((ctx.rosterOf(rosterId)?.players) || []);
  const matches = buildMatcher([...mine].map((id) => ctx.playerOf(id)).filter(Boolean));

  const posts = [];
  for (const feed of feeds) {
    for (const post of feed.posts) {
      const body = BOILERPLATE.test(post.excerpt) ? '' : post.excerpt;
      const mentions = matches(`${post.title} ${body}`).map((p) => ({
        player_id: p.player_id, name: p.name,
        position: p.position, team: displayTeam(p.team),
      }));

      posts.push({
        title: post.title,
        author: post.author,
        url: post.url,
        published: post.published,
        subreddit: post.subreddit,
        excerpt: body,
        mentionsMyPlayers: mentions,
        linkUrl: post.linkUrl,
        credibility: redditTier(post.url, post.linkUrl),
      });
    }
  }

  posts.sort((a, b) => b.mentionsMyPlayers.length - a.mentionsMyPlayers.length
    || String(b.published).localeCompare(String(a.published)));

  return {
    available: true,
    posts,
    aboutMyRoster: posts.filter((p) => p.mentionsMyPlayers.length > 0),
    subreddits: feeds.filter((f) => f.available).map((f) => f.label),
    note: 'Discussion from the fantasy football subreddits, with posts mentioning one of your players first. This is other managers\' opinion, not analysis — none of it feeds the projections, rankings or trade grades anywhere else in this app.',
  };
}
