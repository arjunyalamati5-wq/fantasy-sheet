import { round2 } from '../scoring.js';
import { describe } from './lineup.js';

// "What is this player actually worth to me?" answered by re-solving the lineup
// without him and measuring the drop.
//
// Kickers and defences are excluded. You carry exactly one of each, so removing
// one always leaves the slot empty and they always top the list. That is
// arithmetic about roster construction, not a statement about risk.
const EXCLUDED = new Set(['K', 'DEF']);

export function exposureReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const roster = ctx.rosterOf(rosterId);
  if (!roster) return { error: 'No roster found' };

  const pointsFor = (p) => ctx.pointsFor(p.player_id);
  const base = ctx.solveFor(rosterId, pointsFor);
  const starters = base.assignments.filter((a) => a.player).map((a) => a.player);

  const rows = [];
  for (const p of starters) {
    if (EXCLUDED.has(p.position)) continue;
    const without = ctx.solveFor(rosterId, pointsFor, { exclude: new Set([p.player_id]) });
    const drop = round2(base.total - without.total);
    const replacement = findReplacement(base, without);
    rows.push({
      ...describe(ctx, p),
      lineupCost: drop,
      replacedBy: replacement ? describe(ctx, replacement) : null,
      note: replacement
        ? `If he sat, ${replacement.name} would start and you would lose ${drop.toFixed(1)} points.`
        : `If he sat, you would have nobody legal to fill the slot and lose ${drop.toFixed(1)} points.`,
    });
  }
  rows.sort((a, b) => b.lineupCost - a.lineupCost);

  return {
    rosterId,
    teamName: ctx.teamName(roster),
    week: ctx.week,
    baseline: base.total,
    rows,
    excluded: [...EXCLUDED],
    note: 'Kickers and defences are left out. You only carry one of each, so removing one always empties a slot — that says more about roster size than about risk.',
  };
}

function findReplacement(base, without) {
  const baseIds = new Set(base.assignments.filter((a) => a.player).map((a) => a.player.player_id));
  for (const a of without.assignments) {
    if (a.player && !baseIds.has(a.player.player_id)) return a.player;
  }
  return null;
}
