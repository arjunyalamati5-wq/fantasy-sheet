// Opponent scouting: who a rival will probably start, where that lineup is
// thin next to the rest of the league, how they spend their waiver budget, and
// which free agents are worth bidding against them for. Any team can be
// scouted; the default is this week's opponent.

import { solveLineup, scoreSetLineup, slotLabel } from '../lineup.js';
import { simulateMatchup, lineupToDraws } from '../montecarlo.js';
import { round2 } from '../scoring.js';
import { getTransactions } from '../sleeper.js';
import { describe, setStarters } from './lineup.js';
import { floorCeiling } from './floors.js';
import { needsByPosition } from './waivers.js';

const WEAK_BELOW = 1.0;     // points under the league median at a slot before it is called weak
const EVEN_WITHIN = 0.5;    // head-to-head gaps smaller than this read as even
const CANDIDATES = 60;      // free agents tried against both lineups
const LIST_ROWS = 8;
const SERIOUS = new Set(['Out', 'IR', 'PUP', 'Doubtful', 'Sus', 'NA', 'DNR']);

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pctText = (f) => (f * 100 < 1 ? 'under 1%' : `${Math.round(f * 100)}%`);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Which team to scout. Blank means this week's opponent (or null with no
 * pairing yet). Anything else must be a roster id in this league.
 * Throws an error with .status 400 (malformed) or 404 (not in this league).
 */
export function resolveScoutRoster(ctx, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim();
  if (!/^\d{1,4}$/.test(text)) throw httpError(400, 'That roster is not valid.');
  const roster = (ctx.rosters || []).find((r) => String(r.roster_id) === text);
  if (!roster) throw httpError(404, 'That team is not in this league.');
  return roster.roster_id;
}

/** This week's opponent's roster id, from the live pairings; null when none. */
export function opponentOf(ctx, rosterId = ctx.myRoster?.roster_id) {
  const entries = ctx.currentMatchups || [];
  const mine = entries.find((m) => String(m.roster_id) === String(rosterId));
  if (!mine || mine.matchup_id == null) return null;
  const other = entries.find((m) => m.matchup_id === mine.matchup_id && String(m.roster_id) !== String(rosterId));
  return other ? other.roster_id : null;
}

// ------------------------------------------------------------------ lineups

/**
 * The lineup a manager is likely to start: the one set in Sleeper when it has
 * any starter in it, else the best legal lineup by projection.
 */
export function likelyLineup(ctx, rosterId) {
  const pointsFor = (p) => ctx.pointsFor(p.player_id);
  const ids = safeStarters(ctx, rosterId);
  if (ids.some((id) => id && id !== '0')) {
    const set = scoreSetLineup(ctx.slots, ids, pointsFor, (id) => ctx.playerOf(id));
    return { source: 'set', assignments: set.assignments, total: set.total };
  }
  const best = ctx.solveFor(rosterId, pointsFor);
  return { source: 'projected', assignments: best.assignments, total: best.total };
}

function safeStarters(ctx, rosterId) {
  try { return setStarters(ctx, rosterId) || []; } catch { return []; }
}

/**
 * Per slot, how one lineup compares with the league median at that slot.
 * Starters of the same slot type are ranked high to low (WR1, WR2, ...) in
 * every team, and the median is taken across teams at each rank, so a team is
 * judged against what a typical team puts in its WR2, not in its whole WR group.
 * @param {{slot:string,points:number}[]} target  the team's slot assignments
 * @param {{slot:string,points:number}[][]} all   every team's assignments, target included
 */
export function weakSpots(target, all) {
  const rankOf = (assignments) => {
    const bySlot = new Map();
    assignments.forEach((a, i) => {
      if (!bySlot.has(a.slot)) bySlot.set(a.slot, []);
      bySlot.get(a.slot).push({ i, points: Number(a.points) || 0 });
    });
    const out = new Map(); // `${slot}|${rank}` -> { i, points }
    for (const [slot, list] of bySlot) {
      list.sort((x, y) => y.points - x.points || x.i - y.i).forEach((x, rank) => out.set(`${slot}|${rank}`, { ...x, slot, rank }));
    }
    return out;
  };
  const targetRanks = rankOf(target);
  const pool = new Map(); // key -> [points]
  for (const a of all) {
    for (const [key, x] of rankOf(a)) {
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push(x.points);
    }
  }
  const slotCounts = new Map();
  for (const a of target) slotCounts.set(a.slot, (slotCounts.get(a.slot) || 0) + 1);
  const rows = [];
  for (const [key, x] of targetRanks) {
    const med = median(pool.get(key) || []);
    const delta = med === null ? null : round2(x.points - med);
    const many = slotCounts.get(x.slot) > 1;
    rows.push({
      index: x.i,
      slot: x.slot,
      slotLabel: slotLabel(x.slot) + (many ? ` ${x.rank + 1}` : ''),
      points: round2(x.points),
      leagueMedian: med === null ? null : round2(med),
      delta,
      weak: delta !== null && delta <= -WEAK_BELOW,
    });
  }
  return rows.sort((a, b) => a.index - b.index);
}

function edgeWords(diff) {
  if (!Number.isFinite(diff)) return 'No read';
  if (Math.abs(diff) < EVEN_WITHIN) return 'Even';
  return diff > 0 ? `You by ${diff.toFixed(1)}` : `They by ${(-diff).toFixed(1)}`;
}

/** Slot-by-slot: my starter against theirs, with the edge in words. */
export function headToHead(ctx, mine, theirs) {
  return ctx.slots.map((slot, i) => {
    const a = mine.assignments[i];
    const b = theirs.assignments[i];
    const diff = round2((a?.points || 0) - (b?.points || 0));
    return {
      slot, slotLabel: slotLabel(slot),
      mine: a?.player ? { ...describe(ctx, a.player), points: round2(a.points) } : null,
      theirs: b?.player ? { ...describe(ctx, b.player), points: round2(b.points) } : null,
      diff,
      edge: edgeWords(diff),
    };
  });
}

function lineupRows(ctx, lineup, weak) {
  return lineup.assignments.map((a, i) => {
    const w = weak.find((x) => x.index === i);
    const p = a.player ? describe(ctx, a.player) : null;
    const fc = p ? floorCeiling(ctx, p.position, a.points) : { floor: 0, ceiling: 0 };
    return {
      slot: a.slot, slotLabel: slotLabel(a.slot),
      empty: !a.player,
      illegal: Boolean(a.illegal),
      player: p ? { ...p, projected: round2(a.points) } : null,
      points: round2(a.points),
      floor: fc.floor, ceiling: fc.ceiling,
      leagueMedian: w?.leagueMedian ?? null,
      delta: w?.delta ?? null,
      weak: Boolean(w?.weak),
      risk: p ? riskWords(p) : (a.player ? null : 'Empty slot'),
    };
  });
}

/** Injury, bye or empty-slot wording for a starter, or null when he looks fine. */
function riskWords(p) {
  if (p.onBye) return 'On bye, scores nothing';
  const s = p.injury?.status;
  if (!s) return null;
  const part = p.injury.bodyPart ? ` (${p.injury.bodyPart})` : '';
  return SERIOUS.has(s) ? `${s}${part}, may not play` : `${s}${part}, a game-time call`;
}

function benchDepth(ctx, rosterId, lineup) {
  const used = new Set(lineup.assignments.map((a) => a.player?.player_id).filter(Boolean));
  const bench = ctx.playersOn(rosterId).filter((p) => !used.has(p.player_id));
  const starts = new Set(ctx.slots.flatMap((s) => (s === 'FLEX' ? ['RB', 'WR', 'TE'] : s === 'SUPER_FLEX' ? ['QB', 'RB', 'WR', 'TE'] : [s])));
  const out = [];
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    if (!starts.has(pos)) continue;
    const here = bench.filter((p) => p.position === pos).sort((a, b) => ctx.pointsFor(b.player_id) - ctx.pointsFor(a.player_id));
    const best = here[0] ? describe(ctx, here[0]) : null;
    out.push({
      position: pos, count: here.length, best,
      note: here.length === 0 ? `No ${pos} on the bench. One injury leaves a hole.`
        : `${here.length} on the bench; the best is ${best.name} at ${best.projected.toFixed(1)}.`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ FAAB

/**
 * What a team's claims say about how it bids, from a season of transactions.
 * @param {Array<Array>} batches  getTransactions results, one array per week
 * @param {string|number} rosterId
 * @param {{budget:number|null, remaining:number|null, positionOf:(id)=>string|undefined, needs?:string[]}} opts
 */
export function faabProfile(batches, rosterId, { budget = null, remaining = null, positionOf = () => undefined, needs = [] } = {}) {
  const rid = String(rosterId);
  const all = [];
  for (const batch of batches) {
    for (const t of batch || []) {
      if (!t || t.type !== 'waiver') continue;
      if (t.status !== 'complete' && t.status !== 'failed') continue;
      const raw = t.settings?.waiver_bid;
      if (raw == null || raw === '') continue;
      const bid = Number(raw);
      if (!Number.isFinite(bid)) continue;
      const who = (t.roster_ids || [])[0];
      for (const pid of Object.keys(t.adds || {})) {
        all.push({ week: t.leg, rosterId: String(who ?? t.adds[pid]), playerId: pid, bid, won: t.status === 'complete', position: positionOf(pid) });
      }
    }
  }
  const mine = all.filter((c) => c.rosterId === rid);
  const won = mine.filter((c) => c.won);
  const lost = mine.filter((c) => !c.won);

  // Margins we can see: another team's failed bid on the same player in the same week.
  const rivals = (c) => all.filter((x) => x.playerId === c.playerId && x.week === c.week && x.rosterId !== c.rosterId);
  const overbids = [];
  for (const c of won) {
    const losers = rivals(c).filter((x) => !x.won).map((x) => x.bid);
    if (losers.length) overbids.push(c.bid - Math.max(...losers));
  }
  const shortfalls = [];
  for (const c of lost) {
    const winner = rivals(c).find((x) => x.won);
    if (winner) shortfalls.push(winner.bid - c.bid);
  }

  const byPosition = {};
  for (const c of mine) {
    if (!c.position) continue;
    const row = byPosition[c.position] || (byPosition[c.position] = { claims: 0, won: 0, bids: [], winningBids: [] });
    row.claims++;
    row.bids.push(c.bid);
    if (c.won) { row.won++; row.winningBids.push(c.bid); }
  }
  for (const row of Object.values(byPosition)) {
    row.avgBid = round2(mean(row.bids));
    row.avgWinningBid = row.winningBids.length ? round2(mean(row.winningBids)) : null;
    delete row.bids; delete row.winningBids;
  }

  const winBids = won.map((c) => c.bid);
  const allBids = mine.map((c) => c.bid);
  const onNeeds = mine.filter((c) => needs.includes(c.position)).length;
  const spent = winBids.reduce((a, b) => a + b, 0);
  const avgBid = mean(allBids);
  const avgOverbid = mean(overbids);
  const profile = {
    claims: mine.length,
    won: won.length,
    lost: lost.length,
    totalSpent: spent,
    budget,
    remaining,
    avgWinningBid: winBids.length ? round2(mean(winBids)) : null,
    maxWinningBid: winBids.length ? Math.max(...winBids) : null,
    avgBid: avgBid === null ? null : round2(avgBid),
    avgBidPct: avgBid !== null && budget > 0 ? round2(avgBid / budget) : null,
    avgOverbid: avgOverbid === null ? null : round2(avgOverbid),
    overbidSample: overbids.length,
    avgShortfall: shortfalls.length ? round2(mean(shortfalls)) : null,
    shortfallSample: shortfalls.length,
    byPosition,
    onMyNeeds: onNeeds,
    myNeeds: needs,
  };
  profile.text = profileSentence(profile);
  return profile;
}

function profileSentence(p) {
  if (!p.claims) return 'No waiver claims from this team yet this season, so there is no bidding history to go on.';
  const parts = [`Won ${p.won} of ${p.claims} claims`];
  if (p.won) parts[0] += `, spending ${money(p.totalSpent)}${p.budget ? ` of ${money(p.budget)}` : ''}`;
  parts[0] += '.';
  if (p.avgBidPct != null) parts.push(`They bid ${pctText(p.avgBidPct)} of the budget on average.`);
  if (p.avgOverbid != null) parts.push(`When a rival also bid, they cleared the next bid by ${money(Math.round(p.avgOverbid))} on average.`);
  if (p.avgShortfall != null) parts.push(`When they lost, they were short by ${money(Math.round(p.avgShortfall))} on average.`);
  if (p.claims && p.myNeeds.length) parts.push(`${p.onMyNeeds} of their ${p.claims} claims were at positions you need (${p.myNeeds.join(', ')}).`);
  return parts.join(' ');
}

/**
 * A bid to beat a rival's likely bid.
 * Their likely bid is their usual winning bid at the position (else overall,
 * else their average share of the budget), never more than they have left.
 * Ours adds a margin on top (their usual overbid when known, else 10% of it),
 * and is capped at what we have left.
 * @returns {{likelyTheirs:number|null, suggested:number|null, canBeat:boolean, theyCanBid:boolean, text:string}}
 */
export function suggestBeatBid({ position, profile, theirRemaining, myRemaining, minBid = 0 }) {
  const pos = profile?.byPosition?.[position];
  let likely = pos?.avgWinningBid ?? profile?.avgWinningBid ?? null;
  if (likely === null && profile?.avgBidPct != null && profile.budget > 0) likely = profile.avgBidPct * profile.budget;
  if (likely === null) likely = minBid;
  likely = Math.round(likely);

  if (Number.isFinite(theirRemaining) && theirRemaining < minBid) {
    const s = Math.min(myRemaining, Math.max(minBid, 0));
    return {
      likelyTheirs: null, suggested: s, canBeat: true, theyCanBid: false,
      text: `They have ${money(theirRemaining)} left, under the ${money(minBid)} minimum, so they cannot bid. ${money(s)} wins it.`,
    };
  }
  const ceiling = Number.isFinite(theirRemaining) ? Math.min(likely, theirRemaining) : likely;
  const margin = Math.max(1, Math.round(profile?.avgOverbid != null && profile.avgOverbid > 0 ? profile.avgOverbid : ceiling * 0.1));
  const wanted = Math.max(minBid, ceiling + margin);
  const suggested = Math.min(myRemaining, wanted);
  const canBeat = suggested > ceiling;
  const leftBit = Number.isFinite(theirRemaining) ? `They have ${money(theirRemaining)} left` : 'Their budget is unknown';
  const pctBit = profile?.avgBidPct != null ? ` and bid ${pctText(profile.avgBidPct)} of budget on average` : '';
  const tail = canBeat
    ? `bid ${money(suggested)} to beat their likely ${money(ceiling)}.`
    : `you have only ${money(myRemaining)}, so you cannot clearly beat their likely ${money(ceiling)}.`;
  return {
    likelyTheirs: ceiling, suggested, canBeat, theyCanBid: true,
    text: `${leftBit}${pctBit}; ${tail}`,
  };
}

// ------------------------------------------------------------------ contested

function lineupGains(ctx, rosterId, candidates) {
  const players = ctx.playersOn(rosterId);
  const fn = (p) => ctx.pointsFor(p.player_id);
  const base = solveLineup(ctx.slots, players, fn).total;
  const out = new Map();
  for (const c of candidates) {
    out.set(c.player_id, round2(solveLineup(ctx.slots, [...players, c], fn).total - base));
  }
  return out;
}

function faabNumbers(ctx, rosterId) {
  const s = ctx.league?.settings || {};
  if (Number(s.waiver_type) !== 2) return null;
  const budget = s.waiver_budget != null && Number.isFinite(Number(s.waiver_budget)) ? Number(s.waiver_budget) : 100;
  const used = Number(ctx.rosterOf(rosterId)?.settings?.waiver_budget_used) || 0;
  return { budget, used, remaining: Math.max(0, budget - used), minBid: Number(s.waiver_bid_min) || 0 };
}

// ------------------------------------------------------------------ report

export async function oppScoutReport(ctx, opts = {}) {
  const myId = ctx.myRoster?.roster_id;
  const targetId = opts.rosterId != null && opts.rosterId !== '' ? opts.rosterId : opponentOf(ctx, myId);
  if (targetId == null) {
    return { error: 'No opponent found for this week yet. Sleeper publishes pairings shortly before kickoff; you can still pick any team to scout.' };
  }
  const target = ctx.rosterOf(targetId);
  if (!target) return { error: 'That team is not in this league.' };
  if (String(targetId) === String(myId)) return { error: 'That is your own team. Pick another team to scout.' };

  const isOpponent = String(opponentOf(ctx, myId)) === String(targetId);
  const lineups = new Map();
  for (const r of ctx.rosters) lineups.set(String(r.roster_id), likelyLineup(ctx, r.roster_id));
  const theirs = lineups.get(String(targetId));
  const mine = lineups.get(String(myId)) || likelyLineup(ctx, myId);

  const weak = weakSpots(theirs.assignments, [...lineups.values()].map((l) => l.assignments));
  const lineup = lineupRows(ctx, theirs, weak);

  // Win probability: the same simulation the matchup page runs, on the two lineups.
  const drawsA = lineupToDraws(mine.assignments, ctx.gameLog);
  const drawsB = lineupToDraws(theirs.assignments, ctx.gameLog);
  const sim = simulateMatchup(drawsA, drawsB, { runs: opts.runs || 10_000, seed: 4242 + Number(targetId) });

  // A bad week and a good week for the whole team (10th and 90th percentile of the simulation);
  // adding up every starter's own floor would describe a week where all of them flop at once.
  const flc = () => ({ floor: sim.scoreB.floor, ceiling: sim.scoreB.ceiling });
  const h2h = headToHead(ctx, mine, theirs);
  const weakRows = weak.filter((w) => w.weak).sort((a, b) => a.delta - b.delta);
  const risks = lineup.filter((r) => r.risk).map((r) => ({ slotLabel: r.slotLabel, name: r.player?.name || null, risk: r.risk }));

  // Positions I need and they need, from a replacement-level add.
  const theirNeeds = needsByPosition(ctx, targetId).filter((n) => n.gain > 0.05);
  const myNeeds = needsByPosition(ctx, myId).filter((n) => n.gain > 0.05);

  // FAAB
  const faab = faabNumbers(ctx, targetId);
  const mineFaab = faabNumbers(ctx, myId);
  let profile = null;
  if (faab) {
    let batches = opts.transactions;
    if (!batches) {
      const weeks = [...(ctx.completedWeeks || []), ctx.week];
      batches = await Promise.all(weeks.map((w) => getTransactions(ctx.league.league_id, w).then((b) => b || [])));
    }
    profile = faabProfile(batches, targetId, {
      budget: faab.budget, remaining: faab.remaining,
      positionOf: (id) => ctx.playerOf(id)?.position,
      needs: myNeeds.slice(0, 2).map((n) => n.position),
    });
    profile.spentPerRoster = faab.used;
  }

  // Free agents that would improve both lineups, or only theirs.
  const pool = ctx.freeAgents()
    .filter((p) => p.name && !/duplicate/i.test(p.name) && ctx.pointsFor(p.player_id) > 0)
    .sort((a, b) => Math.max(ctx.pointsFor(b.player_id), ctx.valueOf(b.player_id)) - Math.max(ctx.pointsFor(a.player_id), ctx.valueOf(a.player_id)))
    .slice(0, CANDIDATES);
  const myGain = lineupGains(ctx, myId, pool);
  const theirGain = lineupGains(ctx, targetId, pool);
  const decorate = (p) => {
    const gainTheirs = theirGain.get(p.player_id) || 0;
    const gainMine = myGain.get(p.player_id) || 0;
    const bid = mineFaab && profile
      ? suggestBeatBid({ position: p.position, profile, theirRemaining: faab.remaining, myRemaining: mineFaab.remaining, minBid: mineFaab.minBid })
      : null;
    return { ...describe(ctx, p), gainMine, gainTheirs, bid };
  };
  const rowsFor = (p) => decorate(p);
  const contested = pool.filter((p) => (myGain.get(p.player_id) || 0) > 0.05 && (theirGain.get(p.player_id) || 0) > 0.05)
    .map(rowsFor).sort((a, b) => b.gainTheirs + b.gainMine - (a.gainTheirs + a.gainMine)).slice(0, LIST_ROWS);
  const blocks = pool.filter((p) => (theirGain.get(p.player_id) || 0) > 0.05 && !((myGain.get(p.player_id) || 0) > 0.05))
    .map(rowsFor).sort((a, b) => b.gainTheirs - a.gainTheirs).slice(0, LIST_ROWS);

  const winPct = Math.round(sim.winProb * 100);
  return {
    week: ctx.week,
    rosterId: target.roster_id,
    teamName: ctx.teamName(target),
    isOpponent,
    record: recordOf(target),
    source: theirs.source,
    sourceNote: theirs.source === 'set'
      ? 'This is the lineup they have set in Sleeper. They can still change it until each game kicks off.'
      : 'They have not set a lineup yet, so this is their best lineup by projection.',
    mine: { teamName: ctx.teamName(ctx.rosterOf(myId)), projected: mine.total, source: mine.source },
    projected: theirs.total,
    ...flc(),
    lineup,
    risks,
    weakSpots: weakRows,
    weakSummary: weakRows.length
      ? `Weakest at ${weakRows.slice(0, 3).map((w) => `${w.slotLabel} (${Math.abs(w.delta).toFixed(1)} under the league median)`).join(', ')}.`
      : 'No slot is clearly below the league median. This lineup is solid across the board.',
    bench: benchDepth(ctx, targetId, theirs),
    headToHead: h2h,
    winProbability: sim.winProb,
    projectedScores: { me: sim.projA, them: sim.projB },
    margin: sim.margin,
    headline: `You win ${winPct} of every 100 simulated versions of this matchup, ${mine.total.toFixed(1)} to ${theirs.total.toFixed(1)} on projection.`,
    theirNeeds: theirNeeds.slice(0, 4),
    myNeeds: myNeeds.slice(0, 4),
    faab: faab ? { budget: faab.budget, remaining: faab.remaining, mineRemaining: mineFaab?.remaining ?? null, minBid: faab.minBid } : null,
    faabProfile: profile,
    faabNote: faab ? null : 'This league does not use a FAAB budget, so there are no bids to read. Waiver priority decides claims.',
    contested,
    blocks,
  };
}

function recordOf(roster) {
  const s = roster.settings || {};
  return { wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0 };
}
