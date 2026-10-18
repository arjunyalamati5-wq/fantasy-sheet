import { mulberry32, lognormalScore } from './random.js';
import { round2 } from './scoring.js';
import { buildBracket, simPlan, playBracketOnce, validateUpset } from './features/bracket.js';

// Playoff and title odds by simulating every remaining week from the league's
// REAL pairings (pulled from /matchups/{week} for future weeks), not a
// hand-rolled round robin.

const DEFAULT_SEASONS = 10_000;

/**
 * @param {Object} cfg
 * @param {Array}  cfg.teams          [{ rosterId, name, wins, losses, ties, pointsFor, mean, sd }]
 * @param {Array}  cfg.remainingWeeks [{ week, pairs: [[rosterIdA, rosterIdB], ...] }]
 * @param {number} cfg.playoffTeams
 * @param {number} cfg.runs
 * @param {number} [cfg.upsetFactor]  scales every team's weekly spread, 0.5 to 2.0 (default 1)
 * @param {Object} [cfg.playoff]      { reseed, roundType, startWeek }: how the bracket is played
 * @param {boolean} [cfg.playPlayoffs] play the playoffs inside each simulated season (default true)
 * @param {Array}  [cfg.divisions]    division id per team (same order as teams); with two or more
 *                                    divisions, each division's best team takes a berth and the
 *                                    top seeds, then the rest of the field fills by record
 */
export function simulateSeason(cfg) {
  const { remainingWeeks = [], playoffTeams = 6, runs = DEFAULT_SEASONS, seed = 20260915 } = cfg;
  const upset = validateUpset(cfg.upsetFactor);
  const playPlayoffs = cfg.playPlayoffs !== false;
  // The spread is scaled once, up front, so every score below uses it.
  const teams = upset === 1 ? cfg.teams : cfg.teams.map((t) => ({ ...t, sd: t.sd * upset }));
  const divisionOf = Array.isArray(cfg.divisions) ? cfg.divisions : [];
  const divisionIds = new Set(divisionOf.filter((d) => d !== null && d !== undefined));
  const useDivisions = divisionIds.size >= 2 && divisionOf.length === teams.length;
  const n = teams.length;
  if (n === 0) return { teams: [], runs: 0, playoffTeams };

  const idx = new Map(teams.map((t, i) => [String(t.rosterId), i]));
  // Picked results (the playoff machine): `${week}|${a}|${b}` (sorted ids) -> winner id.
  // Scores are still drawn, so points for stays realistic; the picked team
  // takes the higher of the two.
  const forced = cfg.forced instanceof Map ? cfg.forced : null;
  const forcedFor = (week, a, b) => {
    if (!forced) return null;
    const [x, y] = [String(a), String(b)].sort();
    return forced.get(`${week}|${x}|${y}`) || null;
  };
  const rand = mulberry32(seed);
  // The playoffs draw from their own stream, started from the same seed, so
  // playing them can never move a regular-season number.
  const playoffRand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const P = Math.min(playoffTeams, n);
  const plan = playPlayoffs && P >= 1
    ? simPlan(buildBracket(Array.from({ length: P }, (_, i) => i), cfg.playoff || {}))
    : null;

  const madePlayoffs = new Array(n).fill(0);
  const wonTitle = new Array(n).fill(0);
  const madeFinal = new Array(n).fill(0);
  const winTotal = new Array(n).fill(0);
  const seedCounts = Array.from({ length: n }, () => new Array(n).fill(0));
  const wonDivision = new Array(n).fill(0);
  const winsHist = Array.from({ length: n }, () => new Map()); // final wins (to the half) -> runs

  const wins = new Float64Array(n);
  const pf = new Float64Array(n);
  const scratch = new Float64Array(n);

  for (let s = 0; s < runs; s++) {
    for (let i = 0; i < n; i++) {
      // Ties count as half a win for seeding, which is how Sleeper sorts.
      wins[i] = teams[i].wins + 0.5 * (teams[i].ties || 0);
      pf[i] = teams[i].pointsFor || 0;
    }

    for (const wk of remainingWeeks) {
      for (let i = 0; i < n; i++) scratch[i] = -1;
      for (const [a, b] of wk.pairs) {
        const ia = idx.get(String(a));
        const ib = idx.get(String(b));
        if (ia === undefined || ib === undefined) continue;
        if (scratch[ia] < 0) scratch[ia] = lognormalScore(rand, teams[ia].mean, teams[ia].sd);
        if (scratch[ib] < 0) scratch[ib] = lognormalScore(rand, teams[ib].mean, teams[ib].sd);
        const pick = forcedFor(wk.week, a, b);
        if (pick) {
          const hi = Math.max(scratch[ia], scratch[ib]) + 0.01;
          const lo = Math.min(scratch[ia], scratch[ib]);
          if (pick === String(a)) { scratch[ia] = hi; scratch[ib] = lo; } else { scratch[ib] = hi; scratch[ia] = lo; }
        }
        pf[ia] += scratch[ia];
        pf[ib] += scratch[ib];
        if (scratch[ia] > scratch[ib]) wins[ia] += 1;
        else if (scratch[ib] > scratch[ia]) wins[ib] += 1;
        else { wins[ia] += 0.5; wins[ib] += 0.5; }
      }
    }

    // Seed by wins, then points for — Sleeper's default tiebreak.
    const byRecord = (x, y) => (wins[y] - wins[x]) || (pf[y] - pf[x]);
    let order = [...Array(n).keys()].sort(byRecord);
    if (useDivisions) {
      // Division winners first (best record among them leads), then everyone else by record.
      const seen = new Set();
      const winners = [];
      for (const i of order) {
        const d = divisionOf[i];
        if (d === null || d === undefined || seen.has(d)) continue;
        seen.add(d);
        winners.push(i);
        wonDivision[i] += 1;
      }
      const isWinner = new Set(winners);
      order = [...winners, ...order.filter((i) => !isWinner.has(i))];
    }
    const bracket = order.slice(0, Math.min(playoffTeams, n));

    for (let p = 0; p < order.length; p++) {
      seedCounts[order[p]][p] += 1;
      winTotal[order[p]] += wins[order[p]];
      const key = Math.round(wins[order[p]] * 2) / 2;
      winsHist[order[p]].set(key, (winsHist[order[p]].get(key) || 0) + 1);
    }
    for (const i of bracket) madePlayoffs[i] += 1;

    if (plan) {
      const score = (seedNo, weeks) => {
        const t = teams[bracket[seedNo - 1]];
        let total = 0;
        for (let k = 0; k < weeks.length; k++) total += lognormalScore(playoffRand, t.mean, t.sd);
        return total;
      };
      const { champion, runnerUp } = playBracketOnce(plan, score);
      if (champion !== null) {
        wonTitle[bracket[champion - 1]] += 1;
        madeFinal[bracket[champion - 1]] += 1;
      }
      if (runnerUp !== null) madeFinal[bracket[runnerUp - 1]] += 1;
    }
  }

  const out = teams.map((t, i) => ({
    rosterId: t.rosterId,
    name: t.name,
    wins: t.wins,
    losses: t.losses,
    ties: t.ties || 0,
    pointsFor: round2(t.pointsFor || 0),
    weeklyMean: round2(t.mean),
    weeklySd: round2(cfg.teams[i].sd),
    projectedWins: round2(winTotal[i] / runs),
    playoffOdds: madePlayoffs[i] / runs,
    finalOdds: plan ? madeFinal[i] / runs : null,
    titleOdds: plan ? wonTitle[i] / runs : null,
    seedOdds: seedCounts[i].map((c) => c / runs),
    divisionOdds: useDivisions ? wonDivision[i] / runs : null,
    // The middle 80% of final win totals across the simulated seasons.
    winsLow: histPercentile(winsHist[i], runs, 0.1),
    winsHigh: histPercentile(winsHist[i], runs, 0.9),
    // How often each final win total came up (to the half win), for the win-total chart.
    winsDist: [...winsHist[i]].sort((a, b) => a[0] - b[0]).map(([w, c]) => ({ wins: w, p: c / runs })),
  }));

  out.sort((a, b) => b.playoffOdds - a.playoffOdds || b.titleOdds - a.titleOdds);
  return {
    teams: out, runs, playoffTeams: Math.min(playoffTeams, n), weeksSimulated: remainingWeeks.length,
    divisions: useDivisions ? divisionIds.size : 0,
    upset, playoffsPlayed: !!plan,
  };
}

/** The q-quantile of a histogram of values to the half win (smallest value reaching q of the runs). */
function histPercentile(hist, runs, q) {
  let acc = 0;
  for (const [v, c] of [...hist].sort((a, b) => a[0] - b[0])) {
    acc += c;
    if (acc / runs >= q - 1e-12) return v;
  }
  return 0;
}

/**
 * Sanity check the spec calls for: playoff percentages must sum to
 * playoffTeams x 100, title percentages to 100.
 */
export function checkOdds(result) {
  const playoffSum = result.teams.reduce((s, t) => s + t.playoffOdds, 0);
  // Without the playoff simulation there is no title column to add up.
  const played = result.teams.every((t) => t.titleOdds !== null && t.titleOdds !== undefined);
  const titleSum = played ? result.teams.reduce((s, t) => s + t.titleOdds, 0) : 1;
  return {
    playoffSum,
    playoffExpected: result.playoffTeams,
    playoffOk: Math.abs(playoffSum - result.playoffTeams) < 1e-6,
    titleSum,
    titleOk: Math.abs(titleSum - 1) < 1e-6,
  };
}
