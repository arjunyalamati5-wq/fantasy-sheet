// Hot takes: short, rule-based observations about players ("29% of the targets
// go to Brock Bowers") drawn from this season's weekly stat lines, each backed
// by the same rule replayed over last season to see whether it was ever right.
//
// A detector is a pure function over one player's weekly records (oldest
// first, only weeks BEFORE the week being looked at) and some context. It
// returns a take or null. Nothing here reads a future week, so the live feed
// and the backtest run the very same code.

import { cacheGet, cacheSet } from '../cache.js';
import { loadWeek } from '../ml/data.js';
import { scoreStats, DEFAULT_SCORING, round2 } from '../scoring.js';
import { displayTeam } from '../teams.js';
import { slotLabel, startingSlots } from '../lineup.js';
import { setStarters } from './lineup.js';
import {
  getSeasonCharting, indexSummary, defenseBox, leagueBox, rusherBox,
  defenseCoverage, leagueCoverage, receiverCoverage, COVERAGE_LAST_SEASON,
} from '../charting.js';
import { getCrosswalk } from '../ids.js';
import { loadUsage } from '../usage/store.js';
import { getInjuries } from '../nflverse.js';

// ---------------------------------------------------------------- thresholds

/** Positions the usage detectors speak about. */
export const USAGE_POSITIONS = ['RB', 'WR', 'TE'];
/** Weeks looked at for "lately" (target share, red zone, buy/sell). */
export const RECENT_WEEKS = 3;
/** Weeks looked at for a snap-share jump: the last two games. */
export const SPIKE_WEEKS = 2;
/** How many games before the recent ones are used as "what he used to do". */
export const EARLIER_GAMES_MAX = 4;
export const MIN_EARLIER_GAMES = 2;

/** Target hog: this share of his team's targets over the last 3 weeks... */
export const HOG_SHARE = 0.25;
/** ...on at least this many targets, so a one-game fluke cannot qualify. */
export const HOG_MIN_TARGETS = 15;

/** Snap share must move by this many points (as a fraction) to be a spike/drop. */
export const SNAP_SHIFT = 0.20;
/** A spike must land on a real role, a drop must start from one. */
export const SPIKE_MIN_SNAP = 0.40;
export const DROP_MIN_EARLIER_SNAP = 0.50;

/** Share of the team's inside-20 chances (targets + carries) must move by this much. */
export const RZ_SHIFT = 0.20;
/** Both periods need this many team red-zone chances for a share to mean anything. */
export const RZ_MIN_TEAM_CHANCES = 8;
/** A role is only "lost" if he used to have at least this share. */
export const RZ_MIN_EARLIER_SHARE = 0.25;

/** Buy low: usage is strong (snap share or target share)... */
export const BUY_MIN_SNAP = 0.65;
export const BUY_MIN_TARGET_SHARE = 0.20;
/** ...and points are at most this fraction of projection, a shortfall of at least this many points. */
export const BUY_MAX_RATIO = 0.80;
export const BUY_MIN_SHORTFALL = 5;
export const MIN_PROJ_SUM = 15;

/** Sell high: points at least this multiple of projection, by at least this many points... */
export const SELL_MIN_RATIO = 1.30;
export const SELL_MIN_SURPLUS = 8;
/** ...with touchdowns at least this share of the points, and at least two of them. */
export const SELL_TD_SHARE = 0.40;
export const SELL_MIN_TDS = 2;

/** Soft schedule: next opponents allow this much more than average to his position. */
export const SOFT_FACTOR = 1.15;
export const SOFT_GAMES = 3;
export const MIN_DEF_GAMES = 3;

/** Waiver riser backtest proxy: nobody knew who was free in 2025, so use "has averaged under this". */
export const WAIVER_PROXY_MAX_AVG = 8;

/**
 * Box-count edge (RBs). A "light" box is 6 or fewer defenders, "stacked" is 8 or more.
 * Light boxes are the majority in the NFL (about 56% of runs in 2025) and stacked
 * ones rare (about 8%), so both are judged against the league average, not a fixed bar.
 * The next opponent must show light boxes this many points (as a fraction) more than average...
 */
export const LIGHT_EDGE = 0.08;
/** ...or stacked boxes this many points more than average (a smaller gap: they are rarer). */
export const STACKED_EDGE = 0.07;
/** The defence needs this many games and rushes faced before its box habits mean anything. */
export const BOX_MIN_GAMES = 3;
export const BOX_MIN_RUSHES = 50;
/** The back needs real volume (carries this season) and enough carries against the box type named. */
export const BOX_MIN_CARRIES = 25;
export const BOX_MIN_TYPE_CARRIES = 8;
export const BOX_MIN_STACKED_CARRIES = 5;

/**
 * Coverage note (WR/TE). The receiver's share of his team's targets into man coverage and into
 * zone must differ by this many points (as a fraction)...
 */
export const COV_SHARE_GAP = 0.05;
/** ...on at least this many targets against man and against zone, and the defence must play man this many
 * points more or less than the league average, over at least this many pass plays with a coverage label. */
export const COV_MIN_MAN_TARGETS = 12;
export const COV_MIN_ZONE_TARGETS = 20;
export const COV_DEF_EDGE = 0.08;
export const COV_MIN_DEF_PLAYS = 150;

/** A player is worth a take only if he has played lately and scored a little. */
export const MIN_RECENT_GAMES = 2;
export const MIN_RECENT_AVG = 4;

export const BACKTEST_SEASON = 2025;
export const BACKTEST_MIN_WEEK = 4;
/** Fewer fired takes than this and the hit rate is flagged as a small sample. */
export const SMALL_SAMPLE = 30;
/** A starter week: top 12 at QB and TE, top 24 at RB and WR. */
export const STARTER_RANK = { QB: 12, TE: 12, RB: 24, WR: 24 };
/** A bust: under half his projection. */
export const BUST_SHARE = 0.5;

/** League-wide takes shown at most (yours and the waiver wire are never cut). */
const STRENGTH_CAP = 4;
const LEAGUE_CAP = 120;
const WAIVER_CAP = 80;

// ---------------------------------------------------------------- helpers

const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const mean = (arr, f) => (arr.length ? sum(arr, f) / arr.length : 0);
const pct = (x) => `${Math.round(x * 100)}%`;
const dash = '–';

/** "weeks 3–5" or "week 4". */
export function spanLabel(recs) {
  if (!recs.length) return 'no weeks';
  const a = Math.min(...recs.map((r) => r.week));
  const b = Math.max(...recs.map((r) => r.week));
  return a === b ? `week ${a}` : `weeks ${a}${dash}${b}`;
}

const lastWeeks = (h, week, n) => h.filter((r) => r.week >= week - n && r.week < week);

// ---------------------------------------------------------------- records

/**
 * Turn loaded weeks ([{ week, stats, projections }], slimmed Sleeper rows) into
 * per-player weekly records plus the team totals and opponent facts the
 * detectors need. `scoring` is a league's settings; without it the published
 * standard-PPR points are used (the backtest, which compares to Sleeper's own
 * projections on the same scale).
 */
export function buildRecords(weeks, { scoring = null } = {}) {
  const pointsOf = (row) => (scoring
    ? scoreStats(row.stats, scoring)
    : (typeof row.ppr === 'number' ? row.ppr : scoreStats(row.stats, DEFAULT_SCORING)));
  const recTd = scoring?.rec_td ?? 6;
  const rushTd = scoring?.rush_td ?? 6;

  const team = new Map(); // `${team}|${week}` -> { tgt, rz }
  for (const wk of weeks) {
    for (const row of wk.stats) {
      if (!row.team) continue;
      const k = `${row.team}|${wk.week}`;
      const t = team.get(k) || { tgt: 0, rz: 0 };
      t.tgt += row.stats.rec_tgt || 0;
      t.rz += (row.stats.rec_rz_tgt || 0) + (row.stats.rush_rz_att || 0);
      team.set(k, t);
    }
  }

  const byPlayer = new Map();
  const opponents = new Map(); // `${team}|${week}` -> opponent (the schedule, read off the rows)
  const allowed = []; // { week, def, pos, pts }
  for (const wk of weeks) {
    const proj = new Map(wk.projections.map((p) => [p.id, p]));
    for (const row of wk.stats) {
      if (row.team && row.opp) opponents.set(`${row.team}|${wk.week}`, row.opp);
      const pts = pointsOf(row);
      if (row.opp) allowed.push({ week: wk.week, def: row.opp, pos: row.pos, pts });
      const s = row.stats;
      const t = team.get(`${row.team}|${wk.week}`) || { tgt: 0, rz: 0 };
      const pr = proj.get(row.id);
      const rec = {
        week: wk.week,
        team: row.team,
        opp: row.opp,
        snapShare: s.off_snp > 0 && s.tm_off_snp > 0 ? Math.min(1, s.off_snp / s.tm_off_snp) : null,
        tgt: s.rec_tgt || 0,
        tmTgt: t.tgt,
        rz: (s.rec_rz_tgt || 0) + (s.rush_rz_att || 0),
        tmRz: t.rz,
        tds: (s.rec_td || 0) + (s.rush_td || 0),
        tdPts: (s.rec_td || 0) * recTd + (s.rush_td || 0) * rushTd,
        pts,
        proj: pr ? pointsOf(pr) : null,
      };
      let p = byPlayer.get(row.id);
      if (!p) { p = { id: row.id, name: row.name, pos: row.pos, team: row.team, weeks: [] }; byPlayer.set(row.id, p); }
      p.team = row.team || p.team;
      p.weeks.push(rec);
    }
  }
  for (const p of byPlayer.values()) p.weeks.sort((a, b) => a.week - b.week);
  return { byPlayer, opponents, allowed };
}

/**
 * How much each defence allows to each position relative to the league
 * average, from weeks before `beforeWeek`. Map `${def}|${pos}` -> { factor, games }.
 */
export function defenseFactors(allowed, beforeWeek) {
  const per = new Map(); // `${def}|${pos}` -> Map(week -> pts)
  for (const a of allowed) {
    if (a.week >= beforeWeek) continue;
    const k = `${a.def}|${a.pos}`;
    if (!per.has(k)) per.set(k, new Map());
    const m = per.get(k);
    m.set(a.week, (m.get(a.week) || 0) + a.pts);
  }
  const avgs = new Map();
  const byPos = new Map();
  for (const [k, m] of per) {
    if (m.size < MIN_DEF_GAMES) continue;
    const avg = mean([...m.values()], (x) => x);
    avgs.set(k, { avg, games: m.size });
    const pos = k.split('|')[1];
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(avg);
  }
  const out = new Map();
  for (const [k, v] of avgs) {
    const leagueAvg = mean(byPos.get(k.split('|')[1]), (x) => x);
    if (leagueAvg > 0) out.set(k, { factor: v.avg / leagueAvg, games: v.games });
  }
  return out;
}

/** The next `n` opponents with a usable factor: [{ opp, factor, games }]. */
export function nextOpponents({ team, pos, week, oppFor, factors, n = SOFT_GAMES, horizon = 6 }) {
  const out = [];
  for (let w = week; w < week + horizon && out.length < n; w++) {
    const opp = oppFor(team, w);
    if (!opp) continue;
    const f = factors.get(`${opp}|${pos}`);
    if (f) out.push({ opp, factor: f.factor, games: f.games });
  }
  return out;
}

// ---------------------------------------------------------------- detectors

function snapView(h, week) {
  const withSnaps = h.filter((r) => r.snapShare !== null);
  const recent = withSnaps.filter((r) => r.week >= week - SPIKE_WEEKS);
  const before = withSnaps.filter((r) => r.week < week - SPIKE_WEEKS).slice(-EARLIER_GAMES_MAX);
  if (!recent.length || before.length < MIN_EARLIER_GAMES) return null;
  const r = mean(recent, (x) => x.snapShare);
  const e = mean(before, (x) => x.snapShare);
  return { recent, before, r, e, delta: r - e };
}

export function targetHog(h0, info) {
  const { pos, name, week } = info;
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const h = usageRecords(h0, info);
  const recent = lastWeeks(h, week, RECENT_WEEKS);
  if (recent.length < 2) return null;
  const tgt = sum(recent, (r) => r.tgt);
  const tm = sum(recent, (r) => r.tmTgt);
  if (!tm || tgt < HOG_MIN_TARGETS) return null;
  const share = tgt / tm;
  if (share < HOG_SHARE) return null;
  const sTgt = sum(h, (r) => r.tgt);
  const sTm = sum(h, (r) => r.tmTgt);
  return tag({
    detector: 'targetHog', tone: 'good',
    headline: `${pct(share)} of the targets go to ${name}`,
    evidence: `Target share ${pct(share)} over ${spanLabel(recent)} (${tgt} of ${tm} team targets), ${pct(sTm ? sTgt / sTm : 0)} for the season (${sTgt} targets).`,
    sample: `${tgt} targets`,
    strength: share / HOG_SHARE,
  }, info, 'tgt_share');
}

export function usageSpike(h0, info) {
  const { pos, name, week } = info;
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const h = usageRecords(h0, info);
  const v = snapView(h, week);
  if (!v || v.delta < SNAP_SHIFT || v.r < SPIKE_MIN_SNAP) return null;
  return tag({
    detector: 'usageSpike', tone: 'good',
    headline: `${name} is on the field more`,
    evidence: `${pct(v.r)} of snaps over ${spanLabel(v.recent)}, up from ${pct(v.e)} over ${spanLabel(v.before)}.`,
    sample: `${v.recent.length + v.before.length} games`,
    strength: v.delta / SNAP_SHIFT,
  }, info, 'snap_pct');
}

export function usageDrop(h0, info) {
  const { pos, name, week } = info;
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const h = usageRecords(h0, info);
  const v = snapView(h, week);
  if (!v || v.delta > -SNAP_SHIFT || v.e < DROP_MIN_EARLIER_SNAP) return null;
  return tag({
    detector: 'usageDrop', tone: 'bad',
    headline: `${name} is on the field less`,
    evidence: `${pct(v.r)} of snaps over ${spanLabel(v.recent)}, down from ${pct(v.e)} over ${spanLabel(v.before)}.`,
    sample: `${v.recent.length + v.before.length} games`,
    strength: -v.delta / SNAP_SHIFT,
  }, info, 'snap_pct');
}

function redZoneView(h, week) {
  const recent = lastWeeks(h, week, RECENT_WEEKS);
  const before = h.filter((r) => r.week < week - RECENT_WEEKS).slice(-EARLIER_GAMES_MAX);
  if (recent.length < 2 || before.length < MIN_EARLIER_GAMES) return null;
  const tmR = sum(recent, (r) => r.tmRz);
  const tmE = sum(before, (r) => r.tmRz);
  if (tmR < RZ_MIN_TEAM_CHANCES || tmE < RZ_MIN_TEAM_CHANCES) return null;
  const nR = sum(recent, (r) => r.rz);
  const nE = sum(before, (r) => r.rz);
  return { recent, before, tmR, nR, tmE, nE, r: nR / tmR, e: nE / tmE, delta: nR / tmR - nE / tmE };
}

export function redZoneUp(h0, info) {
  const { pos, name, week } = info;
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const h = usageRecords(h0, info);
  const v = redZoneView(h, week);
  if (!v || v.delta < RZ_SHIFT) return null;
  return tag({
    detector: 'redZoneUp', tone: 'good',
    headline: `${name} is getting more red-zone work`,
    evidence: `Inside-20 share ${pct(v.r)} over ${spanLabel(v.recent)} (${v.nR} of ${v.tmR} team chances), up from ${pct(v.e)}.`,
    sample: `${v.tmR} team red-zone chances`,
    strength: v.delta / RZ_SHIFT,
  }, info, 'rz_share');
}

export function redZoneDown(h0, info) {
  const { pos, name, week } = info;
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const h = usageRecords(h0, info);
  const v = redZoneView(h, week);
  if (!v || v.delta > -RZ_SHIFT || v.e < RZ_MIN_EARLIER_SHARE) return null;
  return tag({
    detector: 'redZoneDown', tone: 'bad',
    headline: `${name} is losing red-zone work`,
    evidence: `Inside-20 share ${pct(v.r)} over ${spanLabel(v.recent)} (${v.nR} of ${v.tmR} team chances), down from ${pct(v.e)}.`,
    sample: `${v.tmR} team red-zone chances`,
    strength: -v.delta / RZ_SHIFT,
  }, info, 'rz_share');
}

/** The last three games that have a projection to compare with, or null. */
function projectedRecent(h, week) {
  const recent = lastWeeks(h, week, RECENT_WEEKS).filter((r) => r.proj !== null);
  return recent.length >= 2 ? recent : null;
}

export function buyLow(h, { pos, name, week }) {
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const recent = projectedRecent(h, week);
  if (!recent) return null;
  const pts = sum(recent, (r) => r.pts);
  const proj = sum(recent, (r) => r.proj);
  if (proj < MIN_PROJ_SUM || pts / proj > BUY_MAX_RATIO || proj - pts < BUY_MIN_SHORTFALL) return null;
  const snaps = recent.filter((r) => r.snapShare !== null);
  const snap = snaps.length ? mean(snaps, (r) => r.snapShare) : null;
  const tm = sum(recent, (r) => r.tmTgt);
  const share = tm ? sum(recent, (r) => r.tgt) / tm : null;
  const bits = [];
  if (snap !== null && snap >= BUY_MIN_SNAP) bits.push(`${pct(snap)} of snaps`);
  if (share !== null && share >= BUY_MIN_TARGET_SHARE) bits.push(`${pct(share)} of team targets`);
  if (!bits.length) return null;
  return {
    detector: 'buyLow', tone: 'good',
    headline: `${name} is due: the work is there, the points are not`,
    evidence: `${bits.join(' and ')} over ${spanLabel(recent)}, but ${pts.toFixed(1)} points against ${proj.toFixed(1)} projected.`,
    sample: `${recent.length} games`,
    strength: (1 - pts / proj) / (1 - BUY_MAX_RATIO),
  };
}

export function sellHigh(h, { pos, name, week }) {
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const recent = projectedRecent(h, week);
  if (!recent) return null;
  const pts = sum(recent, (r) => r.pts);
  const proj = sum(recent, (r) => r.proj);
  const tds = sum(recent, (r) => r.tds);
  const tdPts = sum(recent, (r) => r.tdPts);
  if (proj <= 0 || pts <= 0 || pts / proj < SELL_MIN_RATIO || pts - proj < SELL_MIN_SURPLUS) return null;
  if (tds < SELL_MIN_TDS || tdPts / pts < SELL_TD_SHARE) return null;
  return {
    detector: 'sellHigh', tone: 'watch',
    headline: `${name} is running hot on touchdowns`,
    evidence: `${pts.toFixed(1)} points over ${spanLabel(recent)} against ${proj.toFixed(1)} projected, with ${tds} touchdowns making up ${pct(tdPts / pts)} of them. Touchdowns come and go.`,
    sample: `${recent.length} games, ${tds} touchdowns`,
    strength: (pts / proj) / SELL_MIN_RATIO,
  };
}

export function softSchedule(h, { pos, name, nextOpps }) {
  if (!USAGE_POSITIONS.includes(pos) && pos !== 'QB') return null;
  if (!nextOpps || nextOpps.length < 2) return null;
  const f = mean(nextOpps, (o) => o.factor);
  if (f < SOFT_FACTOR) return null;
  return {
    detector: 'softSchedule', tone: 'good',
    headline: `${name} has a soft run of games`,
    evidence: `His next ${nextOpps.length} opponents (${nextOpps.map((o) => displayTeam(o.opp)).join(', ')}) have allowed ${pct(f - 1)} more ${pos} points than the average defence.`,
    sample: `${Math.min(...nextOpps.map((o) => o.games))}+ games per defence`,
    strength: (f - 1) / (SOFT_FACTOR - 1),
  };
}

/**
 * A free agent whose role is growing. In the live feed this is a spike or a
 * target hog on someone nobody owns. The backtest cannot know who was free in
 * 2025, so it uses "had averaged under WAIVER_PROXY_MAX_AVG points" instead.
 */
export function waiverRiser(h, info) {
  if (!info.freeAgent) {
    if (!(info.backtest && h.length && mean(h, (r) => r.pts) < WAIVER_PROXY_MAX_AVG)) return null;
  }
  const base = usageSpike(h, info) || targetHog(h, info);
  if (!base) return null;
  return {
    detector: 'waiverRiser', tone: 'good',
    headline: `${info.name} is a waiver riser`,
    evidence: base.evidence,
    sample: base.sample,
    strength: base.strength,
    basedOn: base.detector,
    metric: base.metric,
    source: base.source,
  };
}

const oneDecimal = (x) => (x == null ? 'n/a' : x.toFixed(1));

/**
 * Box-count edge: does the back's next opponent show light boxes (or crowded ones)
 * much more than the average defence? Reads only weeks before `info.week`.
 */
export function boxCount(h, { pos, name, id, week, nextOpp, charting }) {
  if (pos !== 'RB' || !nextOpp || !charting?.box) return null;
  const box = charting.box;
  const lg = leagueBox(box, week);
  const def = defenseBox(box, nextOpp, week);
  const me = rusherBox(box, id, week);
  if (!lg || !def || !me) return null;
  if (def.games < BOX_MIN_GAMES || def.rush < BOX_MIN_RUSHES || me.carries < BOX_MIN_CARRIES) return null;
  const opp = displayTeam(nextOpp);
  const lightEdge = def.lightShare - lg.lightShare;
  if (lightEdge >= LIGHT_EDGE && me.lightCarries >= BOX_MIN_TYPE_CARRIES && me.lightYpc !== null
    && lg.lightYpc !== null && me.lightYpc >= lg.lightYpc) {
    return {
      detector: 'boxCount', tone: 'good',
      headline: `${name} should see light boxes against ${opp}`,
      evidence: `${opp} has shown 6 or fewer defenders in the box on ${pct(def.lightShare)} of the runs it faced (${def.light} of ${def.rush} over ${def.games} games), against ${pct(lg.lightShare)} for the average defence. ${name} has gained ${oneDecimal(me.lightYpc)} yards a carry against those fronts (${me.lightCarries} carries; league average ${oneDecimal(lg.lightYpc)}).`,
      sample: `${def.rush} runs faced by ${opp}, ${me.lightCarries} light-box carries`,
      strength: lightEdge / LIGHT_EDGE,
    };
  }
  const stackedEdge = def.stackedShare - lg.stackedShare;
  if (stackedEdge >= STACKED_EDGE && me.stackedCarries >= BOX_MIN_STACKED_CARRIES && me.stackedYpc !== null) {
    return {
      detector: 'boxCount', tone: 'watch',
      headline: `${name} may run into crowded boxes against ${opp}`,
      evidence: `${opp} has shown 8 or more defenders in the box on ${pct(def.stackedShare)} of the runs it faced (${def.stacked} of ${def.rush} over ${def.games} games), against ${pct(lg.stackedShare)} for the average defence. ${name} has gained ${oneDecimal(me.stackedYpc)} yards a carry against stacked boxes (${me.stackedCarries} carries) and ${oneDecimal(me.otherYpc)} otherwise.`,
      sample: `${def.rush} runs faced by ${opp}, ${me.stackedCarries} stacked-box carries`,
      strength: stackedEdge / STACKED_EDGE,
    };
  }
  return null;
}

/**
 * Coverage note: a receiver who gets a very different share of the targets against
 * man and against zone, meeting a defence that plays man much more or less than most.
 * Coverage labels exist for 2025 and earlier; a later season leans on last
 * season's tendencies and says so. Weeks of the same season are cut off at `week`.
 */
export function coverageNote(h, { pos, name, id, week, season, nextOpp, charting }) {
  if ((pos !== 'WR' && pos !== 'TE') || !nextOpp || !charting?.cov?.hasCoverage) return null;
  const cov = charting.cov;
  const priorSeason = season != null && cov.season < season;
  const cut = priorSeason ? Infinity : week;
  const rc = receiverCoverage(cov, id, cut);
  const dc = defenseCoverage(cov, nextOpp, cut);
  const lg = leagueCoverage(cov, cut);
  if (!rc || !dc || !lg) return null;
  if (rc.tMan < COV_MIN_MAN_TARGETS || rc.tZone < COV_MIN_ZONE_TARGETS || dc.plays < COV_MIN_DEF_PLAYS) return null;
  const gap = rc.manShare - rc.zoneShare;
  const defEdge = dc.manShare - lg.manShare;
  if (Math.abs(gap) < COV_SHARE_GAP || Math.abs(defEdge) < COV_DEF_EDGE) return null;
  const manBeater = gap > 0;
  const manHeavy = defEdge > 0;
  const fits = manBeater === manHeavy;
  const opp = displayTeam(nextOpp);
  const note = priorSeason
    ? `From ${cov.season} charting; ${season} coverage data is not published yet.`
    : `From ${cov.season} charting through week ${week - 1}.`;
  return {
    detector: 'coverageNote', tone: fits ? 'good' : 'watch',
    headline: fits
      ? `${name} is set up well against ${opp}'s ${manHeavy ? 'man' : 'zone'} coverage`
      : `${name} may struggle to get targets against ${opp}'s ${manHeavy ? 'man' : 'zone'} coverage`,
    evidence: `${name} has ${pct(rc.manShare)} of his team's targets against man coverage (${rc.tMan} targets, ${oneDecimal(rc.manYpt)} yards each) and ${pct(rc.zoneShare)} against zone (${rc.tZone} targets, ${oneDecimal(rc.zoneYpt)} yards each). ${opp} plays man on ${pct(dc.manShare)} of pass plays (${dc.plays} over ${dc.games} games), ${Math.round(Math.abs(defEdge) * 100)} points ${manHeavy ? 'more' : 'less'} than the league's ${pct(lg.manShare)}. ${note}`,
    sample: `${rc.tMan} targets vs man, ${rc.tZone} vs zone`,
    strength: Math.abs(defEdge) / COV_DEF_EDGE,
  };
}

// ---------------------------------------------------------------- usage (nflverse)
//
// The detectors below read per-game usage built from nflverse play-by-play,
// snap counts and FTN charting (src/usage). `info.usageRows` is the player's
// weekly rows (any weeks, oldest first) and `info.teamWeek` the team-week map;
// every detector cuts the rows at `info.week`, so the live feed and the
// backtest stay leak-free. Without usage, the new detectors stay quiet and the
// original three fall back to Sleeper's weekly stats.

export const SOURCE_PBP = 'nflverse play-by-play and snap counts';
export const SOURCE_FTN = 'FTN charting via nflverse';
const SOURCE_SLEEPER = 'Sleeper weekly stats';

/** Opportunity riser: WOPR (1.5 x target share + 0.7 x air-yards share) over the last games must beat his earlier games by this much... */
export const OPP_WOPR_GAIN = 0.15;
/** ...with air-yards share also up by at least this much (a fraction, so 0.03 is 3 points)... */
export const OPP_AY_GAIN = 0.03;
/** ...and land on a real role: WOPR at least this high lately, by position (a back's WOPR is small by nature). */
export const OPP_MIN_WOPR = { WR: 0.40, TE: 0.35, RB: 0.25 };

/** Touchdown regression: scored this many more than expected (sell), or this many fewer (buy). */
export const TD_SELL_GAP = 2.0;
export const TD_BUY_GAP = 1.5;
/** Both need a season sample (games) before the gap means anything. */
export const TD_MIN_GAMES = 3;
/** Buy low needs real usage lately: snap share, target share or share of team runs at least this high. */
export const TD_BUY_MIN_SNAP = 0.50;
export const TD_BUY_MIN_TGT_SHARE = 0.15;
export const TD_BUY_MIN_RUSH_SHARE = 0.30;

/** Goal-line role: this share of the team's inside-10 carries or targets over the last 3 games... */
export const GL_SHARE = 0.50;
/** ...with at least this many team inside-10 plays of that kind, and at least this many for him. */
export const GL_MIN_TEAM_PLAYS = 4;
export const GL_MIN_OWN = 2;

/** aDOT shift: average depth of target (air yards per target) moves by this many yards (recent 3 games vs earlier)... */
export const ADOT_SHIFT = 4;
/** ...on at least this many recent targets, and this many earlier ones. */
export const ADOT_MIN_RECENT_TGT = 12;
export const ADOT_MIN_EARLIER_TGT = 8;

/** End-zone targets over the last 3 games. */
export const EZ_MIN_TARGETS = 3;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const priorRows = (info) => (info?.usageRows || []).filter((r) => r.week < info.week);
const recentRows = (rows, week, n = RECENT_WEEKS) => rows.filter((r) => r.week >= week - n);
const earlierRows = (rows, week, n = RECENT_WEEKS) => rows.filter((r) => r.week < week - n).slice(-EARLIER_GAMES_MAX);
const spanOf = (rows) => spanLabel(rows);
const two = (x) => x.toFixed(2);
const tdsOfRow = (r) => num(r.rec_td) + num(r.rush_td);
const xtdOfRow = (r) => num(r.xtd_rec) + num(r.xtd_rush);

/**
 * The player's weekly records, from nflverse usage when it has any weeks
 * before the judged one, else the Sleeper-built `h`. Same shape either way
 * (snapShare, tgt, tmTgt, rz, tmRz), so the share detectors do not care.
 * Targets are over true team pass attempts and snaps over true team snaps.
 */
export function usageRecords(h, info) {
  const rows = priorRows(info);
  if (!rows.length) return h;
  return rows.map((r) => {
    const t = info.teamWeek?.get(`${r.team}|${r.week}`);
    const snap = typeof r.snap_pct === 'number' ? r.snap_pct
      : (r.tm_snaps > 0 ? Math.min(1, r.off_snaps / r.tm_snaps) : null);
    return {
      week: r.week, team: r.team, opp: r.opp,
      snapShare: snap,
      tgt: num(r.tgt), tmTgt: t ? num(t.pass_att) : 0,
      rz: num(r.rz_tgt) + num(r.rz_car), tmRz: t ? num(t.rz_pass_att) + num(t.rz_rush_att) : 0,
      tds: tdsOfRow(r), tdPts: 0, pts: 0, proj: null,
    };
  });
}

/** Stamp what a usage-aware detector read: nflverse when it had rows, Sleeper's stats otherwise. */
const tag = (res, info, metric) => (res ? { ...res, metric, source: priorRows(info).length ? SOURCE_PBP : SOURCE_SLEEPER } : null);

/** Opportunity riser (RB/WR/TE): WOPR and air-yards share both climbing. */
export function opportunityRiser(_h, info) {
  const { pos, name, week } = info;
  if (!USAGE_POSITIONS.includes(pos)) return null;
  const rows = priorRows(info).filter((r) => typeof r.wopr === 'number');
  const recent = recentRows(rows, week);
  const before = earlierRows(rows, week);
  if (recent.length < 2 || before.length < MIN_EARLIER_GAMES) return null;
  const r = mean(recent, (x) => x.wopr);
  const e = mean(before, (x) => x.wopr);
  const ar = mean(recent, (x) => num(x.ay_share));
  const ae = mean(before, (x) => num(x.ay_share));
  if (r - e < OPP_WOPR_GAIN || ar - ae < OPP_AY_GAIN || r < OPP_MIN_WOPR[pos]) return null;
  return {
    detector: 'opportunityRiser', tone: 'good', metric: 'wopr', source: SOURCE_PBP,
    headline: `${name}’s opportunity is climbing: WOPR ${two(r)} over ${spanOf(recent)}, up from ${two(e)}`,
    evidence: `Weighted opportunity rating (1.5 x target share + 0.7 x air-yards share) is ${two(r)} over ${spanOf(recent)}, up from ${two(e)} over ${spanOf(before)}. His share of the team’s air yards went from ${pct(ae)} to ${pct(ar)}.`,
    sample: `${recent.length + before.length} games`,
    strength: (r - e) / OPP_WOPR_GAIN,
  };
}

function tdBook(info) {
  const rows = priorRows(info);
  if (rows.length < TD_MIN_GAMES) return null;
  const tds = sum(rows, tdsOfRow);
  const exp = sum(rows, xtdOfRow);
  return { rows, tds, exp, gap: tds - exp };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Running hot: touchdowns well above what his chances expected. */
export function tdRegressionSell(_h, info) {
  if (!USAGE_POSITIONS.includes(info.pos)) return null;
  const b = tdBook(info);
  if (!b || b.gap < TD_SELL_GAP) return null;
  return {
    detector: 'tdRegressionSell', tone: 'watch', metric: 'td_gap', source: SOURCE_PBP,
    headline: `${info.name} is running hot: ${plural(b.tds, 'touchdown')} on ${b.exp.toFixed(1)} expected`,
    evidence: `${plural(b.tds, 'touchdown')} in ${b.rows.length} games against ${b.exp.toFixed(1)} expected from where his targets and carries came (${b.gap.toFixed(1)} more than expected). Scoring that far above the chances tends to cool.`,
    sample: `${b.rows.length} games, ${plural(b.tds, 'touchdown')}`,
    strength: b.gap / TD_SELL_GAP,
  };
}

/** Due: touchdowns well below expected, on solid usage. */
export function tdRegressionBuy(_h, info) {
  if (!USAGE_POSITIONS.includes(info.pos)) return null;
  const b = tdBook(info);
  if (!b || -b.gap < TD_BUY_GAP) return null;
  const recent = recentRows(b.rows, info.week);
  if (recent.length < MIN_RECENT_GAMES) return null;
  const snap = mean(recent, (r) => num(r.snap_pct));
  const tgt = mean(recent, (r) => num(r.tgt_share));
  const run = mean(recent, (r) => num(r.rush_share));
  const bits = [];
  if (snap >= TD_BUY_MIN_SNAP) bits.push(`${pct(snap)} of snaps`);
  if (tgt >= TD_BUY_MIN_TGT_SHARE) bits.push(`${pct(tgt)} of team targets`);
  if (run >= TD_BUY_MIN_RUSH_SHARE) bits.push(`${pct(run)} of team runs`);
  if (!bits.length) return null;
  return {
    detector: 'tdRegressionBuy', tone: 'good', metric: 'td_gap', source: SOURCE_PBP,
    headline: `${info.name} is due: ${plural(b.tds, 'touchdown')} on ${b.exp.toFixed(1)} expected`,
    evidence: `${plural(b.tds, 'touchdown')} in ${b.rows.length} games against ${b.exp.toFixed(1)} expected (${(-b.gap).toFixed(1)} fewer), with ${bits.join(' and ')} over ${spanOf(recent)}. The work is there; the scores have not followed yet.`,
    sample: `${b.rows.length} games, ${plural(b.tds, 'touchdown')}`,
    strength: -b.gap / TD_BUY_GAP,
  };
}

/** Owns the goal line: half or more of the team's inside-10 carries or targets lately. */
export function goalLineRole(_h, info) {
  if (!USAGE_POSITIONS.includes(info.pos)) return null;
  const rows = priorRows(info);
  const recent = recentRows(rows, info.week);
  if (recent.length < MIN_RECENT_GAMES) return null;
  const tw = (r) => info.teamWeek?.get(`${r.team}|${r.week}`);
  const kinds = [
    { own: sum(recent, (r) => r.i10_car), team: sum(recent, (r) => num(tw(r)?.i10_rush_att)), noun: 'carries' },
    { own: sum(recent, (r) => r.i10_tgt), team: sum(recent, (r) => num(tw(r)?.i10_pass_att)), noun: 'targets' },
  ].filter((k) => k.team >= GL_MIN_TEAM_PLAYS && k.own >= GL_MIN_OWN && k.own / k.team >= GL_SHARE);
  if (!kinds.length) return null;
  const best = kinds.sort((a, b) => b.own / b.team - a.own / a.team)[0];
  const share = best.own / best.team;
  return {
    detector: 'goalLineRole', tone: 'good', source: SOURCE_PBP,
    metric: best.noun === 'carries' ? 'i10_car_share' : 'i10_tgt_share',
    headline: `${info.name} owns the goal line: ${pct(share)} of the team’s inside-10 ${best.noun}`,
    evidence: `${best.own} of the team’s ${best.team} inside-10 ${best.noun} over ${spanOf(recent)} (${pct(share)}).`,
    sample: `${best.team} team inside-10 ${best.noun}`,
    strength: share / GL_SHARE,
  };
}

function adotView(info) {
  const rows = priorRows(info);
  const recent = recentRows(rows, info.week);
  const before = earlierRows(rows, info.week);
  const tr = sum(recent, (r) => r.tgt);
  const te = sum(before, (r) => r.tgt);
  if (recent.length < 2 || tr < ADOT_MIN_RECENT_TGT || te < ADOT_MIN_EARLIER_TGT) return null;
  const r = sum(recent, (x) => num(x.air_yds)) / tr;
  const e = sum(before, (x) => num(x.air_yds)) / te;
  return { recent, before, tr, te, r, e, delta: r - e };
}

/** Deep role: aDOT (air yards per target) up by 4+ yards. */
export function deepRole(_h, info) {
  if (info.pos !== 'WR' && info.pos !== 'TE') return null;
  const v = adotView(info);
  if (!v || v.delta < ADOT_SHIFT) return null;
  return {
    detector: 'deepRole', tone: 'good', metric: 'adot', source: SOURCE_PBP,
    headline: `${info.name} is being used deeper: ${v.r.toFixed(1)} yards per target, up from ${v.e.toFixed(1)}`,
    evidence: `Average depth of target ${v.r.toFixed(1)} yards over ${spanOf(v.recent)} (${v.tr} targets), up from ${v.e.toFixed(1)} over ${spanOf(v.before)} (${v.te} targets). Deeper targets bring bigger plays and bigger swings.`,
    sample: `${v.tr} recent targets`,
    strength: v.delta / ADOT_SHIFT,
  };
}

/** Underneath role: aDOT down by 4+ yards. */
export function underneathRole(_h, info) {
  if (info.pos !== 'WR' && info.pos !== 'TE') return null;
  const v = adotView(info);
  if (!v || -v.delta < ADOT_SHIFT) return null;
  return {
    detector: 'underneathRole', tone: 'watch', metric: 'adot', source: SOURCE_PBP,
    headline: `${info.name} is being used shallower: ${v.r.toFixed(1)} yards per target, down from ${v.e.toFixed(1)}`,
    evidence: `Average depth of target ${v.r.toFixed(1)} yards over ${spanOf(v.recent)} (${v.tr} targets), down from ${v.e.toFixed(1)} over ${spanOf(v.before)} (${v.te} targets). Shorter targets mean fewer big plays.`,
    sample: `${v.tr} recent targets`,
    strength: -v.delta / ADOT_SHIFT,
  };
}

/** End-zone targets: 3+ over the last 3 games. */
export function endZoneTargets(_h, info) {
  if (!USAGE_POSITIONS.includes(info.pos)) return null;
  const recent = recentRows(priorRows(info), info.week);
  if (recent.length < MIN_RECENT_GAMES) return null;
  const ez = sum(recent, (r) => r.ez_tgt);
  if (ez < EZ_MIN_TARGETS) return null;
  return {
    detector: 'endZoneTargets', tone: 'good', metric: 'ez_tgt', source: SOURCE_PBP,
    headline: `${info.name} has ${ez} end-zone targets in ${plural(recent.length, 'game')}`,
    evidence: `${ez} targets caught or thrown at or past the goal line over ${spanOf(recent)}, out of ${sum(recent, (r) => r.tgt)} total targets.`,
    sample: `${ez} end-zone targets`,
    strength: ez / EZ_MIN_TARGETS,
  };
}

// ---------------------------------------------------------------- practice reports
//
// nflverse publishes the injury report's practice status for each player and
// week. `info.practice` is that player's Map of week -> 'dnp' | 'limited' |
// 'full' for the weeks up to and including the one being judged (the report
// for week W is filed before week W's kickoff, so a manager has it in hand).
// A move between the last report and this one is the news: a player who was
// out of practice and is now full, or the reverse.

export const SOURCE_PRACTICE = 'NFL injury reports via nflverse';
/** How many weeks back the earlier report may be (2 covers a bye week). */
export const PRACTICE_LOOKBACK = 2;

/** 'Did Not Participate In Practice' -> 'dnp', and so on; anything else null. */
export function practiceLevel(status) {
  const s = String(status || '').toLowerCase();
  if (s.startsWith('did not')) return 'dnp';
  if (s.startsWith('limited')) return 'limited';
  if (s.startsWith('full')) return 'full';
  return null;
}

/** Map sleeperId -> Map(week -> level) from parsed injuries ({ byWeek }) and the gsis crosswalk. */
export function practiceIndex(injuries, gsisToSleeper) {
  const out = new Map();
  if (!injuries?.available || !gsisToSleeper) return out;
  for (const [key, e] of injuries.byWeek) {
    const level = practiceLevel(e.practiceStatus);
    const sid = gsisToSleeper.get(key.slice(key.indexOf('|') + 1));
    if (!level || !sid) continue;
    let m = out.get(sid);
    if (!m) out.set(sid, (m = new Map()));
    m.set(e.week, level);
  }
  return out;
}

function practiceMove(info) {
  const pr = info?.practice;
  if (!pr || !pr.has(info.week)) return null;
  for (let back = 1; back <= PRACTICE_LOOKBACK; back++) {
    if (pr.has(info.week - back)) return { before: pr.get(info.week - back), now: pr.get(info.week), beforeWeek: info.week - back };
  }
  return null;
}

/** Back to full practice after a week of not practising at all. */
export function practiceBack(_h, info) {
  const m = practiceMove(info);
  if (!m || m.before !== 'dnp' || m.now !== 'full') return null;
  return {
    detector: 'practiceBack', tone: 'good', metric: 'practice', source: SOURCE_PRACTICE,
    headline: `${info.name} is back to full practice after sitting out in week ${m.beforeWeek}`,
    evidence: `The injury report has him as a full participant in week ${info.week}, after a did-not-participate in week ${m.beforeWeek}.`,
    sample: `weeks ${m.beforeWeek}${dash}${info.week}`,
    strength: 1.5,
  };
}

/** Practice downgraded to nothing after a full or limited week. */
export function practiceDowngrade(_h, info) {
  const m = practiceMove(info);
  if (!m || m.now !== 'dnp' || (m.before !== 'full' && m.before !== 'limited')) return null;
  return {
    detector: 'practiceDowngrade', tone: 'bad', metric: 'practice', source: SOURCE_PRACTICE,
    headline: `${info.name} did not practise in week ${info.week} after a ${m.before === 'full' ? 'full' : 'limited'} week`,
    evidence: `The injury report has him as did-not-participate in week ${info.week}, after ${m.before === 'full' ? 'full' : 'limited'} participation in week ${m.beforeWeek}. A step down in practice is a warning to check his status before lineups lock.`,
    sample: `weeks ${m.beforeWeek}${dash}${info.week}`,
    strength: 1.5,
  };
}

/** Every detector, in the order the feed lists them. */
export const DETECTORS = [
  { key: 'targetHog', label: 'Target hog', tone: 'good', fn: targetHog },
  { key: 'usageSpike', label: 'Usage spike', tone: 'good', fn: usageSpike },
  { key: 'usageDrop', label: 'Usage drop', tone: 'bad', fn: usageDrop },
  { key: 'redZoneUp', label: 'Red-zone role up', tone: 'good', fn: redZoneUp },
  { key: 'redZoneDown', label: 'Red-zone role down', tone: 'bad', fn: redZoneDown },
  { key: 'buyLow', label: 'Buy low', tone: 'good', fn: buyLow },
  { key: 'sellHigh', label: 'Sell high', tone: 'watch', fn: sellHigh },
  { key: 'softSchedule', label: 'Soft schedule', tone: 'good', fn: softSchedule },
  { key: 'waiverRiser', label: 'Waiver riser', tone: 'good', fn: waiverRiser },
  { key: 'opportunityRiser', label: 'Opportunity riser', tone: 'good', fn: opportunityRiser, sources: [SOURCE_PBP] },
  { key: 'tdRegressionSell', label: 'Touchdowns running hot', tone: 'watch', fn: tdRegressionSell, sources: [SOURCE_PBP] },
  { key: 'tdRegressionBuy', label: 'Touchdowns due', tone: 'good', fn: tdRegressionBuy, sources: [SOURCE_PBP] },
  { key: 'goalLineRole', label: 'Goal-line role', tone: 'good', fn: goalLineRole, sources: [SOURCE_PBP] },
  { key: 'deepRole', label: 'Deeper role (aDOT up)', tone: 'good', fn: deepRole, sources: [SOURCE_PBP] },
  { key: 'underneathRole', label: 'Shallower role (aDOT down)', tone: 'watch', fn: underneathRole, sources: [SOURCE_PBP] },
  { key: 'endZoneTargets', label: 'End-zone targets', tone: 'good', fn: endZoneTargets, sources: [SOURCE_PBP] },
  { key: 'practiceBack', label: 'Back to full practice', tone: 'good', fn: practiceBack, sources: [SOURCE_PRACTICE] },
  { key: 'practiceDowngrade', label: 'Practice downgraded', tone: 'bad', fn: practiceDowngrade, sources: [SOURCE_PRACTICE] },
  {
    key: 'boxCount', label: 'Box-count edge', tone: 'good', fn: boxCount, needs: 'box',
    sources: ['FTN charting via nflverse', 'nflverse play-by-play'],
  },
  {
    key: 'coverageNote', label: 'Coverage note', tone: 'watch', fn: coverageNote, needs: 'cov',
    sources: ['FTN charting via nflverse', 'nflverse play-by-play', `NFL Next Gen Stats participation via nflverse (${COVERAGE_LAST_SEASON})`],
  },
];

/** Has he played lately and scored enough to be worth a sentence? */
export function relevant(h, week) {
  const recent = lastWeeks(h, week, RECENT_WEEKS);
  return recent.length >= MIN_RECENT_GAMES && mean(recent, (r) => r.pts) >= MIN_RECENT_AVG;
}

// ---------------------------------------------------------------- backtest

const BASE_POS = [...USAGE_POSITIONS, 'QB'];

/**
 * Replay every detector week by week over `weeks` using only earlier weeks.
 * A take "hits" when the player's actual points beat Sleeper's projection for
 * that week (a projected player who did not play scores zero, so a miss).
 * The baseline is the same measure over all comparable players: the ones who
 * fit `relevant`, at the same positions, whether or not a take fired.
 * Returns { weeks, detectors: { key: { n, hits, hitRate, baseline, small } } }.
 */
export function runBacktest(weeks, { minWeek = BACKTEST_MIN_WEEK, charting = null, season = BACKTEST_SEASON, usage = null, practice = null } = {}) {
  const hasUsage = Boolean(usage?.available);
  const recs = buildRecords(weeks);
  const oppFor = (team, w) => recs.opponents.get(`${team}|${w}`) || null;
  const basePos = {};
  const acc = Object.fromEntries(DETECTORS.map((d) => [d.key, { n: 0, hits: 0, pts: 0, top: 0, bust: 0, byPos: {} }]));

  for (const wk of weeks) {
    if (wk.week < minWeek) continue;
    const factors = defenseFactors(recs.allowed, wk.week);
    const actual = new Map(wk.stats.map((r) => [r.id, r]));
    const scored = (id) => {
      const a = actual.get(id);
      return a ? (typeof a.ppr === 'number' ? a.ppr : scoreStats(a.stats, DEFAULT_SCORING)) : 0;
    };
    // Where each player finished at his position that week: a "starter week"
    // is top 12 at QB and TE, top 24 at RB and WR (a 12-team league's starters).
    const rankOf = new Map();
    const byPos = {};
    for (const p of wk.projections) if (BASE_POS.includes(p.pos)) (byPos[p.pos] ||= []).push([p.id, scored(p.id)]);
    for (const list of Object.values(byPos)) list.sort((a, b) => b[1] - a[1]).forEach(([id], i) => rankOf.set(id, i + 1));
    for (const p of wk.projections) {
      if (!BASE_POS.includes(p.pos)) continue;
      const rec = recs.byPlayer.get(p.id);
      const h = rec ? rec.weeks.filter((r) => r.week < wk.week) : [];
      if (!relevant(h, wk.week)) continue;
      const got = scored(p.id);
      const hit = got > p.ppr ? 1 : 0;
      const top = (rankOf.get(p.id) || 999) <= STARTER_RANK[p.pos] ? 1 : 0;
      const bust = got < BUST_SHARE * p.ppr ? 1 : 0;
      const bp = (basePos[p.pos] ||= { n: 0, hits: 0, pts: 0, top: 0, bust: 0 });
      bp.n++; bp.hits += hit; bp.pts += got; bp.top += top; bp.bust += bust;
      const team = p.team || rec?.team;
      const info = {
        id: p.id, pos: p.pos, name: p.name, week: wk.week, season, backtest: true, freeAgent: false,
        charting, nextOpp: oppFor(team, wk.week),
        practice: practice?.get(p.id) || null,
        usageRows: hasUsage ? usage.weeksOf(p.id) : [], teamWeek: hasUsage ? usage.teamWeek : null,
        nextOpps: nextOpponents({ team, pos: p.pos, week: wk.week, oppFor, factors }),
      };
      for (const d of DETECTORS) {
        if (!d.fn(h, info)) continue;
        const s = acc[d.key];
        s.n++; s.hits += hit; s.pts += got; s.top += top; s.bust += bust;
        const sp = (s.byPos[p.pos] ||= { n: 0, hits: 0 });
        sp.n++; sp.hits += hit;
      }
    }
  }

  const rate = (x) => (x && x.n ? x.hits / x.n : null);
  const detectors = {};
  for (const d of DETECTORS) {
    const s = acc[d.key];
    // Baseline weighted to the positions this detector actually fired on.
    let exp = 0; let expPts = 0; let expTop = 0; let expBust = 0;
    for (const [pos, v] of Object.entries(s.byPos)) {
      const b = basePos[pos];
      if (!b?.n) continue;
      exp += v.n * (b.hits / b.n); expPts += v.n * (b.pts / b.n);
      expTop += v.n * (b.top / b.n); expBust += v.n * (b.bust / b.n);
    }
    const per = (x) => (s.n ? round2(x / s.n) : null);
    detectors[d.key] = {
      n: s.n,
      hits: s.hits,
      hitRate: s.n ? s.hits / s.n : null,
      baseline: s.n ? exp / s.n : null,
      // Beyond "beat his projection": how much the players scored, how often
      // they had a starter week, and how often they busted (under half their
      // projection), each against other active players at the same positions.
      pts: per(s.pts), basePts: per(expPts),
      topRate: per(s.top), baseTop: per(expTop),
      bustRate: per(s.bust), baseBust: per(expBust),
      small: s.n < SMALL_SAMPLE,
    };
  }
  return { season: null, usage: hasUsage, weeks: weeks.map((w) => w.week), detectors };
}

/**
 * Charting for the detectors that need it: { box, cov, errors }. `box` is the
 * box-count season (the one being judged), `cov` the coverage season (the
 * latest with coverage labels). Each fails on its own: a missing file leaves
 * that index null and the other detector working.
 */
export async function loadCharting(season, { gsisToSleeper = null, loader = getSeasonCharting } = {}) {
  const errors = {};
  let map = gsisToSleeper;
  if (!map) {
    try { map = (await getCrosswalk()).gsisToSleeper; } catch (err) { errors.ids = err.message; }
  }
  const attempt = async (key, s) => {
    if (!map) return null;
    try { return indexSummary(await loader(s), map); } catch (err) {
      console.warn(`[takes] charting ${key} (${s}) unavailable: ${err.message}`);
      errors[key] = err.message;
      return null;
    }
  };
  const covSeason = Math.min(season, COVERAGE_LAST_SEASON);
  const [box, cov] = await Promise.all([attempt('box', season), covSeason === season ? null : attempt('cov', covSeason)]);
  const same = covSeason === season;
  return { box, cov: same ? (box?.hasCoverage ? box : null) : cov, errors };
}

/** A season's practice index (sleeper id -> week -> level), or null when the injury file or crosswalk is missing. */
export async function loadPractice(season, { gsisToSleeper = null, loader = getInjuries } = {}) {
  try {
    const map = gsisToSleeper || (await getCrosswalk()).gsisToSleeper;
    const inj = await loader(season);
    return inj?.available ? practiceIndex(inj, map) : null;
  } catch (err) {
    console.warn(`[takes] practice reports (${season}) unavailable: ${err.message}`);
    return null;
  }
}

const BACKTEST_TTL = 30 * 24 * 60 * 60_000;
let backtestMemo = null;

/** Load a season's weeks from the cache (soft: a missing week is skipped). */
export async function loadSeasonWeeks(season, weekNumbers, { loadWeekFn = loadWeek, concurrency = 6 } = {}) {
  const out = [];
  const missing = [];
  let next = 0;
  const worker = async () => {
    while (next < weekNumbers.length) {
      const week = weekNumbers[next++];
      try {
        const [stats, projections] = await Promise.all([
          loadWeekFn('stats', season, week),
          loadWeekFn('projections', season, week),
        ]);
        out.push({ week, stats, projections });
      } catch (err) {
        missing.push({ week, error: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  out.sort((a, b) => a.week - b.week);
  return { weeks: out, missing };
}

/**
 * The backtest for BACKTEST_SEASON, computed once: kept in memory and in the
 * file cache for a month (a finished season never changes). Resolves to null
 * when too little of the season could be loaded.
 */
export function getBacktest({ loadWeekFn = loadWeek, season = BACKTEST_SEASON, force = false, charting, usage, practice } = {}) {
  if (backtestMemo && !force) return backtestMemo;
  const run = async () => {
    const all = Array.from({ length: 18 }, (_, i) => i + 1);
    const { weeks } = await loadSeasonWeeks(season, all, { loadWeekFn });
    if (weeks.length < BACKTEST_MIN_WEEK + 4) throw new Error(`Only ${weeks.length} weeks of ${season} could be loaded.`);
    const ch = charting !== undefined ? charting : await loadCharting(season);
    const us = usage !== undefined ? usage : await loadUsage(season).catch(() => null);
    const pr = practice !== undefined ? practice : await loadPractice(season);
    return { ch, us, pr, result: { ...runBacktest(weeks, { charting: ch, season, usage: us, practice: pr }), season } };
  };
  // Cached for a month, but only when the charting and usage loaded: a run without
  // them would pin "no data" for those detectors for a month.
  const p = (async () => {
    const key = `takes:backtest:v5:${season}`;
    const hit = await cacheGet(key, BACKTEST_TTL);
    if (hit && !hit.stale) return hit.value;
    const { ch, us, pr, result } = await run();
    if ((ch === null || (ch.box && ch.cov)) && us?.available && pr) await cacheSet(key, result);
    else console.warn('[takes] charting or usage incomplete; backtest not cached');
    return result;
  })().catch(async (err) => {
    backtestMemo = null; // never keep a failure
    console.warn(`[takes] backtest unavailable: ${err.message}`);
    const stale = await cacheGet(`takes:backtest:v5:${season}`, BACKTEST_TTL);
    return stale ? stale.value : null;
  });
  backtestMemo = p;
  return p;
}

export function resetBacktest() { backtestMemo = null; }

const backtestOf = (bt, key) => {
  const d = bt?.detectors?.[key];
  if (!d || !d.n) return null;
  return {
    hitRate: d.hitRate, baseline: d.baseline, n: d.n, small: d.small, season: bt.season,
    pts: d.pts ?? null, basePts: d.basePts ?? null, topRate: d.topRate ?? null, baseTop: d.baseTop ?? null,
    bustRate: d.bustRate ?? null, baseBust: d.baseBust ?? null,
  };
};

// ---------------------------------------------------------------- the report

const SOURCES = ['Sleeper weekly stats', 'Sleeper projections'];
export const CHARTING_UNAVAILABLE = 'Charting data unavailable right now';

const SUPERFLEX_SLOTS = new Set(['SUPER_FLEX', 'QB_FLEX']);
const FLEX_SLOTS = new Set(['FLEX', 'WRT', 'WRRB_FLEX', 'REC_FLEX']);

function whyItMatters(ctx, id, scope, startersList, slots) {
  if (scope === 'waiver') return 'He’s a free agent in your league.';
  if (scope === 'league') {
    const rid = ctx.ownerOf.get(id);
    const name = rid != null && ctx.rosterOf(rid) ? ctx.teamName(ctx.rosterOf(rid)) : null;
    return name ? `Owned by ${name}.` : 'Owned by another team in your league.';
  }
  const i = startersList.indexOf(id);
  const bye = ctx.onByeThisWeek?.(id) ? ' He’s on bye, though.' : '';
  if (i >= 0) {
    const slot = slots[i] || 'a starting spot';
    if (SUPERFLEX_SLOTS.has(slot)) return `He’s in your superflex this week.${bye}`;
    if (FLEX_SLOTS.has(slot)) return `He’s in your flex this week.${bye}`;
    return `He’s starting for you at ${slotLabel(slot)} this week.${bye}`;
  }
  return `He’s on your bench.${bye}`;
}

/**
 * The feed for a league. `opts.loadWeekFn` and `opts.backtest` are for tests.
 */
export async function takesReport(ctx, opts = {}) {
  const loadWeekFn = opts.loadWeekFn || loadWeek;
  const wanted = (ctx.completedWeeks?.length ? ctx.completedWeeks : Array.from({ length: Math.max(0, ctx.week - 1) }, (_, i) => i + 1));
  const [{ weeks, missing }, bt, charting, usage, practice] = await Promise.all([
    loadSeasonWeeks(ctx.season, wanted, { loadWeekFn }),
    // A test's fake loader must never write the shared backtest cache.
    opts.backtest !== undefined ? opts.backtest : (opts.loadWeekFn ? null : getBacktest()),
    // Same for charting: tests inject it, and a failed load only disables the detectors that need it.
    opts.charting !== undefined ? opts.charting
      : (opts.loadWeekFn ? null : loadCharting(ctx.season, { gsisToSleeper: ctx.idMaps?.gsisToSleeper || null })),
    // nflverse usage: injected by tests; a failed or missing load leaves the Sleeper fallback.
    opts.usage !== undefined ? opts.usage
      : (opts.loadWeekFn ? null : loadUsage(Number(ctx.season)).catch(() => null)),
    // Practice reports: injected by tests; unavailable leaves the two practice detectors quiet.
    opts.practice !== undefined ? opts.practice
      : (opts.loadWeekFn ? null : loadPractice(Number(ctx.season), { gsisToSleeper: ctx.idMaps?.gsisToSleeper || null })),
  ]);
  const hasUsage = Boolean(usage?.available);
  const chartingFor = { box: charting?.box || null, cov: charting?.cov || null };

  const recs = buildRecords(weeks, { scoring: ctx.scoring });
  const factors = defenseFactors(recs.allowed, ctx.week);
  const oppFor = (team, w) => ctx.schedule?.gameFor?.(team, w)?.opponent || null;
  const mineId = ctx.myRoster?.roster_id;
  const startersList = mineId != null ? setStarters(ctx, mineId) : [];
  const slots = startingSlots(ctx.rosterPositions || []);

  const takes = [];
  for (const rec of recs.byPlayer.values()) {
    if (!USAGE_POSITIONS.includes(rec.pos) && rec.pos !== 'QB') continue;
    const player = ctx.playerOf(rec.id);
    if (!player) continue;
    const h = rec.weeks;
    if (!relevant(h, ctx.week)) continue;
    const owner = ctx.ownerOf.get(rec.id);
    const scope = owner == null ? 'waiver' : (mineId != null && String(owner) === String(mineId) ? 'mine' : 'league');
    const team = player.team || rec.team;
    const info = {
      id: rec.id, name: player.name || rec.name, pos: rec.pos, week: ctx.week,
      freeAgent: scope === 'waiver', season: ctx.season, charting: chartingFor,
      nextOpp: oppFor(team, ctx.week),
      nextOpps: nextOpponents({ team, pos: rec.pos, week: ctx.week, oppFor, factors }),
      practice: practice?.get(rec.id) || null,
      usageRows: hasUsage ? usage.weeksOf(rec.id) : [], teamWeek: hasUsage ? usage.teamWeek : null,
    };
    const fired = DETECTORS.map((d) => ({ d, res: d.fn(h, info) })).filter((x) => x.res);
    // A free agent's spike or target hog is one story: the waiver riser.
    const riser = fired.some((x) => x.d.key === 'waiverRiser');
    for (const { d, res } of fired) {
      if (riser && (d.key === 'usageSpike' || d.key === 'targetHog')) continue;
      takes.push({
        id: `${d.key}:${rec.id}`,
        detector: d.key,
        tone: res.tone,
        playerId: rec.id,
        name: info.name,
        pos: rec.pos,
        team: displayTeam(team),
        headline: res.headline,
        evidence: res.evidence,
        sample: res.sample,
        backtest: backtestOf(bt, d.key),
        scope,
        whyItMatters: whyItMatters(ctx, rec.id, scope, startersList, slots),
        // Usage takes name what they read (nflverse, or Sleeper's stats when usage was missing).
        sources: res.source ? [res.source, ...(d.sources || []).filter((x) => x !== res.source)] : (d.sources ? [...SOURCES, ...d.sources] : SOURCES),
        metric: res.metric || null,
        source: res.source || d.sources?.[0] || SOURCE_SLEEPER,
        // Capped so one wild ratio cannot bury every other take.
        strength: round2(Math.min(res.strength, STRENGTH_CAP)),
      });
    }
  }

  takes.sort((a, b) => (a.scope === 'mine' ? 0 : 1) - (b.scope === 'mine' ? 0 : 1) || b.strength - a.strength);
  const kept = [];
  const seen = { waiver: 0, league: 0 };
  for (const t of takes) {
    if (t.scope === 'mine') { kept.push(t); continue; }
    const cap = t.scope === 'waiver' ? WAIVER_CAP : LEAGUE_CAP;
    if (seen[t.scope] < cap) { seen[t.scope]++; kept.push(t); }
  }

  const counts = {};
  for (const t of kept) counts[t.detector] = (counts[t.detector] || 0) + 1;

  return {
    week: ctx.week,
    dataThrough: weeks.length ? Math.max(...weeks.map((w) => w.week)) : null,
    missingWeeks: missing.map((m) => m.week),
    backtestSeason: bt?.season ?? BACKTEST_SEASON,
    backtestAvailable: Boolean(bt),
    usageAvailable: hasUsage,
    takes: kept,
    detectors: DETECTORS.map((d) => ({
      key: d.key, label: d.label, tone: d.tone,
      count: counts[d.key] || 0,
      // The charting files could not be read, so this detector could not run.
      unavailable: Boolean(d.needs && !chartingFor[d.needs]),
      note: d.needs && !chartingFor[d.needs] ? CHARTING_UNAVAILABLE : null,
      backtest: backtestOf(bt, d.key),
    })),
  };
}
