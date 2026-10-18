import { getNews } from '../espn.js';
import { displayTeam } from '../teams.js';
import { buildMatcher } from '../mentions.js';
import { sourceTier } from '../credibility.js';

/**
 * League news, with the stories that touch your roster pulled to the top.
 * ESPN tags each story with athletes and teams; we match those against the
 * players you actually hold, because that is the only reason to read it.
 */
export async function newsReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const { available, articles } = await getNews({ limit: 50 });
  if (!available) {
    return {
      articles: [], available: false,
      emptyMessage: 'The news feed is unreachable right now. Everything else on this page still works.',
    };
  }

  const mine = new Set((ctx.rosterOf(rosterId)?.players) || []);
  const matches = buildMatcher([...mine].map((id) => ctx.playerOf(id)).filter(Boolean));
  const myTeams = new Set([...mine].map((id) => ctx.playerOf(id)?.team).filter(Boolean));

  const rows = articles.map((a) => {
    const matched = matches(`${a.headline} ${a.description} ${a.tags.join(' ')}`)
      .map((p) => ({ player_id: p.player_id, name: p.name, position: p.position, team: displayTeam(p.team) }));
    return {
      ...a,
      mentionsMyPlayers: matched,
      aboutMyTeams: [...myTeams].filter((t) => a.tags.some((g) => g.includes(t))),
      credibility: sourceTier(a.link),
    };
  });

  rows.sort((a, b) => b.mentionsMyPlayers.length - a.mentionsMyPlayers.length
    || String(b.published).localeCompare(String(a.published)));

  return {
    available: true,
    articles: rows,
    aboutMyRoster: rows.filter((r) => r.mentionsMyPlayers.length > 0),
    note: 'Stories mentioning a player you hold are listed first. Nothing here feeds the numbers — the projections and rankings are computed from stats, not headlines.',
  };
}
