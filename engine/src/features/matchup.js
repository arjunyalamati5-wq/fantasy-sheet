import { simulateMatchup, lineupToDraws } from '../montecarlo.js';
import { scoreSetLineup } from '../lineup.js';
import { round2 } from '../scoring.js';
import { describe } from './lineup.js';

/**
 * This week's head-to-head, simulated 20,000 times.
 * Both sides use the lineup each manager has actually set — that is the game
 * being played, not the one they could have set.
 */
export function matchupReport(ctx, rosterId = ctx.myRoster?.roster_id, opts = {}) {
  const runs = opts.runs || 20_000;
  const mine = ctx.currentMatchups.find((m) => String(m.roster_id) === String(rosterId));
  if (!mine) {
    return { error: 'No matchup found for this week yet. Sleeper publishes pairings shortly before kickoff.' };
  }
  const oppEntry = ctx.currentMatchups.find(
    (m) => m.matchup_id === mine.matchup_id && String(m.roster_id) !== String(rosterId)
  );
  if (!oppEntry) {
    return { error: 'You are on a bye in the league schedule this week.' };
  }

  const build = (entry) => {
    const roster = ctx.rosterOf(entry.roster_id);
    const pointsFor = (p) => ctx.pointsFor(p.player_id);
    // The matchup's own starters are that week's lineup (live for the week
    // being played); an empty list means Sleeper has none yet, not "no one".
    const starters = Array.isArray(entry.starters) && entry.starters.length ? entry.starters : (roster?.starters || []);
    const set = scoreSetLineup(ctx.slots, starters, pointsFor, (id) => ctx.playerOf(id));
    const optimal = ctx.solveFor(entry.roster_id, pointsFor);
    return { entry, roster, set, optimal };
  };

  const me = build(mine);
  const them = build(oppEntry);

  const drawsA = lineupToDraws(me.set.assignments, ctx.gameLog);
  const drawsB = lineupToDraws(them.set.assignments, ctx.gameLog);
  const sim = simulateMatchup(drawsA, drawsB, { runs, seed: seedFor(ctx, mine, oppEntry) });

  // Which of my starters moves the needle most, measured against a replacement-
  // level score rather than against zero.
  const replacementMean = averageReplacement(ctx);
  const swings = drawsA
    .map((p) => {
      const without = drawsA.map((q) => (q.player_id === p.player_id
        ? { ...q, mean: replacementMean, sd: Math.max(1, replacementMean * 0.6) } : q));
      const wp = simulateMatchup(without, drawsB, { runs: 4000, seed: 777 }).winProb;
      return { ...describe(ctx, ctx.playerOf(p.player_id)), swing: round3(baseWp(drawsA, drawsB) - wp) };
    })
    .sort((a, b) => b.swing - a.swing);

  return {
    week: ctx.week,
    runs,
    me: side(ctx, me),
    them: side(ctx, them),
    winProbability: sim.winProb,
    projected: { me: sim.projA, them: sim.projB },
    margin: sim.margin,
    scores: { me: sim.scoreA, them: sim.scoreB },
    swings: swings.slice(0, 8),
    explanation: explain(sim),
  };
}

let baseCache = new WeakMap();
function baseWp(a, b) {
  let entry = baseCache.get(a);
  if (!entry) { entry = new Map(); baseCache.set(a, entry); }
  const key = b.length;
  if (!entry.has(key)) entry.set(key, simulateMatchup(a, b, { runs: 4000, seed: 777 }).winProb);
  return entry.get(key);
}

function side(ctx, built) {
  return {
    rosterId: built.entry.roster_id,
    teamName: ctx.teamName(built.roster) || `Roster ${built.entry.roster_id}`,
    record: built.roster ? recordOf(built.roster) : null,
    projected: built.set.total,
    optimalProjected: built.optimal.total,
    pointsLeftOnBench: round2(Math.max(0, built.optimal.total - built.set.total)),
    starters: built.set.assignments
      .filter((a) => a.player)
      .map((a) => ({ slot: a.slot, ...describe(ctx, a.player) })),
  };
}

function recordOf(roster) {
  const s = roster.settings || {};
  return { wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0 };
}

function averageReplacement(ctx) {
  const vals = Object.values(ctx.valuations.replacement || {});
  if (!vals.length) return 6;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function seedFor(ctx, a, b) {
  const s = `${ctx.league.league_id}:${ctx.week}:${a.roster_id}:${b.roster_id}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function explain(sim) {
  const pct = Math.round(sim.winProb * 100);
  const med = sim.margin.median;
  const lead = med >= 0 ? `ahead by about ${Math.abs(med).toFixed(1)}` : `behind by about ${Math.abs(med).toFixed(1)}`;
  return `You win ${pct} of every 100 simulated versions of this week. The typical result has you ${lead} points. `
    + `A bad week for you still lands near ${sim.margin.floor.toFixed(1)}; a good one near ${sim.margin.ceiling.toFixed(1)}.`;
}

const round3 = (n) => Math.round(n * 1000) / 1000;
