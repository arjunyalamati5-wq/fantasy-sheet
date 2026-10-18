import { buildContext, withIrReturn } from './context.js';
import { parseIrReturn } from './availability.js';
import { getState, getUser, getLeaguesForUser } from './sleeper.js';
import { lineupReport, describe, bestLineupFor } from './features/lineup.js';
import { lastRegularWeek } from './features/horizon.js';
import { matchupReport } from './features/matchup.js';
import { liveReport, freshMatchups } from './features/live.js';
import { alertsReport } from './features/alerts.js';
import { exposureReport } from './features/exposure.js';
import { analyzeTrade, fullTradeReport, tradeTargets, handshakeDeals, rosValue, withMarket } from './features/trades.js';
import { dynastyReport, leagueKind, pickHoldings } from './features/dynasty.js';
import { profileReport, enrichRoster } from './features/rosterprofile.js';
import { historyReport } from './features/history.js';
import { getTradedPicks } from './sleeper.js';
import { marketForContext, dynastyMarketForContext, MARKET_CREDIT } from './fantasycalc.js';
import { marketReport } from './features/market.js';
import { waiverReport } from './features/waivers.js';
import { oppScoutReport, resolveScoutRoster } from './features/oppscout.js';
import { plannerReport } from './features/planner.js';
import { applyScenario, parseScenario } from './features/whatif.js';
import { tradeFinder } from './features/tradefinder.js';
import { round2 } from './scoring.js';
import { teamStrength } from './context.js';
import { solveLineup } from './lineup.js';
import { outInWeek } from './availability.js';
import { normalCdf } from './features/bracket.js';
import { takesReport } from './features/takes.js';
import { streamingReport, streamingPlan } from './features/streaming.js';
import { loadUsage } from './usage/store.js';
import { gamePlanReport } from './features/gameplan.js';
import { weekModel, predictNow, practiceLog, startPracticeClock } from './ml/live.js';
import { seasonReport, efficiencyReport, powerRankings } from './features/standings.js';
import { leagueBracket, playoffSettings, leagueLosersAdvance, parsePicks, validateUpset, validateLosersStyle } from './features/bracket.js';
import { getBracketLive } from './sleeper.js';
import { newsReport } from './features/news.js';
import { playerNewsReport } from './features/playernews.js';
import { buzzReport } from './features/buzz.js';
import { searchPlayers } from './features/search.js';
import { playerReport, searchCatalogue, isValidPlayerId, calibrationTable } from './features/scouting.js';
import { transactionsReport } from './features/transactions.js';
import { rosRankings } from './features/rankings.js';
import { bettingReport } from './features/betting.js';
import { propsReport } from './features/props.js';
import { startSit } from './features/startsit.js';
import { draftReport } from './features/draft.js';
import { buildMockDraft, runMockPicks, gradeMockRoster } from './features/mockdraft.js';
import { draftBoardReport, draftLiveReport, draftMockReport } from './features/draftroom.js';
import { dfsReport } from './features/dfs.js';
import { communityReport } from './features/community.js';
import { socialReport } from './features/social.js';
import { advisorEnabled, advisorActions, askAdvisor, buildAdvisorPayload } from './advisor.js';
import { cacheStats, cacheClear, cacheGroups } from './cache.js';
import { healthReport } from './features/health.js';
import { methodReport } from './features/method.js';
import { fsSync, env, IS_NODE } from './platform.js';

// Building a context pulls a 5MB player catalogue and several CSVs. Keep the
// assembled object in memory briefly so clicking between tabs is instant.
// Past five minutes a built context is still served — once — while a fresh
// one builds in the background, so the live score bug, which polls every 30
// seconds, never stalls on a rebuild. Past thirty minutes it is too old to
// show and the request waits for the rebuild.
const CONTEXT_TTL = 5 * 60_000;
const CONTEXT_STALE_MAX = 30 * 60_000;
const contexts = new Map(); // key -> { at, promise, ready, refreshing }
let generation = 0;         // bumped by invalidateContexts, so a late rebuild cannot resurrect cleared data

function contextKey({ leagueId, username, week }) {
  return `${leagueId}|${username || ''}|${week || 'current'}`;
}

export function getContext(params, { build = buildContext, now = Date.now } = {}) {
  const key = contextKey(params);
  const hit = contexts.get(key);
  if (hit) {
    const age = now() - hit.at;
    if (age < CONTEXT_TTL) return hit.promise;
    if (hit.ready && age < CONTEXT_STALE_MAX) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        const gen = generation;
        build(params).then((ctx) => {
          if (gen === generation) contexts.set(key, { at: now(), promise: Promise.resolve(ctx), ready: true, refreshing: false });
        }, (err) => {
          hit.refreshing = false; // keep serving the old one; the next request tries again
          console.warn(`[context] background rebuild failed: ${err.message}`);
        });
      }
      return hit.promise;
    }
  }

  pruneContexts(now());
  const entry = { at: now(), promise: null, ready: false, refreshing: false };
  entry.promise = build(params).then((ctx) => {
    entry.ready = true;
    return ctx;
  }, (err) => {
    if (contexts.get(key) === entry) contexts.delete(key); // never cache a failure
    throw err;
  });
  contexts.set(key, entry);
  return entry.promise;
}

// Open to the internet, anyone can ask for any league: keep at most this many
// in memory, and drop any too old to serve anyway.
const MAX_CONTEXTS = 40;
function pruneContexts(t) {
  for (const [k, v] of contexts) if (v.ready && t - v.at > CONTEXT_STALE_MAX) contexts.delete(k);
  while (contexts.size >= MAX_CONTEXTS) contexts.delete(contexts.keys().next().value); // oldest first
}

export function invalidateContexts() {
  generation++;
  contexts.clear();
}

/** Shared league header every view shows. */
function overview(ctx) {
  const roster = ctx.myRoster;
  const s = roster?.settings || {};
  return {
    league: {
      id: ctx.league.league_id,
      name: ctx.league.name,
      season: ctx.season,
      teams: ctx.numTeams,
      slots: ctx.slots,
      rosterPositions: ctx.rosterPositions,
      playoffTeams: ctx.playoffTeams,
      playoffWeekStart: ctx.playoffWeekStart,
      scoringHighlights: scoringHighlights(ctx.scoring),
    },
    week: ctx.week,
    completedWeeks: ctx.completedWeeks,
    projectionsAvailable: ctx.projectionsAvailable,
    warnings: ctx.warnings,
    myTeam: roster ? {
      rosterId: roster.roster_id,
      name: ctx.teamName(roster),
      record: `${s.wins || 0}-${s.losses || 0}${s.ties ? `-${s.ties}` : ''}`,
      pointsFor: Math.round(((s.fpts || 0) + (s.fpts_decimal || 0) / 100) * 100) / 100,
    } : null,
    teams: ctx.rosters.map((r) => ({
      rosterId: r.roster_id,
      name: ctx.teamName(r),
      isMine: String(r.roster_id) === String(ctx.myRoster?.roster_id),
    })),
    advisor: { enabled: advisorEnabled(), actions: advisorActions() },
    modelLab: MODEL_LAB,
  };
}

/** A few settings worth showing so the user can confirm we read the right league. */
function scoringHighlights(scoring) {
  const pick = ['rec', 'pass_td', 'pass_int', 'rush_td', 'rec_td', 'bonus_rec_te'];
  return pick
    .filter((k) => scoring[k] !== undefined)
    .map((k) => ({ key: k, value: scoring[k] }));
}

const ROUTES = {
  async state() {
    return getState();
  },

  async leagues({ query }) {
    const username = checked('username', query.get('username'));
    if (!username) throw httpError(400, 'Enter your Sleeper username.');
    const state = await getState();
    const season = checked('season', query.get('season')) || state.season;
    const user = await getUser(username);
    const leagues = await getLeaguesForUser(user.user_id, season);
    return {
      user: { id: user.user_id, username: user.username, displayName: user.display_name, avatar: user.avatar },
      season,
      leagues: (leagues || []).map((l) => ({
        id: l.league_id,
        name: l.name,
        teams: l.total_rosters,
        status: l.status,
        scoringType: l.scoring_settings?.rec === 1 ? 'PPR'
          : l.scoring_settings?.rec === 0.5 ? 'Half PPR' : 'Standard',
      })),
    };
  },

  async overview({ ctx }) { return overview(ctx); },

  async lineup({ ctx, query }) {
    await freshMatchups(ctx); // the set lineup comes from the live matchups
    const report = lineupReport(ctx, rosterParam(ctx, query));
    if (report.roster) await addRosterExtras(ctx, report);
    return { ...overview(ctx), report };
  },

  /**
   * The locker room's roster table and best-lineup plan with the manager's own
   * return weeks applied (?ir=pid:week,...), plus trade value and usage columns.
   */
  async locker({ ctx, query }) {
    await freshMatchups(ctx);
    const full = lineupReport(ctx, rosterParam(ctx, query));
    if (full.error) return { ...overview(ctx), report: full };
    const report = { rosterId: full.rosterId, week: full.week, roster: full.roster, plan: full.plan };
    await addRosterExtras(ctx, report);
    report.irReturn = Object.fromEntries(ctx.irReturn || []);
    return { ...overview(ctx), report };
  },

  /** Contender or rebuilder, roster age profile and starter injury flags, for the home page. */
  async profile({ ctx, query }) {
    return { ...overview(ctx), report: await profileReport(ctx, rosterParam(ctx, query)) };
  },

  /** Future picks by team, contender/rebuilder labels and dynasty values; an explanation in redraft leagues. */
  async dynasty({ ctx }) {
    return { ...overview(ctx), report: await dynastyReport(ctx) };
  },

  /** The league's past seasons: champions, your finish, all-time standings, head to head, best week. */
  async history({ query }) {
    const leagueId = checked('league', query.get('league'));
    if (!leagueId) throw httpError(400, 'Pick a league first.');
    const username = checked('username', query.get('username')) || env.SLEEPER_USERNAME || null;
    return { report: await historyReport({ leagueId, username }) };
  },

  /**
   * The best lineup by the numbers for one week from now to the end of the
   * regular season, with optional ?pin=id,id (start if legal) and ?bench=id,id (sit).
   * The week is `for`, not `week`: `week` already chooses which week the whole
   * context is built for.
   */
  async 'lineup-best'({ ctx, query }) {
    const last = Math.max(lastRegularWeek(ctx), ctx.week);
    const wk = query.get('for') ? Number(checked('week', query.get('for'))) : ctx.week;
    if (wk < ctx.week || wk > last) throw httpError(400, `Pick a week from ${ctx.week} to ${last}.`);
    const ids = (name) => {
      const raw = query.get(name);
      if (!raw) return [];
      const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
      if (list.length > 40 || list.some((x) => !/^[A-Za-z0-9_]{1,24}$/.test(x))) throw httpError(400, `That ${name} list is not valid.`);
      return list;
    };
    await freshMatchups(ctx);
    const rosterId = rosterParam(ctx, query);
    if (!ctx.rosterOf(rosterId)) throw httpError(404, 'No roster found.');
    return { week: wk, report: bestLineupFor(ctx, rosterId, { week: wk, pin: ids('pin'), bench: ids('bench') }) };
  },

  async matchup({ ctx, query }) {
    await freshMatchups(ctx);
    return { ...overview(ctx), report: matchupReport(ctx, rosterParam(ctx, query)) };
  },

  /** Live points, game clocks and win probability for the score bug. Polled. */
  async live({ ctx, query }) {
    return liveReport(ctx, rosterParam(ctx, query));
  },

  /** Game-day alerts for my set lineup: out/doubtful/bye starters with the best swap. Polled. */
  async alerts({ ctx, query }) {
    await freshMatchups(ctx); // the set lineup comes from the live matchups
    return alertsReport(ctx);
  },

  async exposure({ ctx, query }) {
    return { ...overview(ctx), report: exposureReport(ctx, rosterParam(ctx, query)) };
  },

  /** The prediction model: which approach is live, its practice record, and every graded snapshot. */
  async model({ query }) {
    if (!MODEL_LAB) throw httpError(404, 'No such endpoint: model');
    const leagueId = checked('league', query.get('league'));
    if (!leagueId) throw httpError(400, 'Pick a league first.');
    watchLeague(leagueId);
    const [m, live] = await Promise.all([weekModel(leagueId), practiceLog(leagueId)]);
    return {
      season: m.season, week: m.week, model: m.name, trainedAt: m.trainedAt,
      practice: m.practice, live, missing: m.missing,
    };
  },

  /** This week's predictions, with each one's likely range, beside Sleeper's projection. */
  async predictions({ query }) {
    if (!MODEL_LAB) throw httpError(404, 'No such endpoint: predictions');
    const leagueId = checked('league', query.get('league'));
    if (!leagueId) throw httpError(400, 'Pick a league first.');
    watchLeague(leagueId);
    return predictNow(leagueId);
  },

  /** The week as a to-do list, built from every other report. */
  async gameplan({ ctx, query }) {
    await freshMatchups(ctx);
    return { ...overview(ctx), report: await gamePlanReport(ctx, rosterParam(ctx, query)) };
  },

  async 'trade-targets'({ ctx, query }) {
    return { ...overview(ctx), report: tradeTargets(ctx, rosterParam(ctx, query)) };
  },

  async handshake({ ctx, query }) {
    const market = await marketForContext(ctx);
    return {
      ...overview(ctx),
      report: { ...handshakeDeals(ctx, rosterParam(ctx, query), { market }), marketAvailable: Boolean(market), marketCredit: MARKET_CREDIT },
    };
  },

  async market({ ctx }) { return { ...overview(ctx), report: marketReport(ctx) }; },

  /**
   * Trade finder. `wk` (not `week`, which sets the league's current week) names
   * the week to fix for goal=week. Searches the real league, never a what-if.
   */
  async tradefinder({ ctx, query }) {
    const base = ctx.baseCtx || ctx;
    const report = await tradeFinder(base, { goal: query.get('goal'), week: query.get('wk'), pos: query.get('pos'), limit: query.get('limit') });
    return { ...overview(base), report };
  },

  /** The what-if lab: what the current scenario changes, against the real league. */
  async whatif({ ctx }) {
    const base = ctx.baseCtx || ctx;
    const myId = ctx.myRoster?.roster_id;
    const lineup = (c) => (myId == null ? null : round2(c.solveFor(myId).total));
    const [before, after] = await Promise.all([
      seasonFor(base, 1),
      ctx === base ? null : seasonReport(ctx, { runs: 6000 }),
    ]);
    const mine = (r) => r?.teams.find((t) => t.isMine) || null;
    const b = mine(before);
    const a = mine(after) || b;
    const trades = tradeBreakdown(base, ctx, before, after);
    // With a trade in play the lineup row is points a week from next week on,
    // the same measure as the trade card, not this week's projection.
    const lineupRow = trades.length && trades[0].you.weeklyBefore != null
      ? { before: trades[0].you.weeklyBefore, after: trades[0].you.weeklyAfter, fromNextWeek: true, fromWeek: trades[0].fromWeek }
      : { before: lineup(base), after: lineup(ctx), fromNextWeek: false };
    return {
      ...overview(ctx),
      report: {
        key: ctx.scenario?.key || '',
        changes: ctx.scenario?.changes || [],
        ignoredPicks: after?.whatIf?.ignoredPicks || [],
        lineup: lineupRow,
        playoffs: b ? { before: b.playoffOdds, after: a.playoffOdds } : null,
        title: b ? { before: b.titleOdds ?? null, after: a.titleOdds ?? null } : null,
        expectedWins: b ? { before: b.projectedWins, after: a.projectedWins } : null,
        mark: a ? a.mark : null,
        machine: (after || before).machine,
        teams: (after || before).teams.map((t) => ({ rosterId: t.rosterId, name: t.name, isMine: t.isMine, playoffOdds: t.playoffOdds, mark: t.mark })),
        tradeFromWeek: (Number(ctx.week) || 1) + 1,
        trades,
      },
    };
  },

  /** How the numbers are made: floor/ceiling calibration and each hot-take detector's record. */
  async method({ ctx }) {
    return { ...overview(ctx), report: await methodReport(ctx, { season: seasonFor(ctx, 1) }) };
  },

  async takes({ ctx }) {
    return { ...overview(ctx), report: await takesReport(ctx) };
  },

  async waivers({ ctx, query }) {
    return { ...overview(ctx), report: await waiverReport(ctx, rosterParam(ctx, query)) };
  },

  /** Opponent scouting: ?roster= picks any team in the league; blank means this week's opponent. */
  async oppscout({ ctx, query }) {
    await freshMatchups(ctx);
    const rosterId = resolveScoutRoster(ctx, query.get('roster'));
    return { ...overview(ctx), report: await oppScoutReport(ctx, { rosterId }) };
  },

  /** Bye and injury planner: holes in every week left, with the best waiver fill for each. */
  async planner({ ctx, query }) {
    return { ...overview(ctx), report: await plannerReport(ctx, rosterParam(ctx, query)) };
  },

  async streaming({ ctx, query }) {
    const rosterId = rosterParam(ctx, query);
    // The 3-week kicker and defence plan reads sack rates from the nflverse usage tables when they exist.
    const usage = await loadUsage(Number(ctx.season)).catch(() => null);
    return { ...overview(ctx), report: streamingReport(ctx, rosterId), plan: streamingPlan(ctx, rosterId, { usage }) };
  },

  async season({ ctx, query }) {
    return { ...overview(ctx), report: await seasonFor(ctx, upsetParam(query)) };
  },

  /** The playoff bracket: Sleeper's real one when it exists, else the projected one. */
  async bracket({ ctx, query }) {
    const upset = upsetParam(query);
    let picks;
    let losersStyle;
    try {
      picks = parsePicks(query.get('picks'));
      losersStyle = validateLosersStyle(query.get('losers'));
    } catch (err) { throw httpError(400, err.message); }
    const leagueId = ctx.league.league_id;
    const [report, winnersRaw, losersRaw] = await Promise.all([
      seasonFor(ctx, upset), getBracketLive(leagueId, 'winners'), getBracketLive(leagueId, 'losers'),
    ]);
    const result = leagueBracket({
      teams: report.teams, settings: playoffSettings(ctx.league.settings, report.playoffTeams),
      winnersRaw, losersRaw, picks, losersStyle, upset,
      leagueAdvance: leagueLosersAdvance(ctx.league.settings),
    });
    return { ...overview(ctx), ...result };
  },

  async efficiency({ ctx }) { return { ...overview(ctx), report: efficiencyReport(ctx) }; },

  async power({ ctx }) { return { ...overview(ctx), report: powerRankings(ctx) }; },

  /** Full roster listings, used by the trade builder. */
  async rosters({ ctx }) {
    const market = await marketForContext(ctx);
    const kind = leagueKind(ctx.league);
    const held = kind === 'redraft' ? null : await pickHoldings(ctx).catch(() => null);
    return {
      ...overview(ctx),
      report: {
        kind,
        picks: held ? Object.fromEntries(held.teams.map((t) => [String(t.rosterId), t.picks])) : null,
        marketAvailable: Boolean(market),
        marketCredit: MARKET_CREDIT,
        rosters: ctx.rosters.map((r) => ({
          rosterId: r.roster_id,
          teamName: ctx.teamName(r),
          isMine: String(r.roster_id) === String(ctx.myRoster?.roster_id),
          players: withMarket(ctx.playersOn(r.roster_id)
            .map((p) => ({ ...describe(ctx, p), rosValue: rosValue(ctx, p) })), market)
            .sort((a, b) => b.value - a.value),
        })),
      },
    };
  },

  async news({ ctx, query }) {
    return { ...overview(ctx), report: await newsReport(ctx, rosterParam(ctx, query)) };
  },

  /** Latest stories mentioning one player, for the Model lab's reasons panel. */
  async 'player-news'({ ctx, query }) {
    const player = String(query.get('player') || '').trim();
    if (!/^(?:\d{1,12}|[A-Z]{2,3})$/.test(player)) throw httpError(400, 'That player is not valid.');
    return playerNewsReport(ctx, player);
  },

  /** Crowd mood per player (Sleeper adds/drops, Reddit) for the Model lab. */
  async buzz({ ctx }) {
    // Part of the private Model lab.
    if (!MODEL_LAB) throw httpError(404, 'No such endpoint: buzz');
    return buzzReport(ctx);
  },

  async search({ ctx, query }) {
    return {
      ...overview(ctx),
      report: searchPlayers(ctx, query.get('q'), {
        position: query.get('position') || null,
        limit: Number(query.get('limit')) || 40,
      }),
    };
  },

  /** One player's scouting report: facts, outlook with range, next opponents, game log. */
  async player({ ctx, query }) {
    const id = String(query.get('id') || '').trim();
    if (!isValidPlayerId(id)) throw httpError(400, 'That player is not valid.');
    const report = await playerReport(ctx, id);
    const m = (await marketForContext(ctx))?.get(String(id));
    if (m) report.facts.tradeValue = { value: m.value, posRank: m.posRank, pos: report.facts.pos, trend30: m.trend30, source: MARKET_CREDIT };
    return { ...overview(ctx), report };
  },

  /** Search the whole catalogue by name, position and ownership scope. */
  async players({ ctx, query }) {
    const scope = query.get('scope') || 'all';
    if (!['all', 'mine', 'rostered', 'free', 'ids'].includes(scope)) throw httpError(400, 'That scope is not valid.');
    const pos = query.get('pos') || null;
    if (pos && !['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(pos.toUpperCase())) throw httpError(400, 'That position is not valid.');
    const ids = scope === 'ids'
      ? String(query.get('ids') || '').split(',').filter(isValidPlayerId).slice(0, 200)
      : null;
    return {
      ...overview(ctx),
      report: searchCatalogue(ctx, { q: query.get('q'), pos: pos && pos.toUpperCase(), scope, ids, limit: 50 }),
    };
  },

  async transactions({ ctx }) {
    return { ...overview(ctx), report: await transactionsReport(ctx) };
  },

  async rankings({ ctx, query }) {
    return {
      ...overview(ctx),
      report: rosRankings(ctx, {
        position: query.get('position') || null,
        limit: Number(query.get('limit')) || 60,
        freeAgentsOnly: query.get('free') === '1',
      }),
    };
  },

  async betting({ ctx, query }) {
    return { ...overview(ctx), report: bettingReport(ctx, rosterParam(ctx, query)) };
  },

  async props({ ctx, query }) {
    return {
      ...overview(ctx),
      report: propsReport(ctx, {
        rosterId: rosterParam(ctx, query),
        scope: query.get('scope') || 'mine',
        position: query.get('position') || null,
        limit: Number(query.get('limit')) || 40,
      }),
    };
  },

  async startsit({ ctx, query }) {
    return {
      ...overview(ctx),
      report: startSit(ctx, {
        rosterId: rosterParam(ctx, query),
        a: query.get('a'),
        b: query.get('b'),
      }),
    };
  },

  async draft({ ctx }) {
    return { ...overview(ctx), report: await draftReport(ctx) };
  },

  async mockdraft({ ctx, query }) {
    return {
      ...overview(ctx),
      report: await buildMockDraft(ctx, {
        teams: Number(query.get('teams')) || ctx.numTeams,
        rounds: Number(query.get('rounds')) || null,
        mySlot: Number(query.get('slot')) || 1,
        seed: Number(query.get('seed')) || 1,
      }),
    };
  },

  // Draft room: rankings and tiers, the live assistant, and the seeded mock.
  async draftboard({ ctx }) {
    return { ...overview(ctx), report: await draftBoardReport(ctx) };
  },

  async draftlive({ ctx }) {
    return { report: await draftLiveReport(ctx) };
  },

  async draftmock({ ctx, query }) {
    return { ...overview(ctx), report: await draftMockReport(ctx, query) };
  },

  async community({ ctx, query }) {
    return { ...overview(ctx), report: await communityReport(ctx, rosterParam(ctx, query)) };
  },

  async sources({ ctx }) {
    return { ...overview(ctx), report: socialReport() };
  },

  async cache() { return cacheStats(); },

  /** Saved server data grouped by kind (never by league), for the Front office. */
  async 'cache-stats'() {
    const groups = await cacheGroups();
    const total = await cacheStats();
    const t = Date.now();
    return {
      total, groups,
      memory: { entries: contexts.size, oldestAge: contexts.size ? Math.max(...[...contexts.values()].map((c) => t - c.at)) : 0 },
      clearEveryMs: CLEAR_EVERY_MS,
      nextClearInMs: Math.max(0, lastClear + CLEAR_EVERY_MS - t),
      version: APP_VERSION,
    };
  },

  async health({ query }) {
    return { version: APP_VERSION, ...(await healthReport({
      league: checked('league', query.get('league')),
      username: checked('username', query.get('username')),
    })) };
  },
};

// Browser errors, written to the server log so a page that breaks only in
// one browser can still be diagnosed. Short text only; never stored.
let clientLogCount = 0;
setInterval(() => { clientLogCount = 0; }, 60_000).unref?.();

const POST_ROUTES = {
  async 'client-log'({ body }) {
    if (++clientLogCount > 30) return { ok: false };
    const clip = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' | ').slice(0, n);
    console.log(`[client] ${clip(body?.route, 60)} ${clip(body?.kind, 20)}: ${clip(body?.message, 300)} ${clip(body?.stack, 900)}`);
    return { ok: true };
  },

  async trade({ ctx, body }) {
    const market = await marketForContext(ctx);
    const kind = leagueKind(ctx.league);
    const [dynastyMarket, tradedPicks] = kind === 'redraft' ? [undefined, undefined]
      : await Promise.all([dynastyMarketForContext(ctx), getTradedPicks(ctx.league.league_id)]);
    const list = (v) => (Array.isArray(v) ? v.slice(0, 20).map(String) : []);
    const report = await fullTradeReport(ctx, {
      rosterId: body.rosterId || ctx.myRoster?.roster_id,
      partnerId: body.partnerId,
      give: list(body.give), get: list(body.get),
      givePicks: list(body.givePicks), getPicks: list(body.getPicks),
    }, { market, dynastyMarket, tradedPicks });
    return { ...overview(ctx), report: { ...report, marketAvailable: Boolean(market), marketCredit: MARKET_CREDIT } };
  },

  async advisor({ ctx, body }) {
    if (!advisorEnabled()) {
      return { enabled: false, error: 'No ANTHROPIC_API_KEY is set, so the advisor is switched off.' };
    }
    const payload = await advisorPayloadFor(ctx, body);
    return askAdvisor({ action: body.action, payload, question: body.question || null });
  },

  async dfs({ ctx, body }) {
    return {
      ...overview(ctx),
      report: dfsReport(ctx, {
        salaryCsv: body.salaryCsv,
        contestId: body.contestId,
        locked: body.locked || [],
        excluded: body.excluded || [],
      }),
    };
  },

  async 'mock-pick'({ ctx, body }) {
    const state = {
      board: body.board || [],
      teams: body.teams || ctx.numTeams,
      rounds: body.rounds || 14,
      mySlot: body.mySlot || 1,
      taken: body.taken || [],
      seed: body.seed || 1,
    };
    const advanced = runMockPicks(ctx, state);
    const allTaken = [...state.taken, ...advanced.picks];
    const myPicks = allTaken.filter((p) => p.slot === state.mySlot);
    return {
      ...advanced,
      taken: allTaken,
      grade: myPicks.length ? gradeMockRoster(ctx, myPicks) : null,
    };
  },

  async 'clear-cache'() {
    // Anyone can press it once the app is online; a full refresh re-downloads
    // megabytes from every source, so it runs at most once every ten minutes.
    if (Date.now() - lastClear < CLEAR_EVERY_MS) return { cleared: false, note: 'Data was refreshed in the last ten minutes.' };
    lastClear = Date.now();
    await cacheClear();
    invalidateContexts();
    return { cleared: true };
  },
};

/** Assemble exactly the computed numbers each advisor action needs. */
async function advisorPayloadFor(ctx, body) {
  const rosterId = body.rosterId || ctx.myRoster?.roster_id;
  switch (body.action) {
    case 'briefing': {
      const lineup = lineupReport(ctx, rosterId);
      const matchup = matchupReport(ctx, rosterId);
      const waivers = await waiverReport(ctx, rosterId);
      const streaming = streamingReport(ctx, rosterId);
      return buildAdvisorPayload(ctx, {
        lineup: {
          optimalTotal: lineup.optimal.total,
          setTotal: lineup.set.total,
          pointsLeftOnBench: lineup.pointsLeftOnBench,
          suggestedSwaps: lineup.swaps,
          alerts: lineup.alerts,
        },
        matchup: matchup.error ? { unavailable: matchup.error } : {
          opponent: matchup.them.teamName,
          winProbability: matchup.winProbability,
          projected: matchup.projected,
          margin: matchup.margin,
          mostImportantStarters: matchup.swings.slice(0, 4),
        },
        topWaiverOptions: waivers.rows.slice(0, 6),
        streamingOptions: Object.fromEntries(
          Object.entries(streaming.groups).map(([k, g]) => [k, g.rows.slice(0, 3)])
        ),
      });
    }
    case 'roster': {
      const lineup = lineupReport(ctx, rosterId);
      const exposure = exposureReport(ctx, rosterId);
      const power = powerRankings(ctx);
      return buildAdvisorPayload(ctx, {
        startingLineup: lineup.optimal.assignments
          .filter((a) => a.player)
          .map((a) => ({ slot: a.slotLabel, ...a.player })),
        bench: lineup.bench,
        exposure: exposure.rows,
        powerRanking: power.rows.find((r) => String(r.rosterId) === String(rosterId)) || null,
        leagueRankings: power.rows.map((r) => ({ rank: r.rank, team: r.teamName, vor: r.vor })),
      });
    }
    case 'trade':
    case 'propose': {
      const trade = analyzeTrade(ctx, {
        rosterId,
        partnerId: body.partnerId,
        give: body.give || [],
        get: body.get || [],
      });
      if (trade.error) throw httpError(400, trade.error);
      return buildAdvisorPayload(ctx, { trade });
    }
    default:
      throw httpError(400, `Unknown advisor action "${body.action}".`);
  }
}

/**
 * What each trade in a what-if does, for both teams: lineup points a week from
 * next week on (trades take effect next week), the rest-of-season total, who
 * enters and leaves your starting lineup, and both teams' playoff and title
 * odds, plus a plain verdict.
 */
function tradeBreakdown(base, ctx, before, after) {
  const trades = ctx.scenario?.trades || [];
  if (!trades.length || !after) return [];
  const now = Number(ctx.week) || 1;
  const last = (Number(ctx.playoffWeekStart) || 15) - 1;
  const later = [];
  for (let w = now + 1; w <= last; w++) later.push(w);
  const myId = String(ctx.myRoster?.roster_id);
  const row = (rep, id) => rep.teams.find((t) => String(t.rosterId) === String(id)) || null;
  const weekly = (c, id) => (later.length ? round2(teamStrength(c, id, { weeks: later }).mean) : null);
  const starters = (c) => new Set(c.solveFor(myId).assignments.map((a) => a.player?.player_id).filter(Boolean));
  const was = starters(base);
  const now2 = starters(ctx);
  const nameOf = (pid) => ctx.playerOf(pid)?.name || pid;
  const side = (id) => {
    const b = row(before, id);
    const a = row(after, id);
    const wBefore = weekly(base, id);
    const wAfter = weekly(ctx, id);
    const perWeek = wBefore != null && wAfter != null ? round2(wAfter - wBefore) : null;
    return {
      rosterId: id,
      name: a?.name || b?.name || `Roster ${id}`,
      weeklyBefore: wBefore,
      weeklyAfter: wAfter,
      perWeek,
      restOfSeason: perWeek != null ? round2(perWeek * later.length) : null,
      playoffs: b && a ? { before: b.playoffOdds, after: a.playoffOdds } : null,
      title: b && a && b.titleOdds != null ? { before: b.titleOdds, after: a.titleOdds } : null,
      expectedWins: b && a ? { before: b.projectedWins, after: a.projectedWins } : null,
    };
  };
  // Week by week: every regular-season week left (with your real opponent and
  // win chance) and the fantasy playoff weeks, before and after the trades.
  const playoffStart = Number(ctx.playoffWeekStart) || 15;
  const playoffWeeks = [playoffStart, playoffStart + 1, playoffStart + 2].filter((w) => w <= 18);
  const oppOf = new Map(); // week -> opponent roster id for me
  for (const wk of before.machine || []) {
    for (const g of wk.games) {
      if (String(g.a) === myId) oppOf.set(wk.week, String(g.b));
      if (String(g.b) === myId) oppOf.set(wk.week, String(g.a));
    }
  }
  const strengthAt = (c, id, w) => teamStrength(c, id, { weeks: [w] });
  const winChance = (a, b) => {
    const sd = Math.hypot(a.sd, b.sd);
    return sd > 0 ? normalCdf((a.mean - b.mean) / sd) : 0.5;
  };
  const statusIn = (pid, w) => {
    const p = ctx.playerOf(pid);
    if (!p) return 'unknown';
    if (p.team && ctx.schedule?.isOnBye?.(p.team, w)) return 'bye';
    const inj = ctx.injuryByPlayer?.get(pid);
    if (inj && outInWeek({ status: inj.sleeperStatus, currentWeek: ctx.week, week: w, returnWeek: ctx.irReturn?.get(pid) })) return 'out';
    return 'plays';
  };
  // Starting slots nobody can fill that week (everyone eligible is on bye or out).
  const emptySlots = (c, id, w) => {
    const avail = c.playersOn(id).filter((p) => statusIn(p.player_id, w) === 'plays');
    const { assignments } = solveLineup(c.slots, avail, (p) => c.valueOf(p.player_id));
    return assignments.filter((a) => !a.player).map((a) => a.slotLabel || a.slot);
  };
  const weekRows = (t) => [...later.map((w) => ['regular', w]), ...playoffWeeks.map((w) => ['playoffs', w])].map(([phase, w]) => {
    const yb = strengthAt(base, myId, w);
    const ya = strengthAt(ctx, myId, w);
    const tb = strengthAt(base, t.partner, w);
    const ta = strengthAt(ctx, t.partner, w);
    let match = null;
    const opp = phase === 'regular' ? oppOf.get(w) : null;
    if (opp) {
      const ob = strengthAt(base, opp, w);
      const oa = strengthAt(ctx, opp, w);
      match = { opponentId: opp, opponent: ctx.teamName(ctx.rosterOf(opp)), before: round2(winChance(yb, ob)), after: round2(winChance(ya, oa)), vsPartner: opp === String(t.partner) };
    }
    return {
      week: w, phase,
      you: { before: round2(yb.mean), after: round2(ya.mean), delta: round2(ya.mean - yb.mean) },
      them: { before: round2(tb.mean), after: round2(ta.mean), delta: round2(ta.mean - tb.mean) },
      match,
      // Usual starters missing that week (bye or out): the "why" behind a dip.
      absent: {
        you: { before: [...was].filter((pid) => statusIn(pid, w) !== 'plays').map(nameOf), after: [...now2].filter((pid) => statusIn(pid, w) !== 'plays').map(nameOf) },
      },
      empty: {
        you: { before: emptySlots(base, myId, w), after: emptySlots(ctx, myId, w) },
        them: { before: emptySlots(base, t.partner, w), after: emptySlots(ctx, t.partner, w) },
      },
      players: [...t.give.map((pid) => ['sent', pid]), ...t.get.map((pid) => ['got', pid])].map(([dir, pid]) => ({
        name: nameOf(pid), dir, status: statusIn(pid, w), value: round2(ctx.valueOf(pid)),
      })),
    };
  });
  // How each traded player is valued: per game played, never a season total
  // dragged down by the weeks he missed.
  const valuation = (pid, dir) => {
    const v = ctx.valuations?.byId?.get(pid) || {};
    const log = (ctx.resultsByPlayer?.get(pid) || []).filter((g) => !g.onBye);
    const played = log.filter((g) => g.played !== false);
    const total = played.reduce((a, g) => a + g.points, 0);
    return {
      name: nameOf(pid), dir, pos: ctx.playerOf(pid)?.position || '',
      gamesPlayed: played.length, gamesMissed: log.length - played.length,
      perGame: played.length ? round2(total / played.length) : null,
      seasonTotal: round2(total),
      perWeekOverAllWeeks: log.length ? round2(total / log.length) : null,
      value: round2(ctx.valueOf(pid)),
      projFrom: v.projFrom || null,
      status: statusIn(pid, now),
    };
  };

  return trades.map((t) => {
    const you = side(myId);
    const them = side(t.partner);
    const pct = (x) => `${Math.round(x * 100)}%`;
    const pts = (x) => `${Math.abs(x).toFixed(1)} point${Math.abs(x).toFixed(1) === '1.0' ? '' : 's'} a week`;
    const parts = [];
    if (you.perWeek != null) parts.push(you.perWeek >= 0.05 ? `Your lineup gains ${pts(you.perWeek)} from week ${now + 1}` : you.perWeek <= -0.05 ? `Your lineup loses ${pts(you.perWeek)} from week ${now + 1}` : 'Your lineup barely moves');
    if (you.playoffs) parts.push(`your playoff odds go ${pct(you.playoffs.before)} to ${pct(you.playoffs.after)}`);
    let verdict = `${parts.join(', ')}.`;
    if (them.perWeek != null) {
      verdict += them.perWeek >= 0.05
        ? ` ${them.name} gains ${pts(them.perWeek)} too, so it is an easy pitch.`
        : them.perWeek <= -0.05
          ? ` ${them.name} loses ${pts(them.perWeek)}${them.playoffs ? ` and drops from ${pct(them.playoffs.before)} to ${pct(them.playoffs.after)} playoff odds` : ''}, so expect a counter.`
          : ` It is close to neutral for ${them.name}.`;
    }
    if (!later.length) verdict = 'No regular-season weeks are left after this one, so a trade cannot change the regular season.';
    return {
      partner: t.partner,
      give: t.give.map((pid) => ({ id: pid, name: nameOf(pid), pos: ctx.playerOf(pid)?.position || '' })),
      get: t.get.map((pid) => ({ id: pid, name: nameOf(pid), pos: ctx.playerOf(pid)?.position || '' })),
      fromWeek: now + 1,
      weeksLeft: later.length,
      you,
      them,
      weeks: weekRows(t),
      players: [...t.give.map((pid) => valuation(pid, 'sent')), ...t.get.map((pid) => valuation(pid, 'got'))],
      intoLineup: [...now2].filter((pid) => !was.has(pid)).map(nameOf),
      outOfLineup: [...was].filter((pid) => !now2.has(pid)).map(nameOf),
      verdict,
    };
  });
}

function upsetParam(query) {
  try { return validateUpset(query.get('upset')); } catch (err) { throw httpError(400, err.message); }
}

// One simulation per league context and upset factor: the bracket page asks
// again on every pick, and the answer does not change with a pick.
const seasonMemo = new WeakMap();
function seasonFor(ctx, upset) {
  if (!seasonMemo.has(ctx)) seasonMemo.set(ctx, new Map());
  const memo = seasonMemo.get(ctx);
  if (!memo.has(upset)) {
    const p = seasonReport(ctx, { upset });
    memo.set(upset, p);
    p.catch(() => memo.delete(upset));
  }
  return memo.get(upset);
}

/** Trade value and usage columns on the roster table; either is left out when its source is down. */
async function addRosterExtras(ctx, report) {
  const market = await Promise.race([marketForContext(ctx), new Promise((r) => setTimeout(() => r(null), 2500))]);
  const { rows, columns } = await enrichRoster(ctx, report.roster, { market });
  report.roster = rows;
  report.rosterColumns = columns;
}

function rosterParam(ctx, query) {
  return query.get('roster') || ctx.myRoster?.roster_id;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Routes that need a league context built first. */
// Leagues whose model has been looked at get live practice snapshots taken
// for them from then on (PRACTICE_LEAGUE adds leagues from the start).
// The prediction model is a private tool: on when you run the app yourself,
// off on the public site (render.yaml sets MODEL_LAB=off).
const MODEL_LAB = env.MODEL_LAB !== 'off' && IS_NODE;

const watched = new Map();
export function watchLeague(leagueId) {
  if (!MODEL_LAB || watched.has(leagueId) || watched.size >= 10) return;
  watched.set(leagueId, startPracticeClock(leagueId));
}

let lastClear = 0;
let APP_VERSION = '';
try { if (fsSync) APP_VERSION = JSON.parse(fsSync.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || ''; } catch { /* about line just omits it */ }
const CLEAR_EVERY_MS = 10 * 60_000;

// What a request may name. Sleeper ids are digits and usernames are short
// word characters; anything else never reaches a Sleeper URL.
const VALID = {
  league: /^\d{1,24}$/,
  username: /^[A-Za-z0-9_.-]{1,40}$/,
  season: /^20\d\d$/,
  week: /^(?:[1-9]|1\d|2[0-2])$/,
};
function checked(name, value) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (!VALID[name].test(v)) throw httpError(400, `That ${name} is not valid.`);
  return v;
}

const NEEDS_CONTEXT = new Set([
  ...Object.keys(ROUTES).filter((k) => !['history', 'state', 'leagues', 'cache', 'cache-stats', 'health', 'model', 'predictions'].includes(k)),
  'trade', 'advisor', 'dfs', 'mock-pick',
]);

// Leagues opened lately, so a restarted server (a free host sleeps when idle)
// can build them before the next visitor asks. Ids and usernames only, kept
// with the rest of the server cache.
const RECENT_FILE = new URL('../.cache/recent-leagues.json', import.meta.url);
const RECENT_MAX = 5;
let recentSaved = '';
function rememberLeague(leagueId, username) {
  if (!fsSync) return;
  let list = [];
  try { list = JSON.parse(fsSync.readFileSync(RECENT_FILE, 'utf8')); } catch { /* first one */ }
  list = [{ leagueId, username }, ...list.filter((x) => x.leagueId !== leagueId || x.username !== username)].slice(0, RECENT_MAX);
  const text = JSON.stringify(list);
  if (text === recentSaved) return;
  recentSaved = text;
  try { fsSync.mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true }); fsSync.writeFileSync(RECENT_FILE, text); } catch { /* best effort */ }
}

/** Build the recently opened leagues in the background (called at start-up). */
export async function warmRecentLeagues(log = console.log) {
  if (!fsSync) return;
  let list = [];
  try { list = JSON.parse(fsSync.readFileSync(RECENT_FILE, 'utf8')); } catch { return; }
  for (const { leagueId, username } of list) {
    if (!VALID.league.test(String(leagueId)) || (username && !VALID.username.test(username))) continue;
    const t = Date.now();
    try { await getContext({ leagueId, username }); log(`[warm] league ${leagueId} ready in ${Date.now() - t} ms`); } catch (err) { log(`[warm] league ${leagueId}: ${err.message}`); }
  }
}

export async function handleApi(pathname, { query, body, method }) {
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const table = method === 'POST' ? POST_ROUTES : ROUTES;
  const handler = table[name];
  if (!handler) throw httpError(404, `No such endpoint: ${name}`);

  let ctx = null;
  if (NEEDS_CONTEXT.has(name)) {
    const leagueId = checked('league', query.get('league') || body?.leagueId);
    if (!leagueId) throw httpError(400, 'Pick a league first.');
    rememberLeague(leagueId, checked('username', query.get('username') || body?.username) || null);
    ctx = await getContext({
      leagueId,
      username: checked('username', query.get('username') || body?.username) || env.SLEEPER_USERNAME || null,
      season: checked('season', query.get('season') || body?.season),
      week: checked('week', query.get('week') || body?.week),
    });
    // The manager's own "back in week" choices (ir=pid:week,...) change projections for this request only.
    const irRaw = query.get('ir') || body?.ir;
    if (irRaw) {
      if (String(irRaw).length > 1200) throw httpError(400, 'That return-week list is not valid.');
      ctx = withIrReturn(ctx, parseIrReturn(irRaw, { currentWeek: ctx.week }));
    }
    // The what-if lab (wi=...): roster moves and picked results for this request only.
    const wiRaw = query.get('wi') || body?.wi;
    if (wiRaw) {
      try { ctx = applyScenario(ctx, parseScenario(wiRaw)); } catch (err) {
        // The client clears a what-if it is told is stale; the prefix is how it knows.
        throw httpError(err.status || 400, `What-if: ${err.message}`);
      }
    }
  }

  return handler({ ctx, query, body, method });
}

export { httpError };
