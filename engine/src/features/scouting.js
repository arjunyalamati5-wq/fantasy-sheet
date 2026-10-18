// Player scouting reports: the facts, an outlook with a likely range, how the
// next opponents have fared against his position, and his game log.
//
// Everything is derived from data the app already caches (Sleeper weekly stat
// lines and projections via ml/data.js loadWeek) and from the league context.

import { loadWeek } from '../ml/data.js';
import { getProjections } from '../sleeper.js';
import { scoreStats, round2 } from '../scoring.js';
import { displayTeam } from '../teams.js';
import { loadUsage } from '../usage/store.js';
import { playoffSos } from './playoffsos.js';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
export const MIN_SAMPLES = 25;
export const SOFT_AT = 1.15;
export const TOUGH_AT = 0.87;

/** Used for a position until it has MIN_SAMPLES graded weeks of its own. */
export const FALLBACK_BANDS = {
  QB: { floor: 0.45, ceiling: 1.45 },
  RB: { floor: 0.30, ceiling: 1.65 },
  WR: { floor: 0.30, ceiling: 1.70 },
  TE: { floor: 0.25, ceiling: 1.70 },
  K: { floor: 0.35, ceiling: 1.60 },
  DEF: { floor: 0.20, ceiling: 1.90 },
};

// A Sleeper id is digits; a team defence is its 2-3 letter code.
const ID_RE = /^(?:\d{1,12}|[A-Z]{2,3})$/;
export const isValidPlayerId = (v) => typeof v === 'string' && ID_RE.test(v);

/** p in 0..1 over an ascending-sorted array, linear interpolation. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const at = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/**
 * Per position, the 20th and 80th percentile of actual ÷ projected over the
 * finished weeks given (standard-PPR points as Sleeper published both, so the
 * ratio does not depend on any league's scoring). Only players who recorded a
 * stat line count, so the band describes "when he plays".
 * @param {Array<{stats:Array, projections:Array}>} weeks
 * @returns {Array<{pos, floor, ceiling, samples, fallback}>}
 */
export function calibrate(weeks) {
  const ratios = Object.fromEntries(POSITIONS.map((p) => [p, []]));
  for (const w of weeks || []) {
    const actual = new Map();
    for (const s of w.stats || []) if (typeof s.ppr === 'number') actual.set(s.id, s.ppr);
    for (const pr of w.projections || []) {
      if (!(pr.ppr > 0.5) || !ratios[pr.pos] || !actual.has(pr.id)) continue;
      ratios[pr.pos].push(Math.max(0, actual.get(pr.id)) / pr.ppr);
    }
  }
  return POSITIONS.map((pos) => {
    const sorted = ratios[pos].slice().sort((a, b) => a - b);
    if (sorted.length < MIN_SAMPLES) {
      return { pos, ...FALLBACK_BANDS[pos], samples: sorted.length, fallback: true };
    }
    return {
      pos,
      floor: round2(percentile(sorted, 0.2)),
      ceiling: round2(percentile(sorted, 0.8)),
      samples: sorted.length,
      fallback: false,
    };
  });
}

/** Floor and ceiling for a projection, from a calibration table. */
export function floorCeiling(proj, pos, table) {
  const band = (table || []).find((r) => r.pos === pos) || { ...FALLBACK_BANDS[pos] || { floor: 0.3, ceiling: 1.7 } };
  if (!(proj > 0)) return { floor: 0, ceiling: 0 };
  return { floor: round2(proj * band.floor), ceiling: round2(proj * band.ceiling) };
}

export function gradeFor(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return 'avg';
  if (ratio >= SOFT_AT) return 'soft';
  if (ratio <= TOUGH_AT) return 'tough';
  return 'avg';
}

/**
 * How many points each defence has allowed to each position per game, as a
 * multiple of the league average for that position.
 * @param weeks   [{ week, stats:[{pos, team, opp, stats}] }] for this season
 * @param scoring league scoring_settings
 * @param oppOf   (team, week) => opponent code, used when a row lacks one
 */
export function defenseRatios(weeks, scoring, oppOf = () => null) {
  // pos -> opp -> week -> points
  const acc = {};
  for (const w of weeks || []) {
    for (const s of w.stats || []) {
      const opp = s.opp || oppOf(s.team, w.week);
      if (!opp || !POSITIONS.includes(s.pos)) continue;
      const byOpp = (acc[s.pos] ||= new Map());
      const byWeek = byOpp.get(opp) || byOpp.set(opp, new Map()).get(opp);
      byWeek.set(w.week, (byWeek.get(w.week) || 0) + scoreStats(s.stats, scoring));
    }
  }
  const perGame = {};
  for (const [pos, byOpp] of Object.entries(acc)) {
    perGame[pos] = new Map();
    for (const [opp, byWeek] of byOpp) {
      const vals = [...byWeek.values()];
      perGame[pos].set(opp, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  const league = {};
  for (const [pos, m] of Object.entries(perGame)) {
    const v = [...m.values()];
    league[pos] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  }
  return {
    ratio(pos, opp) {
      const g = perGame[pos]?.get(opp);
      return g != null && league[pos] > 0 ? round2(g / league[pos]) : null;
    },
    leagueAverage: league,
  };
}

/** "6 rec, 86 yd, 1 TD" style line for one stat line. */
export function lineFor(pos, st) {
  const n = (k) => st?.[k] || 0;
  const parts = [];
  if (pos === 'QB') {
    if (n('pass_yd') || n('pass_att')) parts.push(`${Math.round(n('pass_cmp'))}/${Math.round(n('pass_att'))}, ${Math.round(n('pass_yd'))} pass yd`);
    if (n('pass_td')) parts.push(`${n('pass_td')} pass TD`);
    if (n('pass_int')) parts.push(`${n('pass_int')} INT`);
    if (n('rush_yd') >= 10) parts.push(`${Math.round(n('rush_yd'))} rush yd`);
    if (n('rush_td')) parts.push(`${n('rush_td')} rush TD`);
  } else if (pos === 'K') {
    if (n('fgm') || n('fga')) parts.push(`${n('fgm')}/${n('fga') || n('fgm')} FG`);
    if (n('xpm')) parts.push(`${n('xpm')} XP`);
  } else if (pos === 'DEF') {
    if (n('sack')) parts.push(`${n('sack')} sack${n('sack') === 1 ? '' : 's'}`);
    if (n('int')) parts.push(`${n('int')} INT`);
    if (n('ff') || n('fum_rec')) parts.push(`${n('fum_rec')} fum rec`);
    if (n('def_td') || n('def_st_td')) parts.push(`${n('def_td') + n('def_st_td')} TD`);
    if (st && 'pts_allow' in st) parts.push(`${n('pts_allow')} pts allowed`);
  } else {
    if (n('rush_att') || n('rush_yd')) parts.push(`${Math.round(n('rush_att'))} car, ${Math.round(n('rush_yd'))} rush yd`);
    if (n('rec') || n('rec_yd')) parts.push(`${n('rec')} rec, ${Math.round(n('rec_yd'))} yd`);
    const td = n('rush_td') + n('rec_td') + n('pass_td');
    if (td) parts.push(`${td} TD`);
    if (n('fum_lost')) parts.push(`${n('fum_lost')} fum lost`);
  }
  return parts.join(', ') || 'no stats';
}

/** Who holds a player: 'mine', the owner's team name, or 'free agent'. */
export function ownerLabel(ctx, id) {
  const rid = ctx.ownerOf?.get(id);
  if (rid === undefined || rid === null) return 'free agent';
  if (ctx.myRoster && String(rid) === String(ctx.myRoster.roster_id)) return 'mine';
  const roster = ctx.rosterOf(rid);
  return roster ? ctx.teamName(roster) : 'rostered';
}

function formatHeight(h) {
  if (!h) return null;
  const s = String(h);
  if (/^\d{2}$/.test(s)) return `${Math.floor(Number(s) / 12)}'${Number(s) % 12}"`;
  const m = s.match(/^(\d)'?\s*(\d{1,2})"?$/);
  return m ? `${m[1]}'${m[2]}"` : s;
}

function ageOf(p, now = new Date()) {
  if (p.age != null && Number.isFinite(Number(p.age))) return Number(p.age);
  if (!p.birth_date) return null;
  const b = new Date(p.birth_date);
  if (Number.isNaN(b.getTime())) return null;
  return Math.floor((now - b) / (365.25 * 86_400_000));
}

// ---- data loading (memoised: finished weeks never change) -------------------

const weekMemo = new Map();
function finishedWeek(season, week, load) {
  const key = `${season}|${week}`;
  if (!weekMemo.has(key)) {
    const p = (async () => {
      const [stats, projections] = await Promise.all([
        load('stats', season, week), load('projections', season, week),
      ]);
      return { season, week, stats, projections };
    })().catch(() => { weekMemo.delete(key); return null; });
    weekMemo.set(key, p);
  }
  return weekMemo.get(key);
}

/** This season's and last season's finished weeks; weeks that cannot load are left out. */
export async function loadRecentWeeks(ctx, { load = loadWeek } = {}) {
  const season = Number(ctx.season);
  const wanted = [];
  for (let w = 1; w <= 18; w++) wanted.push([season - 1, w]);
  for (let w = 1; w < ctx.week; w++) wanted.push([season, w]);
  const out = [];
  for (let i = 0; i < wanted.length; i += 6) {
    out.push(...await Promise.all(wanted.slice(i, i + 6).map(([s, w]) => finishedWeek(s, w, load))));
  }
  return out.filter(Boolean);
}

const calMemo = new Map();
/** The calibration table, for the report and for a methods page. */
export async function calibrationTable(ctx, opts = {}) {
  const key = `${ctx.season}|${ctx.week}`;
  if (!calMemo.has(key) || opts.load) {
    const p = loadRecentWeeks(ctx, opts).then((weeks) => ({
      table: calibrate(weeks), weeks,
    }));
    if (opts.load) return p;
    calMemo.set(key, p.catch((e) => { calMemo.delete(key); throw e; }));
  }
  return calMemo.get(key);
}

// ---- the report ------------------------------------------------------------

export async function playerReport(ctx, playerId, opts = {}) {
  if (!isValidPlayerId(playerId)) { const e = new Error('That player is not valid.'); e.status = 400; throw e; }
  const p = ctx.playerOf(playerId);
  if (!p) { const e = new Error('No such player in the Sleeper catalogue.'); e.status = 404; throw e; }

  const { table, weeks } = await calibrationTable(ctx, opts);
  const thisSeason = weeks.filter((w) => w.season === Number(ctx.season));
  const defence = defenseRatios(thisSeason, ctx.scoring, (team, wk) => ctx.schedule.gameFor(team, wk)?.opponent || null);

  // --- facts
  const status = ctx.weekStatusOf?.(playerId) || p.injury_status || null;
  const inj = ctx.injuryByPlayer?.get(playerId);
  const injury = status ? `${status}${inj?.bodyPart ? ` (${inj.bodyPart})` : ''}` : null;
  const order = p.depth_chart_order;
  const depthChart = order ? `${p.depth_chart_position || p.position}${order}` : null;
  const facts = {
    name: p.name, pos: p.position, team: displayTeam(p.team) || null,
    age: ageOf(p), experience: p.years_exp ?? null, injury, depthChart,
    height: formatHeight(p.height), weight: p.weight ? `${p.weight} lb` : null,
    college: p.college || null, owner: ownerLabel(ctx, playerId),
  };

  // --- outlook
  const proj = round2(ctx.pointsFor(playerId));
  const band = floorCeiling(proj, p.position, table);

  const nextWeeks = [];
  for (let w = ctx.week; w < ctx.week + 4 && w <= 18; w++) nextWeeks.push(w);
  const weekProj = new Map([[ctx.week, proj]]);
  const getProj = opts.getProjections || getProjections;
  await Promise.all(nextWeeks.filter((w) => w !== ctx.week).map(async (w) => {
    try {
      const rows = await getProj(ctx.season, w);
      const row = rows?.[playerId];
      if (row?.stats) weekProj.set(w, round2(scoreStats(row.stats, ctx.scoring)));
    } catch { /* fall back to his current projection */ }
  }));

  const next = nextWeeks.map((w) => {
    const game = p.team ? ctx.schedule.gameFor(p.team, w) : null;
    const bye = !game && p.team && ctx.schedule.isOnBye(p.team, w);
    if (bye) return { week: w, opp: null, home: null, grade: 'bye', ratio: null, proj: 0, floor: 0, ceiling: 0 };
    const pr = weekProj.has(w) ? weekProj.get(w) : proj;
    const opp = game?.opponent || null;
    const ratio = opp ? defence.ratio(p.position, opp) : null;
    return {
      week: w, opp: opp ? displayTeam(opp) : null, home: game ? game.isHome : null,
      grade: gradeFor(ratio), ratio, proj: pr, ...floorCeiling(pr, p.position, table),
    };
  });

  // Rest of season: his per-game value over the games left before the playoffs.
  const lastWeek = Math.max(ctx.week, (ctx.playoffWeekStart || 15) - 1);
  let games = 0;
  for (let w = ctx.week; w <= lastWeek; w++) {
    if (!p.team || !ctx.schedule.isOnBye(p.team, w)) games++;
  }
  const value = ctx.valueOf(playerId);
  const ros = round2(value * games);
  const pool = ctx.valuations.rows.filter((r) => r.position === p.position);
  const rosRank = pool.length ? 1 + pool.filter((r) => r.value > value).length : null;

  // --- game log, newest first
  const gameLog = [];
  for (const w of thisSeason.slice().sort((a, b) => b.week - a.week)) {
    const row = w.stats.find((s) => s.id === playerId);
    if (row) {
      const opp = row.opp || ctx.schedule.gameFor(row.team || p.team, w.week)?.opponent || null;
      gameLog.push({
        week: w.week, opp: opp ? displayTeam(opp) : null,
        points: round2(scoreStats(row.stats, ctx.scoring)), line: lineFor(p.position, row.stats),
      });
    } else if (p.team && ctx.schedule.isOnBye(p.team, w.week)) {
      gameLog.push({ week: w.week, opp: null, points: null, line: 'bye' });
    }
  }

  return {
    facts,
    outlook: {
      week: ctx.week, proj, ...band, ros, rosRank, rosPoolSize: pool.length, games, next,
      // His team's opponents in the league's playoff weeks, graded like the next-opponent rows.
      playoffs: playoffSos(ctx, p, (pos, opp) => defence.ratio(pos, opp)),
    },
    gameLog,
    calibration: table,
    usage: await usageFor(ctx, playerId, p.position, opts),
  };
}

// ---- usage (nflverse weekly/season rows from src/usage) ---------------------

export const USAGE_WEEK_COLS = [
  'week', 'opp', 'off_snaps', 'tgt', 'car', 'rec_td', 'rush_td', 'snap_pct', 'tgt_share', 'ay_share', 'wopr',
  'rush_share', 'rz_tgt_share', 'i10_tgt_share', 'rz_car_share', 'i10_car_share',
  'qb_db', 'qb_scrambles', 'designed_runs', 'qb_sacks', 'qb_hits', 'pa_db',
];
const AVG_SEASON = [
  'snap_pct', 'tgt_share', 'ay_share', 'wopr', 'rush_share', 'rz_tgt_share', 'i10_tgt_share', 'rz_car_share',
  'i10_car_share', 'adot', 'ypt', 'catch_rate', 'drop_rate', 'ypc', 'ypc_stk', 'ypc_lgt', 'tgt_per_snap',
  'ypt_bl', 'ypt_nbl', 'pa_share', 'scr_share', 'cont_rate',
  'pressure_to_sack', 'scramble_rate', 'sack_rate', 'pa_rate', 'designed_run_share',
];
// Quarterback averages compare starters: a backup's three dropbacks would drag every rate.
const MIN_QB_DROPBACKS = 60;
const QB_KEYS = ['pressure_to_sack', 'scramble_rate', 'sack_rate', 'pa_rate', 'designed_run_share'];
const AVG_COVERAGE = ['yprr', 'tprr', 'yprr_man', 'tprr_man', 'yprr_zone', 'tprr_zone'];
const MIN_GAMES = 3;
const MIN_ROUTES = 100;
const avgMemo = new WeakMap(); // usage object -> pos -> averages

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Mean of each usage metric over a position's players with enough games (or routes). */
export function positionAverages(usage, ctx, pos) {
  let byPos = avgMemo.get(usage);
  if (!byPos) avgMemo.set(usage, (byPos = new Map()));
  if (byPos.has(pos)) return byPos.get(pos);
  const out = {};
  const inPos = (pid) => ctx.playerOf(pid)?.position === pos;
  const seasonRows = (usage.seasonRows || []).filter((r) => (r.games || 0) >= MIN_GAMES && inPos(r.pid));
  const starters = pos === 'QB' ? seasonRows.filter((r) => (r.qb_db || 0) >= MIN_QB_DROPBACKS) : seasonRows;
  for (const k of AVG_SEASON) {
    const v = mean((QB_KEYS.includes(k) ? starters : seasonRows).map((r) => num(r[k])).filter((x) => x !== null));
    if (v !== null) out[k] = Math.round(v * 1000) / 1000;
  }
  const cov = (usage.coverage || []).filter((r) => (r.routes || 0) >= MIN_ROUTES && inPos(r.pid));
  for (const k of AVG_COVERAGE) {
    const v = mean(cov.map((r) => num(r[k])).filter((x) => x !== null));
    if (v !== null) out[k] = Math.round(v * 1000) / 1000;
  }
  byPos.set(pos, out);
  return out;
}

/** The usage block of the report. Never throws: missing data is { available: false }. */
export async function usageFor(ctx, playerId, pos, opts = {}) {
  let u;
  try { u = await (opts.loadUsage || loadUsage)(Number(ctx.season)); } catch { u = null; }
  if (!u || !u.available) return { available: false, reason: u?.reason || 'nflverse data arrives with the nightly update.' };
  const rows = u.weeksOf(playerId) || [];
  const season = u.seasonOf.get(playerId) || null;
  const coverage = u.coverageOf.get(playerId) || null;
  const coverageNote = coverage && u.coverageMeta && !u.coverageMeta.isCurrent
    ? `from ${u.coverageMeta.season} — ${ctx.season} coverage data is not published yet` : null;
  const weeks = rows.map((r) => {
    const o = {};
    for (const c of USAGE_WEEK_COLS) o[c] = r[c] ?? null;
    o.tgt_per_snap = r.off_snaps > 0 && r.tgt != null ? Math.round((r.tgt / r.off_snaps) * 1000) / 1000 : null;
    return o;
  });
  return {
    available: weeks.length > 0 || !!season,
    reason: weeks.length || season ? null : 'no nflverse usage on file for this player yet.',
    throughWeek: u.throughWeek ?? null,
    weeks, season, coverage, coverageNote,
    posAverages: positionAverages(u, ctx, pos),
  };
}

// ---- search ----------------------------------------------------------------

/**
 * Search the whole catalogue. scope: all | mine | rostered | free | ids
 * (ids: only the given player ids, which is how a browser-side watchlist asks).
 */
export function searchCatalogue(ctx, { q = '', pos = null, scope = 'all', ids = null, limit = 50 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const idSet = ids ? new Set(ids) : null;
  const rows = [];
  for (const [id, p] of Object.entries(ctx.players)) {
    if (!POSITIONS.includes(p.position)) continue;
    if (pos && p.position !== pos) continue;
    const owner = ownerLabel(ctx, id);
    if (scope === 'mine' && owner !== 'mine') continue;
    if (scope === 'rostered' && owner === 'free agent') continue;
    if (scope === 'free' && owner !== 'free agent') continue;
    if (scope === 'ids' && !(idSet && idSet.has(id))) continue;
    let score = 0;
    if (query) {
      const name = p.name.toLowerCase();
      if (name === query) score = 100;
      else if (name.startsWith(query)) score = 80;
      else if (name.split(' ').some((w) => w.startsWith(query))) score = 60;
      else if (name.includes(query)) score = 40;
      else if ((displayTeam(p.team) || '').toLowerCase() === query) score = 30;
      if (!score) continue;
    }
    rows.push({
      id, name: p.name, pos: p.position, team: displayTeam(p.team) || null, owner,
      proj: ctx.candidateIds.has(id) ? round2(ctx.pointsFor(id)) : null, score,
    });
  }
  rows.sort((a, b) => b.score - a.score || (b.proj ?? -1) - (a.proj ?? -1) || a.name.localeCompare(b.name));
  return { rows: rows.slice(0, limit).map(({ score, ...r }) => r), total: rows.length };
}
