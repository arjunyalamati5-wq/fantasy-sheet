import { describe } from './lineup.js';
import { positionReplacementRank } from '../value.js';
import { slotDemand } from '../lineup.js';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/**
 * Rest-of-season rankings in this league's scoring, by position and overall.
 * Ranked on value over replacement rather than raw points, because a 15-point
 * QB and a 15-point TE are not worth the same when replacement level differs.
 */
export function rosRankings(ctx, { position = null, limit = 60, freeAgentsOnly = false } = {}) {
  // Only rank positions this league actually starts, counting flex eligibility.
  const demand = slotDemand(ctx.slots);
  const wanted = (position ? [position] : POSITIONS).filter((p) => demand[p]);
  const groups = {};

  for (const pos of wanted) {
    const rows = ctx.valuations.rows
      .filter((r) => r.position === pos)
      .filter((r) => !freeAgentsOnly || !ctx.ownerOf.has(r.player_id))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit)
      .map((r, i) => {
        const p = ctx.playerOf(r.player_id);
        const owner = ctx.ownerOf.get(r.player_id);
        const ownerRoster = owner ? ctx.rosterOf(owner) : null;
        return {
          rank: i + 1,
          ...describe(ctx, p),
          vor: r.vor,
          replacement: r.replacement,
          ownedBy: ownerRoster ? ctx.teamName(ownerRoster) : null,
          isFreeAgent: !owner,
          isMine: String(owner) === String(ctx.myRoster?.roster_id),
        };
      });

    groups[pos] = {
      position: pos,
      rows,
      replacementRank: positionReplacementRank(ctx.slots, ctx.numTeams, pos),
      replacementValue: ctx.valuations.replacement[pos] ?? 0,
    };
  }

  // Overall board, ranked by value over replacement so positions are comparable.
  const overall = ctx.valuations.rows
    .filter((r) => POSITIONS.includes(r.position))
    .filter((r) => !freeAgentsOnly || !ctx.ownerOf.has(r.player_id))
    .sort((a, b) => b.vor - a.vor)
    .slice(0, limit)
    .map((r, i) => {
      const p = ctx.playerOf(r.player_id);
      const owner = ctx.ownerOf.get(r.player_id);
      const ownerRoster = owner ? ctx.rosterOf(owner) : null;
      return {
        rank: i + 1,
        ...describe(ctx, p),
        vor: r.vor,
        ownedBy: ownerRoster ? ctx.teamName(ownerRoster) : null,
        isFreeAgent: !owner,
        isMine: String(owner) === String(ctx.myRoster?.roster_id),
      };
    });

  return {
    groups,
    overall,
    weeksRemaining: Math.max(0, (ctx.playoffWeekStart || 15) - ctx.week),
    note: 'Ranked on points above replacement — what a player is worth compared with the best free agent at his position. That makes a quarterback and a tight end directly comparable, which raw points do not.',
  };
}
