import { solveLineup, slotDemand } from '../lineup.js';
import { round2 } from '../scoring.js';
import { getTrending, getTransactions } from '../sleeper.js';
import { claimHistory, suggestBid } from '../faab.js';
import { describe } from './lineup.js';
import { getWeeklyUsage, getSnapCounts } from '../nflverse.js';
import { HORIZONS, horizonWeeks, weeklyTotals, horizonLift, suggestDrop } from './horizon.js';
import { floorCeiling } from './floors.js';
import { nextMatchup } from './oppgrade.js';
import { playoffSos } from './playoffsos.js';

const HORIZON_LABEL = { next: 'Next week', ros: 'Rest of season', playoffs: 'Playoff weeks' };
const DROP_ROWS = 25; // suggested drops cost a few lineup solves each; only the rows worth claiming get one

/**
 * Trending adds, filtered to players actually free in this league, ranked by
 * two things: what they project this week, and how much your lineup needs that
 * position. A great WR is worth less to you if you already start three.
 */
export async function waiverReport(ctx, rosterId = ctx.myRoster?.roster_id, opts = {}) {
  const limit = opts.limit || 60;
  const fetchTrending = opts.fetchTrending || getTrending;
  const [adds, drops] = await Promise.all([
    fetchTrending('add', { lookbackHours: 48, limit }),
    fetchTrending('drop', { lookbackHours: 48, limit: 30 }),
  ]);
  // null means the feed failed; [] means Sleeper answered with nobody.
  const trendingAvailable = Array.isArray(adds);
  const trending = adds || [];
  const dropCounts = new Map((drops || []).map((t) => [t.player_id, t.count]));

  const myPlayers = ctx.playersOn(rosterId);
  const valueFn = (p) => ctx.valueOf(p.player_id);
  const base = solveLineup(ctx.slots, myPlayers, valueFn).total;

  const faab = await faabContext(ctx, rosterId);

  // Lineup lift by horizon: the weeks each one covers, and my best lineup in every one of them.
  const weeksBy = Object.fromEntries(HORIZONS.map((h) => [h, horizonWeeks(ctx, h)]));
  const allWeeks = [...new Set(HORIZONS.flatMap((h) => weeksBy[h]))].sort((a, b) => a - b);
  const bases = weeklyTotals(ctx, myPlayers, allWeeks);
  const rows = [];
  for (const t of trending) {
    const p = ctx.playerOf(t.player_id);
    if (!p) continue;
    if (ctx.ownerOf.has(t.player_id)) continue; // already rostered in this league

    // What would he do for my lineup if I added him today?
    const withHim = solveLineup(ctx.slots, [...myPlayers, p], valueFn).total;
    const lineupGain = round2(withHim - base);

    const per = horizonLift(ctx, myPlayers, p, allWeeks, bases).perWeek;
    const horizons = {};
    for (const h of HORIZONS) {
      const mine = per.filter((x) => weeksBy[h].includes(x.week));
      horizons[h] = {
        lift: round2(mine.reduce((a, x) => a + x.gain, 0)),
        starts: mine.filter((x) => x.starts).length,
        weeks: mine.length,
      };
    }
    const fc = floorCeiling(ctx, p.position, ctx.pointsFor(p.player_id));

    rows.push({
      ...describe(ctx, p),
      horizons,
      floor: fc.floor,
      ceiling: fc.ceiling,
      matchup: nextMatchup(ctx, p),
      playoffs: playoffSos(ctx, p),
      drop: null,
      addsLast48h: t.count,
      dropsLast48h: dropCounts.get(t.player_id) || 0,
      lineupGain,
      wouldStart: lineupGain > 0,
      reason: reasonFor(ctx, p, lineupGain, t.count),
      bid: faab
        ? suggestBid({ position: p.position, value: ctx.valueOf(p.player_id), wouldStart: lineupGain > 0, lineupGain }, faab.history, faab)
        : null,
    });
  }

  // Rank by what he would actually add to your lineup, then by raw projection.
  rows.sort((a, b) => b.lineupGain - a.lineupGain || b.projected - a.projected);

  // Who to cut for the ones that help. Only needed when the roster is full.
  const rosterFull = !Array.isArray(ctx.rosterPositions) || ctx.rosterPositions.length === 0
    || myPlayers.length >= ctx.rosterPositions.length;
  const dropWeeks = weeksBy.ros.length ? weeksBy.ros : weeksBy.next;
  if (rosterFull) {
    const worthIt = [...rows]
      .filter((r) => HORIZONS.some((h) => r.horizons[h].lift > 0.01))
      .sort((a, b) => b.horizons.ros.lift - a.horizons.ros.lift || b.horizons.next.lift - a.horizons.next.lift)
      .slice(0, DROP_ROWS);
    for (const r of worthIt) {
      const d = suggestDrop(ctx, myPlayers, ctx.playerOf(r.player_id), dropWeeks);
      if (d) r.drop = { player_id: d.player.player_id, name: d.player.name, position: d.player.position, cost: d.cost };
    }
  }

  const positionNeeds = needsByPosition(ctx, rosterId);
  const risers = await usageRisers(ctx, opts).catch(() => ({
    available: false, message: 'Snap and target data could not be read just now.', free: [], all: [],
  }));

  return {
    week: ctx.week,
    rows,
    positionNeeds,
    horizons: HORIZONS.map((h) => ({ id: h, label: HORIZON_LABEL[h], weeks: weeksBy[h] })),
    rosterFull,
    risers,
    faab: faab ? { budget: faab.budget, remaining: faab.remaining, claims: faab.history.length } : null,
    trendingAvailable,
    emptyMessage: !trendingAvailable
      ? 'Sleeper\'s trending feed is unavailable right now, so there are no trending adds to rank. Try again in a few minutes.'
      : rows.length === 0
        ? 'Nobody trending on waivers is free in your league right now. Check back after the Tuesday waiver run.'
        : null,
  };
}

/**
 * The league's FAAB economy: budget, what this roster has left, and every
 * completed claim so far. Null when the league does not bid on waivers.
 */
export async function faabContext(ctx, rosterId) {
  const s = ctx.league.settings || {};
  if (Number(s.waiver_type) !== 2) return null;
  // A league can genuinely set a $0 budget; only a missing value means the $100 default.
  const budget = s.waiver_budget != null && Number.isFinite(Number(s.waiver_budget)) ? Number(s.waiver_budget) : 100;
  const used = Number(ctx.rosterOf(rosterId)?.settings?.waiver_budget_used) || 0;
  const weeks = [...ctx.completedWeeks, ctx.week];
  const batches = await Promise.all(weeks.map((w) => getTransactions(ctx.league.league_id, w)));
  const history = claimHistory(batches.map((b) => b || []), {
    positionOf: (id) => ctx.playerOf(id)?.position,
    valueOf: (id) => ctx.valueOf(id),
  });
  return { budget, remaining: Math.max(0, budget - used), minBid: Number(s.waiver_bid_min) || 0, history };
}

function reasonFor(ctx, p, lineupGain, adds) {
  if (lineupGain > 0) {
    return `He would start for you immediately and add about ${lineupGain.toFixed(1)} points a week.`;
  }
  const usage = ctx.usageByPlayer.get(p.player_id);
  if (usage?.snapShare != null && usage.snapShare > 0.6) {
    return `He would not crack your lineup yet, but he is on the field for ${(usage.snapShare * 100).toFixed(0)}% of snaps — worth a bench spot.`;
  }
  return `${adds.toLocaleString()} managers added him in the last two days. He does not beat anyone you already start.`;
}

/**
 * How badly each position needs help: the gain from a hypothetical
 * replacement-level-plus player at that position.
 */
export function needsByPosition(ctx, rosterId) {
  const myPlayers = ctx.playersOn(rosterId);
  const valueFn = (p) => ctx.valueOf(p.player_id);
  const base = solveLineup(ctx.slots, myPlayers, valueFn).total;

  // Only positions this league actually starts. A league with no kicker slot
  // should not be told it is "covered at K" — the position does not exist here.
  const demand = slotDemand(ctx.slots);

  const out = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    if (!demand[pos]) continue;
    const repl = ctx.valuations.replacement[pos] ?? 0;
    const ghost = { player_id: `__ghost_${pos}`, position: pos, fantasy_positions: [pos], name: `Replacement ${pos}` };
    const values = { [`__ghost_${pos}`]: repl };
    const withGhost = solveLineup(ctx.slots, [...myPlayers, ghost],
      (p) => (values[p.player_id] !== undefined ? values[p.player_id] : ctx.valueOf(p.player_id))).total;
    out.push({
      position: pos,
      gain: round2(withGhost - base),
      count: myPlayers.filter((p) => p.position === pos).length,
    });
  }
  out.sort((a, b) => b.gain - a.gain);
  return out;
}

// ---------------------------------------------------------------- usage risers

const RISER_POSITIONS = new Set(['RB', 'WR', 'TE']);
const RISER_LIMIT = 30;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const finite = (xs) => xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x));

/**
 * Players whose role grew over the last two completed weeks: snap share and
 * target share against the weeks before, and the change in fantasy points.
 * `sample` says how many games sit behind each side, so a one-game blip reads as one.
 */
export async function usageRisers(ctx, opts = {}) {
  const done = (ctx.completedWeeks || []).slice();
  if (done.length < 3) {
    return { available: false, message: 'Usage trends need at least three played weeks. This fills in after week 3.', free: [], all: [] };
  }
  const usage = opts.usage || await getWeeklyUsage(ctx.season);
  const snaps = opts.snaps || await getSnapCounts(ctx.season);
  if (!usage?.available && !snaps?.available) {
    return { available: false, message: 'The snap and target files could not be loaded just now.', free: [], all: [] };
  }
  const recent = done.slice(-2);
  const first = recent[0];
  const isRecent = (w) => recent.includes(w);
  const isBefore = (w) => w < first;
  const ids = ctx.candidateIds ? [...ctx.candidateIds] : [];
  const out = [];

  for (const id of ids) {
    const p = ctx.playerOf(id);
    if (!p || !RISER_POSITIONS.has(p.position)) continue;
    const gsis = ctx.idMaps?.sleeperToGsis?.get(id);
    const pfr = ctx.idMaps?.sleeperToPfr?.get(id);
    const uRows = gsis ? usage?.byPlayer?.get(gsis) || [] : [];
    const sRows = pfr ? snaps?.byPfr?.get(pfr) || [] : [];

    const snapNow = mean(finite(sRows.filter((r) => isRecent(r.week)).map((r) => r.offensePct)));
    const snapPrev = mean(finite(sRows.filter((r) => isBefore(r.week)).map((r) => r.offensePct)));
    const tgtNow = mean(finite(uRows.filter((r) => isRecent(r.week)).map((r) => r.targetShare)));
    const tgtPrev = mean(finite(uRows.filter((r) => isBefore(r.week)).map((r) => r.targetShare)));
    const games = (ctx.resultsByPlayer?.get(id) || []).filter((g) => g.played && !g.onBye);
    const ptsNow = mean(games.filter((g) => isRecent(g.week)).map((g) => g.points));
    const ptsPrev = mean(games.filter((g) => isBefore(g.week)).map((g) => g.points));

    const snapDelta = snapNow !== null && snapPrev !== null ? snapNow - snapPrev : null;
    const tgtDelta = tgtNow !== null && tgtPrev !== null && p.position !== 'RB' ? tgtNow - tgtPrev : null;
    if (snapDelta === null && tgtDelta === null) continue;
    const score = (snapDelta || 0) + 2 * (tgtDelta || 0);
    // A real role change, on a player who is actually on the field.
    if (score < 0.06) continue;
    if ((snapNow ?? 0) < 0.2 && (tgtNow ?? 0) < 0.08) continue;

    const owner = ctx.ownerOf?.get(id);
    out.push({
      ...describe(ctx, p),
      isFreeAgent: owner === undefined,
      ownedBy: owner === undefined ? null : (ctx.teamName && ctx.rosterOf ? ctx.teamName(ctx.rosterOf(owner)) : null),
      snap: { now: snapNow, before: snapPrev, delta: snapDelta },
      target: { now: tgtNow, before: tgtPrev, delta: tgtDelta },
      points: { now: ptsNow === null ? null : round2(ptsNow), before: ptsPrev === null ? null : round2(ptsPrev),
        change: ptsNow !== null && ptsPrev !== null ? round2(ptsNow - ptsPrev) : null },
      sample: {
        recent: Math.max(sRows.filter((r) => isRecent(r.week)).length, uRows.filter((r) => isRecent(r.week)).length),
        before: Math.max(sRows.filter((r) => isBefore(r.week)).length, uRows.filter((r) => isBefore(r.week)).length),
      },
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return {
    available: true,
    weeks: { recent, before: done.filter(isBefore) },
    free: out.filter((r) => r.isFreeAgent).slice(0, RISER_LIMIT),
    all: out.slice(0, RISER_LIMIT),
  };
}
