import { mulberry32, lognormalScore, seedFrom } from './random.js';
import { playerSd } from './variance.js';
import { round2 } from './scoring.js';

const DEFAULT_RUNS = 20_000;

/**
 * Turn a solved lineup into simulation inputs.
 * @param {Array} assignments  from solveLineup / scoreSetLineup
 * @param {(id)=>number[]} gameLog  weekly points for a player, for their own variance
 */
export function lineupToDraws(assignments, gameLog = () => []) {
  return assignments
    .filter((a) => a.player)
    .map((a) => ({
      player_id: a.player.player_id,
      name: a.player.name || a.player.player_id,
      position: a.player.position,
      mean: a.points,
      sd: playerSd(a.player.position, a.points, gameLog(a.player.player_id)),
    }));
}

/**
 * Monte Carlo a head-to-head matchup.
 * Each starter is drawn independently from a right-skewed distribution built
 * from his own game log blended with a positional default.
 */
export function simulateMatchup(teamA, teamB, opts = {}) {
  const runs = opts.runs || DEFAULT_RUNS;
  const rand = mulberry32(opts.seed ?? seedFrom(JSON.stringify([teamA.map(p => p.player_id), teamB.map(p => p.player_id)])));

  let wins = 0;
  let ties = 0;
  const margins = new Float64Array(runs);
  const scoresA = new Float64Array(runs);
  const scoresB = new Float64Array(runs);

  for (let i = 0; i < runs; i++) {
    let a = 0;
    for (const p of teamA) a += lognormalScore(rand, p.mean, p.sd);
    let b = 0;
    for (const p of teamB) b += lognormalScore(rand, p.mean, p.sd);

    scoresA[i] = a;
    scoresB[i] = b;
    margins[i] = a - b;
    if (a > b) wins++;
    else if (a === b) ties++;
  }

  margins.sort();
  scoresA.sort();
  scoresB.sort();

  const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];

  return {
    runs,
    winProb: round3((wins + ties / 2) / runs),
    projA: round2(teamA.reduce((s, p) => s + p.mean, 0)),
    projB: round2(teamB.reduce((s, p) => s + p.mean, 0)),
    // "Floor" is the 10th-percentile outcome for you, "ceiling" the 90th.
    margin: {
      floor: round2(pct(margins, 0.1)),
      median: round2(pct(margins, 0.5)),
      ceiling: round2(pct(margins, 0.9)),
    },
    scoreA: {
      floor: round2(pct(scoresA, 0.1)),
      median: round2(pct(scoresA, 0.5)),
      ceiling: round2(pct(scoresA, 0.9)),
    },
    scoreB: {
      floor: round2(pct(scoresB, 0.1)),
      median: round2(pct(scoresB, 0.5)),
      ceiling: round2(pct(scoresB, 0.9)),
    },
  };
}

/**
 * How much each starter moves the win probability: re-simulate with that player
 * replaced by a replacement-level score.
 */
export function swingFactors(teamA, teamB, replacementMean, opts = {}) {
  const runs = opts.runs || 4000;
  const base = simulateMatchup(teamA, teamB, { runs, seed: 12345 }).winProb;
  return teamA
    .map((p) => {
      const without = teamA.map((q) =>
        q.player_id === p.player_id ? { ...q, mean: replacementMean, sd: playerSd(q.position, replacementMean, []) } : q
      );
      const wp = simulateMatchup(without, teamB, { runs, seed: 12345 }).winProb;
      return { player_id: p.player_id, name: p.name, position: p.position, swing: round3(base - wp) };
    })
    .sort((a, b) => b.swing - a.swing);
}

const round3 = (n) => Math.round(n * 1000) / 1000;
