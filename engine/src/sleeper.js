import { getJson, getJsonSoft } from './http.js';
import { TTL } from './cache.js';
import { normTeam } from './teams.js';

const V1 = 'https://api.sleeper.app/v1';
// Projections live on a different host: api.sleeper.com, not .app. This is the
// undocumented endpoint Sleeper's own app calls. Every use is wrapped soft so a
// disappearance downgrades us to results-only analysis instead of breaking.
const INTERNAL = 'https://api.sleeper.com';

export async function getState() {
  const s = await getJson(`${V1}/state/nfl`, { ttl: TTL.STATE });
  return {
    season: String(s.season),
    week: Number(s.week) || 1,
    displayWeek: Number(s.display_week) || Number(s.week) || 1,
    seasonType: s.season_type,
    seasonStartDate: s.season_start_date,
  };
}

export async function getUser(username) {
  const u = await getJson(`${V1}/user/${encodeURIComponent(username)}`, { ttl: TTL.LEAGUE });
  if (!u || !u.user_id) throw new Error(`No Sleeper user named "${username}"`);
  return u;
}

export function getLeaguesForUser(userId, season) {
  return getJson(`${V1}/user/${userId}/leagues/nfl/${season}`, { ttl: TTL.LEAGUE });
}

export function getLeague(leagueId) {
  return getJson(`${V1}/league/${leagueId}`, { ttl: TTL.LEAGUE });
}

export function getRosters(leagueId) {
  return getJson(`${V1}/league/${leagueId}/rosters`, { ttl: TTL.LEAGUE });
}

export function getLeagueUsers(leagueId) {
  return getJson(`${V1}/league/${leagueId}/users`, { ttl: TTL.LEAGUE });
}

/**
 * Matchups for one week. Past weeks give scores; future weeks give the schedule
 * pairings (matchup_id with empty points). Both are useful.
 */
export function getMatchups(leagueId, week, { live = false } = {}) {
  return getJsonSoft(
    `${V1}/league/${leagueId}/matchups/${week}`,
    // Live scores never fall back to an old cached copy: a failure must look
    // like one, so the live view can say its scores are delayed.
    { ttl: live ? TTL.MATCHUPS_LIVE : TTL.MATCHUPS_PAST, serveStale: !live },
    []
  );
}

/**
 * A playoff bracket Sleeper has published, side 'winners' or 'losers' (items
 * {r, m, t1, t2, w, l, t1_from, t2_from, p}). [] until a bracket exists. Short
 * cache: results land through the playoffs.
 */
export function getBracketLive(leagueId, side = 'winners') {
  const which = side === 'losers' ? 'losers_bracket' : 'winners_bracket';
  return getJsonSoft(`${V1}/league/${leagueId}/${which}`, { ttl: TTL.MATCHUPS_LIVE }, []);
}

export function getTransactions(leagueId, week) {
  return getJsonSoft(`${V1}/league/${leagueId}/transactions/${week}`, { ttl: TTL.LEAGUE }, []);
}

/** Drafts belonging to a league. A completed draft never changes, so cache hard. */
export function getDrafts(leagueId) {
  return getJsonSoft(`${V1}/league/${leagueId}/drafts`, { ttl: TTL.DRAFT }, []);
}

export function getDraftPicks(draftId) {
  return getJsonSoft(`${V1}/draft/${draftId}/picks`, { ttl: TTL.DRAFT }, []);
}

export function getDraft(draftId) {
  return getJsonSoft(`${V1}/draft/${draftId}`, { ttl: TTL.DRAFT }, null);
}

/**
 * The full player catalogue is ~5MB and changes slowly. Cache it for 12 hours
 * and slim it to the fields we actually use — keeping the raw blob in memory
 * for every request is wasteful.
 */
export async function getPlayers() {
  const raw = await getJson(`${V1}/players/nfl`, { key: 'sleeper:players:nfl', ttl: TTL.PLAYERS, timeout: 120_000 });
  const slim = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p) continue;
    const pos = p.position || (p.fantasy_positions && p.fantasy_positions[0]);
    if (!pos) continue;
    // Skip the long tail of inactive practice-squad bodies we will never rank.
    if (!p.team && p.status && p.status !== 'Active' && !p.injury_status) {
      if (!['DEF', 'K'].includes(pos)) continue;
    }
    slim[id] = {
      player_id: id,
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || id,
      position: pos,
      fantasy_positions: p.fantasy_positions || [pos],
      team: normTeam(p.team),
      status: p.status || null,
      injury_status: p.injury_status || null,
      injury_body_part: p.injury_body_part || null,
      injury_notes: p.injury_notes || null,
      years_exp: p.years_exp ?? null,
      number: p.number ?? null,
      age: p.age ?? null,
      depth_chart_order: p.depth_chart_order ?? null,
      depth_chart_position: p.depth_chart_position || null,
      height: p.height || null,
      weight: p.weight || null,
      college: p.college || null,
      birth_date: p.birth_date || null,
      gsis_id: p.gsis_id || null,   // Sleeper sometimes carries this itself
      espn_id: p.espn_id || null,
      search_rank: p.search_rank ?? null,
    };
  }
  return slim;
}

/**
 * Trending adds or drops. Returns null when the feed could not be read (and
 * nothing is cached), [] only when Sleeper genuinely answered with nobody —
 * callers must be able to tell "the feed is down" from "nobody is trending".
 */
export async function getTrending(type = 'add', { lookbackHours = 48, limit = 60 } = {}) {
  const rows = await getJsonSoft(
    `${V1}/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`,
    { ttl: TTL.TRENDING },
    null
  );
  return Array.isArray(rows) ? rows : null;
}

const PROJ_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

function positionQuery() {
  return PROJ_POSITIONS.map((p) => `position[]=${p}`).join('&');
}

/**
 * Weekly projections as RAW STAT LINES, keyed by sleeper player_id.
 * We score these against the league's own settings rather than trusting the
 * pts_ppr field, which assumes standard scoring.
 * Returns {} when the undocumented endpoint is unavailable.
 */
export async function getProjections(season, week) {
  const url = `${INTERNAL}/projections/nfl/${season}/${week}?season_type=regular&${positionQuery()}`;
  const rows = await getJsonSoft(url, { key: `proj:${season}:${week}`, ttl: TTL.PROJECTIONS }, null);
  return indexStatRows(rows);
}

/** Actual weekly stats as raw stat lines, same shape as projections. */
export async function getWeekStats(season, week) {
  const url = `${INTERNAL}/stats/nfl/${season}/${week}?season_type=regular&${positionQuery()}`;
  const rows = await getJsonSoft(url, { key: `stats:${season}:${week}`, ttl: TTL.PROJECTIONS }, null);
  return indexStatRows(rows);
}

function indexStatRows(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const id = row.player_id || row.player?.player_id;
    if (!id || !row.stats) continue;
    out[id] = {
      stats: row.stats,
      team: normTeam(row.team || row.player?.team),
      opponent: normTeam(row.opponent),
      gameDate: row.date || null,
    };
  }
  return out;
}

/** True when the undocumented projections host answered with usable data. */
export function projectionsAvailable(proj) {
  return proj && Object.keys(proj).length > 0;
}

// ---- Draft room: the same draft endpoints with a short, caller-chosen cache.
// A live draft moves every few seconds, so these never serve a stale copy.

export function getDraftsFresh(leagueId, ttl = 5_000) {
  return getJsonSoft(`${V1}/league/${leagueId}/drafts`, { ttl, serveStale: false }, null);
}

export function getDraftFresh(draftId, ttl = 5_000) {
  return getJsonSoft(`${V1}/draft/${draftId}`, { ttl, serveStale: false }, null);
}

export function getDraftPicksFresh(draftId, ttl = 3_000) {
  return getJsonSoft(`${V1}/draft/${draftId}/picks`, { ttl, serveStale: false }, null);
}

export function getDraftTradedPicks(draftId, ttl = 15_000) {
  return getJsonSoft(`${V1}/draft/${draftId}/traded_picks`, { ttl, serveStale: false }, null);
}

// ---- Dynasty and history getters (read-only).

/** Picks that have changed hands: [{season, round, roster_id (original), previous_owner_id, owner_id}]. */
export function getTradedPicks(leagueId) {
  return getJsonSoft(`${V1}/league/${leagueId}/traded_picks`, { ttl: TTL.LEAGUE }, null);
}

/** A finished season's playoff bracket. Never changes once played, so cached long. */
export function getWinnersBracket(leagueId) {
  return getJsonSoft(`${V1}/league/${leagueId}/winners_bracket`, { ttl: TTL.DRAFT }, null);
}
