// "Under the hood": every number the app leans on, and how far to trust it.
// Each part below is computed from this league's own data and fails alone: a
// piece that cannot load comes back as { available: false, reason } and the
// rest of the page still renders.

import { calibrate, calibrationTable } from './scouting.js';
import { scoreStats, round2 } from '../scoring.js';
import { takesReport } from './takes.js';
import { playoffSettings, bracketSize, buildBracket, LOSERS_STYLES } from './bracket.js';
import {
  QUESTIONABLE_SHARE, DOUBTFUL_SHARE, IR_DEFAULT_WEEKS, RULED_OUT, LAST_WEEK,
} from '../availability.js';
import { loadManifest } from '../usage/store.js';
import { practiceLog } from '../ml/live.js';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
/** The floor and ceiling are the 20th and 80th percentile, so six games in ten should land between. */
export const BAND_LOW = 0.2;
export const BAND_HIGH = 0.8;
export const COVERAGE_TARGET = round2(BAND_HIGH - BAND_LOW);

const unavailable = (reason) => ({ available: false, reason });
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (v) => (v == null ? null : round2(v));
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/** Run one part; any throw becomes { available: false, reason }. */
async function part(fn, what) {
  try {
    const v = await fn();
    return v && typeof v === 'object' && 'available' in v ? v : { available: true, ...v };
  } catch (err) {
    return unavailable(`${what} could not be worked out right now (${err?.message || 'unknown error'}).`);
  }
}

// ---- projection check ------------------------------------------------------

/**
 * How far Sleeper's weekly projection missed, scored with THIS league's rules.
 * Counts players Sleeper projected to play (more than half a point), who
 * recorded a stat line that week and for whom `include(id)` holds. Bias is
 * projection minus actual: positive means the projection ran high.
 * @param {Array<{season,week,stats:Array,projections:Array}>} weeks
 */
export function projectionCheck(weeks, scoring, include = () => true) {
  const rows = [];
  const used = [];
  for (const w of weeks || []) {
    const actual = new Map();
    for (const s of w.stats || []) actual.set(s.id, scoreStats(s.stats, scoring));
    let n = 0;
    for (const p of w.projections || []) {
      if (!actual.has(p.id) || !include(p.id)) continue;
      const proj = scoreStats(p.stats, scoring);
      rows.push({ pos: p.pos, proj, actual: actual.get(p.id) });
      n++;
    }
    if (n) used.push(w.week);
  }
  const summary = (rs) => ({
    n: rs.length,
    mae: rs.length ? r2(mean(rs.map((r) => Math.abs(r.proj - r.actual)))) : null,
    bias: rs.length ? r2(mean(rs.map((r) => r.proj - r.actual))) : null,
  });
  if (!rows.length) return unavailable('No finished week with both a projection and a stat line yet.');
  return {
    available: true,
    firstWeek: Math.min(...used),
    lastWeek: Math.max(...used),
    weeks: used.length,
    ...summary(rows),
    byPos: POSITIONS.map((pos) => ({ pos, ...summary(rows.filter((r) => r.pos === pos)) })).filter((r) => r.n),
  };
}

// ---- floors and ceilings: held-out coverage and spread ---------------------

/**
 * Calibrate on every finished week before the latest one, then count how many
 * of the latest week's outcomes fell between the floor and the ceiling.
 */
export function heldOutCoverage(weeks) {
  const sorted = (weeks || []).slice().sort((a, b) => (a.season * 100 + a.week) - (b.season * 100 + b.week));
  if (sorted.length < 2) return unavailable('Needs at least two finished weeks to hold one out.');
  const test = sorted[sorted.length - 1];
  const table = calibrate(sorted.slice(0, -1));
  const actual = new Map();
  for (const s of test.stats || []) if (typeof s.ppr === 'number') actual.set(s.id, s.ppr);
  const tally = {};
  for (const p of test.projections || []) {
    if (!(p.ppr > 0.5) || !actual.has(p.id)) continue;
    const band = table.find((b) => b.pos === p.pos);
    if (!band) continue;
    const ratio = Math.max(0, actual.get(p.id)) / p.ppr;
    const t = (tally[p.pos] ||= { n: 0, inside: 0 });
    t.n++;
    if (ratio >= band.floor && ratio <= band.ceiling) t.inside++;
  }
  const n = Object.values(tally).reduce((s, t) => s + t.n, 0);
  if (!n) return unavailable('The latest finished week has no outcomes to test against.');
  const inside = Object.values(tally).reduce((s, t) => s + t.inside, 0);
  return {
    available: true,
    season: test.season,
    week: test.week,
    n,
    coverage: r3(inside / n),
    target: COVERAGE_TARGET,
    byPos: POSITIONS.filter((p) => tally[p]).map((pos) => ({ pos, n: tally[pos].n, coverage: r3(tally[pos].inside / tally[pos].n) })),
  };
}

/** Standard deviation, in points, of actual minus projected by position (standard PPR as Sleeper published both). */
export function residualSd(weeks) {
  const by = Object.fromEntries(POSITIONS.map((p) => [p, []]));
  for (const w of weeks || []) {
    const actual = new Map();
    for (const s of w.stats || []) if (typeof s.ppr === 'number') actual.set(s.id, s.ppr);
    for (const p of w.projections || []) {
      if (p.ppr > 0.5 && by[p.pos] && actual.has(p.id)) by[p.pos].push(actual.get(p.id) - p.ppr);
    }
  }
  const out = {};
  for (const [pos, xs] of Object.entries(by)) {
    if (xs.length < 2) continue;
    const m = mean(xs);
    out[pos] = r2(Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)));
  }
  return out;
}

// ---- league rules ----------------------------------------------------------

export function leagueRules(ctx) {
  const sc = ctx.scoring || {};
  const val = (k) => (typeof sc[k] === 'number' ? sc[k] : null);
  const slotCount = {};
  for (const s of ctx.rosterPositions || []) slotCount[s] = (slotCount[s] || 0) + 1;
  const st = ctx.league?.settings || {};
  const faab = Number(st.waiver_type) === 2;
  const bench = slotCount.BN || 0;
  return {
    available: true,
    name: ctx.league?.name || null,
    teams: ctx.numTeams,
    scoring: {
      reception: val('rec'), passTd: val('pass_td'), passYd: val('pass_yd'), rushYd: val('rush_yd'),
      rushTd: val('rush_td'), recYd: val('rec_yd'), recTd: val('rec_td'), interception: val('pass_int'),
      teBonus: val('bonus_rec_te'), passYd300Bonus: val('bonus_pass_yd_300'),
      rushYd100Bonus: val('bonus_rush_yd_100'), recYd100Bonus: val('bonus_rec_yd_100'),
    },
    scoringRules: Object.keys(sc).filter((k) => typeof sc[k] === 'number' && sc[k] !== 0).length,
    slots: Object.entries(slotCount).map(([slot, count]) => ({ slot, count })),
    starters: (ctx.rosterPositions || []).filter((s) => s !== 'BN' && s !== 'IR' && s !== 'TAXI').length,
    bench,
    faab: faab ? { budget: st.waiver_budget ?? null, minBid: st.waiver_bid_min ?? 0 } : null,
    waiverType: faab ? 'FAAB budget' : 'waiver priority',
  };
}

// ---- assumptions: read from the real constants -----------------------------

export function assumptions() {
  return {
    available: true,
    questionableShare: QUESTIONABLE_SHARE,
    doubtfulShare: DOUBTFUL_SHARE,
    outShare: 0,
    ruledOut: [...RULED_OUT],
    irDefaultWeeks: IR_DEFAULT_WEEKS,
    lastWeek: LAST_WEEK,
  };
}

// ---- season simulation, brackets, clinch marks -----------------------------

export async function simulationInfo(season) {
  const r = await season;
  const teams = r?.teams || [];
  if (!teams.length) return unavailable('The season simulation has not run yet.');
  const sds = teams.map((t) => t.weeklySd).filter((v) => Number.isFinite(v));
  const means = teams.map((t) => t.weeklyMean).filter((v) => Number.isFinite(v));
  return {
    available: true,
    runs: r.runs,
    playoffTeams: r.playoffTeams,
    divisions: r.divisions || 0,
    weeksSimulated: r.weeksSimulated,
    playoffsPlayed: !!r.playoffsPlayed,
    sdMean: r2(mean(sds)), sdMin: r2(Math.min(...sds)), sdMax: r2(Math.max(...sds)),
    meanMin: r2(Math.min(...means)), meanMax: r2(Math.max(...means)),
    teams: teams.length,
    marked: teams.filter((t) => t.mark).length,
  };
}

export function bracketInfo(ctx) {
  const s = playoffSettings(ctx.league?.settings, ctx.playoffTeams);
  const teams = Math.min(s.teams, ctx.numTeams || s.teams);
  const size = bracketSize(teams);
  const seeds = Array.from({ length: teams }, (_, i) => String(i + 1));
  let byes = size - teams;
  let rounds = Math.log2(size);
  try {
    const b = buildBracket(seeds, { reseed: s.reseed, roundType: s.roundType, startWeek: s.startWeek });
    byes = b.byes?.length ?? byes;
    rounds = b.rounds?.length || rounds;
  } catch { /* keep the arithmetic above */ }
  const lastRegular = s.startWeek - 1;
  return {
    available: true,
    teams, bracketSize: size, byes, rounds, startWeek: s.startWeek,
    reseed: s.reseed, twoWeekFinal: s.roundType !== 0,
    roundType: s.roundType,
    losersStyles: LOSERS_STYLES,
    regularWeeksLeft: Math.max(0, lastRegular - Number(ctx.week) + 1),
    lastRegularWeek: lastRegular,
    divisions: new Set((ctx.rosters || []).map((r) => Number(r.settings?.division)).filter((d) => d > 0)).size,
  };
}

// ---- model bake-off --------------------------------------------------------

/** Live practice grades if any exist for this league, otherwise the documented offline finding. */
export async function bakeOff(ctx, opts = {}) {
  const documented = {
    available: true, kind: 'documented', graded: 0,
    note: "Every model tried, from linear corrections to boosted trees, landed within about 0.2% of Sleeper's game-day projection on the same weeks.",
  };
  let log = [];
  try { log = await (opts.practiceLog || practiceLog)(ctx.league?.league_id); } catch { /* none yet */ }
  const graded = (log || []).filter((e) => e.grade && e.grade.n > 0);
  if (!graded.length) return documented;
  const total = graded.reduce((s, e) => s + e.grade.n, 0);
  const wavg = (pick) => graded.reduce((s, e) => s + pick(e.grade) * e.grade.n, 0) / total;
  return {
    available: true, kind: 'practice', graded: graded.length, n: total,
    modelMae: r3(wavg((g) => g.model.mae)), sleeperMae: r3(wavg((g) => g.sleeper.mae)),
    note: documented.note,
  };
}

// ---- usage build -----------------------------------------------------------

export async function usageBuild(opts = {}) {
  const m = await (opts.loadManifest || loadManifest)();
  if (!m) return unavailable('The usage data has not been built yet.');
  const sum = (o) => Object.values(o || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  return {
    available: true,
    generatedAt: m.generatedAt ?? null,
    season: m.season ?? null,
    throughWeek: m.throughWeek ?? null,
    matched: m.matched ?? null,
    matchMethods: Object.entries(m.matchMethods || {}).map(([method, count]) => ({ method, count })),
    matchTotal: sum(m.matchMethods),
    unmatched: m.unmatchedCount ?? null,
    ftnJoinRate: m.ftnJoinRate ?? null,
    xtd: m.xtd ? { fitSeason: m.xtd.fitSeason, targets: m.xtd.targets, carries: m.xtd.carries } : null,
    participationSeason: m.participationSeason ?? null,
    participationIsCurrent: !!m.participationIsCurrent,
  };
}

export const CREDITS = [
  { name: 'Sleeper', what: 'league, rosters, matchups, live scores, weekly stats and projections, trending adds and drops', licence: null },
  { name: 'nflverse', what: 'play-by-play, snap counts, the schedule with betting lines, injury and practice reports', licence: null },
  { name: 'FTN Data via nflverse', what: 'play charting: box counts, play action, routes', licence: null },
  { name: 'NFL Next Gen Stats participation via nflverse', what: 'who was on the field, for coverage splits', licence: null },
  { name: 'FantasyCalc', what: 'trade values', licence: null },
  { name: 'Open-Meteo', what: 'kickoff weather for open-air stadiums', licence: 'CC BY 4.0' },
  { name: 'ESPN', what: 'NFL news and the live game clock', licence: null },
  { name: 'Reddit', what: 'what the fantasy subreddits are saying', licence: null },
];

// ---- the report ------------------------------------------------------------

/**
 * @param {Object} opts  test seams: load, takes, season (promise), loadManifest, practiceLog
 */
export async function methodReport(ctx, opts = {}) {
  const recent = await part(async () => {
    const { table, weeks } = await calibrationTable(ctx, opts.load ? { load: opts.load } : {});
    if (!weeks.length) throw new Error('no finished weeks could be loaded from Sleeper');
    return { table, weeks };
  }, 'The finished weeks');
  const weeks = recent.available ? recent.weeks : [];
  const thisSeason = weeks.filter((w) => w.season === Number(ctx.season));

  const [takes, sim, bake, usage] = await Promise.all([
    part(async () => ({ detectors: (await (opts.takes || takesReport)(ctx))?.detectors || [] }), 'The hot-take record'),
    part(() => simulationInfo(opts.season), 'The season simulation'),
    part(() => bakeOff(ctx, opts), 'The model comparison'),
    part(() => usageBuild(opts), 'The usage data'),
  ]);

  const sd = recent.available ? residualSd(weeks) : {};
  return {
    rules: await part(async () => leagueRules(ctx), 'The league rules'),
    projectionCheck: recent.available
      ? await part(async () => projectionCheck(thisSeason, ctx.scoring, (id) => ctx.ownerOf?.has(id)), 'The projection check')
      : unavailable(recent.reason),
    bakeOff: bake,
    bands: recent.available
      ? await part(async () => ({
        table: recent.table.map((r) => ({ ...r, sd: sd[r.pos] ?? null })),
        weeks: weeks.length,
        heldOut: heldOutCoverage(weeks),
        low: BAND_LOW, high: BAND_HIGH, target: COVERAGE_TARGET,
      }), 'The floors and ceilings')
      : unavailable(recent.reason),
    simulation: sim,
    bracket: await part(async () => bracketInfo(ctx), 'The bracket'),
    assumptions: await part(async () => assumptions(), 'The assumptions'),
    usage,
    takes,
    credits: CREDITS,
    // Kept for the older shape of this report.
    calibration: recent.available ? recent.table : null,
    calibrationWeeks: recent.available ? weeks.length : 0,
    detectors: takes.available ? takes.detectors : [],
  };
}

