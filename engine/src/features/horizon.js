// Looking past this week: what a player is worth in each future week, which
// weeks make up "next week", "rest of season" and "playoffs", and what adding
// a player does to a lineup summed over those weeks.

import { solveLineup } from '../lineup.js';
import { round2 } from '../scoring.js';
import { outInWeek } from '../availability.js';

const PLAYOFF_ROUNDS = 3;

export const HORIZONS = ['next', 'ros', 'playoffs'];

export function lastRegularWeek(ctx) {
  return (Number(ctx.playoffWeekStart) || 15) - 1;
}

/** The weeks a horizon covers, never including a week already played. */
export function horizonWeeks(ctx, kind) {
  const week = Number(ctx.week);
  const last = lastRegularWeek(ctx);
  const range = (a, b) => { const out = []; for (let w = a; w <= b; w++) out.push(w); return out; };
  if (kind === 'next') return [week];
  if (kind === 'ros') return range(week, last);
  if (kind === 'playoffs') {
    const start = last + 1;
    return range(Math.max(week, start), Math.min(start + PLAYOFF_ROUNDS - 1, 18));
  }
  return [];
}

/**
 * Points a player is expected to score in a given week. The week being viewed
 * uses its real projection (already adjusted for bye and injury); later weeks
 * have no projection yet, so the blended per-game value stands in, zero on his
 * bye and while he is out: an IR/PUP/NA player counts again four weeks on, or
 * from the week the manager set in ctx.irReturn (see availability.outInWeek).
 */
export function weeklyPoints(ctx, player, week) {
  if (!player) return 0;
  if (Number(week) === Number(ctx.week)) return ctx.pointsFor(player.player_id);
  if (player.team && ctx.schedule?.isOnBye?.(player.team, week)) return 0;
  const inj = ctx.injuryByPlayer?.get(player.player_id);
  if (inj && outInWeek({
    status: inj.sleeperStatus, currentWeek: ctx.week, week, returnWeek: ctx.irReturn?.get(player.player_id),
  })) return 0;
  return ctx.valueOf(player.player_id);
}

/** Best-lineup total for each of the weeks, for a set of players. */
export function weeklyTotals(ctx, players, weeks) {
  const out = new Map();
  for (const w of weeks) {
    out.set(w, solveLineup(ctx.slots, players, (p) => weeklyPoints(ctx, p, w)).total);
  }
  return out;
}

/**
 * What adding one player does to a lineup over several weeks: the sum of each
 * week's gain, and in how many of those weeks he is in the best lineup.
 * @param {Map<number,number>} [bases] weeklyTotals() of the current players, to avoid re-solving
 */
export function horizonLift(ctx, players, candidate, weeks, bases = weeklyTotals(ctx, players, weeks)) {
  let lift = 0;
  let starts = 0;
  const perWeek = [];
  for (const w of weeks) {
    const fn = (p) => weeklyPoints(ctx, p, w);
    const withHim = solveLineup(ctx.slots, [...players, candidate], fn);
    const gain = Math.max(0, withHim.total - (bases.get(w) ?? 0));
    const starting = withHim.assignments.some((a) => a.player?.player_id === candidate.player_id) && fn(candidate) > 0;
    if (starting) starts++;
    lift += gain;
    perWeek.push({ week: w, gain: round2(gain), starts: starting });
  }
  return { lift: round2(lift), starts, weeks: weeks.length, perWeek };
}

/**
 * Who to drop to make room: among the few lowest-valued players who are not
 * mid-game, the one whose absence costs the lineup least over the weeks,
 * judged with the new player already on the roster.
 * @returns {{player, cost}|null}
 */
export function suggestDrop(ctx, players, candidate, weeks, { tryCount = 5 } = {}) {
  if (!weeks.length) return null;
  const pool = players
    .filter((p) => p.player_id !== candidate.player_id && !(ctx.isLocked?.(p.player_id)))
    .sort((a, b) => ctx.valueOf(a.player_id) - ctx.valueOf(b.player_id))
    .slice(0, tryCount);
  if (!pool.length) return null;
  const withHim = [...players, candidate];
  const total = (list) => weeks.reduce((s, w) => s + solveLineup(ctx.slots, list, (p) => weeklyPoints(ctx, p, w)).total, 0);
  const full = total(withHim);
  let best = null;
  for (const d of pool) {
    const cost = Math.max(0, full - total(withHim.filter((p) => p.player_id !== d.player_id)));
    if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) <= 1e-9 && ctx.valueOf(d.player_id) < ctx.valueOf(best.player.player_id))) {
      best = { player: d, cost };
    }
  }
  return best && { player: best.player, cost: round2(best.cost) };
}
