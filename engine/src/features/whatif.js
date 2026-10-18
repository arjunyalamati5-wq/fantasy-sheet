// The what-if lab: try an add, a drop, a trade or a result, and see every
// number that depends on rosters or results move — lineup, matchup, playoff
// odds, clinch marks, the bracket, waivers. A scenario travels with each
// request as one short string (`wi=`), is validated here, and is laid over the
// league context for that request only; nothing is ever written to Sleeper.
//
//   a.<pid>                           add a free agent to your roster
//   d.<pid>                           drop one of your players
//   t.<roster>.<give+give>.<get+get>  trade with another roster (from next week)
//   w.<week>.<roster>                 pick that roster to win its game that week
//
// Items are joined with `;`. Player ids are Sleeper ids (digits) or a team
// code for a defence.

import { teamStrength } from '../context.js';
import { solveLineup } from '../lineup.js';

export const WI_MAX_LENGTH = 1500;
const PID = /^(?:\d{1,12}|[A-Z]{2,3})$/;
const ROSTER = /^\d{1,3}$/;

function fail(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Parse and shape-check a scenario string. Throws a 400 with a plain message. */
export function parseScenario(raw) {
  const sc = { adds: [], drops: [], trades: [], picks: [] };
  if (!raw) return sc;
  const text = String(raw);
  if (text.length > WI_MAX_LENGTH) throw fail('That what-if is too long.');
  for (const item of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [kind, ...parts] = item.split('.');
    if (kind === 'a' || kind === 'd') {
      if (parts.length !== 1 || !PID.test(parts[0])) throw fail(`"${item}" is not a valid ${kind === 'a' ? 'add' : 'drop'}.`);
      (kind === 'a' ? sc.adds : sc.drops).push(parts[0]);
    } else if (kind === 't') {
      const [partner, give = '', get = ''] = parts;
      const gives = give.split('+').filter(Boolean);
      const gets = get.split('+').filter(Boolean);
      if (parts.length !== 3 || !ROSTER.test(partner) || !gives.length || !gets.length || ![...gives, ...gets].every((p) => PID.test(p))) {
        throw fail(`"${item}" is not a valid trade.`);
      }
      sc.trades.push({ partner, give: gives, get: gets });
    } else if (kind === 'w') {
      const [week, winner] = parts;
      if (parts.length !== 2 || !/^\d{1,2}$/.test(week) || !ROSTER.test(winner)) throw fail(`"${item}" is not a valid pick.`);
      sc.picks.push({ week: Number(week), winner });
    } else {
      throw fail(`"${item}" is not something the what-if lab understands.`);
    }
  }
  return sc;
}

/** The scenario as a string again (canonical order), for cache keys and links. */
export function scenarioKey(sc) {
  return [
    ...sc.adds.map((p) => `a.${p}`),
    ...sc.drops.map((p) => `d.${p}`),
    ...sc.trades.map((t) => `t.${t.partner}.${t.give.join('+')}.${t.get.join('+')}`),
    ...sc.picks.map((p) => `w.${p.week}.${p.winner}`),
  ].join(';');
}

export const isEmpty = (sc) => !sc || (sc.adds.length + sc.drops.length + sc.trades.length + sc.picks.length === 0);

/**
 * Lay a scenario over a league context. Returns a context that reads like the
 * original but with the changed rosters, plus `scenario` (with a plain
 * description of each change) and `baseCtx`. Roster moves are checked
 * against the real league: you can only add free agents, drop or trade your
 * own players, and receive players the partner really has.
 */
export function applyScenario(ctx, sc) {
  if (isEmpty(sc)) return ctx;
  const myId = String(ctx.myRoster?.roster_id ?? '');
  if (!myId && (sc.adds.length || sc.drops.length || sc.trades.length)) throw fail('Roster moves need your team; this league has none for you.');
  const rosters = ctx.rosters.map((r) => ({ ...r, players: [...(r.players || [])] }));
  const byId = new Map(rosters.map((r) => [String(r.roster_id), r]));
  const mine = byId.get(myId);
  const nameOf = (pid) => ctx.playerOf(pid)?.name || pid;
  const used = new Set();
  const once = (pid) => {
    if (used.has(pid)) throw fail(`${nameOf(pid)} appears twice in this what-if.`);
    used.add(pid);
  };
  const changes = [];
  const tradedRosters = new Set();

  for (const pid of sc.drops) {
    once(pid);
    if (!mine.players.includes(pid)) throw fail(`${nameOf(pid)} is not on your roster.`);
    mine.players = mine.players.filter((x) => x !== pid);
    changes.push({ kind: 'drop', text: `Drop ${nameOf(pid)}` });
  }
  for (const pid of sc.adds) {
    once(pid);
    if (!ctx.playerOf(pid)) throw fail(`No player with id ${pid}.`);
    if (rosters.some((r) => r.players.includes(pid))) throw fail(`${nameOf(pid)} is not a free agent.`);
    mine.players.push(pid);
    changes.push({ kind: 'add', text: `Add ${nameOf(pid)}` });
  }
  for (const t of sc.trades) {
    const partner = byId.get(String(t.partner));
    if (!partner || String(t.partner) === myId) throw fail('That trade partner is not another team in this league.');
    for (const pid of t.give) { once(pid); if (!mine.players.includes(pid)) throw fail(`${nameOf(pid)} is not on your roster.`); }
    for (const pid of t.get) { once(pid); if (!partner.players.includes(pid)) throw fail(`${nameOf(pid)} is not on ${ctx.teamName(partner)}.`); }
    mine.players = [...mine.players.filter((x) => !t.give.includes(x)), ...t.get];
    partner.players = [...partner.players.filter((x) => !t.get.includes(x)), ...t.give];
    tradedRosters.add(myId);
    tradedRosters.add(String(t.partner));
    changes.push({ kind: 'trade', text: `Trade ${t.give.map(nameOf).join(' and ')} to ${ctx.teamName(partner)} for ${t.get.map(nameOf).join(' and ')}` });
  }
  for (const p of sc.picks) {
    const r = byId.get(String(p.winner));
    if (!r) throw fail('That pick names a team that is not in this league.');
    changes.push({ kind: 'pick', text: `${ctx.teamName(r)} wins in week ${p.week}` });
  }

  const ownerOf = new Map();
  for (const r of rosters) for (const pid of r.players) ownerOf.set(pid, r.roster_id);
  const over = Object.create(ctx);
  Object.assign(over, {
    baseCtx: ctx,
    rosters,
    ownerOf,
    myRoster: mine || ctx.myRoster,
    scenario: { ...sc, key: scenarioKey(sc), changes, tradedRosters, tradeFromWeek: (Number(ctx.week) || 1) + 1 },
    rosterOf(rosterId) { return byId.get(String(rosterId)) || null; },
    playersOn(rosterId) {
      const r = byId.get(String(rosterId));
      return r ? r.players.map((id) => ctx.playerOf(id)).filter(Boolean) : [];
    },
    solveFor(rosterId, valueFn = (p) => ctx.pointsFor(p.player_id), opts = {}) {
      return solveLineup(ctx.slots, over.playersOn(rosterId), valueFn, opts);
    },
    freeAgents() {
      // The real free agents still unowned, plus anyone the scenario dropped.
      const pool = ctx.freeAgents().filter((p) => !ownerOf.has(p.player_id));
      const dropped = sc.drops.map((pid) => ctx.playerOf(pid)).filter(Boolean);
      return [...pool, ...dropped];
    },
  });
  return over;
}

/**
 * Team strength under a scenario. A traded roster keeps its old players for
 * the current week (trades take effect next week) and the new ones after; the
 * mean and spread are the week-weighted mix of the two.
 */
export function scenarioStrength(ctx, rosterId) {
  const sc = ctx.scenario;
  if (!sc || !sc.tradedRosters.has(String(rosterId))) return teamStrength(ctx, rosterId);
  const base = ctx.baseCtx;
  const now = Number(ctx.week) || 1;
  const last = (Number(ctx.playoffWeekStart) || 15) - 1;
  const later = [];
  for (let w = now + 1; w <= last; w++) later.push(w);
  const cur = teamStrength(base, rosterId, { weeks: [now] });
  if (!later.length) return cur;
  const next = teamStrength(ctx, rosterId, { weeks: later });
  const k = later.length;
  const mean = (cur.mean + next.mean * k) / (1 + k);
  const variance = (cur.sd ** 2 + next.sd ** 2 * k) / (1 + k) + ((cur.mean - mean) ** 2 + k * (next.mean - mean) ** 2) / (1 + k);
  return { mean, sd: Math.sqrt(variance) };
}

/**
 * Picked results for the season simulator and the clinch arithmetic:
 * Map `${week}|${a}|${b}` (ids sorted) -> winner id, for picks that match a
 * real pairing. Picks naming a team without a game that week are returned in
 * `ignored`, not used.
 */
export function forcedResults(sc, remainingWeeks) {
  const forced = new Map();
  const ignored = [];
  for (const p of sc?.picks || []) {
    const wk = remainingWeeks.find((w) => w.week === p.week);
    const pair = wk?.pairs.find((pr) => pr.map(String).includes(String(p.winner)));
    if (!pair) { ignored.push(p); continue; }
    const [a, b] = pair.map(String).sort();
    forced.set(`${p.week}|${a}|${b}`, String(p.winner));
  }
  return { forced, ignored };
}
