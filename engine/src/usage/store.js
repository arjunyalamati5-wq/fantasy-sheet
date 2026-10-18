// Reading the usage tables the nightly build writes (src/usage/build.js), and
// keeping them fresh while the server runs. Everything degrades: no files yet
// means { available: false } and the pages that need usage say so.

import { IS_NODE, fsp as fs, pathMod as path, STATIC_BASE } from '../platform.js';
import { DATA_DIR, buildUsage } from './build.js';
import { fromColumnar } from './aggregate.js';

const memo = new Map(); // file -> { mtimeMs, value }

async function readJson(name, dir = DATA_DIR) {
  if (!IS_NODE) {
    const url = `${STATIC_BASE}${dir}/${name}`;
    const hit = memo.get(url);
    if (hit) return hit.value;
    const value = await fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (value) memo.set(url, { value });
    return value;
  }
  const file = path.join(dir, name);
  let st;
  try { st = await fs.stat(file); } catch { return null; }
  const hit = memo.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    memo.set(file, { mtimeMs: st.mtimeMs, value });
    return value;
  } catch { return null; }
}

/** The manifest, or null when no build has run. */
export function loadManifest(opts = {}) { return readJson('manifest.json', opts.dir); }

/**
 * Usage for a season: weekly/season rows as objects, team weeks, the newest
 * coverage season, and lookups by Sleeper id. { available: false, reason }
 * when the build has not landed.
 */
export async function loadUsage(season, opts = {}) {
  const dir = opts.dir || DATA_DIR;
  const manifest = await readJson('manifest.json', dir);
  if (!manifest) return { available: false, reason: 'The usage data has not been built yet.' };
  const s = season || manifest.season;
  const [weekly, seasonT, teams, coverage] = await Promise.all([
    readJson(`weekly_${s}.json`, dir), readJson(`season_${s}.json`, dir), readJson(`teams_${s}.json`, dir),
    readJson(`coverage_${manifest.participationSeason}.json`, dir),
  ]);
  if (!weekly || !seasonT) return { available: false, reason: `No usage data for ${s} yet.` };
  const key = `${dir}|${s}|${manifest.generatedAt}`;
  const hit = memo.get(key);
  if (hit) return hit.value;

  const weeklyRows = fromColumnar(weekly);
  const seasonRows = fromColumnar(seasonT);
  const teamRows = teams ? fromColumnar(teams) : [];
  const coverageRows = coverage ? fromColumnar(coverage) : [];
  const byPlayer = new Map();
  for (const r of weeklyRows) {
    const list = byPlayer.get(r.pid);
    if (list) list.push(r); else byPlayer.set(r.pid, [r]);
  }
  for (const list of byPlayer.values()) list.sort((a, b) => a.week - b.week);
  const value = {
    available: true,
    manifest,
    season: s,
    throughWeek: seasonT.throughWeek ?? manifest.throughWeek,
    weekly: weeklyRows,
    seasonRows,
    teams: teamRows,
    coverage: coverageRows,
    coverageMeta: coverage ? { season: coverage.season, isCurrent: !!coverage.isCurrent, teams: coverage.teams, shells: coverage.shells } : null,
    weeksOf: (pid) => byPlayer.get(String(pid)) || [],
    seasonOf: new Map(seasonRows.map((r) => [r.pid, r])),
    coverageOf: new Map(coverageRows.map((r) => [r.pid, r])),
    teamWeek: new Map(teamRows.map((t) => [`${t.team}|${t.week}`, t])),
  };
  memo.set(key, { value });
  return value;
}

// ---------------------------------------------------------------- refresh

let running = null;

/**
 * Rebuild when the files are missing or older than `maxAgeMs`. Never throws:
 * a failed build keeps serving the last good files.
 */
export function refreshUsage({ getSleeperPlayers, getCrosswalk, maxAgeMs = 20 * 60 * 60_000, force = false, log = console.log } = {}) {
  if (running) return running;
  running = (async () => {
    try {
      const m = await loadManifest();
      const age = m ? Date.now() - Date.parse(m.generatedAt) : Infinity;
      if (!force && age < maxAgeMs) return m;
      const [sleeperPlayers, cw] = await Promise.all([getSleeperPlayers(), getCrosswalk().catch(() => null)]);
      return await buildUsage({ sleeperPlayers, crosswalk: cw?.gsisToSleeper || new Map(), log: (msg) => log(`[usage] ${msg}`) });
    } catch (err) {
      log(`[usage] build failed, keeping the last files: ${err.message}`);
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Check at start-up, then hourly; rebuilds at most every ~20 h (nflverse updates nightly). */
export function startUsageClock(deps) {
  const tick = () => refreshUsage(deps);
  setTimeout(tick, 5_000).unref?.();
  return setInterval(tick, 60 * 60_000).unref?.();
}
