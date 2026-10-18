import { round2 } from '../scoring.js';
import { eligiblePositions, solveLineup } from '../lineup.js';
import { describe } from './lineup.js';
import { tradeOdds } from './oddsim.js';
import { dynastyTradeRead, leagueKind } from './dynasty.js';

// A trade is graded on what it does to your STARTING LINEUP, not on raw point
// totals. Swapping your bench for their bench changes nothing you can score.
//
// We also compute the effect on their lineup, because a trade they would never
// accept is worth exactly nothing.

const MIN_GAIN = 0.6;      // points/week I must gain for a target to be worth listing
const MAX_THEIR_COST = 2.5; // points/week they may lose before they simply say no

/**
 * Analyse a specific proposal.
 * @param {string[]} give  my player ids going out
 * @param {string[]} get   their player ids coming in
 */
export function analyzeTrade(ctx, { rosterId = ctx.myRoster?.roster_id, partnerId, give = [], get = [], market }) {
  const mine = ctx.rosterOf(rosterId);
  const theirs = ctx.rosterOf(partnerId);
  if (!mine) return { error: 'No roster found' };
  if (!theirs) return { error: 'Pick a trade partner first.' };
  if (give.length === 0 && get.length === 0) return { error: 'Add at least one player to each side.' };

  const giveSet = new Set(give);
  const getSet = new Set(get);
  const valueFn = (p) => ctx.valueOf(p.player_id);

  const myBefore = ctx.playersOn(rosterId);
  const myAfter = [...myBefore.filter((p) => !giveSet.has(p.player_id)),
    ...get.map((id) => ctx.playerOf(id)).filter(Boolean)];
  const theirBefore = ctx.playersOn(partnerId);
  const theirAfter = [...theirBefore.filter((p) => !getSet.has(p.player_id)),
    ...give.map((id) => ctx.playerOf(id)).filter(Boolean)];

  const mineBeforeLineup = solveWith(ctx, myBefore, valueFn);
  const mineAfterLineup = solveWith(ctx, myAfter, valueFn);
  const theirBeforeLineup = solveWith(ctx, theirBefore, valueFn);
  const theirAfterLineup = solveWith(ctx, theirAfter, valueFn);

  const myDelta = round2(mineAfterLineup.total - mineBeforeLineup.total);
  const theirDelta = round2(theirAfterLineup.total - theirBeforeLineup.total);

  return {
    rosterId,
    partnerId,
    myTeam: ctx.teamName(mine),
    theirTeam: ctx.teamName(theirs),
    give: give.map((id) => withRos(ctx, ctx.playerOf(id))).filter(Boolean),
    get: get.map((id) => withRos(ctx, ctx.playerOf(id))).filter(Boolean),
    me: {
      before: mineBeforeLineup.total,
      after: mineAfterLineup.total,
      delta: myDelta,
      lineupChanges: lineupDiff(ctx, mineBeforeLineup, mineAfterLineup),
    },
    them: {
      before: theirBeforeLineup.total,
      after: theirAfterLineup.total,
      delta: theirDelta,
      lineupChanges: lineupDiff(ctx, theirBeforeLineup, theirAfterLineup),
    },
    grade: gradeFor(myDelta),
    acceptance: acceptanceFor(theirDelta),
    depthWarnings: depthWarnings(ctx, myBefore, myAfter, [...giveSet, ...getSet]),
    verdict: verdict(ctx, myDelta, theirDelta),
    line: verdictLine(myDelta, theirDelta),
    market: marketSide(market, give, get, gradeFor(myDelta).letter),
  };
}

// ---------------------------------------------------------------- Market second opinion

/** % the market says I gain, relative to what I give. Null when nothing is sent. */
export function marketGapPct(giveTotal, getTotal) {
  if (!(giveTotal > 0)) return null;
  return Math.round(((getTotal - giveTotal) / giveTotal) * 1000) / 10;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** Plain-English read of a market gap (percent, my point of view). */
export function marketSentence(giveTotal, getTotal) {
  const pct = marketGapPct(giveTotal, getTotal);
  const head = `By market value you give ${fmt(giveTotal)} and get ${fmt(getTotal)}`;
  if (pct === null) return `${head}: there is nothing on your side to compare against.`;
  const a = Math.abs(pct);
  if (a < 3) return `${head}: the market sees this as an even swap.`;
  const who = pct > 0 ? 'you' : 'them';
  const size = a < 10 ? 'a slight win' : a < 25 ? 'a clear win' : 'a lopsided win';
  return `${head}: the market sees this as ${size} for ${who}.`;
}

/**
 * Market side of a trade: per-player values, totals, a sentence. Null when the
 * market feed is down (the lineup grade still stands on its own).
 */
export function marketSide(market, give, get, letter) {
  if (!market) return null;
  const pick = (ids) => ids.map((id) => {
    const m = market.get(String(id));
    return { player_id: id, value: m ? m.value : null, rank: m?.rank ?? null, posRank: m?.posRank ?? null };
  });
  const g = pick(give); const r = pick(get);
  const sum = (l) => l.reduce((t, x) => t + (x.value || 0), 0);
  const giveTotal = sum(g); const getTotal = sum(r);
  const missing = [...g, ...r].filter((x) => x.value === null).length;
  const gapPct = marketGapPct(giveTotal, getTotal);
  let sentence = marketSentence(giveTotal, getTotal);
  if (missing) sentence += ` ${missing} player${missing === 1 ? ' has' : 's have'} no market value and count${missing === 1 ? 's' : ''} as zero.`;
  const lineup = letter ? `Your lineup says ${letter}` : null;
  const second = gapPct === null ? null
    : Math.abs(gapPct) < 3 ? 'the market calls it even'
      : `the market says you ${gapPct > 0 ? 'win' : 'lose'} by ${Math.abs(Math.round(gapPct))}%`;
  return {
    give: g, get: r, giveTotal, getTotal, gapPct, missing, sentence,
    compare: lineup && second ? `${lineup}; ${second}.` : null,
    source: 'FantasyCalc',
  };
}

/** Attach market values to a list of described players (non-destructive). */
export function withMarket(players, market) {
  if (!market) return players;
  return players.map((p) => {
    const m = market.get(String(p.player_id));
    return m ? { ...p, market: m.value, marketRank: m.rank, marketPosRank: m.posRank } : p;
  });
}

function withRos(ctx, p) {
  return p ? { ...describe(ctx, p), rosValue: rosValue(ctx, p) } : null;
}

/** Solve a lineup for an arbitrary player list (a roster as it would look after a trade). */
function solveWith(ctx, players, valueFn) {
  return solveLineup(ctx.slots, players, valueFn);
}

function lineupDiff(ctx, before, after) {
  const beforeIds = new Set(before.assignments.filter((a) => a.player).map((a) => a.player.player_id));
  const afterIds = new Set(after.assignments.filter((a) => a.player).map((a) => a.player.player_id));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id));
  return {
    nowStarting: added.map((id) => describe(ctx, ctx.playerOf(id))).filter(Boolean),
    noLongerStarting: removed.map((id) => describe(ctx, ctx.playerOf(id))).filter(Boolean),
  };
}

/**
 * Depth warnings, but only for positions this trade actually touches.
 * Comparing before and after counts is the whole point: warning that you are
 * "thin at TE" when the trade never mentioned a TE is noise.
 */
export function depthWarnings(ctx, before, after, touchedIds) {
  const touchedPositions = new Set(
    touchedIds.map((id) => ctx.playerOf(id)?.position).filter(Boolean)
  );
  // Only slots that position alone can fill: a FLEX takes a WR or RB just as
  // well, so it never obliges you to roster a second TE.
  const required = (pos) => ctx.slots.filter((slot) => {
    const elig = eligiblePositions(slot);
    return elig.length === 1 && elig[0] === pos;
  }).length;
  const countBy = (list, pos) => list.filter((p) => p.position === pos).length;

  const warnings = [];
  for (const pos of touchedPositions) {
    const b = countBy(before, pos);
    const a = countBy(after, pos);
    if (a >= b) continue; // this trade does not thin the position

    const needed = Math.max(1, required(pos));
    if (a <= needed) {
      warnings.push({
        position: pos,
        before: b,
        after: a,
        needed,
        message: a < needed
          ? `This leaves you with ${a} ${pos}${a === 1 ? '' : 's'} for ${needed} starting spot${needed === 1 ? '' : 's'}. You would have to start someone off waivers.`
          : `This leaves you with exactly ${a} ${pos}${a === 1 ? '' : 's'} for ${needed} starting spot${needed === 1 ? '' : 's'}. One injury or bye and you are stuck.`,
      });
    }
  }
  return warnings;
}

function gradeFor(delta) {
  if (delta >= 4) return { letter: 'A', label: 'Clear win' };
  if (delta >= 2) return { letter: 'B', label: 'Good for you' };
  if (delta >= 0.5) return { letter: 'C+', label: 'Slight edge to you' };
  if (delta > -0.5) return { letter: 'C', label: 'Roughly even' };
  if (delta > -2) return { letter: 'D', label: 'Slightly against you' };
  return { letter: 'F', label: 'Bad for you' };
}

function acceptanceFor(theirDelta) {
  if (theirDelta >= 0.5) return { level: 'easy', label: 'They gain too', likelihood: 'Likely accepted' };
  if (theirDelta > -1) return { level: 'fair', label: 'Close to even for them', likelihood: 'Worth asking' };
  if (theirDelta > -2.5) return { level: 'hard', label: 'They lose a little', likelihood: 'Needs a sweetener or a sales pitch' };
  return { level: 'nope', label: 'They lose badly', likelihood: 'They will almost certainly decline' };
}

// ---------------------------------------------------------------- Handshake verdict line

/** Points a week either lineup must move before we call it better or worse. */
export const NEUTRAL_BAND = 0.5;

/**
 * One line to say how a deal looks from both sides, from the change in each
 * lineup (points a week). Within +-0.5 a lineup counts as unchanged.
 * @returns {{key: string, text: string}}
 */
export function verdictLine(myDelta, theirDelta, band = NEUTRAL_BAND) {
  const meUp = myDelta >= band; const meDown = myDelta <= -band;
  const themUp = theirDelta >= band; const themDown = theirDelta <= -band;
  if (meUp && themUp) return { key: 'both', text: 'Both lineups get better. Easy pitch.' };
  if (meUp && themDown) {
    return { key: 'counter', text: `Good for you, but their lineup drops ${Math.abs(theirDelta).toFixed(1)}. Expect a counter.` };
  }
  if (meUp) return { key: 'you', text: 'Good for you and close to even for them. Worth a try.' };
  if (themUp && !meDown) return { key: 'them', text: 'Helps them more than you. Pass unless your playoff weeks jump.' };
  if (themUp && meDown) return { key: 'them', text: `Helps them more than you, and your lineup drops ${Math.abs(myDelta).toFixed(1)}. Pass.` };
  if (meDown && themDown) return { key: 'lose', text: 'Hurts both lineups. Not worth doing.' };
  if (meDown) return { key: 'lose', text: `Your lineup drops ${Math.abs(myDelta).toFixed(1)} and theirs barely moves. Pass.` };
  return { key: 'neutral', text: 'Close to neutral for your lineup.' };
}

/**
 * The full trade report: the lineup grade, plus playoff odds before and after
 * (trades take effect next week) and, in dynasty and keeper leagues, how the
 * deal reads for this season against the future. Both extras fail soft.
 * @param {object} body  { rosterId, partnerId, give, get, givePicks, getPicks }
 * @param {object} extra { market, dynastyMarket, tradedPicks, remainingWeeks }
 */
export async function fullTradeReport(ctx, body, extra = {}) {
  const rosterId = body.rosterId || ctx.myRoster?.roster_id;
  const report = analyzeTrade(ctx, {
    market: extra.market, rosterId, partnerId: body.partnerId, give: body.give || [], get: body.get || [],
  });
  if (report.error) return report;

  const giveSet = new Set(body.give || []); const getSet = new Set(body.get || []);
  const myAfter = [...ctx.playersOn(rosterId).filter((p) => !giveSet.has(p.player_id)),
    ...(body.get || []).map((id) => ctx.playerOf(id)).filter(Boolean)];
  const theirAfter = [...ctx.playersOn(body.partnerId).filter((p) => !getSet.has(p.player_id)),
    ...(body.give || []).map((id) => ctx.playerOf(id)).filter(Boolean)];
  try {
    report.odds = await tradeOdds(ctx, { rosterId, partnerId: body.partnerId, myAfter, theirAfter },
      { remainingWeeks: extra.remainingWeeks });
  } catch (err) {
    report.odds = { available: false, reason: 'Playoff odds could not be worked out right now.' };
  }
  report.kind = leagueKind(ctx.league);
  if (report.kind !== 'redraft') {
    try {
      report.dynasty = await dynastyTradeRead(ctx, {
        rosterId, partnerId: body.partnerId, give: body.give || [], get: body.get || [],
        givePicks: body.givePicks || [], getPicks: body.getPicks || [],
        myDelta: report.me.delta, theirDelta: report.them.delta,
      }, { dynastyMarket: extra.dynastyMarket, tradedPicks: extra.tradedPicks, odds: report.odds?.leagueBefore || null });
    } catch (err) {
      report.dynasty = { available: false, reason: 'The dynasty read could not be worked out right now.' };
    }
  }
  return report;
}

function verdict(ctx, myDelta, theirDelta) {
  const mine = myDelta >= 0
    ? `adds about ${myDelta.toFixed(1)} points a week to your starting lineup`
    : `costs you about ${Math.abs(myDelta).toFixed(1)} points a week in your starting lineup`;
  const theirs = theirDelta >= 0
    ? `and improves theirs by about ${theirDelta.toFixed(1)}`
    : `and costs them about ${Math.abs(theirDelta).toFixed(1)}`;
  const close = ctx.valuations.sampleSize < 4
    ? ' Sample sizes are still small this early, so treat the margins as rough.'
    : '';
  return `This trade ${mine}, ${theirs}.${close}`;
}

/**
 * Scan every other roster for one-for-one swaps worth proposing.
 * Deduped to one row per target player, keeping the cheapest piece I would
 * have to give up.
 */
export function tradeTargets(ctx, rosterId = ctx.myRoster?.roster_id, opts = {}) {
  const minGain = opts.minGain ?? MIN_GAIN;
  const maxCost = opts.maxCost ?? MAX_THEIR_COST;
  const valueFn = (p) => ctx.valueOf(p.player_id);

  const myPlayers = ctx.playersOn(rosterId);
  if (myPlayers.length === 0) return { rows: [], minGain, maxCost };
  const myBase = solveWith(ctx, myPlayers, valueFn).total;

  const bestByTarget = new Map();

  for (const roster of ctx.rosters) {
    if (String(roster.roster_id) === String(rosterId)) continue;
    const theirPlayers = ctx.playersOn(roster.roster_id);
    if (theirPlayers.length === 0) continue;
    const theirBase = solveWith(ctx, theirPlayers, valueFn).total;

    for (const target of theirPlayers) {
      // Cheap prefilter: a player who could never crack my lineup is not a target.
      const repl = ctx.valuations.replacement[target.position] ?? 0;
      if (ctx.valueOf(target.player_id) <= repl) continue;

      for (const piece of myPlayers) {
        if (piece.player_id === target.player_id) continue;

        const myAfter = solveWith(ctx,
          [...myPlayers.filter((p) => p.player_id !== piece.player_id), target], valueFn).total;
        const myGain = myAfter - myBase;
        if (myGain < minGain) continue;

        const theirAfter = solveWith(ctx,
          [...theirPlayers.filter((p) => p.player_id !== target.player_id), piece], valueFn).total;
        const theirCost = theirBase - theirAfter;
        if (theirCost > maxCost) continue;

        const prev = bestByTarget.get(target.player_id);
        // One row per target, keeping the cheapest piece — not the flashiest.
        if (!prev || theirCost < prev.theirCost - 1e-9
            || (Math.abs(theirCost - prev.theirCost) < 1e-9 && myGain > prev.myGain)) {
          bestByTarget.set(target.player_id, {
            target: describe(ctx, target),
            piece: describe(ctx, piece),
            fromRosterId: roster.roster_id,
            fromTeam: ctx.teamName(roster),
            myGain: round2(myGain),
            theirCost: round2(theirCost),
            difficulty: difficultyFor(theirCost),
          });
        }
      }
    }
  }

  const rows = [...bestByTarget.values()].sort(
    (a, b) => (b.myGain - b.theirCost * 0.5) - (a.myGain - a.theirCost * 0.5)
  );
  return { rows, minGain, maxCost, scanned: ctx.rosters.length - 1 };
}

function difficultyFor(theirCost) {
  if (theirCost <= 0) return { level: 'easy', label: 'Easy ask — they improve too' };
  if (theirCost <= 1) return { level: 'fair', label: 'Fair ask — costs them very little' };
  return { level: 'hard', label: 'Hard ask — they give up real points' };
}

// ---------------------------------------------------------------- Handshake deals

const HS_MIN_GAIN = 3;       // rest-of-season lineup points I must gain for a deal to be listed
const HS_SHORTLIST = 60;     // candidates re-scored week by week (the expensive step)
const HS_TOP = 20;           // deals returned
const HS_TWO_MY_POOL = 10;   // two-for-one: pieces I may send come from my top N by value
const HS_TWO_TARGETS = 4;    // two-for-one: I only ask for one of a partner's top N players

function dealMarket(market, send, get) {
  if (!market) return null;
  const tot = (l) => l.reduce((t, p) => t + (market.get(String(p.player_id))?.value || 0), 0);
  const sendTotal = tot(send); const getTotal = tot(get);
  return { sendTotal, getTotal, gapPct: marketGapPct(sendTotal, getTotal) };
}

/** Regular-season weeks still to play, from this week up to the playoffs. */
export function remainingWeeks(ctx) {
  const last = (ctx.playoffWeekStart || 15) - 1;
  const out = [];
  for (let w = ctx.week; w <= last; w++) out.push(w);
  return out;
}

const onBye = (ctx, p, week) => Boolean(p?.team && ctx.schedule?.isOnBye?.(p.team, week));

/** Rest-of-season value: weekly value times the games he actually plays (byes excluded). */
export function rosValue(ctx, playerOrId, weeks = remainingWeeks(ctx)) {
  const p = typeof playerOrId === 'object' ? playerOrId : ctx.playerOf(playerOrId);
  if (!p) return 0;
  const games = weeks.filter((w) => !onBye(ctx, p, w)).length;
  return round2(ctx.valueOf(p.player_id) * games);
}

/**
 * One- and two-for-one swaps where BOTH best lineups improve, ranked by the
 * smaller of the two gains so fair deals come first. Gains are summed over the
 * remaining weeks, with bye-week players scoring nothing that week, and use the
 * same lineup solver and valuation as the analyzer.
 *
 * Bounds: stage 1 scores every pair once with this week's values (one-for-one:
 * my players x their players; two-for-one: pairs from my top 10 for one of their
 * top 4). Only the best 60 by smaller gain go on to stage 2, which re-solves both
 * lineups for every remaining week. Each roster's baseline is solved once.
 * Returned deals never share a player (greedy by rank).
 */
export function handshakeDeals(ctx, rosterId = ctx.myRoster?.roster_id, opts = {}) {
  const market = opts.market || null;
  const minGain = opts.minGain ?? HS_MIN_GAIN;
  const top = opts.top ?? HS_TOP;
  const weeks = remainingWeeks(ctx);
  const nWeeks = Math.max(1, weeks.length);
  const val = (p) => ctx.valueOf(p.player_id);
  const myPlayers = ctx.playersOn(rosterId);
  if (!myPlayers.length) return { rows: [], minGain, weeks: weeks.length };
  const weekVal = (w) => (p) => (onBye(ctx, p, w) ? 0 : val(p));
  const total = (players, fn) => solveWith(ctx, players, fn).total;

  const myBase = total(myPlayers, val);
  const rows = [];
  const cand = [];
  const partners = [];
  for (const roster of ctx.rosters) {
    if (String(roster.roster_id) === String(rosterId)) continue;
    const theirs = ctx.playersOn(roster.roster_id);
    if (!theirs.length) continue;
    partners.push({ roster, theirs, base: total(theirs, val) });
  }

  // Stage 1: cheap screen on this week's values.
  const screen = (part, send, get) => {
    const sendIds = new Set(send.map((p) => p.player_id));
    const getIds = new Set(get.map((p) => p.player_id));
    const mine = total([...myPlayers.filter((p) => !sendIds.has(p.player_id)), ...get], val) - myBase;
    if (mine <= 0 || mine * nWeeks <= minGain) return;
    const theirs = total([...part.theirs.filter((p) => !getIds.has(p.player_id)), ...send], val) - part.base;
    if (theirs <= 0) return;
    cand.push({ part, send, get, score: Math.min(mine, theirs) });
  };
  const myTop = [...myPlayers].sort((a, b) => val(b) - val(a)).slice(0, HS_TWO_MY_POOL);
  for (const part of partners) {
    for (const target of part.theirs) {
      if (val(target) <= (ctx.valuations.replacement[target.position] ?? 0)) continue;
      for (const piece of myPlayers) screen(part, [piece], [target]);
    }
    for (const target of [...part.theirs].sort((a, b) => val(b) - val(a)).slice(0, HS_TWO_TARGETS)) {
      for (let i = 0; i < myTop.length; i++) {
        for (let j = i + 1; j < myTop.length; j++) screen(part, [myTop[i], myTop[j]], [target]);
      }
    }
  }
  cand.sort((a, b) => b.score - a.score);

  // Stage 2: exact rest-of-season gains for the shortlist, baselines cached per week.
  const myWeekBase = weeks.map((w) => total(myPlayers, weekVal(w)));
  for (const part of partners) part.weekBase = null;
  for (const c of cand.slice(0, HS_SHORTLIST)) {
    const { part, send, get } = c;
    const sendIds = new Set(send.map((p) => p.player_id));
    const getIds = new Set(get.map((p) => p.player_id));
    part.weekBase ||= weeks.map((w) => total(part.theirs, weekVal(w)));
    const myAfter = [...myPlayers.filter((p) => !sendIds.has(p.player_id)), ...get];
    const theirAfter = [...part.theirs.filter((p) => !getIds.has(p.player_id)), ...send];
    let yourGain = 0; let theirGain = 0; let starts = 0;
    weeks.forEach((w, i) => {
      const fn = weekVal(w);
      const solved = solveWith(ctx, myAfter, fn);
      yourGain += solved.total - myWeekBase[i];
      theirGain += total(theirAfter, fn) - part.weekBase[i];
      if (solved.assignments.some((a) => a.player && getIds.has(a.player.player_id) && fn(a.player) > 0)) starts++;
    });
    yourGain = round2(yourGain); theirGain = round2(theirGain);
    if (yourGain <= minGain || theirGain <= 0) continue;
    rows.push({
      send: withMarket(send.map((p) => ({ ...describe(ctx, p), rosValue: rosValue(ctx, p, weeks) })), market),
      get: withMarket(get.map((p) => ({ ...describe(ctx, p), rosValue: rosValue(ctx, p, weeks) })), market),
      partner: { rosterId: part.roster.roster_id, teamName: ctx.teamName(part.roster) },
      yourGain, theirGain, startsForYou: starts,
      line: verdictLine(yourGain / nWeeks, theirGain / nWeeks, 0.25),
      market: dealMarket(market, send, get),
      why: `${get.map((p) => p.name).join(' and ')} ${get.length > 1 ? 'fill' : 'fills'} a bigger hole in your lineup than ${send.map((p) => p.name).join(' and ')} ${send.length > 1 ? 'do' : 'does'}, and the swap helps ${ctx.teamName(part.roster)} too.`,
    });
  }

  rows.sort((a, b) => Math.min(b.yourGain, b.theirGain) - Math.min(a.yourGain, a.theirGain));
  const used = new Set();
  const picked = [];
  for (const r of rows) {
    const ids = [...r.send, ...r.get].map((p) => p.player_id);
    if (ids.some((id) => used.has(id))) continue;
    ids.forEach((id) => used.add(id));
    picked.push(r);
    if (picked.length >= top) break;
  }
  return { rows: picked, minGain, weeks: weeks.length, scanned: partners.length };
}
