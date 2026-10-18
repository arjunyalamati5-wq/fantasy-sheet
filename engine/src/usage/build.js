// The nightly usage build: free nflverse files in, small JSON tables out.
//
//   data/nflverse/manifest.json     what was built, from which files, when
//   data/nflverse/weekly_<S>.json   one row per player-week (Sleeper ids)
//   data/nflverse/season_<S>.json   season totals and rates per player
//   data/nflverse/teams_<S>.json    team-week offence and defence tables
//   data/nflverse/coverage_<P>.json routes and man/zone splits (participation season P)
//   data/nflverse/unmatched.json    players with usage we could not join to Sleeper
//
// Run with `npm run data:nflverse`, or let the server refresh it nightly.
// Sources are URLs by default; pass { dir } to read local copies instead.

import { fsp as fs, pathMod as path, cwd, IS_NODE } from '../platform.js';
import { csvObjects, linesOf, currentSeason } from '../charting.js';
import { normTeam } from '../teams.js';
import { matchPlayers, nameKey } from './ids.js';
import {
  slimPlay, aggregateSeason, aggregateCoverage, fitXtd, withShares, seasonRow, columnar,
  WEEKLY_COUNTS, SHARES, SEASON_RATES, TEAM_COLS,
} from './aggregate.js';

export const DATA_DIR = IS_NODE ? path.resolve(cwd(), 'data/nflverse') : 'data/nflverse';
const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

export const sourceUrls = (season, prev, partSeason) => ({
  pbp: `${BASE}/pbp/play_by_play_${season}.csv.gz`,
  pbp_prev: `${BASE}/pbp/play_by_play_${prev}.csv.gz`,
  snap_counts: `${BASE}/snap_counts/snap_counts_${season}.csv`,
  ftn_charting: `${BASE}/ftn_charting/ftn_charting_${season}.csv`,
  pbp_participation: `${BASE}/pbp_participation/pbp_participation_${partSeason}.csv`,
  players: `${BASE}/players/players.csv`,
});

const PBP_COLS = [
  'play_id', 'game_id', 'week', 'season_type', 'posteam', 'defteam', 'yardline_100', 'qb_dropback', 'pass_attempt',
  'rush_attempt', 'sack', 'two_point_attempt', 'air_yards', 'yards_gained', 'complete_pass', 'pass_touchdown',
  'rush_touchdown', 'td_player_id', 'receiver_player_id', 'rusher_player_id', 'play_type', 'receiving_yards', 'rushing_yards',
  'passer_player_id', 'qb_scramble', 'qb_hit',
];
const FTN_COLS = ['nflverse_game_id', 'nflverse_play_id', 'n_defense_box', 'n_blitzers', 'is_play_action', 'is_screen_pass', 'is_catchable_ball', 'is_contested_ball', 'is_drop'];
const COVER_COLS = ['pid', 'team', 'routes', 'tgt', 'rec', 'yds', 'td', 'man_routes', 'man_tgt', 'man_rec', 'man_yds', 'man_td', 'zone_routes', 'zone_tgt', 'zone_rec', 'zone_yds', 'zone_td', 'yprr', 'tprr', 'yprr_man', 'tprr_man', 'yprr_zone', 'tprr_zone'];
const SKILL = ['QB', 'RB', 'WR', 'TE', 'FB'];

async function ftnMap(source) {
  const m = new Map();
  for await (const r of csvObjects(linesOf(source), FTN_COLS)) m.set(`${r.nflverse_game_id}|${r.nflverse_play_id}`, r);
  return m;
}

async function readPlays(pbpSource, ftn = null) {
  const plays = [];
  for await (const r of csvObjects(linesOf(pbpSource), PBP_COLS)) {
    const p = slimPlay(r, ftn?.get(`${r.game_id}|${r.play_id}`) || null);
    if (p) plays.push(p);
  }
  return plays;
}

/** Does a URL (or local file) exist? Picks the newest participation season. */
async function exists(source) {
  if (!/^https?:/.test(source)) return fs.access(source).then(() => true, () => false);
  try {
    const res = await fetch(source, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch { return false; }
}

async function writeAtomic(file, text) {
  await fs.writeFile(`${file}.tmp`, text);
  await fs.rename(`${file}.tmp`, file);
}

/**
 * @param {object} opts
 * @param {number} [opts.season]   season to build (default: current NFL season)
 * @param {string} [opts.dir]      read sources from this folder (same file names as the URLs) instead of the network
 * @param {object} opts.sleeperPlayers Sleeper players by id (slim, with gsis_id/espn_id)
 * @param {Map}    [opts.crosswalk] gsis -> sleeper id
 * @param {string} [opts.outDir]
 * @param {Function} [opts.log]
 */
export async function buildUsage({ season = currentSeason(), dir = null, sleeperPlayers, crosswalk = new Map(), outDir = DATA_DIR, log = () => {}, writeManifest = true } = {}) {
  if (!sleeperPlayers) throw new Error('buildUsage needs the Sleeper players file');
  const prev = season - 1;
  const local = (url) => (dir ? path.join(dir, path.basename(url)) : url);
  const partSeason = (await exists(local(sourceUrls(season, prev, season).pbp_participation))) ? season : prev;
  const src = Object.fromEntries(Object.entries(sourceUrls(season, prev, partSeason)).map(([k, v]) => [k, local(v)]));
  const started = Date.now();

  // 1. Who is who.
  const nflPlayers = [];
  for await (const r of csvObjects(linesOf(src.players), ['gsis_id', 'display_name', 'position', 'latest_team', 'espn_id', 'pfr_id'])) nflPlayers.push(r);
  const ids = matchPlayers({ sleeper: sleeperPlayers, crosswalk, nflPlayers });
  const nflById = new Map(nflPlayers.map((r) => [r.gsis_id, r]));
  log(`ids: ${ids.gsisToSleeper.size} matched`);

  // 2. Last season: the touchdown model, and the plays participation may join to.
  const prevPlays = await readPlays(src.pbp_prev);
  const xtd = fitXtd(prevPlays);
  log(`xtd fit on ${xtd.n.tgt} targets and ${xtd.n.car} carries`);

  // 3. This season's plays with charting, and snaps.
  const ftn = await ftnMap(src.ftn_charting);
  const plays = await readPlays(src.pbp, ftn);
  const ftnJoined = plays.filter((p) => p.ftn).length;
  const snaps = [];
  // Snap counts are keyed by PFR id; when players.csv lacks it, fall back to
  // a unique name + team match among nflverse players.
  const byNameTeam = new Map();
  for (const r of nflPlayers) {
    const k = `${nameKey(r.display_name)}|${r.latest_team}`;
    byNameTeam.set(k, byNameTeam.has(k) ? null : r.gsis_id);
  }
  for await (const r of csvObjects(linesOf(src.snap_counts), ['game_type', 'week', 'player', 'pfr_player_id', 'team', 'opponent', 'offense_snaps'])) {
    if (r.game_type && r.game_type !== 'REG') continue;
    const gsis = ids.pfrToGsis.get(r.pfr_player_id) || byNameTeam.get(`${nameKey(r.player)}|${r.team}`) || null;
    snaps.push({ gsis, week: Number(r.week), team: r.team, opp: r.opponent, offense_snaps: Number(r.offense_snaps) || 0 });
  }
  const qbIds = nflPlayers.filter((r) => r.position === 'QB').map((r) => r.gsis_id);
  const { players, teams } = aggregateSeason(plays, { xtd, snaps, qbIds });

  // 4. Routes and coverage from the newest participation season.
  const byKey = new Map((partSeason === season ? plays : prevPlays).map((p) => [`${p.game}|${p.play}`, p]));
  const partRows = [];
  for await (const r of csvObjects(linesOf(src.pbp_participation), ['nflverse_game_id', 'play_id', 'offense_players', 'offense_positions', 'defense_man_zone_type', 'defense_coverage_type'])) {
    partRows.push({ key: `${r.nflverse_game_id}|${r.play_id}`, players: r.offense_players.split(';'), positions: r.offense_positions.split(';'), mz: r.defense_man_zone_type, shell: r.defense_coverage_type });
  }
  const cov = aggregateCoverage(partRows, byKey);
  if (partSeason === season) {
    for (const t of teams.values()) {
      const c = cov.teams.get(t.team);
      if (c) { t.def_mz_db = c.db; t.def_man = c.man; t.def_man_rate = c.man_rate; }
    }
  }

  // 5. Rows keyed by Sleeper id; anyone with usage but no match is reported.
  const unmatched = [];
  const weekly = [];
  const seasonRows = [];
  const throughWeek = plays.reduce((m, p) => Math.max(m, p.week), 0);
  for (const [gsis, byWeek] of players) {
    const sid = ids.gsisToSleeper.get(gsis);
    const weeks = [...byWeek.values()].sort((a, b) => a.week - b.week);
    if (!sid) {
      const nfl = nflById.get(gsis);
      const touched = weeks.some((w) => w.tgt > 0 || w.car > 0 || w.off_snaps > 0 || w.qb_db > 0);
      if (touched && nfl && SKILL.includes(nfl.position)) {
        const conflict = ids.conflicts.find((c) => c.gsis === gsis);
        unmatched.push({ gsis, name: nfl.display_name, pos: nfl.position, team: normTeam(nfl.latest_team), reason: conflict ? conflict.reason : 'no sleeper player fits on id, espn id or name' });
      }
      continue;
    }
    for (const w of weeks) {
      weekly.push({ pid: sid, ...withShares(w, teams.get(`${w.team}|${w.week}`)), team: normTeam(w.team), opp: normTeam(w.opp) });
    }
    seasonRows.push({ pid: sid, ...seasonRow(weeks, teams), team: normTeam(weeks.at(-1).team) });
  }
  const coverageRows = [];
  for (const [gsis, r] of cov.players) {
    const sid = ids.gsisToSleeper.get(gsis);
    if (sid && r.routes > 0) coverageRows.push({ pid: sid, ...r, team: normTeam(r.team) });
  }
  const teamRows = [...teams.values()].map((t) => ({ ...t, team: normTeam(t.team), opp: normTeam(t.opp) }));
  const covTeams = Object.fromEntries([...cov.teams].map(([k, v]) => [normTeam(k), v]));

  // 6. Write, each file atomically so a reader never sees half a file.
  const generatedAt = new Date().toISOString();
  const head = (extra = {}) => ({ schema: 1, season, generatedAt, ...extra });
  const files = {
    [`weekly_${season}.json`]: { ...head(), ...columnar(weekly, ['pid', 'week', 'team', 'opp', ...WEEKLY_COUNTS, ...SHARES]) },
    [`season_${season}.json`]: { ...head({ throughWeek }), ...columnar(seasonRows, ['pid', 'team', 'games', ...WEEKLY_COUNTS, ...SHARES, ...SEASON_RATES]) },
    [`teams_${season}.json`]: { ...head({ hasManZone: partSeason === season }), ...columnar(teamRows, ['team', 'week', 'opp', ...TEAM_COLS]) },
    [`coverage_${partSeason}.json`]: { ...head({ season: partSeason, isCurrent: partSeason === season }), shells: cov.shells, teams: covTeams, ...columnar(coverageRows, COVER_COLS) },
    'unmatched.json': { schema: 1, generatedAt, players: unmatched.sort((a, b) => a.name.localeCompare(b.name)) },
  };
  if (!writeManifest) delete files['unmatched.json'];
  await fs.mkdir(outDir, { recursive: true });
  const sizes = {};
  for (const [name, body] of Object.entries(files)) {
    const text = JSON.stringify(body);
    await writeAtomic(path.join(outDir, name), text);
    sizes[name] = Buffer.byteLength(text);
  }
  const manifest = {
    schema: 1, generatedAt, season, throughWeek, participationSeason: partSeason, participationIsCurrent: partSeason === season,
    sources: Object.entries(sourceUrls(season, prev, partSeason)).map(([id, url]) => ({ id, url, name: path.basename(url) })),
    files: sizes,
    xtd: { fitSeason: prev, targets: xtd.n.tgt, carries: xtd.n.car, bins: xtd.bins, tgt: xtd.tgt, car: xtd.car },
    matched: ids.gsisToSleeper.size, matchMethods: ids.counts, idConflicts: ids.conflicts.length, unmatchedCount: unmatched.length,
    ftnJoinRate: plays.length ? +(ftnJoined / plays.length).toFixed(3) : 0,
    buildMs: Date.now() - started,
    attribution: 'Play-by-play and snap data: nflverse. Charting data: FTN Data via nflverse. Participation: NFL Next Gen Stats via nflverse.',
  };
  // A past season (built for backtests) leaves the current manifest alone.
  if (writeManifest) await writeAtomic(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  else await writeAtomic(path.join(outDir, `manifest_${season}.json`), JSON.stringify(manifest, null, 1));
  log(`built ${weekly.length} player-weeks, ${seasonRows.length} players, ${unmatched.length} unmatched in ${manifest.buildMs} ms`);
  return manifest;
}
