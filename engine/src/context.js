import {
  getState, getUser, getLeaguesForUser, getLeague, getRosters, getLeagueUsers,
  getMatchups, getPlayers, getProjections, getWeekStats, getTrending, projectionsAvailable,
} from './sleeper.js';
import { getWeeklyUsage, getSnapCounts, getInjuries, getSchedule, lockChecker } from './nflverse.js';
import { loadWeekWeather } from './weather.js';
import { buildIdMaps } from './ids.js';
import { scoreStats, DEFAULT_SCORING, round2 } from './scoring.js';
import { startingSlots, solveLineup } from './lineup.js';
import { buildValuations } from './value.js';
import { playerSd } from './variance.js';
import { normTeam } from './teams.js';
import { weekStatus, weekProjection, outInWeek } from './availability.js';

const RELEVANT = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const USAGE_LOOKBACK = 4; // weeks of snap/target data that describe a current role

/**
 * Load everything one league needs and derive the shared numbers every feature
 * reads from. Built once per request and cached upstream by the HTTP layer.
 */
export async function buildContext({ leagueId, username, season, week }) {
  const state = await getState();
  const useSeason = String(season || state.season);
  const targetWeek = Number(week) || Math.max(1, state.week);

  // Start the slow, independent loads now so they overlap everything below.
  // Weather needs only the schedule; forecasts exist only for the week being
  // played. Neither promise can reject (both sources are soft).
  const schedulePromise = getSchedule(useSeason);
  const weatherPromise = targetWeek === Number(state.week)
    ? schedulePromise.then((s) => loadWeekWeather(s, targetWeek)).catch(() => new Map())
    : Promise.resolve(new Map());
  const userLookup = username
    ? getUser(username).then((user) => ({ user }), (error) => ({ error }))
    : Promise.resolve(null);

  const [league, rosters, leagueUsers, players] = await Promise.all([
    getLeague(leagueId),
    getRosters(leagueId),
    getLeagueUsers(leagueId),
    getPlayers(),
  ]).catch((err) => {
    // Don't surface a raw URL and status code to someone who mistyped a league.
    if (err.status === 404) {
      throw Object.assign(
        new Error('That league could not be found on Sleeper. Check the league, or pick it again from your list.'),
        { status: 404 }
      );
    }
    throw err;
  });
  if (!league) throw new Error(`League ${leagueId} could not be loaded from Sleeper.`);

  const scoring = league.scoring_settings && Object.keys(league.scoring_settings).length
    ? league.scoring_settings
    : DEFAULT_SCORING;
  const rosterPositions = league.roster_positions || [];
  const slots = startingSlots(rosterPositions);
  const numTeams = rosters.length || league.total_rosters || 10;

  // Completed weeks this season. Week 1 is only "complete" once week 2 begins.
  const completedWeeks = [];
  for (let w = 1; w < targetWeek; w++) completedWeeks.push(w);

  const [projections, schedule, usageRaw, snapsRaw, injuriesRaw, idMaps, ...futureProjections] = await Promise.all([
    getProjections(useSeason, targetWeek),
    schedulePromise,
    getWeeklyUsage(useSeason),
    getSnapCounts(useSeason),
    getInjuries(useSeason),
    buildIdMaps(players),
    // The next two weeks, so a player on bye or briefly out is valued on the
    // week he next plays (see value.js). Soft: a missing week is just null.
    getProjections(useSeason, targetWeek + 1).catch(() => null),
    getProjections(useSeason, targetWeek + 2).catch(() => null),
  ]);

  const weekStats = {};
  await Promise.all(completedWeeks.map(async (w) => { weekStats[w] = await getWeekStats(useSeason, w); }));

  // Historical matchups give us set lineups (for efficiency) and past scores.
  const pastMatchups = {};
  await Promise.all(completedWeeks.map(async (w) => { pastMatchups[w] = await getMatchups(leagueId, w); }));
  const currentMatchups = await getMatchups(leagueId, targetWeek, { live: true });

  // --- Ownership ----------------------------------------------------------
  const ownerOf = new Map();  // player_id -> rosterId
  for (const r of rosters) {
    for (const pid of r.players || []) ownerOf.set(pid, r.roster_id);
  }
  const userById = new Map(leagueUsers.map((u) => [u.user_id, u]));
  const teamName = (r) => {
    const u = userById.get(r.owner_id);
    return u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}`;
  };

  const mine = pickMyRoster(rosters, username, await userLookup, teamName);
  const myRoster = mine.roster;

  // --- Results: score every completed week in THIS league's settings -------
  const resultsByPlayer = new Map();
  const candidateIds = buildCandidateSet(players, ownerOf);

  for (const w of completedWeeks) {
    const stats = weekStats[w] || {};
    for (const id of candidateIds) {
      const p = players[id];
      if (!p) continue;
      const line = stats[id];
      let entry;
      if (line) {
        entry = { week: w, points: scoreStats(line.stats, scoring), onBye: false, played: true };
      } else if (p.team) {
        // No stat line: either the team was on bye, or he did not play.
        // isOnBye fails open, so an unrecognised team is never treated as a bye.
        const onBye = schedule.isOnBye(p.team, w);
        entry = { week: w, points: 0, onBye, played: false };
      } else {
        continue; // free agent with no team: nothing to say about that week
      }
      if (!resultsByPlayer.has(id)) resultsByPlayer.set(id, []);
      resultsByPlayer.get(id).push(entry);
    }
  }

  // --- Usage: nflverse targets/snaps, joined through the crosswalk --------
  const usageByPlayer = buildUsage({
    players, candidateIds, idMaps, usageRaw, snapsRaw,
    weeks: completedWeeks.slice(-USAGE_LOOKBACK),
  });

  // --- Injuries -----------------------------------------------------------
  // The official report counts only when it was filed for the week being
  // viewed; a player's latest report can be weeks old.
  const injuryByPlayer = new Map();
  for (const id of candidateIds) {
    const p = players[id];
    const gsis = idMaps.sleeperToGsis.get(id);
    const latest = gsis ? injuriesRaw.byGsis.get(gsis) : null;
    const official = latest && Number(latest.week) === targetWeek ? latest : null;
    if (p?.injury_status || official) {
      injuryByPlayer.set(id, {
        sleeperStatus: p?.injury_status || null,
        bodyPart: p?.injury_body_part || official?.primaryInjury || null,
        reportStatus: official?.reportStatus || null,
        practiceStatus: official?.practiceStatus || null,
        week: official?.week ?? null,
      });
    }
  }

  // --- Valuations ---------------------------------------------------------
  const valuations = buildValuations({
    players, scoring, projections, futureProjections, resultsByPlayer, usageByPlayer,
    slots, numTeams, candidateIds: [...candidateIds],
  });

  const onByeThisWeek = (id) => {
    const p = players[id];
    return p?.team ? schedule.isOnBye(p.team, targetWeek) : false;
  };

  // The designation that applies to the week being viewed (see availability.js).
  const statusByPlayer = new Map();
  for (const [id, inj] of injuryByPlayer) {
    const status = weekStatus({
      sleeperStatus: inj.sleeperStatus,
      official: inj.reportStatus ? { reportStatus: inj.reportStatus, week: inj.week } : null,
      targetWeek, currentWeek: state.week,
    });
    if (status) statusByPlayer.set(id, status);
  }

  // Per-week projected points used by the lineup views. With no projection
  // row, fall back to the blended value so a slot is not silently worth zero —
  // unless he has no game (bye, or no NFL team) or has been ruled out, when
  // zero is the truth.
  const weekPoints = new Map();
  for (const id of candidateIds) {
    const proj = projections[id];
    weekPoints.set(id, weekProjection({
      projected: proj ? scoreStats(proj.stats, scoring) : null,
      fallback: valuations.byId.get(id)?.value ?? 0,
      onBye: onByeThisWeek(id),
      hasTeam: Boolean(players[id]?.team),
      status: statusByPlayer.get(id) || null,
    }));
  }

  // Forecasts only exist for the week being played; a past or far-future week
  // gets none. The load started with the other fetches, so this rarely waits.
  const weatherByGame = await weatherPromise;

  // Sleeper's player file keeps long-gone players attached to a team (a 2009
  // rookie still reads "SF, Active"). A free agent worth naming must not be
  // inactive and must show real football: a projection this week or in the
  // next two, or a game played this season. Defences always count.
  const projected = (id) => [projections, ...futureProjections].some((pr) => {
    const row = pr?.[id];
    return row && scoreStats(row.stats, scoring) > 0.5;
  });
  const isLiveFreeAgent = (p) => {
    if (p.position === 'DEF') return true;
    if (p.status === 'Inactive' || (p.search_rank ?? 0) >= 9_999_999) return false;
    return projected(p.player_id) || (resultsByPlayer.get(p.player_id) || []).some((g) => g.played);
  };

  // Games he played: a missed week is neither a 0 nor part of his swing.
  const gameLog = (id) => (resultsByPlayer.get(id) || []).filter((g) => !g.onBye && g.played !== false).map((g) => g.points);

  const ctx = {
    state, season: useSeason, week: targetWeek, completedWeeks,
    league, scoring, rosterPositions, slots, numTeams,
    rosters, leagueUsers, players, teamName, ownerOf, myRoster,
    projections, projectionsAvailable: projectionsAvailable(projections),
    schedule, usageByPlayer, injuryByPlayer, idMaps,
    resultsByPlayer, valuations, weekPoints, candidateIds,
    pastMatchups, currentMatchups,
    playoffTeams: league.settings?.playoff_teams || 6,
    playoffWeekStart: league.settings?.playoff_week_start || 15,

    /** Points we expect a player to score this week. */
    pointsFor(id) { return weekPoints.get(id) ?? 0; },
    /** Long-run value (the blended three-signal number). */
    valueOf(id) { return valuations.byId.get(id)?.value ?? 0; },
    vorOf(id) { return valuations.byId.get(id)?.vor ?? 0; },
    /** Injury designation that applies to the week being viewed, or null. */
    weekStatusOf(id) { return statusByPlayer.get(id) || null; },
    onByeThisWeek,
    gameLog,
    /**
     * True once a player's game this week has kicked off, so Sleeper will not
     * let him move in or out of a lineup.
     */
    isLocked: lockChecker({ schedule, players, week: targetWeek, currentWeek: state.week }),
    /** Kickoff-hour forecast for a team's game this week, or null (indoors, or none yet). */
    weatherFor(team) {
      const game = team ? schedule.gameFor(team, targetWeek) : null;
      return game ? weatherByGame.get(game.gameId) || null : null;
    },
    playerOf(id) { return players[id] || null; },
    rosterOf(rosterId) { return rosters.find((r) => String(r.roster_id) === String(rosterId)) || null; },
    /** Players on a roster, as full player objects. */
    playersOn(rosterId) {
      const r = ctx.rosterOf(rosterId);
      if (!r) return [];
      return (r.players || []).map((id) => players[id]).filter(Boolean);
    },
    /** Best legal lineup for a roster, valued however you like. */
    solveFor(rosterId, valueFn = (p) => ctx.pointsFor(p.player_id), opts = {}) {
      return solveLineup(slots, ctx.playersOn(rosterId), valueFn, opts);
    },
    freeAgents() {
      return [...candidateIds]
        .filter((id) => !ownerOf.has(id))
        .map((id) => players[id])
        .filter((p) => p && RELEVANT.has(p.position) && isLiveFreeAgent(p));
    },
    warnings: [],
  };

  // --- Data-health warnings, surfaced in the UI ---------------------------
  if (mine.warning) ctx.warnings.push(mine.warning);
  if (!ctx.projectionsAvailable) {
    ctx.warnings.push('Sleeper projections are unavailable right now, so rankings use results and usage only.');
  }
  if (schedule.schemaMismatch) {
    ctx.warnings.push('The NFL schedule file came back with columns this app does not recognise, so bye weeks, kickoff times and Vegas totals are missing.');
  } else if (!schedule.available) {
    ctx.warnings.push('The NFL schedule file could not be loaded, so bye weeks and Vegas totals are missing.');
  } else {
    const rosterTeams = [...new Set(Object.values(players).map((p) => p.team).filter(Boolean))];
    const unmatched = schedule.unmatchedTeams(rosterTeams);
    if (unmatched.length) {
      ctx.warnings.push(`These team codes did not match the NFL schedule: ${unmatched.join(', ')}. Their players are valued without bye or opponent context.`);
    }
  }
  if (usageRaw.schemaMismatch || snapsRaw.schemaMismatch) {
    const which = [usageRaw.schemaMismatch && 'weekly stats', snapsRaw.schemaMismatch && 'snap counts'].filter(Boolean).join(' and ');
    ctx.warnings.push(`The nflverse ${which} file came back with columns this app does not recognise, so ${usageRaw.schemaMismatch ? 'the usage adjustment is switched off' : 'snap shares are missing'}.`);
  } else if (!usageRaw.available) {
    ctx.warnings.push('Snap and target data could not be loaded, so the usage adjustment is switched off.');
  }
  if (injuriesRaw.schemaMismatch) {
    ctx.warnings.push('The official injury report file came back with columns this app does not recognise, so only Sleeper\'s injury designations are used.');
  }

  return ctx;
}

/**
 * Which roster is "mine". Falls back to the league's first roster so the page
 * still works, but never silently: a failed lookup or a user with no team
 * here comes back with a warning saying whose team is showing instead.
 * @param {null|{user}|{error}} lookup  the settled getUser result (null: no username given)
 */
export function pickMyRoster(rosters, username, lookup, teamName = (r) => `Roster ${r.roster_id}`) {
  const first = rosters[0] || null;
  if (!username || !lookup) return { roster: first, warning: null };
  const instead = first ? `, so this shows ${teamName(first)} instead of your team` : '';
  if (lookup.error || !lookup.user?.user_id) {
    return {
      roster: first,
      warning: `Sleeper could not look up the user "${username}"${instead}. Check the username, or try again in a minute.`,
    };
  }
  const id = lookup.user.user_id;
  const roster = rosters.find((r) => r.owner_id === id || (r.co_owners || []).includes(id)) || null;
  if (roster) return { roster, warning: null };
  return { roster: first, warning: `"${username}" has no team in this league${instead}.` };
}

function buildCandidateSet(players, ownerOf) {
  const ids = new Set(ownerOf.keys());
  for (const [id, p] of Object.entries(players)) {
    if (!RELEVANT.has(p.position)) continue;
    // Free agents worth ranking: on an NFL roster, or a team defence.
    if (p.team || p.position === 'DEF') ids.add(id);
  }
  return ids;
}

function buildUsage({ players, candidateIds, idMaps, usageRaw, snapsRaw, weeks }) {
  const out = new Map();
  if (!usageRaw.available && !snapsRaw.available) return out;
  const weekSet = new Set(weeks);
  const inWindow = (w) => weekSet.size === 0 || weekSet.has(w);

  for (const id of candidateIds) {
    const p = players[id];
    if (!p) continue;

    const gsis = idMaps.sleeperToGsis.get(id);
    const pfr = idMaps.sleeperToPfr.get(id);
    const stats = gsis ? (usageRaw.byPlayer.get(gsis) || []).filter((r) => inWindow(r.week)) : [];
    const snaps = pfr ? (snapsRaw.byPfr.get(pfr) || []).filter((r) => inWindow(r.week)) : [];
    if (stats.length === 0 && snaps.length === 0) continue;

    const avg = (arr, key) => {
      const vals = arr.map((r) => r[key]).filter((v) => v !== null && Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);

    out.set(id, {
      games: Math.max(stats.length, snaps.length),
      snapShare: avg(snaps, 'offensePct'),
      targetShare: avg(stats, 'targetShare'),
      targets: sum(stats, 'targets'),
      carries: sum(stats, 'carries'),
      receptions: sum(stats, 'receptions'),
      airYards: sum(stats, 'airYards'),
      airYardsShare: avg(stats, 'airYardsShare'),
      targetsPerGame: stats.length ? round2(sum(stats, 'targets') / stats.length) : null,
      carriesPerGame: stats.length ? round2(sum(stats, 'carries') / stats.length) : null,
    });
  }
  return out;
}

/**
 * A copy of the context with the manager's own "back in week" choices
 * (Map playerId -> week) applied to every future-week projection. The shared,
 * cached context is never changed.
 */
export function withIrReturn(ctx, irReturn) {
  if (!irReturn || irReturn.size === 0) return ctx;
  return Object.assign(Object.create(ctx), { irReturn });
}

/**
 * Team strength for the season simulator: expected weekly points and spread
 * across the regular-season weeks still to play. A player who is out in a given
 * week (IR counts again four weeks on, or from the week set in ctx.irReturn)
 * leaves that week's lineup, so a team's mean averages the weeks with and
 * without him. With nobody out it is one solve, as before.
 * @param {{players?: object[], weeks?: number[]}} [opts] players: a roster as it would look (a trade); weeks: override
 */
export function teamStrength(ctx, rosterId, opts = {}) {
  const players = opts.players || ctx.playersOn(rosterId);
  const last = (Number(ctx.playoffWeekStart) || 15) - 1;
  let weeks = opts.weeks;
  if (!weeks) {
    weeks = [];
    for (let w = Number(ctx.week) || 1; w <= last; w++) weeks.push(w);
  }
  if (weeks.length === 0) weeks = [Number(ctx.week) || 1];

  const outIn = (p, w) => {
    // A bye is a week off too: the lineup for that week is solved without him.
    if (p.team && ctx.schedule?.isOnBye?.(p.team, w)) return true;
    const inj = ctx.injuryByPlayer?.get(p.player_id);
    return Boolean(inj) && outInWeek({
      status: inj.sleeperStatus, currentWeek: ctx.week, week: w, returnWeek: ctx.irReturn?.get(p.player_id),
    });
  };
  // Weeks with the same set of absentees share one lineup solve.
  const groups = new Map();
  for (const w of weeks) {
    const out = players.filter((p) => outIn(p, w)).map((p) => p.player_id).sort();
    const key = out.join(',');
    if (!groups.has(key)) groups.set(key, { out: new Set(out), n: 0 });
    groups.get(key).n++;
  }

  let mean = 0; let variance = 0;
  for (const g of groups.values()) {
    const { assignments, total } = solveLineup(
      ctx.slots, players.filter((p) => !g.out.has(p.player_id)), (p) => ctx.valueOf(p.player_id));
    const v = assignments
      .filter((a) => a.player)
      .reduce((s, a) => s + playerSd(a.player.position, a.points, ctx.gameLog(a.player.player_id)) ** 2, 0);
    mean += (total * g.n) / weeks.length;
    variance += (v * g.n) / weeks.length;
  }
  return { mean: Math.max(1, mean), sd: Math.max(5, Math.sqrt(variance)) };
}

export { RELEVANT };
