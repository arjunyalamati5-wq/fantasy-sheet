// Trade finder: search every one- and two-for-one trade in the league and
// rank them by what they do for YOU, week by week.
//
// Goals
//   odds      biggest rise in playoff + title odds (default)
//   week      biggest gain to your lineup in one week (say, a bye hole)
//   position  improve your starter at one position
//   fair      both lineups gain; ranked by the smaller gain
//
// Trades take effect NEXT week (as in the what-if lab), so only weeks after
// ctx.week count. Value is per game played (src/value.js); a player on bye or
// ruled out in a week adds nothing that week (same rules as teamStrength).
//
// Bounds (a 12-team league answers in about a second or two; BOUNDS.budgetMs
// caps the odds stage so a slow machine still answers):
//   stage 1  every give x get pair is screened with ONE lineup solve per side
//            (week-agnostic values, or the target week's availability for the
//            'week' goal). Gives: all your players; gets: partner players above
//            replacement level. Two-for-one: pairs from your top 10 for one of
//            a partner's top 4. Best 150 continue.
//   stage 2  exact lineup totals for each remaining week (bye and injury
//            aware), both sides. Best 40 by goal score are ranked; at most two
//            results may share a player; the top 12 are finalists.
//   stage 3  playoff and title odds before/after for the finalists, two season
//            simulations each at BOUNDS.oddsRuns runs with the fixed oddsim seed,
//            so before and after differ only by the rosters.

import { teamStrength } from '../context.js';
import { solveLineup } from '../lineup.js';
import { outInWeek } from '../availability.js';
import { round2 } from '../scoring.js';
import { simulateOdds, remainingPairings, blendStrength } from './oddsim.js';
import { NEUTRAL_BAND } from './trades.js';

export const GOALS = ['odds', 'week', 'position', 'fair'];
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
export const BOUNDS = {
  myPool2for1: 10,
  targets2for1: 4,
  stage1Keep: 150,
  stage2Keep: 40,
  finalists: 12,
  maxLimit: 12,
  defaultLimit: 8,
  oddsRuns: 3000,
  budgetMs: 3500,
  /** Points a week a partner may lose in the screen before a deal is not worth listing. */
  theirFloorPerWeek: 3,
  /** Per-week lift both sides need before a "fair" deal counts as a gain for both. */
  fairMin: 0.25,
};

function fail(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Validate request parameters. Throws a 400 with a plain message. */
export function validateParams({ goal, week, pos, limit } = {}) {
  const g = goal == null || goal === '' ? 'odds' : String(goal);
  if (!GOALS.includes(g)) throw fail(`That goal is not one of ${GOALS.join(', ')}.`);
  let wk = null;
  if (week != null && week !== '') {
    if (!/^\d{1,2}$/.test(String(week).trim()) || Number(week) < 1 || Number(week) > 18) throw fail('The week must be a whole number from 1 to 18.');
    wk = Number(week);
  }
  let p = null;
  if (pos != null && pos !== '') {
    p = String(pos).toUpperCase();
    if (!POSITIONS.includes(p)) throw fail(`The position must be one of ${POSITIONS.join(', ')}.`);
  }
  if (g === 'position' && !p) throw fail('Pick a position to upgrade.');
  let lim = BOUNDS.defaultLimit;
  if (limit != null && limit !== '') {
    if (!/^\d{1,3}$/.test(String(limit).trim()) || Number(limit) < 1) throw fail('The limit must be a whole number of at least 1.');
    lim = Math.min(BOUNDS.maxLimit, Number(limit));
  }
  return { goal: g, week: wk, pos: p, limit: lim };
}

/** How a partner is likely to take it, from their lineup change in points a week. */
export function acceptanceFor(theirPerWeek) {
  if (theirPerWeek >= NEUTRAL_BAND) return 'likely';
  if (theirPerWeek > -NEUTRAL_BAND) return 'maybe';
  return 'unlikely';
}
// A trade the other manager would refuse is a long shot, not a plan: it
// ranks below every realistic deal unless its gain is many times larger.
const ACCEPT_WEIGHT = { likely: 1, maybe: 0.75, unlikely: 0.15 };

/** The what-if lab item for a trade. */
export const itemFor = (partnerId, give, get) => `t.${partnerId}.${give.join('+')}.${get.join('+')}`;

const lastRegularWeek = (ctx) => (Number(ctx.playoffWeekStart) || 15) - 1;

/** Weeks after this one: regular-season ones (what odds care about) and playoff ones (up to 18). */
export function tradeWeeks(ctx) {
  const now = Number(ctx.week) || 1;
  const last = lastRegularWeek(ctx);
  const later = [];
  for (let w = now + 1; w <= last; w++) later.push(w);
  const playoff = [];
  for (let w = Math.max(last + 1, now + 1); w <= Math.min(18, last + 3); w++) playoff.push(w);
  return { later, playoff };
}

function makeAbsent(ctx) {
  const memo = new Map();
  return (p, w) => {
    const key = `${p.player_id}|${w}`;
    let v = memo.get(key);
    if (v === undefined) {
      v = Boolean(p.team && ctx.schedule?.isOnBye?.(p.team, w));
      if (!v) {
        const inj = ctx.injuryByPlayer?.get(p.player_id);
        v = Boolean(inj) && outInWeek({ status: inj.sleeperStatus, currentWeek: ctx.week, week: w, returnWeek: ctx.irReturn?.get(p.player_id) });
      }
      memo.set(key, v);
    }
    return v;
  };
}

const slotName = (a) => a.slotLabel || a.slot;

/**
 * @param {object} ctx
 * @param {{goal?:string, week?:number|string, pos?:string, limit?:number}} params
 * @param {{odds?:boolean, runs?:number, remainingWeeks?:Array, budgetMs?:number, now?:()=>number}} [opts]
 */
export async function tradeFinder(ctx, params = {}, opts = {}) {
  const { goal, week, pos, limit } = validateParams(params);
  const clock = opts.now || (() => Date.now());
  const started = clock();
  const myId = ctx.myRoster?.roster_id;
  if (myId == null) throw fail('The trade finder needs your team; this league has none for you.');
  const { later, playoff } = tradeWeeks(ctx);
  const allWeeks = [...later, ...playoff];
  const empty = (note) => ({ goal, week, pos, weeksLeft: later.length, results: [], weekOutlook: [], note, bounds: { ...BOUNDS }, scanned: { candidates: 0, shortlisted: 0, finalists: 0 }, oddsAvailable: false, elapsedMs: clock() - started });
  if (!allWeeks.length) return empty('The regular season is over, and trades take effect next week, so there is nothing left to improve.');
  if (goal === 'week' && week != null && !allWeeks.includes(week)) {
    throw fail(`Trades take effect next week, so week ${week} is not one a trade can change. Pick a week from ${allWeeks[0]} to ${allWeeks[allWeeks.length - 1]}.`);
  }

  const abs = makeAbsent(ctx);
  const val = (p) => ctx.valueOf(p.player_id);
  const total = (players, w) => solveLineup(ctx.slots, w == null ? players : players.filter((p) => !abs(p, w)), val).total;
  const mine = ctx.playersOn(myId);
  if (!mine.length) return empty('Your roster is empty.');

  // Weeks where your lineup has a hole (a starting slot nobody can fill), for the picker.
  const weekOutlook = allWeeks.map((w) => {
    const avail = mine.filter((p) => !abs(p, w));
    const { assignments, total: t } = solveLineup(ctx.slots, avail, val);
    return { week: w, phase: later.includes(w) ? 'regular' : 'playoffs', lineup: round2(t), holes: assignments.filter((a) => !a.player).map(slotName), absent: mine.length - avail.length };
  });
  let targetWeek = week;
  if (goal === 'week' && targetWeek == null) {
    const worst = weekOutlook.find((o) => o.holes.length) || [...weekOutlook].sort((a, b) => a.lineup - b.lineup)[0];
    targetWeek = worst.week;
  }

  const partners = [];
  for (const roster of ctx.rosters) {
    if (String(roster.roster_id) === String(myId)) continue;
    const theirs = ctx.playersOn(roster.roster_id);
    if (theirs.length) partners.push({ roster, theirs });
  }
  const w1 = goal === 'week' ? targetWeek : null;
  const myBase1 = total(mine, w1);
  for (const part of partners) part.base1 = total(part.theirs, w1);
  const nLater = Math.max(1, later.length);
  const repl = (p) => ctx.valuations?.replacement?.[p.position] ?? 0;

  // ---- Stage 1: one solve per side per pair.
  const cand = [];
  const screen = (part, send, get) => {
    if (pos && !get.some((p) => p.position === pos)) return;
    const sendIds = new Set(send.map((p) => p.player_id));
    const getIds = new Set(get.map((p) => p.player_id));
    const m = total([...mine.filter((p) => !sendIds.has(p.player_id)), ...get], w1) - myBase1;
    if (m <= 0.01) return;
    const t = total([...part.theirs.filter((p) => !getIds.has(p.player_id)), ...send], w1) - part.base1;
    if (t < -BOUNDS.theirFloorPerWeek) return;
    if (goal === 'fair' && (t < BOUNDS.fairMin || m < BOUNDS.fairMin)) return;
    const score = goal === 'fair' ? Math.min(m, t) : m * ACCEPT_WEIGHT[acceptanceFor(t)];
    cand.push({ part, send, get, score });
  };
  const myTop = [...mine].sort((a, b) => val(b) - val(a)).slice(0, BOUNDS.myPool2for1);
  for (const part of partners) {
    for (const target of part.theirs) {
      if (val(target) <= repl(target)) continue;
      for (const piece of mine) screen(part, [piece], [target]);
    }
    const top = [...part.theirs].sort((a, b) => val(b) - val(a)).slice(0, BOUNDS.targets2for1);
    for (const target of top) {
      for (let i = 0; i < myTop.length; i++) for (let j = i + 1; j < myTop.length; j++) screen(part, [myTop[i], myTop[j]], [target]);
    }
  }
  const candidates = cand.length;
  cand.sort((a, b) => b.score - a.score || String(a.send[0].player_id).localeCompare(String(b.send[0].player_id)));
  const shortlist = cand.slice(0, BOUNDS.stage1Keep);

  // ---- Stage 2: exact week-by-week totals for both sides.
  const baseMemo = new Map();
  const baseTotal = (id, players, w) => {
    const k = `${id}|${w}`;
    if (!baseMemo.has(k)) baseMemo.set(k, total(players, w));
    return baseMemo.get(k);
  };
  const scored = [];
  for (const c of shortlist) {
    const sendIds = new Set(c.send.map((p) => p.player_id));
    const getIds = new Set(c.get.map((p) => p.player_id));
    const myAfter = [...mine.filter((p) => !sendIds.has(p.player_id)), ...c.get];
    const theirAfter = [...c.part.theirs.filter((p) => !getIds.has(p.player_id)), ...c.send];
    const rid = c.part.roster.roster_id;
    const rows = allWeeks.map((w) => {
      const you = total(myAfter, w) - baseTotal(myId, mine, w);
      const them = total(theirAfter, w) - baseTotal(rid, c.part.theirs, w);
      return { week: w, phase: later.includes(w) ? 'regular' : 'playoffs', you: round2(you), them: round2(them) };
    });
    const reg = rows.filter((r) => r.phase === 'regular');
    const myGain = round2(reg.reduce((s, r) => s + r.you, 0));
    const theirGain = round2(reg.reduce((s, r) => s + r.them, 0));
    const myPer = myGain / nLater;
    const theirPer = theirGain / nLater;
    const wkRow = goal === 'week' ? rows.find((r) => r.week === targetWeek) : null;
    if (goal === 'week' && !(wkRow && wkRow.you > 0.01)) continue;
    if (goal !== 'week' && !(reg.length ? myGain > 0.01 : rows.reduce((s, r) => s + r.you, 0) > 0.01)) continue;
    if (goal === 'fair' && (myPer < BOUNDS.fairMin || theirPer < BOUNDS.fairMin)) continue;
    const acceptance = acceptanceFor(theirPer);
    const raw = goal === 'week' ? wkRow.you + 0.5 * Math.min(0, myGain) : goal === 'fair' ? Math.min(myPer, theirPer) : myGain;
    const score = goal === 'fair' ? raw : raw * ACCEPT_WEIGHT[acceptance];
    scored.push({ c, rows, myGain, theirGain, myPer, theirPer, acceptance, score, tie: myGain });
  }
  scored.sort((a, b) => b.score - a.score || b.tie - a.tie || itemOf(a).localeCompare(itemOf(b)));
  // A two-for-one must beat the plain one-for-one for the same player; otherwise
  // the second piece is just baggage.
  const bestOne = new Map();
  for (const s of scored) {
    if (s.c.send.length !== 1) continue;
    const k = `${s.c.part.roster.roster_id}|${s.c.get[0].player_id}`;
    if (!bestOne.has(k)) bestOne.set(k, s.score);
  }
  const kept = scored
    .filter((s) => s.c.send.length === 1 || !(bestOne.get(`${s.c.part.roster.roster_id}|${s.c.get[0].player_id}`) >= s.score - 0.05))
    .slice(0, BOUNDS.stage2Keep);
  const uses = new Map();
  const finalists = [];
  for (const s of kept) {
    const ids = [...s.c.send, ...s.c.get].map((p) => p.player_id);
    if (ids.some((id) => (uses.get(id) || 0) >= 2)) continue;
    ids.forEach((id) => uses.set(id, (uses.get(id) || 0) + 1));
    finalists.push(s);
    if (finalists.length >= BOUNDS.finalists) break;
  }

  // ---- Stage 3: playoff and title odds for the finalists.
  let oddsAvailable = false;
  let oddsNote = null;
  const wantOdds = opts.odds !== false && later.length > 0 && finalists.length > 0;
  if (wantOdds) {
    try {
      const weeks = opts.remainingWeeks || await remainingPairings(ctx);
      if (weeks.length) {
        const runs = opts.runs || BOUNDS.oddsRuns;
        const afterWeeks = weeks.filter((x) => x.week > ctx.week).length;
        const base = new Map(ctx.rosters.map((r) => [String(r.roster_id), teamStrength(ctx, r.roster_id)]));
        const before = simulateOdds(ctx, weeks, { runs, strengths: base });
        const pick = (res, id) => res.teams.find((t) => String(t.rosterId) === String(id));
        const b = pick(before, myId);
        const budget = opts.budgetMs ?? BOUNDS.budgetMs;
        for (const s of finalists) {
          if (clock() - started > budget) { oddsNote = 'The odds stage hit its time limit, so the last few deals show lineup numbers only.'; break; }
          const rid = s.c.part.roster.roster_id;
          const sendIds = new Set(s.c.send.map((p) => p.player_id));
          const getIds = new Set(s.c.get.map((p) => p.player_id));
          const myAfter = [...mine.filter((p) => !sendIds.has(p.player_id)), ...s.c.get];
          const theirAfter = [...s.c.part.theirs.filter((p) => !getIds.has(p.player_id)), ...s.c.send];
          const changed = new Map(base);
          changed.set(String(myId), blendStrength(base.get(String(myId)), teamStrength(ctx, myId, { players: myAfter }), afterWeeks, weeks.length));
          changed.set(String(rid), blendStrength(base.get(String(rid)), teamStrength(ctx, rid, { players: theirAfter }), afterWeeks, weeks.length));
          const a = pick(simulateOdds(ctx, weeks, { runs, strengths: changed }), myId);
          s.odds = {
            playoffBefore: b.playoffOdds, playoffAfter: a.playoffOdds, playoffChange: a.playoffOdds - b.playoffOdds,
            titleBefore: b.titleOdds ?? 0, titleAfter: a.titleOdds ?? 0, titleChange: (a.titleOdds ?? 0) - (b.titleOdds ?? 0),
          };
          oddsAvailable = true;
        }
      } else oddsNote = 'No games are left to simulate, so odds are not shown.';
    } catch (err) {
      oddsNote = 'Playoff odds were not available this time; lineup numbers are shown.';
    }
  }
  if (goal === 'odds') {
    const oddsScore = (s) => (s.odds ? (s.odds.playoffChange + s.odds.titleChange) * ACCEPT_WEIGHT[s.acceptance] : -Infinity);
    finalists.sort((a, b) => oddsScore(b) - oddsScore(a) || b.score - a.score || itemOf(a).localeCompare(itemOf(b)));
  }

  const results = finalists.slice(0, limit).map((s) => buildResult(ctx, s, { goal, targetWeek, pos, mine, abs, myId }));
  return {
    goal, week: goal === 'week' ? targetWeek : week, pos, weeksLeft: later.length,
    results, weekOutlook,
    note: [
      `Trades take effect next week, so only weeks ${allWeeks[0]} to ${allWeeks[allWeeks.length - 1]} count.`,
      oddsAvailable ? `Odds come from ${(opts.runs || BOUNDS.oddsRuns).toLocaleString('en-US')} simulated seasons per deal with the same dice before and after.` : null,
      oddsNote,
    ].filter(Boolean).join(' '),
    bounds: { ...BOUNDS },
    scanned: { candidates, shortlisted: shortlist.length, finalists: finalists.length, partners: partners.length },
    oddsAvailable,
    elapsedMs: clock() - started,
  };
}

function itemOf(s) {
  return itemFor(s.c.part.roster.roster_id, s.c.send.map((p) => p.player_id), s.c.get.map((p) => p.player_id));
}

const who = (ctx, p) => ({ player_id: p.player_id, name: p.name, position: p.position, team: p.team || null, valuePerGame: round2(ctx.valueOf(p.player_id)) });
const join = (list) => list.join(' and ');
const sgn = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;

function buildResult(ctx, s, { goal, targetWeek, pos, mine, abs, myId }) {
  const { c } = s;
  const give = c.send.map((p) => who(ctx, p));
  const get = c.get.map((p) => who(ctx, p));
  const partnerName = ctx.teamName(c.part.roster);
  const sendIds = new Set(c.send.map((p) => p.player_id));
  const myAfter = [...mine.filter((p) => !sendIds.has(p.player_id)), ...c.get];
  // Holes per week before and after, so a bye fix can be named.
  const holesAt = (players, w) => solveLineup(ctx.slots, players.filter((p) => !abs(p, w)), (p) => ctx.valueOf(p.player_id)).assignments.filter((a) => !a.player).map(slotName);
  const weeks = s.rows.map((r) => ({
    ...r,
    holesBefore: holesAt(mine, r.week),
    holesAfter: holesAt(myAfter, r.week),
  }));
  const wkRow = goal === 'week' ? weeks.find((r) => r.week === targetWeek) : null;
  const fixed = wkRow ? wkRow.holesBefore.length - wkRow.holesAfter.length : 0;
  const theirText = s.acceptance === 'likely' ? `${partnerName} gains too, so the pitch is easy`
    : s.acceptance === 'maybe' ? `${partnerName} comes out about even`
      : `${partnerName} loses ${Math.abs(s.theirPer).toFixed(1)} points a week, so expect a counter`;
  let why;
  if (goal === 'week') {
    why = `Adds ${wkRow.you.toFixed(1)} points to your week ${targetWeek} lineup${fixed > 0 ? ` and fills ${fixed === 1 ? 'an empty starting slot' : 'empty starting slots'}` : ''}; ${theirText}.`;
  } else if (goal === 'position') {
    why = `Upgrades ${pos} for ${s.myPer >= 0.1 ? `${s.myPer.toFixed(1)} more points a week` : 'the stretch run'}; ${theirText}.`;
  } else if (goal === 'fair') {
    why = `Both lineups gain: you ${sgn(s.myPer)} and ${partnerName} ${sgn(s.theirPer)} points a week.`;
  } else {
    why = `${join(get.map((p) => p.name))} lifts your lineup ${s.myPer.toFixed(1)} points a week; ${theirText}.`;
  }
  return {
    give, get,
    partner: { rosterId: c.part.roster.roster_id, teamName: partnerName },
    yourPerWeek: round2(s.myPer),
    theirPerWeek: round2(s.theirPer),
    restOfSeason: s.myGain,
    theirRestOfSeason: s.theirGain,
    weekGain: wkRow ? wkRow.you : null,
    week: goal === 'week' ? targetWeek : null,
    odds: s.odds || null,
    acceptance: s.acceptance,
    why,
    weeks,
    item: itemFor(c.part.roster.roster_id, give.map((p) => p.player_id), get.map((p) => p.player_id)),
  };
}
