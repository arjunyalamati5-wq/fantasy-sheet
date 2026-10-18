// Sleeper returns raw stat lines (pass_yd, rush_td, rec, fgm_50_59 ...) and a
// league's scoring_settings is keyed by those same stat names. So scoring a line
// is just a dot product. We deliberately do NOT use the pts_ppr Sleeper ships —
// it is standard PPR, and a league with 4-point passing TDs or kicker distance
// bonuses will not match it.

/**
 * Keys that appear in stat lines but describe the row rather than scoring it.
 * We iterate over the league's settings (not the stat line), so these are
 * mostly belt-and-braces — but a league can carry informational keys too, and
 * multiplying by "rank_ppr" would be silently nonsense.
 */
const INFORMATIONAL = new Set([
  'gp', 'gms_active', 'gp_pct',
  'pts_ppr', 'pts_std', 'pts_half_ppr',
  'adp_dd_ppr', 'pos_adp_dd_ppr',
]);

const INFORMATIONAL_PREFIX = ['rank_', 'adp_', 'pos_adp_', 'tm_'];
const INFORMATIONAL_SUFFIX = ['_snp', '_pct', '_rank'];

export function isInformationalKey(k) {
  if (INFORMATIONAL.has(k)) return true;
  if (INFORMATIONAL_PREFIX.some((p) => k.startsWith(p))) return true;
  if (INFORMATIONAL_SUFFIX.some((s) => k.endsWith(s))) return true;
  return false;
}

/**
 * Score one raw stat line against a league's scoring_settings.
 * @param {Object} stats    raw stat line, e.g. { pass_yd: 164, pass_td: 2, rush_yd: 31 }
 * @param {Object} settings league scoring_settings, e.g. { pass_yd: 0.04, pass_td: 4 }
 * @returns {number} points, rounded to 2dp to match Sleeper's own display
 */
export function scoreStats(stats, settings) {
  if (!stats || !settings) return 0;
  let total = 0;
  for (const [key, weight] of Object.entries(settings)) {
    if (typeof weight !== 'number' || weight === 0) continue;
    if (isInformationalKey(key)) continue;
    const v = stats[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    total += v * weight;
  }
  return round2(total);
}

/**
 * Itemised breakdown, for showing a manager *why* a player scored what he did.
 * Returns the largest contributors first.
 */
export function scoreBreakdown(stats, settings) {
  if (!stats || !settings) return { total: 0, items: [] };
  const items = [];
  let total = 0;
  for (const [key, weight] of Object.entries(settings)) {
    if (typeof weight !== 'number' || weight === 0) continue;
    if (isInformationalKey(key)) continue;
    const v = stats[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v === 0) continue;
    const pts = v * weight;
    total += pts;
    items.push({ key, label: statLabel(key), amount: v, weight, points: round2(pts) });
  }
  items.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { total: round2(total), items };
}

/** Round the way a scoreboard does — 2dp, no floating-point crumbs. */
export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const LABELS = {
  pass_yd: 'passing yards', pass_td: 'passing TDs', pass_int: 'interceptions thrown',
  pass_2pt: 'passing 2-pt conversions', pass_sack: 'sacks taken',
  rush_yd: 'rushing yards', rush_td: 'rushing TDs', rush_2pt: 'rushing 2-pt conversions',
  rec: 'receptions', rec_yd: 'receiving yards', rec_td: 'receiving TDs',
  rec_2pt: 'receiving 2-pt conversions',
  fum_lost: 'fumbles lost', fum: 'fumbles', fum_rec_td: 'fumble return TDs',
  xpm: 'extra points made', xpmiss: 'extra points missed',
  fgm: 'field goals made', fgmiss: 'field goals missed',
  fgm_0_19: 'FG 0-19 yards', fgm_20_29: 'FG 20-29 yards', fgm_30_39: 'FG 30-39 yards',
  fgm_40_49: 'FG 40-49 yards', fgm_50_59: 'FG 50-59 yards', fgm_50p: 'FG 50+ yards',
  fgm_60p: 'FG 60+ yards',
  def_td: 'defensive TDs', def_st_td: 'special-teams TDs', st_td: 'special-teams TDs',
  sack: 'sacks', int: 'interceptions', ff: 'forced fumbles', fum_rec: 'fumbles recovered',
  safe: 'safeties', blk_kick: 'blocked kicks',
  pts_allow_0: 'shutout', pts_allow_1_6: 'allowed 1-6', pts_allow_7_13: 'allowed 7-13',
  pts_allow_14_20: 'allowed 14-20', pts_allow_21_27: 'allowed 21-27',
  pts_allow_28_34: 'allowed 28-34', pts_allow_35p: 'allowed 35+',
  bonus_rec_te: 'TE reception bonus', bonus_rush_yd_100: '100-yard rushing bonus',
  bonus_rec_yd_100: '100-yard receiving bonus', bonus_pass_yd_300: '300-yard passing bonus',
};

export function statLabel(key) {
  return LABELS[key] || key.replace(/_/g, ' ');
}

/**
 * A plain full-PPR / 4-point-passing-TD ruleset with kicker distance bonuses.
 * Used as a fallback when a league's settings can't be read, and as the
 * reference ruleset the scoring tests assert against.
 */
export const DEFAULT_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2,
  xpm: 1, xpmiss: -1,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 5,
  fgmiss: -1,
  def_td: 6, st_td: 6, sack: 1, int: 2, ff: 1, fum_rec: 2, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};
