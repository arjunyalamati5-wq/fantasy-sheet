// Training data for the prediction model: every regular-season week's actual
// stat lines and the projections Sleeper published before it, for several
// seasons. Sleeper's responses are a few megabytes a week, so each week is
// slimmed to what the model reads (fantasy positions, stat fields only) before
// it is cached; a finished week never changes, so it is kept for a month.

import { cached } from '../cache.js';
import { normTeam } from '../teams.js';
import { getSchedule, getInjuries } from '../nflverse.js';
import { getCrosswalk } from '../ids.js';

const HOST = 'https://api.sleeper.com';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const FINISHED_TTL = 30 * 24 * 60 * 60_000;
const OPEN_TTL = 60 * 60_000;
export const REGULAR_WEEKS = 18;

// Fields that describe a row rather than a stat; never needed for scoring.
// (pts_allow, a defence's real points allowed, is a stat and is kept.)
const SKIP = /^(rank_|pos_rank|adp_|pos_adp|pts_ppr|pts_std|pts_half_ppr)/;

async function fetchJson(url, { timeout = 60_000, attempts = 3 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

/** One raw Sleeper row slimmed to { id, pos, team, opp, stats }. Exported for tests. */
export function slimRow(row) {
  const id = row.player_id || row.player?.player_id;
  const pos = row.player?.position || row.player?.fantasy_positions?.[0];
  if (!id || !POSITIONS.includes(pos) || !row.stats) return null;
  const stats = {};
  for (const [k, v] of Object.entries(row.stats)) {
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0 && !SKIP.test(k)) stats[k] = v;
  }
  return {
    id,
    name: row.player ? [row.player.first_name, row.player.last_name].filter(Boolean).join(' ') : id,
    pos,
    team: normTeam(row.team || row.player?.team),
    opp: normTeam(row.opponent),
    // Standard PPR as published, kept only to decide who was really projected to play.
    ppr: typeof row.stats.pts_ppr === 'number' ? row.stats.pts_ppr : null,
    stats,
  };
}

/**
 * One week of `kind` ('stats' or 'projections'), slimmed and cached.
 * Projections keep only players expected to score, which is everyone a
 * lineup decision could involve; stats keep everyone who recorded one.
 */
export async function loadWeek(kind, season, week, { finished = true, fetcher = fetchJson } = {}) {
  // v2: pts_allow is kept (v1 dropped it with the pts_ fields).
  const key = `ml2:${kind}:${season}:${week}`;
  return cached(key, finished ? FINISHED_TTL : OPEN_TTL, async () => {
    const q = POSITIONS.map((p) => `position[]=${p}`).join('&');
    const rows = await fetcher(`${HOST}/${kind}/nfl/${season}/${week}?season_type=regular&${q}`);
    if (!Array.isArray(rows)) throw new Error(`Sleeper ${kind} ${season} week ${week}: no rows`);
    // A short answer (a week not finished, a feed hiccup) must not be cached
    // as the truth for a month: a full week has several hundred of each.
    const min = kind === 'stats' ? 400 : 200;
    if (finished && rows.length < min) throw new Error(`Sleeper ${kind} ${season} week ${week}: only ${rows.length} rows, not complete`);
    const out = [];
    for (const r of rows) {
      const s = slimRow(r);
      if (!s) continue;
      if (kind === 'projections' && !(s.ppr > 0.5)) continue;
      out.push(s);
    }
    return out;
  });
}

/** nflverse report_status -> Out | Doubtful | Questionable | null. Exported for tests. */
export function normReport(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'out') return 'Out';
  if (s === 'doubtful') return 'Doubtful';
  if (s === 'questionable') return 'Questionable';
  return null;
}

/** nflverse practice_status -> DNP | Limited | Full | null. Exported for tests. */
export function normPractice(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('did not')) return 'DNP';
  if (s.startsWith('limited')) return 'Limited';
  if (s.startsWith('full')) return 'Full';
  return null;
}

/**
 * One season's injury report as Map("<week>|<sleeperId>" -> {report, practice}).
 * Entries with neither a report status nor a practice status are left out.
 * Exported for tests.
 */
export function injuryMap(byWeek, gsisToSleeper) {
  const out = new Map();
  for (const [key, e] of byWeek) {
    const [week, gsis] = key.split('|');
    const sid = gsisToSleeper.get(gsis);
    if (!sid) continue;
    const report = normReport(e.reportStatus);
    const practice = normPractice(e.practiceStatus);
    if (report || practice) out.set(`${week}|${sid}`, { report, practice });
  }
  return out;
}

/**
 * Every week from `fromSeason` week 1 up to (not including) `untilSeason`
 * week `untilWeek`, oldest first, with each season's schedule. A week that
 * cannot be fetched is reported in `missing` and skipped, never invented.
 */
export async function loadHistory({ fromSeason, untilSeason, untilWeek, concurrency = 6, log = () => {} }) {
  const wanted = [];
  for (let s = fromSeason; s <= untilSeason; s++) {
    const last = s < untilSeason ? REGULAR_WEEKS : untilWeek - 1;
    for (let w = 1; w <= last; w++) wanted.push({ season: s, week: w });
  }
  const weeks = new Array(wanted.length);
  const missing = [];
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const i = next++;
      const { season, week } = wanted[i];
      try {
        const [stats, projections] = await Promise.all([
          loadWeek('stats', season, week),
          loadWeek('projections', season, week),
        ]);
        weeks[i] = { season, week, stats, projections };
        log(`loaded ${season} week ${week}: ${projections.length} projected, ${stats.length} with stats`);
      } catch (err) {
        missing.push({ season, week, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const schedules = {};
  for (let s = fromSeason; s <= untilSeason; s++) schedules[s] = await getSchedule(s);

  // Injury reports (published before kickoff). Soft-fail: a season that cannot
  // load is empty and listed in `missing`, and its rows simply see no report.
  const injuries = {};
  let cw = null;
  let cwError = '';
  try { cw = await getCrosswalk(); } catch (err) { cwError = err.message; }
  for (let s = fromSeason; s <= untilSeason; s++) {
    injuries[s] = new Map();
    try {
      if (!cw) throw new Error(`id crosswalk unavailable: ${cwError}`);
      const inj = await getInjuries(s);
      if (!inj.available) throw new Error('injury report unavailable');
      injuries[s] = injuryMap(inj.byWeek, cw.gsisToSleeper);
    } catch (err) {
      missing.push({ season: s, kind: 'injuries', error: err.message });
    }
  }
  return { weeks: weeks.filter(Boolean), schedules, injuries, missing };
}
