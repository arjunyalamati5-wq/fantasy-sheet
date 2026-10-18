import { scoreStats, round2 } from './scoring.js';
import { slotDemand } from './lineup.js';

// Three signals, blended so that results matter more as the sample grows:
//   1. Sleeper's projection, re-scored in this league's settings
//   2. Actual results, also re-scored, bye weeks excluded
//   3. Usage (snap share, target share) as a small correction, not a driver
//
// Early in a season n is tiny, so a raw per-game average is noise. We shrink
// toward a prior instead of trusting two good games.

const PRIOR_K = 4;              // results weight is n/(n+4)
const HEALTHY_PROJ_MIN = 0.5;   // below this, this week's projection means "not playing", not "bad"
const POS_MEAN_PULL = 0.25;     // how far the prior sits toward the positional mean
const USAGE_MAX = 0.12;         // usage may move a valuation by at most +/-12%

/** Positions we bother modelling usage for. K and DEF have no meaningful snap share. */
const USAGE_POSITIONS = new Set(['RB', 'WR', 'TE', 'QB']);

/**
 * @param {Object} ctx
 * @param {Object} ctx.players        slim Sleeper catalogue keyed by player_id
 * @param {Object} ctx.scoring        league scoring_settings
 * @param {Object} ctx.projections    { player_id: { stats } } for the target week
 * @param {Map}    ctx.resultsByPlayer player_id -> [{ week, points, onBye }]
 * @param {Map}    ctx.usageByPlayer   player_id -> { snapShare, targetShare, ... }
 * @param {string[]} ctx.slots        starting slots
 * @param {number} ctx.numTeams
 * @param {string[]} ctx.candidateIds players to value (rostered + free agents)
 */
export function buildValuations(ctx) {
  const {
    players, scoring, projections = {}, futureProjections = [], resultsByPlayer = new Map(),
    usageByPlayer = new Map(), slots = [], numTeams = 10, candidateIds = null,
  } = ctx;

  const ids = candidateIds || Object.keys(players);

  // --- Step 1: per-player projection and raw results ----------------------
  const rows = [];
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    const proj = projections[id];
    const weekProj = proj ? scoreStats(proj.stats, scoring) : null;
    // A player on bye or ruled out this week projects ~0, which says nothing
    // about how good he is. Value him on the next week he is projected to
    // play, so a bye or a short injury never sinks his worth for the season.
    let projPoints = weekProj;
    let projFrom = 'this week';
    if (!(weekProj > HEALTHY_PROJ_MIN)) {
      for (const [i, fut] of futureProjections.entries()) {
        const fp = fut?.[id] ? scoreStats(fut[id].stats, scoring) : null;
        if (fp > HEALTHY_PROJ_MIN) { projPoints = fp; projFrom = `week +${i + 1}`; break; }
      }
    }

    // Only games he actually played: a week he missed injured is not a
    // 0-point game, and counting it as one undervalues him (and inflates his
    // swing) for the rest of the season.
    const all = (resultsByPlayer.get(id) || []).filter((g) => !g.onBye);
    const log = all.filter((g) => g.played !== false);
    const samples = log.map((g) => g.points);
    const n = samples.length;
    const rawMean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : null;

    rows.push({
      player_id: id,
      name: p.name,
      position: p.position,
      team: p.team,
      injury_status: p.injury_status,
      projPoints,
      weekProj,
      projFrom,
      gamesPlayed: n,
      gamesMissed: all.length - n,
      rawMean,
      samples,
    });
  }

  // --- Step 2: positional means, used as the shrink target ----------------
  const posMean = positionalMeans(rows);

  // --- Step 3: blend ------------------------------------------------------
  // Usage norms belong to THIS call's players and usage. They used to be
  // memoised process-wide by list sizes, so a second league with the same
  // counts was judged against the first league's peers.
  const usageNorms = posUsageNorms(rows, usageByPlayer);
  for (const r of rows) {
    const pm = posMean[r.position] ?? 0;

    // The prior is mostly the projection, pulled a quarter of the way toward
    // the positional mean so an outlier projection can't run away early.
    const prior = r.projPoints !== null && Number.isFinite(r.projPoints)
      ? (1 - POS_MEAN_PULL) * r.projPoints + POS_MEAN_PULL * pm
      : pm;

    const w = r.gamesPlayed / (r.gamesPlayed + PRIOR_K);
    const blended = r.rawMean === null ? prior : (1 - w) * prior + w * r.rawMean;

    const usage = usageByPlayer.get(r.player_id) || null;
    const usageScore = usageSignal(r.position, usage, usageNorms);
    const usageFactor = 1 + USAGE_MAX * usageScore;

    r.prior = round2(prior);
    r.resultsWeight = round3(w);
    r.blended = round2(blended);
    r.usage = usage;
    r.usageScore = round3(usageScore);
    r.usageFactor = round3(usageFactor);
    r.value = round2(Math.max(0, blended * usageFactor));
  }

  // --- Step 4: value over replacement -------------------------------------
  const replacement = replacementLevels(rows, slots, numTeams);
  for (const r of rows) {
    const repl = replacement[r.position] ?? 0;
    r.replacement = round2(repl);
    r.vor = round2(r.value - repl);
  }

  const byId = new Map(rows.map((r) => [r.player_id, r]));
  return { rows, byId, posMean, replacement, sampleSize: maxGames(rows) };
}

function maxGames(rows) {
  return rows.reduce((m, r) => Math.max(m, r.gamesPlayed), 0);
}

/**
 * Mean points per game for each position, computed over players who actually
 * play — otherwise the long tail of inactive bodies drags every mean to zero.
 */
function positionalMeans(rows) {
  const buckets = {};
  for (const r of rows) {
    const v = r.rawMean !== null ? r.rawMean : r.projPoints;
    if (v === null || !Number.isFinite(v) || v <= 0) continue;
    (buckets[r.position] ||= []).push(v);
  }
  const out = {};
  for (const [pos, vals] of Object.entries(buckets)) {
    vals.sort((a, b) => b - a);
    // Top half only: the mean of "every QB in the database" is not a useful prior.
    const top = vals.slice(0, Math.max(3, Math.ceil(vals.length / 2)));
    out[pos] = top.reduce((a, b) => a + b, 0) / top.length;
  }
  return out;
}

/** Median snap/target share by position, so usage is judged against peers. */
export function posUsageNorms(rows, usageByPlayer) {
  const snap = {};
  const tgt = {};
  for (const r of rows) {
    const u = usageByPlayer.get(r.player_id);
    if (!u) continue;
    if (u.snapShare != null && u.snapShare > 0) (snap[r.position] ||= []).push(u.snapShare);
    if (u.targetShare != null && u.targetShare > 0) (tgt[r.position] ||= []).push(u.targetShare);
  }
  const med = (arr) => {
    if (!arr || arr.length === 0) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const out = { snap: {}, targets: {} };
  for (const pos of new Set([...Object.keys(snap), ...Object.keys(tgt)])) {
    out.snap[pos] = med(snap[pos]);
    out.targets[pos] = med(tgt[pos]);
  }
  return out;
}

/**
 * Turn usage into a score in [-1, 1]. Playing more snaps and drawing more
 * targets than a positional peer nudges a valuation up; the reverse nudges down.
 * Returns 0 when we have no usage data, so missing data never invents an edge.
 */
export function usageSignal(position, usage, norms) {
  if (!usage || !USAGE_POSITIONS.has(position)) return 0;

  const parts = [];
  const snapNorm = norms?.snap?.[position];
  if (usage.snapShare != null && snapNorm) {
    parts.push(clamp((usage.snapShare - snapNorm) / Math.max(0.15, snapNorm), -1, 1));
  }
  const tgtNorm = norms?.targets?.[position];
  if (usage.targetShare != null && tgtNorm && position !== 'QB') {
    parts.push(clamp((usage.targetShare - tgtNorm) / Math.max(0.05, tgtNorm), -1, 1));
  }
  if (parts.length === 0) return 0;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, -1, 1);
}

/**
 * Replacement level per position: the value of the best player you could pick
 * up free. Replacement rank = how many of that position the league starts in
 * total, where a three-way flex counts as a third of a slot toward each of
 * RB/WR/TE.
 */
export function replacementLevels(rows, slots, numTeams) {
  const demand = slotDemand(slots);
  const out = {};
  for (const [pos, perTeam] of Object.entries(demand)) {
    const rank = Math.max(1, Math.round(perTeam * numTeams));
    const pool = rows
      .filter((r) => r.position === pos)
      .map((r) => r.value ?? 0)
      .sort((a, b) => b - a);
    if (pool.length === 0) { out[pos] = 0; continue; }
    // If the league is shallower than the replacement rank, the last ranked
    // player is the best available stand-in.
    out[pos] = pool[Math.min(rank, pool.length) - 1];
  }
  return out;
}

export function positionReplacementRank(slots, numTeams, pos) {
  const demand = slotDemand(slots);
  return Math.max(1, Math.round((demand[pos] || 0) * numTeams));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (n) => Math.round(n * 1000) / 1000;
