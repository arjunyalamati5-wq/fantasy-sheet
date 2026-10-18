// Whether a player will actually play in the week being viewed, and what that
// does to his projection. Sleeper's projection rows do not always catch up
// with the injury report, so a player ruled out can still carry a full
// projection — and a team on bye with no projection row used to fall back to
// its season value. Both would put a zero into a lineup as a starter.

/** Designations that mean he will not play: projected 0. */
export const RULED_OUT = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR']);

/** Designations that last beyond the current week, so they apply to future weeks too. */
const MULTI_WEEK = new Set(['IR', 'PUP', 'NA']);

/**
 * Injury discounts on the CURRENT week's projection (the share of his normal
 * points a player keeps): Questionable 85%, Doubtful 30%, Out 0. Players listed
 * Probable are not discounted.
 */
export const QUESTIONABLE_SHARE = 0.85;
export const DOUBTFUL_SHARE = 0.3;

/** Share of his normal projection a player keeps under a designation. */
export function availabilityFactor(status) {
  if (!status) return 1;
  if (RULED_OUT.has(status)) return 0;
  if (status === 'Doubtful') return DOUBTFUL_SHARE;
  if (status === 'Questionable') return QUESTIONABLE_SHARE;
  return 1;
}

/** Weeks a long-term designation (IR, PUP, NA) keeps a player out unless the manager says otherwise. */
export const IR_DEFAULT_WEEKS = 4;
export const LAST_WEEK = 18;

/**
 * Is a player out in a given week? `returnWeek` is the manager's own "back in
 * week N" (he is out for every week before it). Without one, an IR/PUP/NA
 * player counts again four weeks out, and a one-week "Out" covers only the
 * current week. Weeks already played are never "out" (nothing to project).
 */
export function outInWeek({ status = null, currentWeek, week, returnWeek = null }) {
  if (!status || !RULED_OUT.has(status)) return false;
  const cur = Number(currentWeek);
  const wk = Number(week);
  if (!(wk >= cur)) return false;
  const back = Number(returnWeek);
  if (Number.isInteger(back) && back > cur) return wk < back;
  if (MULTI_WEEK.has(status)) return wk < cur + IR_DEFAULT_WEEKS;
  return wk === cur;
}

/**
 * Parse `ir=pid:week,pid:week` (the manager's "back in week" choices).
 * Throws an Error with .status 400 on anything malformed, so a bad query never
 * reaches the projections. Weeks must lie after the current week and by 18.
 * @returns {Map<string, number>}
 */
export function parseIrReturn(raw, { currentWeek = 1, maxEntries = 40 } = {}) {
  const out = new Map();
  if (raw == null || raw === '') return out;
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const parts = String(raw).split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length > maxEntries) throw bad('Too many return weeks.');
  for (const part of parts) {
    const m = /^([A-Za-z0-9_]{1,24}):(\d{1,2})$/.exec(part);
    if (!m) throw bad('That return-week list is not valid.');
    const week = Number(m[2]);
    if (week <= Number(currentWeek) || week > LAST_WEEK) {
      throw bad(`A return week must be from ${Number(currentWeek) + 1} to ${LAST_WEEK}.`);
    }
    out.set(m[1], week);
  }
  return out;
}

/**
 * The designation that applies to the week being viewed, or null.
 *
 * Sleeper's `injury_status` describes today, so it applies to the current
 * week; a future week only inherits designations that outlast a week (IR,
 * PUP, NA), and a week already played inherits nothing. The official report
 * applies only when it was filed for the week being viewed — last week's
 * "Out" says nothing about this Sunday. Sleeper wins when both speak, because
 * it updates through game day while the report is filed on Friday.
 */
export function weekStatus({ sleeperStatus = null, official = null, targetWeek, currentWeek }) {
  const target = Number(targetWeek);
  const current = Number(currentWeek);
  if (sleeperStatus) {
    if (target === current) return sleeperStatus;
    if (target > current && MULTI_WEEK.has(sleeperStatus)) return sleeperStatus;
  }
  if (official?.reportStatus && official.week != null && Number(official.week) === target) {
    return official.reportStatus;
  }
  return null;
}

/**
 * Points a player projects for the week. No game (bye, or no NFL team) is 0,
 * whatever the season value says; otherwise the projection (or, with no
 * projection row, the fallback) scaled by his availability.
 */
export function weekProjection({ projected = null, fallback = 0, onBye = false, hasTeam = true, status = null }) {
  if (onBye || !hasTeam) return 0;
  const base = projected !== null && Number.isFinite(projected) ? projected : (Number(fallback) || 0);
  return base * availabilityFactor(status);
}
