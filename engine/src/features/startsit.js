import { describe } from './lineup.js';
import { solveLineup, playerFitsSlot, slotLabel } from '../lineup.js';
import { simulateMatchup } from '../montecarlo.js';
import { playerSd } from '../variance.js';
import { round2 } from '../scoring.js';

/**
 * Head-to-head: should I start A or B?
 * The honest answer is not "who projects higher" but "which one does my lineup
 * actually score more with", because the loser may still start in a flex.
 */
export function startSit(ctx, { rosterId = ctx.myRoster?.roster_id, a, b } = {}) {
  const pa = ctx.playerOf(a);
  const pb = ctx.playerOf(b);
  if (!pa || !pb) return { error: 'Pick two players to compare.' };
  if (a === b) return { error: 'Those are the same player.' };

  const pointsFor = (p) => ctx.pointsFor(p.player_id);
  const roster = ctx.playersOn(rosterId);
  const pool = [...roster];
  for (const p of [pa, pb]) if (!pool.some((x) => x.player_id === p.player_id)) pool.push(p);

  const base = solveLineup(ctx.slots, pool, pointsFor);
  const withoutA = solveLineup(ctx.slots, pool.filter((p) => p.player_id !== a), pointsFor);
  const withoutB = solveLineup(ctx.slots, pool.filter((p) => p.player_id !== b), pointsFor);

  // What each is worth to the lineup, not just to himself.
  const costOfBenchingA = round2(base.total - withoutA.total);
  const costOfBenchingB = round2(base.total - withoutB.total);

  const startsA = base.assignments.find((x) => x.player?.player_id === a) || null;
  const startsB = base.assignments.find((x) => x.player?.player_id === b) || null;

  // A straight one-on-one too, for the week's floor and ceiling.
  const drawA = [{ player_id: a, name: pa.name, position: pa.position, mean: pointsFor(pa), sd: playerSd(pa.position, pointsFor(pa), ctx.gameLog(a)) }];
  const drawB = [{ player_id: b, name: pb.name, position: pb.position, mean: pointsFor(pb), sd: playerSd(pb.position, pointsFor(pb), ctx.gameLog(b)) }];
  const head = simulateMatchup(drawA, drawB, { runs: 20_000, seed: 4242 });

  const winner = costOfBenchingA === costOfBenchingB
    ? (pointsFor(pa) >= pointsFor(pb) ? pa : pb)
    : (costOfBenchingA > costOfBenchingB ? pa : pb);
  const loser = winner.player_id === a ? pb : pa;

  return {
    a: { ...describe(ctx, pa), startsInSlot: startsA ? slotLabel(startsA.slot) : null, lineupCost: costOfBenchingA },
    b: { ...describe(ctx, pb), startsInSlot: startsB ? slotLabel(startsB.slot) : null, lineupCost: costOfBenchingB },
    bothStart: Boolean(startsA && startsB),
    recommend: { player_id: winner.player_id, name: winner.name },
    outscoreProbability: head.winProb, // chance A outscores B
    spread: head.margin,
    verdict: verdict(ctx, pa, pb, startsA, startsB, costOfBenchingA, costOfBenchingB, head, winner, loser),
    eligibleSlots: ctx.slots
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .filter((s) => playerFitsSlot(s, pa) || playerFitsSlot(s, pb))
      .map((s) => ({ slot: s, label: slotLabel(s), a: playerFitsSlot(s, pa), b: playerFitsSlot(s, pb) })),
  };
}

function verdict(ctx, pa, pb, startsA, startsB, costA, costB, head, winner, loser) {
  if (startsA && startsB) {
    return `Start both. Your lineup has room for each of them, so this is not a choice you need to make.`;
  }
  const pct = Math.round((winner.player_id === pa.player_id ? head.winProb : 1 - head.winProb) * 100);
  const gap = Math.abs(costA - costB);
  if (gap < 0.5) {
    return `It is close to a coin flip. ${winner.name} is worth about ${gap.toFixed(1)} more points to your lineup, and outscores ${loser.name} in ${pct} of 100 simulated weeks. Either is defensible.`;
  }
  return `Start ${winner.name}. He is worth about ${gap.toFixed(1)} more points a week to your lineup than ${loser.name}, and outscores him in ${pct} of 100 simulated weeks.`;
}
