import { displayTeam } from '../teams.js';
import { round2 } from '../scoring.js';

/**
 * The week's betting board, from the Vegas lines in the nflverse schedule.
 * The useful derived number is the implied team total: the points each side is
 * expected to score, which is what actually drives fantasy scoring.
 *
 *   implied home = total/2 + spread/2      (spread_line is home-relative)
 *   implied away = total/2 - spread/2
 */
export function bettingReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  if (!ctx.schedule.available) {
    return {
      games: [], available: false,
      emptyMessage: 'The NFL schedule file could not be loaded, so there are no lines to show.',
    };
  }

  const mine = new Set((ctx.rosterOf(rosterId)?.players) || []);
  const myTeams = new Map();
  for (const id of mine) {
    const p = ctx.playerOf(id);
    if (!p?.team) continue;
    if (!myTeams.has(p.team)) myTeams.set(p.team, []);
    myTeams.get(p.team).push({ name: p.name, position: p.position });
  }

  const games = ctx.schedule.games
    .filter((g) => g.week === ctx.week)
    .map((g) => {
      const total = g.totalLine;
      const spread = g.spreadLine; // positive = home favoured
      const impliedHome = total != null && spread != null ? round2(total / 2 + spread / 2) : null;
      const impliedAway = total != null && spread != null ? round2(total / 2 - spread / 2) : null;

      return {
        gameId: g.gameId,
        kickoff: g.gameday,
        weekday: g.weekday,
        home: displayTeam(g.home),
        away: displayTeam(g.away),
        total,
        spread,
        favourite: spread == null ? null : (spread > 0 ? displayTeam(g.home) : displayTeam(g.away)),
        favouriteBy: spread == null ? null : Math.abs(spread),
        impliedHome,
        impliedAway,
        roof: g.roof,
        divGame: g.divGame,
        myPlayers: [
          ...(myTeams.get(g.home) || []).map((p) => ({ ...p, team: displayTeam(g.home) })),
          ...(myTeams.get(g.away) || []).map((p) => ({ ...p, team: displayTeam(g.away) })),
        ],
        readout: readout(total, impliedHome, impliedAway, displayTeam(g.home), displayTeam(g.away)),
      };
    })
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  const withLines = games.filter((g) => g.total != null).length;

  return {
    available: true,
    week: ctx.week,
    games,
    withLines,
    emptyMessage: withLines === 0
      ? 'Vegas has not posted lines for this week yet. They usually appear on the Sunday before.'
      : null,
    note: 'Implied team total is how many points Vegas expects each side to score on its own. It is the single most useful betting number for fantasy: a player in a game where his team is expected to score 27 has more chances than one whose team is expected to score 17.',
  };
}

function readout(total, home, away, homeName, awayName) {
  if (total == null || home == null) return null;
  const hi = home >= away ? homeName : awayName;
  const hiVal = Math.max(home, away);
  const lo = home >= away ? awayName : homeName;
  const loVal = Math.min(home, away);
  return `${total} points expected in total: about ${hiVal} for ${hi} and ${loVal} for ${lo}.`;
}
