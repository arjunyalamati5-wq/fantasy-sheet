import { getSeasonProjections, adpKeyFor, readAdp } from '../adp.js';
import { scoreStats, round2 } from '../scoring.js';
import { eligiblePositions } from '../lineup.js';
import { getJson } from '../http.js';
import { marketForContext, marketParams, parseMarket, MARKET_TTL } from '../fantasycalc.js';
import {
  getDraftsFresh, getDraftFresh, getDraftPicksFresh, getDraftTradedPicks,
} from '../sleeper.js';
import { mulberry32, normal, seedFrom } from '../random.js';
import {
  replacementLevels, rankByVor, assignTiers, buildOrder, slotForPick, picksOf, startingNeeds,
  positionalRuns, likelyGone, pickValue, gradeDraft, countdown,
} from './draftrank.js';

// The draft room: rankings by value over replacement, a seeded mock draft,
// and a live assistant that follows the league's real Sleeper draft.

export const MESSAGES = {
  noDraftTime: 'no draft time is set yet. the commissioner sets it in sleeper.',
  noOrder: 'the draft order is not set yet. it shows here once the commissioner sets it in sleeper.',
  noDraft: "no draft in progress. the assistant wakes up when your league's draft starts.",
  noMarket: "fantasycalc is not answering, so these rankings use sleeper's numbers only.",
  noProjections: 'season projections are not available from sleeper right now, so rankings cannot be built.',
  unsupportedAuction: 'this is an auction draft. the assistant follows snake and linear drafts only, so it shows the pick feed but cannot say who is on the clock.',
};

// ------------------------------------------------------------------ the board

/** Season projections scored in this league's settings, one row per player. */
export function projectionRows({ byPlayer, scoring, adpKeys, playerOf }) {
  const rows = [];
  for (const [id, row] of Object.entries(byPlayer || {})) {
    const p = playerOf(id);
    const position = p?.position || row.position;
    if (!position) continue;
    rows.push({
      id,
      name: p?.name || row.name || `Player ${id}`,
      position,
      team: p?.team || row.team || null,
      yearsExp: p?.years_exp ?? null,
      points: round2(scoreStats(row.stats, scoring)),
      adp: readAdp(row.stats, adpKeys),
    });
  }
  return rows;
}

/** Rank, tier and attach the market value: the whole board from plain rows. */
export function makeBoard({ rows, rosterPositions, numTeams, market = null }) {
  const levels = replacementLevels(rows, rosterPositions, numTeams);
  const ranked = rankByVor(rows, levels);
  const { tiers } = assignTiers(ranked);
  for (const r of ranked) {
    const m = market?.get(String(r.id));
    r.market = m ? { value: m.value, rank: m.rank } : null;
  }
  return { levels, ranked, tiers, marketAvailable: Boolean(market && market.size) };
}

const boards = new WeakMap(); // ctx -> promise, so one context loads the board once

export function loadBoard(ctx, deps = {}) {
  if (!deps.fresh && boards.has(ctx)) return boards.get(ctx);
  const promise = (async () => {
    const [season, market] = await Promise.all([
      (deps.getSeason || getSeasonProjections)(ctx.season),
      deps.market !== undefined ? deps.market : marketForContext(ctx).catch(() => null),
    ]);
    if (!season.available) return { available: false, emptyMessage: MESSAGES.noProjections };
    const adpKeys = adpKeyFor({ slots: ctx.slots, scoring: ctx.scoring });
    const rows = projectionRows({ byPlayer: season.byPlayer, scoring: ctx.scoring, adpKeys, playerOf: ctx.playerOf });
    return { available: true, adpKey: adpKeys[0], ...makeBoard({ rows, rosterPositions: ctx.rosterPositions, numTeams: ctx.numTeams, market }) };
  })();
  if (!deps.fresh) {
    boards.set(ctx, promise);
    promise.catch(() => boards.delete(ctx));
  }
  return promise;
}

// ---------------------------------------------------------- which draft, and who

const STATUS_RANK = { drafting: 0, paused: 1, pre_draft: 2, complete: 3 };

/** The draft that matters most: one under way, else the next, else the latest. */
export function chooseDraft(drafts) {
  if (!Array.isArray(drafts) || !drafts.length) return null;
  return [...drafts].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    || (Number(b.start_time || b.created || 0) - Number(a.start_time || a.created || 0)))[0];
}

/** slot -> roster id, from Sleeper's own map or from the user -> slot map. */
export function slotMap(draft, rosters = []) {
  const direct = draft?.slot_to_roster_id;
  if (direct && Object.keys(direct).length) return direct;
  const out = {};
  const ownerToRoster = new Map();
  for (const r of rosters) {
    if (r.owner_id) ownerToRoster.set(String(r.owner_id), r.roster_id);
    for (const c of r.co_owners || []) ownerToRoster.set(String(c), r.roster_id);
  }
  for (const [userId, slot] of Object.entries(draft?.draft_order || {})) {
    if (ownerToRoster.has(String(userId))) out[slot] = ownerToRoster.get(String(userId));
  }
  return out;
}

function draftShape(draft, ctx) {
  const teams = Number(draft?.settings?.teams) || ctx.numTeams;
  const rounds = Number(draft?.settings?.rounds) || Math.max(ctx.slots.length + 6, 14);
  return {
    teams, rounds,
    type: draft?.type || 'snake',
    reversalRound: Number(draft?.settings?.reversal_round) || 0,
  };
}

function orderSummary(draft, ctx) {
  const map = slotMap(draft, ctx.rosters);
  const mine = ctx.myRoster?.roster_id;
  const slots = Object.entries(map).map(([slot, rid]) => {
    const roster = ctx.rosterOf(rid);
    return { slot: Number(slot), rosterId: rid, teamName: roster ? ctx.teamName(roster) : `Roster ${rid}`, isMine: String(rid) === String(mine) };
  }).sort((a, b) => a.slot - b.slot);
  return { set: slots.length > 0, mySlot: slots.find((s) => s.isMine)?.slot ?? null, slots };
}

// -------------------------------------------------------------- rankings route

/** Rookies by FantasyCalc dynasty value (dynasty leagues only). */
export async function rookieClass(ctx, { limit = 24, fetchRows } = {}) {
  if (Number(ctx.league?.settings?.type) !== 2) return null;
  const p = marketParams({ rosterPositions: ctx.rosterPositions, scoring: ctx.scoring, numTeams: ctx.numTeams });
  const url = `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${p.numQbs}&numTeams=${p.numTeams}&ppr=${p.ppr}`;
  let rows;
  try {
    rows = fetchRows ? await fetchRows() : await getJson(url, { key: `fantasycalc:dyn:${p.numQbs}:${p.numTeams}:${p.ppr}`, ttl: MARKET_TTL, timeout: 15_000 });
  } catch (err) {
    console.warn(`[fantasycalc] rookies unavailable: ${err.message}`);
    return { available: false, rows: [] };
  }
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.player?.sleeperId ? String(r.player.sleeperId) : null;
    const yoe = r?.player?.maybeYoe ?? ctx.playerOf?.(id)?.years_exp ?? null;
    if (!id || Number(yoe) !== 0 || !Number.isFinite(Number(r.value))) continue;
    const pl = ctx.playerOf?.(id);
    out.push({
      id, name: r.player.name || pl?.name || id, position: r.player.position || pl?.position || null,
      team: pl?.team || r.player.maybeTeam || null, value: Math.round(Number(r.value)), overallRank: r.overallRank ?? null,
    });
  }
  out.sort((a, b) => b.value - a.value);
  return { available: true, rows: out.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 })) };
}

export async function draftBoardReport(ctx, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const [board, drafts] = await Promise.all([
    loadBoard(ctx, deps),
    (deps.getDrafts || getDraftsFresh)(ctx.league.league_id, 15_000),
  ]);
  const meta = chooseDraft(drafts);
  const draft = meta ? ((await (deps.getDraft || getDraftFresh)(meta.draft_id, 15_000)) || meta) : null;

  // Drafted players drop off the board only while the draft is being made.
  let drafted = [];
  if (draft && (draft.status === 'drafting' || draft.status === 'paused')) {
    const picks = await (deps.getPicks || getDraftPicksFresh)(draft.draft_id, 5_000);
    drafted = (picks || []).map((p) => String(p.player_id));
  }

  const out = {
    league: { id: ctx.league.league_id, name: ctx.league.name, season: ctx.season, teams: ctx.numTeams, rosterPositions: ctx.rosterPositions },
    draft: draft ? {
      id: draft.draft_id, status: draft.status, type: draft.type || 'snake',
      ...draftShape(draft, ctx),
      startTime: draft.start_time ?? null,
    } : null,
    countdown: { ...countdown(draft?.start_time, now), message: draft?.start_time ? null : MESSAGES.noDraftTime },
    order: draft ? orderSummary(draft, ctx) : { set: false, mySlot: null, slots: [] },
    orderMessage: MESSAGES.noOrder,
    drafted,
    hidesDrafted: drafted.length > 0,
  };
  if (!board.available) return { ...out, available: false, emptyMessage: board.emptyMessage };

  const dropped = new Set(drafted);
  const rankings = board.ranked.slice(0, 320).map((r) => ({
    rank: r.rank, id: r.id, name: r.name, position: r.position, team: r.team, posRank: r.posRank,
    points: r.points, vor: r.vor, tier: r.tier, adp: r.adp, market: r.market, drafted: dropped.has(String(r.id)),
  }));
  return {
    ...out,
    available: true,
    rankings,
    replacement: board.levels,
    tiers: board.tiers,
    marketAvailable: board.marketAvailable,
    marketMessage: board.marketAvailable ? null : MESSAGES.noMarket,
    adpKey: board.adpKey,
    rookies: await rookieClass(ctx, deps.rookies || {}),
    notes: {
      rankings: 'by value over replacement: a player’s projected season points, in your league’s scoring, minus what the best player nobody drafts at his position would give you.',
      tiers: 'value over replacement, grouped by natural gaps. a new tier starts where the drop to the next player is much bigger than usual for that position.',
    },
  };
}

// ----------------------------------------------------------------- live state

const POLL = { drafting: 5, paused: 15, pre_draft: 30, complete: 0, none: 60 };

/** Pure: everything the live assistant shows, from a draft and its picks. */
export function liveState({ draft, picks = [], tradedPicks = [], ranked = [], rosterPositions = [], myRosterId = null, teamName = (id) => `Roster ${id}`, rosters = [], numTeams = 12, slotsCount = 8, now = Date.now() }) {
  if (!draft) return { mode: 'none', status: 'none', supported: true, message: MESSAGES.noDraft, pollSeconds: POLL.none };

  const status = draft.status || 'pre_draft';
  const mode = status === 'complete' ? 'replay' : status === 'pre_draft' ? 'waiting' : 'live';
  const teams = Number(draft.settings?.teams) || numTeams;
  const rounds = Number(draft.settings?.rounds) || Math.max(slotsCount + 6, 14);
  const type = draft.type || 'snake';
  const reversalRound = Number(draft.settings?.reversal_round) || 0;
  const base = { mode, status, type, teams, rounds, totalPicks: teams * rounds, draftId: draft.draft_id, startTime: draft.start_time ?? null, pollSeconds: POLL[status] ?? 30 };
  if (status === 'pre_draft' && base.startTime && base.startTime - now < 10 * 60_000) base.pollSeconds = 10;

  const sorted = [...(picks || [])].sort((a, b) => a.pick_no - b.pick_no);
  const picksMade = sorted.length;

  if (type !== 'snake' && type !== 'linear') {
    return { ...base, supported: false, message: MESSAGES.unsupportedAuction, picksMade, feed: [], replayNote: null };
  }

  const map = slotMap(draft, rosters);
  const orderSet = Object.keys(map).length > 0;
  const order = buildOrder({ teams, rounds, type, reversalRound, slotToRoster: map, tradedPicks });
  const byId = new Map(ranked.map((r) => [String(r.id), r]));
  const mineKey = myRosterId != null ? String(myRosterId) : null;
  const isMine = (rid) => mineKey != null && rid != null && String(rid) === mineKey;

  const shaped = sorted.map((p) => {
    const r = byId.get(String(p.player_id));
    const md = p.metadata || {};
    const adp = r?.adp ?? null;
    return {
      pickNo: p.pick_no, round: p.round, slot: p.draft_slot ?? order[p.pick_no - 1]?.slot ?? null,
      rosterId: p.roster_id, teamName: teamName(p.roster_id), isMine: isMine(p.roster_id), isKeeper: Boolean(p.is_keeper),
      id: String(p.player_id),
      name: r?.name || [md.first_name, md.last_name].filter(Boolean).join(' ') || `Player ${p.player_id}`,
      position: r?.position || md.position || null,
      team: r?.team || md.team || null,
      adp, points: r?.points ?? null, vor: r?.vor ?? null,
      value: pickValue(p.pick_no, adp),
    };
  });
  const taken = new Set(shaped.map((p) => p.id));
  const available = ranked.filter((r) => !taken.has(String(r.id)));

  const nextPickNo = picksMade + 1;
  const live = mode === 'live' && orderSet && nextPickNo <= base.totalPicks;
  const onSlot = live ? order[nextPickNo - 1] : null;
  const onClock = onSlot ? {
    pickNo: nextPickNo, round: onSlot.round, slot: onSlot.slot, rosterId: onSlot.rosterId,
    teamName: onSlot.rosterId != null ? teamName(onSlot.rosterId) : null, isMine: isMine(onSlot.rosterId), traded: onSlot.traded,
  } : null;
  const myPicks = shaped.filter((p) => p.isMine);
  const upcomingMine = mineKey ? picksOf(order, mineKey, nextPickNo) : [];
  const myNext = upcomingMine[0] ?? null;

  const needs = startingNeeds(rosterPositions, myPicks.map((p) => ({ id: p.id, name: p.name, position: p.position, points: p.points || 0 })));
  const needPositions = new Set(needs.open.flatMap((s) => eligiblePositions(s)));
  const best = available.slice(0, 12).map((r) => ({
    id: r.id, name: r.name, position: r.position, team: r.team, vor: r.vor, points: r.points, adp: r.adp,
    tier: r.tier ?? null, fillsNeed: needPositions.has(r.position),
  }));
  const gone = likelyGone(available, myNext).slice(0, 12)
    .map((r) => ({ id: r.id, name: r.name, position: r.position, team: r.team, adp: r.adp, vor: r.vor }));

  // The board: rounds x slots. A column belongs to a slot; a cell to its owner.
  const mySlotCols = new Set(order.filter((o) => isMine(o.originalRosterId)).map((o) => o.slot));
  const columns = Array.from({ length: teams }, (_, i) => {
    const rid = map[i + 1] ?? null;
    return { slot: i + 1, rosterId: rid, teamName: rid != null ? teamName(rid) : `Slot ${i + 1}`, isMine: mySlotCols.has(i + 1) };
  });
  const cells = Array.from({ length: rounds }, () => Array(teams));
  for (const o of order) {
    const pick = shaped[o.pickNo - 1];
    cells[o.round - 1][o.slot - 1] = {
      pickNo: o.pickNo, slot: o.slot, traded: o.traded, ownerName: o.rosterId != null ? teamName(o.rosterId) : null,
      isMine: isMine(o.rosterId), onClock: onClock?.pickNo === o.pickNo,
      player: pick ? { name: pick.name, position: pick.position, team: pick.team } : null,
    };
  }

  // Grade: each team's projected starting lineup against the median team.
  const byRoster = new Map();
  for (const rid of new Set([...Object.values(map), ...shaped.map((p) => p.rosterId)])) byRoster.set(String(rid), []);
  for (const p of shaped) byRoster.get(String(p.rosterId))?.push({ id: p.id, name: p.name, position: p.position, points: p.points || 0 });
  const grade = gradeDraft(rosterPositions, byRoster);
  grade.teams = grade.teams.map((t) => ({ ...t, teamName: teamName(t.rosterId), isMine: isMine(t.rosterId) }));
  const me = grade.teams.find((t) => t.isMine) || null;
  grade.mine = me;
  grade.lineup = me ? grade.positions.map((pos) => ({ position: pos, mine: me.byPosition[pos] || 0, median: grade.medianByPosition[pos] || 0 })) : [];

  return {
    ...base,
    supported: true,
    orderSet,
    orderMessage: orderSet ? null : MESSAGES.noOrder,
    picksMade,
    onClock,
    waitingOnYou: Boolean(onClock?.isMine),
    myNextPick: myNext,
    picksUntilMine: myNext != null && onClock ? myNext - onClock.pickNo : null,
    myUpcoming: upcomingMine.slice(0, 5),
    pickedIds: [...taken],
    bestAvailable: best,
    runs: positionalRuns(shaped),
    needs,
    needsMessage: needs.filled ? 'every starting slot is filled. depth from here.' : 'starting slots you have not filled',
    likelyGone: gone,
    likelyGoneMessage: gone.length ? null : 'nobody on the board is likely to go before you pick.',
    feed: [...shaped].reverse().slice(0, 40),
    board: { columns, cells },
    grade,
    replayNote: mode === 'replay' ? 'a saved draft, replayed' : null,
  };
}

const LIVE_TTL = 3_000;
const liveCache = new WeakMap(); // ctx -> { at, promise }: every open tab shares one Sleeper read per 3s

export function draftLiveReport(ctx, deps = {}) {
  const t = deps.now ? deps.now() : Date.now();
  const hit = liveCache.get(ctx);
  if (!deps.fresh && hit && t - hit.at < LIVE_TTL) return hit.promise;
  const promise = buildLiveReport(ctx, deps);
  if (!deps.fresh) {
    liveCache.set(ctx, { at: t, promise });
    promise.catch(() => { if (liveCache.get(ctx)?.promise === promise) liveCache.delete(ctx); });
  }
  return promise;
}

async function buildLiveReport(ctx, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const [board, drafts] = await Promise.all([
    loadBoard(ctx, deps).catch(() => ({ available: false, ranked: [] })),
    (deps.getDrafts || getDraftsFresh)(ctx.league.league_id, 3_000),
  ]);
  const meta = chooseDraft(drafts);
  const common = {
    rosterPositions: ctx.rosterPositions, myRosterId: ctx.myRoster?.roster_id, rosters: ctx.rosters, numTeams: ctx.numTeams,
    slotsCount: ctx.slots.length, now, ranked: board.ranked || [],
    teamName: (id) => { const r = ctx.rosterOf(id); return r ? ctx.teamName(r) : `Roster ${id}`; },
  };
  if (!meta) return { ...liveState({ ...common, draft: null }), boardAvailable: board.available };

  const draft = (await (deps.getDraft || getDraftFresh)(meta.draft_id, 3_000)) || meta;
  const finished = draft.status === 'complete';
  const [picks, traded] = await Promise.all([
    (deps.getPicks || getDraftPicksFresh)(draft.draft_id, finished ? 10 * 60_000 : 3_000),
    (deps.getTraded || getDraftTradedPicks)(draft.draft_id, finished ? 10 * 60_000 : 15_000),
  ]);
  return {
    ...liveState({ ...common, draft, picks: picks || [], tradedPicks: traded || [] }),
    boardAvailable: board.available,
    feedStale: picks == null,
    generatedAt: now,
  };
}

// ------------------------------------------------------------------ mock draft

const FILLER_LATE = 2; // K and DEF wait until the last rounds, as a room's do

function counts(roster) {
  const c = {};
  for (const p of roster) c[p.position] = (c[p.position] || 0) + 1;
  return c;
}

/** How many of a position a team may carry before more is hoarding. */
function positionCap(position, starters) {
  const base = starters[position] || 0;
  if (position === 'K' || position === 'DEF') return Math.max(1, Math.ceil(base));
  if (position === 'QB' || position === 'TE') return Math.ceil(base) + 1;
  return Math.ceil(base) + 3;
}

function needSet(rosterPositions, roster) {
  const open = startingNeeds(rosterPositions, roster).open;
  return new Set(open.flatMap((s) => eligiblePositions(s)));
}

/**
 * Bots draft by ADP with a little noise and roster need. The noise for a pick
 * comes from `seed` and the pick number alone, so the same seed replays the
 * same bots whatever you choose.
 */
function botPick({ available, roster, rosterPositions, starters, seed, pickNo, round, rounds }) {
  const rand = mulberry32(seedFrom(`${seed}:${pickNo}`));
  const needs = needSet(rosterPositions, roster);
  const have = counts(roster);
  let best = null;
  for (const p of available.slice(0, 28)) {
    const sigma = 1.2 + 0.07 * p.mockAdp;
    let score = p.mockAdp + normal(rand) * sigma;
    if (needs.has(p.position)) score -= 3;
    if ((have[p.position] || 0) >= positionCap(p.position, starters)) score += 25;
    if ((p.position === 'K' || p.position === 'DEF') && round <= rounds - FILLER_LATE) score += 40;
    if (!starters[p.position]) score += 60;
    if (!best || score < best.score) best = { score, p };
  }
  return (best || { p: available[0] }).p;
}

/** Your pick when the computer drafts for you: best value, nudged by need. */
function autoPickFor({ available, roster, rosterPositions, starters, round, rounds }) {
  const needsList = startingNeeds(rosterPositions, roster).open;
  const needs = new Set(needsList.flatMap((s) => eligiblePositions(s)));
  const have = counts(roster);
  const roundsLeft = rounds - round + 1;
  // Rounds are running out for the starters still missing: take one now.
  const urgent = needsList.length >= roundsLeft;
  const usable = available.filter((p) => starters[p.position]
    && (have[p.position] || 0) < positionCap(p.position, starters)
    && !((p.position === 'K' || p.position === 'DEF') && round <= rounds - FILLER_LATE)
    && (!urgent || needs.has(p.position)));
  const from = usable.length ? usable : available;
  let best = null;
  for (const p of from) {
    const score = p.vor + (needs.has(p.position) ? 4 : 0);
    if (!best || score > best.score) best = { score, p };
  }
  return (best || { p: available[0] }).p;
}

/**
 * Run a mock draft from the top. `mine` is the ids you have chosen so far, in
 * order; the draft replays the bots to your first empty pick and stops there.
 * With `auto`, the computer makes your picks too (the quick mock).
 * Deterministic: the same inputs always give the same draft.
 */
export function runMock({ ranked, rosterPositions, teams, rounds, mySlot, seed = 1, mine = [], auto = false }) {
  const starters = Object.fromEntries(Object.entries(startersMap(rosterPositions)));
  // Players the room has an ADP for; anyone without one is drafted after those who do.
  const maxAdp = ranked.reduce((m, r) => (Number.isFinite(r.adp) ? Math.max(m, r.adp) : m), 0);
  const pool = ranked.map((r) => ({ ...r, mockAdp: Number.isFinite(r.adp) ? r.adp : maxAdp + 5 + r.rank / 10 }))
    .sort((a, b) => a.mockAdp - b.mockAdp);
  const gone = new Set();
  const rosters = new Map(Array.from({ length: teams }, (_, i) => [i + 1, []]));
  const picks = [];
  let mineIdx = 0;
  let onClock = null;

  for (let pickNo = 1; pickNo <= teams * rounds; pickNo++) {
    const round = Math.ceil(pickNo / teams);
    const slot = slotForPick(pickNo, teams, { type: 'snake' });
    const available = pool.filter((p) => !gone.has(p.id));
    if (!available.length) break;
    const roster = rosters.get(slot);
    let choice;
    let byUser = false;
    if (slot === mySlot) {
      if (auto) {
        choice = autoPickFor({ available, roster, rosterPositions, starters, round, rounds });
      } else {
        const wanted = mine[mineIdx];
        choice = wanted != null ? available.find((p) => String(p.id) === String(wanted)) : null;
        if (!choice) { onClock = { pickNo, round, slot }; break; }
        mineIdx++;
      }
      byUser = true;
    } else {
      choice = botPick({ available, roster, rosterPositions, starters, seed, pickNo, round, rounds });
    }
    gone.add(choice.id);
    const entry = {
      pickNo, round, slot, byUser, id: choice.id, name: choice.name, position: choice.position, team: choice.team,
      adp: choice.adp ?? null, points: choice.points, vor: choice.vor, value: pickValue(pickNo, choice.adp),
    };
    picks.push(entry);
    roster.push(entry);
  }

  const complete = !onClock;
  const left = pool.filter((p) => !gone.has(p.id)).sort((a, b) => b.vor - a.vor);
  const mySide = rosters.get(mySlot) || [];
  const needs = startingNeeds(rosterPositions, mySide);
  const needPositions = new Set(needs.open.flatMap((s) => eligiblePositions(s)));
  const grade = gradeDraft(rosterPositions, new Map([...rosters.entries()].map(([s, list]) => [s, list.map((p) => ({ id: p.id, name: p.name, position: p.position, points: p.points || 0 }))])));
  grade.teams = grade.teams.map((t) => ({ ...t, teamName: `Team ${t.rosterId}`, isMine: Number(t.rosterId) === Number(mySlot) }));
  grade.mine = grade.teams.find((t) => t.isMine) || null;
  grade.lineup = grade.mine ? grade.positions.map((pos) => ({ position: pos, mine: grade.mine.byPosition[pos] || 0, median: grade.medianByPosition[pos] || 0 })) : [];

  return {
    teams, rounds, mySlot, seed, auto, complete, onClock, picks,
    mine: picks.filter((p) => p.byUser),
    bestAvailable: left.slice(0, 15).map((p) => ({ id: p.id, name: p.name, position: p.position, team: p.team, vor: p.vor, adp: p.adp ?? null, tier: p.tier ?? null, fillsNeed: needPositions.has(p.position) })),
    needs,
    grade,
    columns: Array.from({ length: teams }, (_, i) => ({ slot: i + 1, teamName: i + 1 === mySlot ? 'You' : `Team ${i + 1}`, isMine: i + 1 === mySlot })),
  };
}

function startersMap(rosterPositions) {
  const out = {};
  for (const slot of rosterPositions || []) {
    if (['BN', 'IR', 'TAXI'].includes(slot)) continue;
    const el = eligiblePositions(slot);
    for (const pos of el) out[pos] = (out[pos] || 0) + 1 / el.length;
  }
  return out;
}

export async function draftMockReport(ctx, query, deps = {}) {
  const board = await loadBoard(ctx, deps);
  if (!board.available) return { available: false, emptyMessage: board.emptyMessage };
  const drafts = await (deps.getDrafts || getDraftsFresh)(ctx.league.league_id, 15_000);
  const meta = chooseDraft(drafts);
  const draft = meta ? ((await (deps.getDraft || getDraftFresh)(meta.draft_id, 15_000)) || meta) : null;
  const shape = draftShape(draft, ctx);
  const realSlot = draft ? orderSummary(draft, ctx).mySlot : null;

  const int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
  const teams = int(query.get('teams'), 2, 20, shape.teams);
  const rounds = int(query.get('rounds'), 1, 30, Math.min(shape.rounds, 30));
  const mySlot = int(query.get('slot'), 1, teams, Math.min(realSlot || 1, teams));
  const seed = int(query.get('seed'), 0, 2_147_483_647, 1);
  const mine = (query.get('mine') || '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,24}$/.test(s)).slice(0, 40);
  const quick = query.get('quick') === '1';

  const result = runMock({ ranked: board.ranked, rosterPositions: ctx.rosterPositions, teams, rounds, mySlot, seed, mine, auto: quick });
  return {
    available: true,
    realSlot, usedRealSlot: realSlot != null && realSlot === mySlot,
    quick,
    firstPicks: result.mine.slice(0, 5).map((p) => ({ pickNo: p.pickNo, name: p.name, position: p.position, team: p.team })),
    ...result,
  };
}
