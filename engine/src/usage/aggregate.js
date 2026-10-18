// Per player-week usage from play-by-play, FTN charting and snap counts, plus
// team-week tables and last season's route/coverage splits. Pure functions
// over already-parsed rows, so every rate here is unit-testable by hand.
//
// Definitions (shown on the methods page):
//   snap_pct      offensive snaps / team offensive snaps
//   tgt_share     targets / team pass attempts (sacks excluded, throwaways included)
//   ay_share      air yards on his targets / team air yards on all pass attempts
//   wopr          1.5 x tgt_share + 0.7 x ay_share
//   rush_share    carries / team runs (QB runs included)
//   rz_*, i10_*   the same inside the opponent's 20 and 10
//   ez_tgt        targets whose catch spot is at or past the goal line
//   xtd_*         expected touchdowns from a field-position model fit on last season
//   box splits    FTN defenders in the box: light 6 or fewer, stacked 8 or more
//
// Quarterback usage (added columns, same player-week rows):
//   qb_db         his dropbacks: pass attempts and sacks (nflverse passer id) plus his scrambles
//                 (a scramble has no passer id in nflverse; the runner is the quarterback)
//   qb_scrambles  dropbacks that became a scramble (nflverse qb_scramble)
//   designed_runs rush attempts by a quarterback that are not scrambles (kneel-downs are not plays here)
//   qb_sacks      sacks taken; qb_hits his dropbacks flagged qb_hit (sacks are usually flagged too)
//   qb_press      dropbacks with a sack or a qb_hit: the plays he was pressured on
//   pa_db         dropbacks FTN charted as play-action; qb_ftn_db the dropbacks FTN charted at all
//   rates         pressure_to_sack = qb_sacks / qb_press; scramble_rate = qb_scrambles / qb_db;
//                 sack_rate = qb_sacks / qb_db; pa_rate = pa_db / qb_ftn_db;
//                 designed_run_share = designed_runs / (team rush attempts - team scrambles)

export const LIGHT_BOX_MAX = 6;
export const STACKED_BOX_MIN = 8;
export const LAST_REGULAR_WEEK = 18;

export const WEEKLY_COUNTS = [
  'off_snaps', 'tm_snaps', 'tgt', 'rec', 'rec_yds', 'rec_td', 'air_yds',
  'catchable_tgt', 'catchable_rec', 'drops', 'ftn_tgt', 'rz_tgt', 'i10_tgt', 'ez_tgt',
  'car', 'rush_yds', 'rush_td', 'rz_car', 'i10_car', 'box_car', 'stk_car', 'stk_yds', 'lgt_car', 'lgt_yds',
  'bl_tgt', 'bl_rec', 'bl_yds', 'nbl_tgt', 'nbl_rec', 'nbl_yds', 'pa_tgt', 'scr_tgt', 'cont_tgt', 'cont_rec',
  'xtd_rec', 'xtd_rush',
  'qb_db', 'qb_scrambles', 'designed_runs', 'qb_sacks', 'qb_hits', 'qb_press', 'pa_db', 'qb_ftn_db',
];
export const SHARES = ['snap_pct', 'tgt_share', 'ay_share', 'wopr', 'rush_share', 'rz_tgt_share', 'i10_tgt_share', 'rz_car_share', 'i10_car_share', 'designed_run_share'];
export const SEASON_RATES = ['adot', 'ypt', 'catch_rate', 'drop_rate', 'ypc', 'ypc_stk', 'ypc_lgt', 'tgt_per_snap', 'ypt_bl', 'ypt_nbl', 'pa_share', 'scr_share', 'cont_rate', 'td_gap',
  'pressure_to_sack', 'scramble_rate', 'sack_rate', 'pa_rate'];
export const TEAM_COLS = [
  'off_snaps', 'pass_att', 'rush_att', 'air_yds', 'rz_pass_att', 'i10_pass_att', 'rz_rush_att', 'i10_rush_att', 'dropbacks',
  'def_db', 'def_blitz', 'def_blitz_rate', 'def_box_car', 'def_light_car', 'def_light_rate', 'def_stk_car', 'def_stk_rate',
  'def_mz_db', 'def_man', 'def_man_rate',
  'sacks', 'scrambles', 'def_sacks',
];

const num = (v) => { if (v === '' || v === null || v === undefined || v === 'NA') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const flag = (v) => v === '1' || v === 1 || v === 'TRUE' || v === 'true' || v === true;
const ratio = (a, b, d = 3) => (b > 0 ? +(a / b).toFixed(d) : null);

// ---------------------------------------------------------------- xTD model

/** Field-position bins (yards from the goal line) for the touchdown model. */
const XTD_BINS = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 60, 100];
export const xtdBin = (yl) => XTD_BINS.findIndex((b) => yl <= b);

/** Fit P(touchdown) by bin for targets and carries from last season's plays. */
export function fitXtd(plays) {
  const acc = { tgt: XTD_BINS.map(() => [0, 0]), car: XTD_BINS.map(() => [0, 0]) };
  for (const p of plays) {
    if (p.yl == null) continue;
    const b = xtdBin(p.yl);
    if (b < 0) continue;
    if (p.pass && p.receiver) { acc.tgt[b][0]++; acc.tgt[b][1] += p.recTd ? 1 : 0; }
    if (p.run && p.rusher) { acc.car[b][0]++; acc.car[b][1] += p.rushTd ? 1 : 0; }
  }
  const rate = (arr) => arr.map(([n, k]) => (n > 0 ? +(k / n).toFixed(4) : 0));
  return { bins: XTD_BINS, tgt: rate(acc.tgt), car: rate(acc.car), n: { tgt: acc.tgt.reduce((s, [n]) => s + n, 0), car: acc.car.reduce((s, [n]) => s + n, 0) } };
}

export const xtdOf = (model, kind, yl) => {
  if (!model || yl == null) return 0;
  const b = xtdBin(yl);
  return b < 0 ? 0 : model[kind][b] || 0;
};

// ---------------------------------------------------------------- plays

/**
 * Normalise one pbp row (object with nflverse column names) into a slim play,
 * or null when it is not a regular-season run, pass or dropback. `ftn` is the
 * joined FTN row for the play, if charted.
 */
export function slimPlay(r, ftn = null) {
  if (r.season_type && r.season_type !== 'REG') return null;
  if (flag(r.two_point_attempt)) return null;
  // Kneel-downs and spikes are clock plays, not carries or targets.
  if (r.play_type === 'qb_kneel' || r.play_type === 'qb_spike') return null;
  const week = num(r.week);
  if (!(week >= 1 && week <= LAST_REGULAR_WEEK)) return null;
  const passAtt = flag(r.pass_attempt) && !flag(r.sack);
  const run = flag(r.rush_attempt);
  const dropback = flag(r.qb_dropback);
  if (!passAtt && !run && !dropback) return null;
  const tdPlayer = r.td_player_id || '';
  // The player's own yards (nflverse's receiving/rushing columns) leave out
  // laterals and fumble returns that yards_gained includes.
  const own = passAtt ? num(r.receiving_yards) : run ? num(r.rushing_yards) : null;
  return {
    game: r.game_id, play: r.play_id, week, off: r.posteam, def: r.defteam,
    pass: passAtt, run, dropback, sack: flag(r.sack),
    scramble: dropback && flag(r.qb_scramble), hit: dropback && flag(r.qb_hit),
    // A scramble carries no passer id in nflverse: the runner is the quarterback.
    passer: dropback ? ((flag(r.qb_scramble) ? r.rusher_player_id : r.passer_player_id) || null) : null,
    yl: num(r.yardline_100), air: num(r.air_yards), yds: own ?? num(r.yards_gained) ?? 0,
    receiver: passAtt ? (r.receiver_player_id || null) : null,
    rusher: run ? (r.rusher_player_id || null) : null,
    complete: flag(r.complete_pass),
    recTd: passAtt && flag(r.pass_touchdown) && (!tdPlayer || tdPlayer === r.receiver_player_id),
    rushTd: run && flag(r.rush_touchdown) && (!tdPlayer || tdPlayer === r.rusher_player_id),
    ftn: ftn ? {
      box: num(ftn.n_defense_box), blitzers: num(ftn.n_blitzers),
      pa: flag(ftn.is_play_action), screen: flag(ftn.is_screen_pass),
      catchable: flag(ftn.is_catchable_ball), contested: flag(ftn.is_contested_ball), drop: flag(ftn.is_drop),
    } : null,
  };
}

// ---------------------------------------------------------------- weekly build

const blank = (cols) => Object.fromEntries(cols.map((c) => [c, 0]));

/**
 * @param {Iterable} plays slim plays for one season
 * @param {object}  opts { xtd, snaps: [{gsis, week, team, opp, offense_snaps}], qbIds: gsis ids known to be quarterbacks }
 * @returns {{ players: Map<gsis, Map<week, row>>, teams: Map<'TEAM|week', row> }}
 */
export function aggregateSeason(plays, { xtd = null, snaps = [], qbIds = [] } = {}) {
  const players = new Map();
  const teams = new Map();
  const pw = (gsis, week, team, opp) => {
    let byWeek = players.get(gsis);
    if (!byWeek) players.set(gsis, (byWeek = new Map()));
    let row = byWeek.get(week);
    if (!row) byWeek.set(week, (row = { week, team, opp, ...blank(WEEKLY_COUNTS) }));
    return row;
  };
  const tw = (team, week, opp) => {
    const k = `${team}|${week}`;
    let row = teams.get(k);
    if (!row) teams.set(k, (row = { team, week, opp, ...blank(TEAM_COLS), _ftnDb: 0 }));
    if (opp && !row.opp) row.opp = opp;
    return row;
  };

  // Quarterbacks: anyone with a dropback of his own, plus the ids the caller knows are QBs
  // (a backup who only ever ran a designed keeper would otherwise look like a back).
  const qbs = new Set(qbIds);
  for (const p of plays) if (p?.passer) qbs.add(p.passer);

  for (const p of plays) {
    if (!p || !p.off || !p.def) continue;
    const o = tw(p.off, p.week, p.def);
    const d = tw(p.def, p.week, p.off);
    if (p.dropback) {
      o.dropbacks++;
      d.def_db++;
      if (p.ftn && p.ftn.blitzers != null) { d._ftnDb++; if (p.ftn.blitzers > 0) d.def_blitz++; }
      if (p.sack) { o.sacks++; d.def_sacks++; }
      if (p.scramble) o.scrambles++;
      if (p.passer) {
        const q = pw(p.passer, p.week, p.off, p.def);
        q.qb_db++;
        if (p.scramble) q.qb_scrambles++;
        if (p.sack) q.qb_sacks++;
        if (p.hit) q.qb_hits++;
        if (p.sack || p.hit) q.qb_press++;
        if (p.ftn) { q.qb_ftn_db++; if (p.ftn.pa) q.pa_db++; }
      }
    }
    if (p.pass) {
      o.pass_att++;
      if (p.air != null) o.air_yds += p.air;
      if (p.yl != null && p.yl <= 20) o.rz_pass_att++;
      if (p.yl != null && p.yl <= 10) o.i10_pass_att++;
      if (p.receiver) {
        const r = pw(p.receiver, p.week, p.off, p.def);
        r.tgt++;
        if (p.air != null) r.air_yds += p.air;
        if (p.complete) { r.rec++; r.rec_yds += p.yds; }
        if (p.recTd) r.rec_td++;
        if (p.yl != null) {
          if (p.yl <= 20) r.rz_tgt++;
          if (p.yl <= 10) r.i10_tgt++;
          if (p.air != null && p.air >= p.yl) r.ez_tgt++;
        }
        r.xtd_rec += xtdOf(xtd, 'tgt', p.yl);
        if (p.ftn) {
          r.ftn_tgt++;
          if (p.ftn.catchable) { r.catchable_tgt++; if (p.complete) r.catchable_rec++; }
          if (p.ftn.drop) r.drops++;
          if (p.ftn.pa) r.pa_tgt++;
          if (p.ftn.screen) r.scr_tgt++;
          if (p.ftn.contested) { r.cont_tgt++; if (p.complete) r.cont_rec++; }
          if (p.ftn.blitzers != null) {
            const pre = p.ftn.blitzers > 0 ? 'bl' : 'nbl';
            r[`${pre}_tgt`]++;
            if (p.complete) { r[`${pre}_rec`]++; r[`${pre}_yds`] += p.yds; }
          }
        }
      }
    }
    if (p.run) {
      o.rush_att++;
      if (p.yl != null && p.yl <= 20) o.rz_rush_att++;
      if (p.yl != null && p.yl <= 10) o.i10_rush_att++;
      const box = p.ftn?.box ?? null;
      if (box != null) {
        d.def_box_car++;
        if (box <= LIGHT_BOX_MAX) d.def_light_car++;
        if (box >= STACKED_BOX_MIN) d.def_stk_car++;
      }
      if (p.rusher) {
        const r = pw(p.rusher, p.week, p.off, p.def);
        r.car++;
        if (!p.scramble && qbs.has(p.rusher)) r.designed_runs++;
        r.rush_yds += p.yds;
        if (p.rushTd) r.rush_td++;
        if (p.yl != null) {
          if (p.yl <= 20) r.rz_car++;
          if (p.yl <= 10) r.i10_car++;
        }
        r.xtd_rush += xtdOf(xtd, 'car', p.yl);
        if (box != null) {
          r.box_car++;
          if (box >= STACKED_BOX_MIN) { r.stk_car++; r.stk_yds += p.yds; }
          if (box <= LIGHT_BOX_MAX) { r.lgt_car++; r.lgt_yds += p.yds; }
        }
      }
    }
  }

  // Snaps: team snaps are the most any player of that team logged that week.
  const tmSnaps = new Map();
  for (const s of snaps) {
    const k = `${s.team}|${s.week}`;
    tmSnaps.set(k, Math.max(tmSnaps.get(k) || 0, s.offense_snaps || 0));
  }
  for (const s of snaps) {
    if (!s.gsis || !(s.offense_snaps > 0)) continue;
    const r = pw(s.gsis, s.week, s.team, s.opp);
    r.off_snaps = s.offense_snaps;
    r.tm_snaps = tmSnaps.get(`${s.team}|${s.week}`) || 0;
  }
  for (const [k, n] of tmSnaps) {
    const t = teams.get(k);
    if (t) t.off_snaps = n;
  }
  for (const t of teams.values()) {
    t.def_blitz_rate = ratio(t.def_blitz, t._ftnDb);
    t.def_light_rate = ratio(t.def_light_car, t.def_box_car);
    t.def_stk_rate = ratio(t.def_stk_car, t.def_box_car);
    delete t._ftnDb;
  }
  return { players, teams };
}

/** Shares for one player-week (or season sum) against his team's totals. */
export function withShares(row, team) {
  const out = { ...row };
  out.snap_pct = ratio(row.off_snaps, row.tm_snaps);
  out.tgt_share = team ? ratio(row.tgt, team.pass_att) : null;
  out.ay_share = team && team.air_yds > 0 ? ratio(row.air_yds, team.air_yds) : null;
  out.wopr = out.tgt_share != null ? +((1.5 * out.tgt_share) + 0.7 * (out.ay_share || 0)).toFixed(3) : null;
  out.rush_share = team ? ratio(row.car, team.rush_att) : null;
  out.rz_tgt_share = team ? ratio(row.rz_tgt, team.rz_pass_att) : null;
  out.i10_tgt_share = team ? ratio(row.i10_tgt, team.i10_pass_att) : null;
  out.rz_car_share = team ? ratio(row.rz_car, team.rz_rush_att) : null;
  out.i10_car_share = team ? ratio(row.i10_car, team.i10_rush_att) : null;
  // A quarterback's designed runs against the team's designed runs (every run that was not a scramble).
  const designed = team ? (team.rush_att || 0) - (team.scrambles || 0) : 0;
  out.designed_run_share = team && designed > 0 && (row.qb_db > 0 || row.designed_runs > 0) ? ratio(row.designed_runs, designed) : null;
  out.xtd_rec = +row.xtd_rec.toFixed(3);
  out.xtd_rush = +row.xtd_rush.toFixed(3);
  return out;
}

/** Season totals and rates from a player's weekly rows (with team weeks for shares). */
export function seasonRow(weeks, teamWeeks) {
  const sum = blank(WEEKLY_COUNTS);
  const tm = { pass_att: 0, air_yds: 0, rush_att: 0, scrambles: 0, rz_pass_att: 0, i10_pass_att: 0, rz_rush_att: 0, i10_rush_att: 0 };
  let games = 0;
  let team = null;
  for (const w of weeks) {
    for (const c of WEEKLY_COUNTS) sum[c] += w[c] || 0;
    if (w.off_snaps > 0 || w.tgt > 0 || w.car > 0) games++;
    const t = teamWeeks.get(`${w.team}|${w.week}`);
    if (t) for (const c of Object.keys(tm)) tm[c] += t[c] || 0;
    team = w.team;
  }
  const s = { team, games, ...withShares(sum, tm) };
  s.adot = ratio(sum.air_yds, sum.tgt, 2);
  s.ypt = ratio(sum.rec_yds, sum.tgt, 2);
  s.catch_rate = ratio(sum.catchable_rec, sum.catchable_tgt);
  s.drop_rate = ratio(sum.drops, sum.catchable_tgt);
  s.ypc = ratio(sum.rush_yds, sum.car, 2);
  s.ypc_stk = ratio(sum.stk_yds, sum.stk_car, 2);
  s.ypc_lgt = ratio(sum.lgt_yds, sum.lgt_car, 2);
  s.tgt_per_snap = ratio(sum.tgt, sum.off_snaps);
  s.ypt_bl = ratio(sum.bl_yds, sum.bl_tgt, 2);
  s.ypt_nbl = ratio(sum.nbl_yds, sum.nbl_tgt, 2);
  s.pa_share = ratio(sum.pa_tgt, sum.ftn_tgt);
  s.scr_share = ratio(sum.scr_tgt, sum.ftn_tgt);
  s.cont_rate = ratio(sum.cont_rec, sum.cont_tgt);
  s.pressure_to_sack = ratio(sum.qb_sacks, sum.qb_press);
  s.scramble_rate = ratio(sum.qb_scrambles, sum.qb_db);
  s.sack_rate = ratio(sum.qb_sacks, sum.qb_db);
  s.pa_rate = ratio(sum.pa_db, sum.qb_ftn_db);
  s.td_gap = +((sum.rec_td + sum.rush_td) - (sum.xtd_rec + sum.xtd_rush)).toFixed(2);
  return s;
}

// ---------------------------------------------------------------- coverage

const ROUTE_POS = new Set(['WR', 'TE', 'RB', 'FB']);

/**
 * Routes and man/zone splits from participation joined to slim plays.
 * A player's routes are the dropbacks he was on the field for as a WR, TE or
 * RB (participation names the route only for the targeted receiver), so
 * blocking TEs and backs run high and their per-route rates low.
 * @param {Iterable} rows participation rows: { key, players:[gsis], positions:[pos], mz, shell }
 * @param {Map} playsByKey slim plays by `${game}|${play}`
 */
export function aggregateCoverage(rows, playsByKey) {
  const players = new Map();
  const teams = new Map();
  const shells = {};
  const get = (gsis, team) => {
    let r = players.get(gsis);
    if (!r) {
      r = { team, routes: 0, tgt: 0, rec: 0, yds: 0, td: 0, man_routes: 0, man_tgt: 0, man_rec: 0, man_yds: 0, man_td: 0, zone_routes: 0, zone_tgt: 0, zone_rec: 0, zone_yds: 0, zone_td: 0 };
      players.set(gsis, r);
    }
    r.team = team;
    return r;
  };
  for (const row of rows) {
    const p = playsByKey.get(row.key);
    if (!p || !p.dropback) continue;
    const mz = row.mz === 'MAN_COVERAGE' ? 'man' : row.mz === 'ZONE_COVERAGE' ? 'zone' : null;
    if (row.shell) shells[row.shell] = (shells[row.shell] || 0) + 1;
    if (mz) {
      let t = teams.get(p.def);
      if (!t) teams.set(p.def, (t = { db: 0, man: 0, zone: 0, shells: {} }));
      t.db++; t[mz]++;
      if (row.shell) t.shells[row.shell] = (t.shells[row.shell] || 0) + 1;
    }
    row.players.forEach((g, i) => {
      if (!g || !ROUTE_POS.has(row.positions[i])) return;
      const r = get(g, p.off);
      r.routes++;
      if (mz) r[`${mz}_routes`]++;
      if (p.pass && p.receiver === g) {
        r.tgt++;
        if (mz) r[`${mz}_tgt`]++;
        if (p.complete) { r.rec++; r.yds += p.yds; if (mz) { r[`${mz}_rec`]++; r[`${mz}_yds`] += p.yds; } }
        if (p.recTd) { r.td++; if (mz) r[`${mz}_td`]++; }
      }
    });
  }
  for (const r of players.values()) {
    r.yprr = ratio(r.yds, r.routes, 2);
    r.tprr = ratio(r.tgt, r.routes);
    r.yprr_man = ratio(r.man_yds, r.man_routes, 2);
    r.tprr_man = ratio(r.man_tgt, r.man_routes);
    r.yprr_zone = ratio(r.zone_yds, r.zone_routes, 2);
    r.tprr_zone = ratio(r.zone_tgt, r.zone_routes);
  }
  for (const t of teams.values()) t.man_rate = ratio(t.man, t.db);
  return { players, teams, shells };
}

// ---------------------------------------------------------------- columnar

/** { cols, rows } so the files stay small: names once, values per row. */
export function columnar(objs, cols) {
  return { cols, rows: objs.map((o) => cols.map((c) => (o[c] === undefined ? null : o[c]))) };
}
export function fromColumnar({ cols, rows }) {
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? null])));
}
