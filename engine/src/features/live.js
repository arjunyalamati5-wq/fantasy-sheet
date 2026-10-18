import { getMatchups } from '../sleeper.js';
import { getScoreboard } from '../espn.js';
import { normTeam, displayTeam } from '../teams.js';
import { playerSd } from '../variance.js';
import { mulberry32, lognormalScore, seedFrom } from '../random.js';
import { round2 } from '../scoring.js';
import { setStarters } from './lineup.js';

// The live score bug: Sleeper's live fantasy points (this league's scoring),
// the NFL game clock from ESPN, and a win probability that narrows as the
// clock runs. Each feed fails soft and fast — a poll must answer in about a
// second and a half, so a slow feed is waited on only briefly and its
// request is left to fill the cache for the next poll.

export const LIVE_REFRESH_MS = 30_000;
export const IDLE_REFRESH_MS = 300_000;
const FEED_DEADLINE_MS = 1_100;
const RUNS = 20_000;
const REGULATION_MIN = 60;
const QUARTER_MIN = 15;
// Wall-clock length of a game, for estimating the state when ESPN is down:
// about 3h10m for regulation, and a game past 3h30m is taken to be over.
const GAME_WALL_MS = 190 * 60_000;
const GAME_OVER_MS = 210 * 60_000;
// Poll fast from five minutes before a kickoff, so the first snap is not missed.
const KICKOFF_LEAD_MS = 5 * 60_000;

// ------------------------------------------------------------------ clock

/** Game-clock text as minutes: "8:42" is 8.7, "0:42.5" or "42.5" is under one. Null when unreadable. */
export function parseClock(clock) {
  if (clock == null) return null;
  const s = String(clock).trim();
  let m = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (m) {
    const sec = Number(m[2]);
    return sec < 60 ? Number(m[1]) + sec / 60 : null;
  }
  m = /^(\d{1,2}(?:\.\d+)?)$/.exec(s);
  return m && Number(m[1]) < 60 ? Number(m[1]) / 60 : null;
}

const isHalftime = (g) => g.statusName === 'STATUS_HALFTIME'
  || (g.period === 2 && parseClock(g.clock) === 0);

/**
 * Share of regulation still to play, 0..1. Pre-game is 1 and final is 0. In
 * progress it is the regulation time left over 60 minutes, so halftime is a
 * half and overtime is 0 (regulation is over). Null when an in-progress game
 * has no readable period, so the caller can estimate from the kickoff.
 */
export function fractionLeft({ state, period = null, clock = null, statusName = null }) {
  if (state === 'pre') return 1;
  if (state === 'post') return 0;
  if (state !== 'in') return null;
  if (isHalftime({ period, clock, statusName })) return 0.5;
  const p = Number(period);
  if (!Number.isFinite(p) || p < 1) return null;
  if (p > 4) return 0;
  const onClock = parseClock(clock);
  // No clock: assume the middle of the quarter rather than either end.
  const inQuarter = onClock === null ? QUARTER_MIN / 2 : Math.min(QUARTER_MIN, onClock);
  return clamp01(((4 - p) * QUARTER_MIN + inQuarter) / REGULATION_MIN);
}

/**
 * State from the kickoff time alone, for when the scoreboard is down: before
 * kickoff it is pre, then in progress with regulation draining over about
 * 3h10m of wall clock, then final.
 */
export function estimateFromKickoff(kickoff, now = Date.now()) {
  if (!Number.isFinite(kickoff)) return { state: 'pre', fraction: 1 };
  const elapsed = now - kickoff;
  if (elapsed < 0) return { state: 'pre', fraction: 1 };
  if (elapsed >= GAME_OVER_MS) return { state: 'post', fraction: 0 };
  return { state: 'in', fraction: clamp01(1 - elapsed / GAME_WALL_MS) };
}

// ------------------------------------------------------------------ labels

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});

/** Kickoff as broadcast shorthand in Eastern time: "Sun 4:25pm". */
export function kickoffLabel(ms) {
  if (!Number.isFinite(ms)) return 'Kickoff to be set';
  const parts = Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.hour}:${parts.minute}${String(parts.dayPeriod || '').toLowerCase()}`;
}

const ordinalPeriod = (p) => (p <= 4 ? `Q${p}` : p === 5 ? 'OT' : `${p - 4}OT`);

/** "Sun 4:25pm", "Q3 8:42", "Halftime", "End of Q1", "OT 3:10", "In progress" (estimated) or "Final". */
export function gameLabel(g) {
  if (g.state === 'pre') return kickoffLabel(g.kickoff);
  if (g.state === 'post') {
    if (/POSTPONED/.test(g.statusName || '')) return 'Postponed';
    if (/CANCEL/.test(g.statusName || '')) return 'Canceled';
    return 'Final';
  }
  if (g.estimated || !Number.isFinite(Number(g.period)) || Number(g.period) < 1) return 'In progress';
  if (isHalftime(g)) return 'Halftime';
  const p = Number(g.period);
  const onClock = parseClock(g.clock);
  if (g.statusName === 'STATUS_END_PERIOD' || onClock === 0) return `End of ${ordinalPeriod(p)}`;
  return g.clock ? `${ordinalPeriod(p)} ${g.clock}` : ordinalPeriod(p);
}

// ------------------------------------------------------------------ games

const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * Every NFL game in the week, in the live contract's shape plus an internal
 * `fraction` and canonical team codes. The schedule supplies the games and
 * kickoffs; ESPN, when it answers for this week, supplies state, clock and
 * score. A game ESPN does not cover is estimated from its kickoff (or marked
 * final when the schedule already has its score).
 */
export function buildGames({ schedule, week, season = null, scoreboard = null, now = Date.now() }) {
  const espnOk = scoreboard?.available && (scoreboard.week == null || Number(scoreboard.week) === Number(week));
  const espnByPair = new Map();
  if (espnOk) {
    for (const e of scoreboard.games || []) {
      if (e.home && e.away) espnByPair.set(pairKey(e.home, e.away), e);
    }
  }

  const base = (schedule?.games || []).filter((g) => Number(g.week) === Number(week));
  const seen = new Set();
  const games = base.map((g) => {
    const key = pairKey(g.home, g.away);
    seen.add(key);
    return oneGame({ id: g.gameId, home: g.home, away: g.away, kickoff: g.kickoff, final: g.homeScore != null && g.awayScore != null ? g : null }, espnByPair.get(key), now);
  });
  // With the schedule file down, ESPN alone still gives a full slate.
  for (const [key, e] of espnByPair) {
    if (seen.has(key)) continue;
    const id = season ? `${season}_${String(week).padStart(2, '0')}_${e.away}_${e.home}` : e.id;
    games.push(oneGame({ id, home: e.home, away: e.away, kickoff: null, final: null }, e, now));
  }
  games.sort((a, b) => (a.kickoffMs ?? Infinity) - (b.kickoffMs ?? Infinity) || a.gameId.localeCompare(b.gameId));
  return games;
}

function oneGame({ id, home, away, kickoff, final }, espn, now) {
  const espnKick = espn?.date ? Date.parse(espn.date) : NaN;
  // ESPN's time wins: it follows flexed and moved games within the minute.
  const kickoffMs = Number.isFinite(espnKick) ? espnKick : (Number.isFinite(kickoff) ? kickoff : null);
  let g;
  if (espn && ['pre', 'in', 'post'].includes(espn.state)) {
    const inPlay = espn.state !== 'pre';
    g = {
      state: espn.state,
      period: inPlay ? espn.period ?? null : null,
      clock: espn.state === 'in' ? espn.clock ?? null : null,
      statusName: espn.statusName || null,
      homeScore: inPlay ? espn.homeScore ?? null : null,
      awayScore: inPlay ? espn.awayScore ?? null : null,
      estimated: false,
    };
    g.fraction = fractionLeft(g);
    if (g.fraction === null) {
      g.fraction = estimateFromKickoff(kickoffMs, now).fraction;
      g.estimated = true;
    }
  } else if (final) {
    g = { state: 'post', period: null, clock: null, statusName: null, homeScore: final.homeScore, awayScore: final.awayScore, estimated: true, fraction: 0 };
  } else {
    const est = estimateFromKickoff(kickoffMs, now);
    g = { state: est.state, period: null, clock: null, statusName: null, homeScore: null, awayScore: null, estimated: true, fraction: est.fraction };
  }
  const game = {
    gameId: id,
    away: displayTeam(away),
    home: displayTeam(home),
    awayScore: g.awayScore,
    homeScore: g.homeScore,
    state: g.state,
    period: g.period,
    clock: g.clock,
    kickoff: kickoffMs === null ? null : new Date(kickoffMs).toISOString(),
    label: '',
  };
  game.label = gameLabel({ ...g, kickoff: kickoffMs });
  // Internal fields, stripped before the response goes out.
  Object.defineProperties(game, {
    fraction: { value: g.fraction, enumerable: false },
    kickoffMs: { value: kickoffMs, enumerable: false },
    teams: { value: [normTeam(home), normTeam(away)], enumerable: false },
  });
  return game;
}

/** 30 s while any game is in progress or about to kick off, otherwise 5 minutes. */
export function nextRefreshMs(games, now = Date.now()) {
  const soon = games.some((g) => g.state === 'in'
    || (g.state === 'pre' && Number.isFinite(g.kickoffMs) && g.kickoffMs - now <= KICKOFF_LEAD_MS));
  return soon ? LIVE_REFRESH_MS : IDLE_REFRESH_MS;
}

// ------------------------------------------------------------------ one side

/**
 * One team's live line: points so far, each starter's remaining projection
 * (his projection times the share of his game left), and the draws the
 * simulator needs for what is still to be played.
 */
export function liveSide(ctx, entry, gamesByTeam, { defaultFraction = 1 } = {}) {
  const roster = ctx.rosterOf(entry.roster_id);
  const ids = Array.isArray(entry.starters) && entry.starters.length ? entry.starters : setStarters(ctx, entry.roster_id);
  const pp = entry.players_points || {};
  const starters = [];
  const draws = [];

  ids.forEach((id, i) => {
    if (!id || id === '0') return; // an empty slot scores nothing and has nothing to show
    const p = ctx.playerOf(id) || { player_id: id, name: id, position: null, team: null };
    const team = normTeam(p.team);
    const game = team ? gamesByTeam.get(team) : null;
    const onBye = team ? Boolean(ctx.onByeThisWeek?.(id)) : false;
    // Known to have no game (bye, no NFL team) means nothing left; no game
    // data at all means we cannot tell, so the week's default applies.
    const fraction = game ? game.fraction : (gamesByTeam.size === 0 ? defaultFraction : 0);
    const projected = round2(Number(ctx.pointsFor(id)) || 0);
    const points = round2(Number(pp[id]) || 0);
    const remaining = projected * fraction;
    const status = ctx.weekStatusOf?.(id) ?? null;
    starters.push({
      player_id: id,
      name: p.name || id,
      position: p.position || null,
      team: displayTeam(p.team),
      slot: ctx.slots?.[i] ?? null,
      points,
      projected,
      projectedRemaining: round2(remaining),
      gameState: game ? game.state : null,
      gameLabel: game ? game.label : (onBye ? 'Bye' : team ? '' : 'No game'),
      // Same shape as the other views' players, so the same Out/Doubtful tag shows.
      injury: status ? { status } : null,
    });
    // A zero projection draws nothing, as in the pre-game simulation; a
    // negative one (a defence expected to give up points) still draws.
    if (remaining !== 0) {
      draws.push({
        mean: remaining,
        // His whole-game spread, shrunk by the square root of the time left:
        // variance accrues roughly in proportion to the snaps still to come.
        sd: playerSd(p.position, projected, ctx.gameLog ? ctx.gameLog(id) : []) * Math.sqrt(fraction),
      });
    }
  });

  const sumPoints = starters.reduce((s, x) => s + x.points, 0);
  const official = Number(entry.custom_points ?? entry.points);
  const points = round2(Number.isFinite(official) && (official !== 0 || sumPoints === 0) ? official : sumPoints);
  return {
    rosterId: entry.roster_id,
    teamName: roster ? ctx.teamName(roster) : `Roster ${entry.roster_id}`,
    points,
    projectedFinal: round2(points + starters.reduce((s, x) => s + x.projectedRemaining, 0)),
    starters,
    draws,
  };
}

/**
 * Chance side A finishes ahead: its points so far plus a right-skewed draw
 * for each starter's remaining time, 20,000 times. Ties count half.
 */
export function liveWinProbability(a, b, { runs = RUNS, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  let wins = 0;
  let ties = 0;
  for (let i = 0; i < runs; i++) {
    let sa = a.points;
    for (const d of a.draws) sa += lognormalScore(rand, d.mean, d.sd);
    let sb = b.points;
    for (const d of b.draws) sb += lognormalScore(rand, d.mean, d.sd);
    if (sa > sb) wins++;
    else if (sa === sb) ties++;
  }
  return Math.round(((wins + ties / 2) / runs) * 1000) / 1000;
}

// ------------------------------------------------------------------ feeds

const TIMED_OUT = Symbol('timed out');

/** Resolve with the promise's value, or `fallback` after `ms` (or on error). */
function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * This week's matchups as fresh as the 30-second cache allows, written back
 * onto the context so the lineup and matchup views read the same lineups.
 * A slow or dead feed leaves the context's copy in place.
 */
export async function freshMatchups(ctx, { fetchMatchups = getMatchups, deadlineMs = FEED_DEADLINE_MS, now = Date.now() } = {}) {
  const current = !ctx.state || Number(ctx.week) === Number(ctx.state.week);
  if (!current) return ctx.currentMatchups || [];
  const got = await withDeadline(fetchMatchups(ctx.league.league_id, ctx.week, { live: true }), deadlineMs, TIMED_OUT);
  if (Array.isArray(got) && got.length) {
    ctx.currentMatchups = got;
    ctx.matchupsAsOf = now; // when these points were last known to be current
  }
  return ctx.currentMatchups || [];
}

// ------------------------------------------------------------------ report

/** The /api/live payload. */
export async function liveReport(ctx, rosterId = ctx.myRoster?.roster_id, opts = {}) {
  const now = opts.now ?? Date.now();
  const deadlineMs = opts.deadlineMs ?? FEED_DEADLINE_MS;
  const fetchScoreboard = opts.fetchScoreboard || ((q) => getScoreboard(q));

  const [entries, scoreboard] = await Promise.all([
    freshMatchups(ctx, { fetchMatchups: opts.fetchMatchups, deadlineMs, now }),
    withDeadline(fetchScoreboard({ season: ctx.season, week: ctx.week }), deadlineMs, { available: false, games: [] }),
  ]);

  const games = buildGames({ schedule: ctx.schedule, week: ctx.week, season: ctx.season, scoreboard, now });
  const gamesByTeam = new Map();
  for (const g of games) for (const t of g.teams) if (t) gamesByTeam.set(t, g);

  const currentWeek = Number(ctx.state?.week ?? ctx.week);
  const defaultFraction = Number(ctx.week) < currentWeek ? 0 : 1;

  // Points and time left must come from the same moment. When this poll's
  // Sleeper fetch failed, the points are the last good copy, so each game's
  // time left is taken from that poll too; with the live clock instead the
  // remaining projection would drain away and the win chance would run to
  // 0% or 100% on a score that is no longer the score.
  const isCurrentWeek = Number(ctx.week) === currentWeek;
  const fresh = ctx.matchupsAsOf === now;
  if (fresh) ctx.liveFractions = new Map([...gamesByTeam].map(([t, g]) => [t, g.fraction]));
  const scoresStale = isCurrentWeek && !fresh && games.some((g) => g.state !== 'pre');
  const sideGames = scoresStale && ctx.liveFractions
    ? new Map([...gamesByTeam].map(([t, g]) => [t, { ...g, fraction: ctx.liveFractions.get(t) ?? g.fraction }]))
    : gamesByTeam;

  return {
    week: ctx.week,
    updatedAt: new Date(now).toISOString(),
    anyLive: games.some((g) => g.state === 'in'),
    nextRefreshMs: nextRefreshMs(games, now),
    // True when Sleeper's scores could not be refreshed on this poll and the
    // points shown are older than the game clocks beside them.
    scoresStale,
    scoresAsOf: ctx.matchupsAsOf ? new Date(ctx.matchupsAsOf).toISOString() : null,
    games,
    matchup: liveMatchup(ctx, entries, rosterId, sideGames, { defaultFraction, runs: opts.runs }),
  };
}

function liveMatchup(ctx, entries, rosterId, gamesByTeam, { defaultFraction, runs }) {
  const mine = (entries || []).find((m) => String(m.roster_id) === String(rosterId));
  if (!mine || mine.matchup_id == null) return null;
  const opp = entries.find((m) => m.matchup_id === mine.matchup_id && String(m.roster_id) !== String(rosterId));
  if (!opp) return null;

  const me = liveSide(ctx, mine, gamesByTeam, { defaultFraction });
  const them = liveSide(ctx, opp, gamesByTeam, { defaultFraction });
  const seed = seedFrom(`${ctx.league?.league_id}:${ctx.week}:${mine.roster_id}:${opp.roster_id}`);
  const winProbability = liveWinProbability(me, them, { runs: runs || RUNS, seed });
  const strip = ({ draws, ...side }) => side;
  return { winProbability, me: strip(me), them: strip(them) };
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
