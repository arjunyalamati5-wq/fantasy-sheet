import { getTextSoft } from './http.js';
import { TTL } from './cache.js';
import { parseCsv, num, num0, col } from './csv.js';
import { normTeam } from './teams.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

// The weekly stats dataset was renamed: the release tag is `stats_player` and
// the file is `stats_player_week_{season}.csv`. The old
// `player_stats/player_stats_{season}.csv` path is a 404.
const statsUrl = (season) => `${BASE}/stats_player/stats_player_week_${season}.csv`;
const snapsUrl = (season) => `${BASE}/snap_counts/snap_counts_${season}.csv`;
const injuriesUrl = (season) => `${BASE}/injuries/injuries_${season}.csv`;
const gamesUrl = () => `${BASE}/schedules/games.csv`;

const STAT_COLS = [
  'player_id', 'player_name', 'player_display_name', 'position', 'season', 'week', 'season_type',
  'team', 'recent_team', 'opponent_team',
  'completions', 'attempts', 'passing_yards', 'passing_tds',
  'passing_interceptions', 'interceptions', 'sacks_suffered', 'sacks',
  'carries', 'rushing_yards', 'rushing_tds',
  'receptions', 'targets', 'receiving_yards', 'receiving_tds',
  'receiving_air_yards', 'target_share', 'air_yards_share', 'wopr',
  'fantasy_points', 'fantasy_points_ppr',
];

/**
 * Weekly usage rows keyed by gsis player id.
 * Column names moved between seasons, so every read goes through `col()` with
 * the old name kept as a fallback.
 */
export async function getWeeklyUsage(season) {
  const text = await getTextSoft(statsUrl(season), { key: `nflverse:stats:${season}`, ttl: TTL.NFLVERSE });
  if (!text) return { byPlayer: new Map(), weeks: [], available: false, schemaMismatch: false };
  return parseWeeklyUsage(text);
}

/**
 * The weekly stats CSV as usage rows. When rows parse but not one carries a
 * player id and a week, the columns have been renamed under us: the data is
 * reported unavailable (schemaMismatch) rather than as a season of nothing.
 */
export function parseWeeklyUsage(text) {
  const rows = parseCsv(text, STAT_COLS);
  const byPlayer = new Map();
  const weeks = new Set();
  let keyed = 0;

  for (const r of rows) {
    const gsis = r.player_id;
    if (!gsis) continue;
    const week = num(r.week);
    if (week === null) continue;
    keyed++;
    if (r.season_type && r.season_type !== 'REG') continue;
    weeks.add(week);

    const entry = {
      week,
      season: num(r.season),
      name: r.player_display_name || r.player_name || '',
      position: r.position || null,
      team: normTeam(col(r, 'team', 'recent_team')),
      opponent: normTeam(r.opponent_team),
      targets: num0(r.targets),
      carries: num0(r.carries),
      receptions: num0(r.receptions),
      targetShare: num(r.target_share),
      airYards: num0(r.receiving_air_yards),
      airYardsShare: num(r.air_yards_share),
      wopr: num(r.wopr),
      passingYards: num0(r.passing_yards),
      // renamed columns, old names kept as fallbacks
      interceptions: num0(col(r, 'passing_interceptions', 'interceptions')),
      sacksSuffered: num0(col(r, 'sacks_suffered', 'sacks')),
      rushingYards: num0(r.rushing_yards),
      receivingYards: num0(r.receiving_yards),
    };

    if (!byPlayer.has(gsis)) byPlayer.set(gsis, []);
    byPlayer.get(gsis).push(entry);
  }

  for (const list of byPlayer.values()) list.sort((a, b) => a.week - b.week);
  const schemaMismatch = rows.length > 0 && keyed === 0;
  return { byPlayer, weeks: [...weeks].sort((a, b) => a - b), available: !schemaMismatch, schemaMismatch };
}

const SNAP_COLS = ['season', 'week', 'game_type', 'player', 'pfr_player_id', 'position',
  'team', 'opponent', 'offense_snaps', 'offense_pct', 'defense_snaps', 'defense_pct', 'st_pct'];

/** Snap counts keyed by pfr_player_id — this file has no gsis id. */
export async function getSnapCounts(season) {
  const text = await getTextSoft(snapsUrl(season), { key: `nflverse:snaps:${season}`, ttl: TTL.NFLVERSE });
  if (!text) return { byPfr: new Map(), available: false, schemaMismatch: false };
  return parseSnapCounts(text);
}

/** Snap-count CSV keyed by pfr id; unavailable when no row carries one (renamed columns). */
export function parseSnapCounts(text) {
  const rows = parseCsv(text, SNAP_COLS);
  const byPfr = new Map();
  let keyed = 0;
  for (const r of rows) {
    const pfr = r.pfr_player_id;
    if (!pfr || num(r.week) === null) continue;
    keyed++;
    if (r.game_type && r.game_type !== 'REG') continue;
    const entry = {
      week: num(r.week),
      team: normTeam(r.team),
      offenseSnaps: num0(r.offense_snaps),
      offensePct: pct(r.offense_pct),
      defensePct: pct(r.defense_pct),
      stPct: pct(r.st_pct),
    };
    if (!byPfr.has(pfr)) byPfr.set(pfr, []);
    byPfr.get(pfr).push(entry);
  }
  for (const list of byPfr.values()) list.sort((a, b) => a.week - b.week);
  const schemaMismatch = rows.length > 0 && keyed === 0;
  return { byPfr, available: !schemaMismatch, schemaMismatch };
}

// nflverse writes these as a 0-1 fraction in some seasons and 0-100 in others.
function pct(v) {
  const n = num(v);
  if (n === null) return null;
  return n > 1.5 ? n / 100 : n;
}

const INJ_COLS = ['season', 'season_type', 'game_type', 'team', 'week', 'gsis_id', 'position',
  'full_name', 'report_primary_injury', 'report_secondary_injury', 'report_status',
  'practice_primary_injury', 'practice_status'];

/** Official injury report keyed by gsis_id, latest week first. */
export async function getInjuries(season) {
  const text = await getTextSoft(injuriesUrl(season), { key: `nflverse:injuries:${season}`, ttl: TTL.NFLVERSE });
  if (!text) return { byGsis: new Map(), byWeek: new Map(), available: false, schemaMismatch: false };
  return parseInjuries(text);
}

/** Injury-report CSV keyed by gsis id; unavailable when no row carries one (renamed columns). */
export function parseInjuries(text) {
  const rows = parseCsv(text, INJ_COLS);
  const byGsis = new Map();
  const byWeek = new Map(); // `${week}|${gsis}` -> entry, regular season only: every week's report, not just the latest
  for (const r of rows) {
    const gsis = r.gsis_id;
    if (!gsis) continue;
    const week = num(r.week);
    const entry = {
      week,
      team: normTeam(r.team),
      name: r.full_name || '',
      reportStatus: r.report_status || null,
      primaryInjury: r.report_primary_injury || r.practice_primary_injury || null,
      secondaryInjury: r.report_secondary_injury || null,
      practiceStatus: r.practice_status || null,
    };
    const prev = byGsis.get(gsis);
    if (!prev || (week ?? 0) >= (prev.week ?? 0)) byGsis.set(gsis, entry);
    const gt = r.game_type || r.season_type;
    if (week != null && (!gt || gt === 'REG')) byWeek.set(`${week}|${gsis}`, entry);
  }
  const schemaMismatch = rows.length > 0 && byGsis.size === 0;
  return { byGsis, byWeek, available: !schemaMismatch, schemaMismatch };
}

const GAME_COLS = ['game_id', 'season', 'game_type', 'week', 'gameday', 'weekday', 'gametime',
  'away_team', 'home_team', 'away_score', 'home_score', 'result', 'total',
  'spread_line', 'total_line', 'away_moneyline', 'home_moneyline', 'roof', 'surface', 'div_game',
  'stadium_id', 'stadium'];

/**
 * Season schedule with Vegas lines.
 * `spread_line` is from the home team's perspective; `total_line` is the
 * over/under, which is what we use for streaming context.
 */
export async function getSchedule(season) {
  const text = await getTextSoft(gamesUrl(), { key: 'nflverse:games', ttl: TTL.NFLVERSE, timeout: 180_000 });
  if (!text) return emptySchedule();
  return parseSchedule(text, season);
}

/** The games CSV for one season, indexed. Unavailable when no row names two teams (renamed columns). */
export function parseSchedule(text, season) {
  const rows = parseCsv(text, GAME_COLS);
  const games = [];
  let keyed = 0;
  for (const r of rows) {
    const home = normTeam(r.home_team);
    const away = normTeam(r.away_team);
    if (!home || !away || num(r.week) === null) continue;
    keyed++;
    if (num(r.season) !== Number(season)) continue;
    if (r.game_type && r.game_type !== 'REG') continue;
    games.push({
      gameId: r.game_id,
      week: num(r.week),
      gameday: r.gameday || null,
      gametime: r.gametime || null,
      weekday: r.weekday || null,
      home,
      away,
      homeScore: num(r.home_score),
      awayScore: num(r.away_score),
      spreadLine: num(r.spread_line),   // positive = home favoured
      totalLine: num(r.total_line),     // over/under
      roof: r.roof || null,
      stadiumId: r.stadium_id || null,
      stadium: r.stadium || null,
      divGame: num(r.div_game) === 1,
      kickoff: kickoffMs(r.gameday, r.gametime),
    });
  }
  if (rows.length > 0 && keyed === 0) return { ...emptySchedule(), schemaMismatch: true };
  return buildScheduleIndex(games, season);
}

/**
 * Kickoff as epoch milliseconds. nflverse gives the date and a wall-clock
 * time in New York, so the UTC offset depends on daylight saving that day:
 * a 13:00 game is 17:00 UTC in September and 18:00 UTC in December.
 */
export function kickoffMs(gameday, gametime) {
  if (!gameday || !/^\d{4}-\d{2}-\d{2}$/.test(gameday)) return null;
  const [y, m, d] = gameday.split('-').map(Number);
  // No kickoff time means no lock: guessing 1pm would freeze a later game's
  // players early.
  if (!/^\d{1,2}:\d{2}$/.test(gametime || '')) return null;
  const [hh, mm] = gametime.split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Date.UTC rolls an impossible date forward ('2026-13-45' becomes February
  // 2027), so a corrupt row must be rejected, not quietly moved.
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  // Guess with EDT, then correct by New York's real offset at that instant.
  const guess = wall + 4 * 3_600_000;
  return wall - newYorkOffsetMinutes(guess) * 60_000;
}

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** New York's offset from UTC in minutes at a given instant (-240 or -300). */
function newYorkOffsetMinutes(ms) {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - ms) / 60_000);
}

/**
 * A check for whether a player's game has kicked off. Only the week being
 * played can lock, and a game with no kickoff time never does. It reads the
 * clock on every call, so a cached context never keeps a player movable.
 */
export function lockChecker({ schedule, players, week, currentWeek }) {
  return (id, now = Date.now()) => {
    if (week !== Number(currentWeek)) return false;
    const team = players[id]?.team;
    const game = team ? schedule.gameFor(team, week) : null;
    return Boolean(game?.kickoff && now >= game.kickoff);
  };
}

function emptySchedule() {
  return {
    available: false, schemaMismatch: false, season: null, games: [], byTeamWeek: new Map(),
    teamsSeen: new Set(), byeWeek: () => null, isOnBye: () => false,
    gameFor: () => null, maxWeek: 18,
  };
}

function buildScheduleIndex(games, season) {
  const byTeamWeek = new Map();       // "TEAM:week" -> game
  const weeksByTeam = new Map();      // team -> Set(weeks with a game)
  const teamsSeen = new Set();
  let maxWeek = 0;

  for (const g of games) {
    for (const [team, opp, isHome] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      teamsSeen.add(team);
      byTeamWeek.set(`${team}:${g.week}`, { ...g, team, opponent: opp, isHome });
      if (!weeksByTeam.has(team)) weeksByTeam.set(team, new Set());
      weeksByTeam.get(team).add(g.week);
    }
    if (g.week > maxWeek) maxWeek = g.week;
  }

  const allWeeks = [];
  for (let w = 1; w <= maxWeek; w++) allWeeks.push(w);

  /**
   * Bye week for a team, or null when we don't know.
   * FAIL OPEN: if a team matches zero games, we return null rather than
   * concluding "on bye every week". That is how an abbreviation mismatch turns
   * into a silent column of zeroes instead of a visible error.
   */
  function byeWeek(team) {
    const t = normTeam(team);
    const weeks = t ? weeksByTeam.get(t) : null;
    if (!weeks || weeks.size === 0) return null; // unknown team -> filter nothing
    const missing = allWeeks.filter((w) => !weeks.has(w));
    return missing.length === 1 ? missing[0] : null;
  }

  function isOnBye(team, week) {
    const t = normTeam(team);
    const weeks = t ? weeksByTeam.get(t) : null;
    if (!weeks || weeks.size === 0) return false; // fail open
    return !weeks.has(Number(week));
  }

  function gameFor(team, week) {
    const t = normTeam(team);
    if (!t) return null;
    return byTeamWeek.get(`${t}:${Number(week)}`) || null;
  }

  return {
    available: games.length > 0,
    schemaMismatch: false,
    season: String(season),
    games, byTeamWeek, teamsSeen, maxWeek,
    byeWeek, isOnBye, gameFor,
    /** Teams present in Sleeper but missing from the schedule — an alias bug. */
    unmatchedTeams(teams) {
      return [...new Set(teams.map(normTeam).filter(Boolean))].filter((t) => !teamsSeen.has(t));
    },
  };
}

export const _urls = { statsUrl, snapsUrl, injuriesUrl, gamesUrl };
