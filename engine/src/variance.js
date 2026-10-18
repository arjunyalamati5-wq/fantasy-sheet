// Week-to-week variance, expressed as a coefficient of variation (sd / mean).
// A player's own game log is the best evidence, but three games is not enough
// to estimate a spread, so we blend it with a positional default.

/** Positional defaults. QBs are the steadiest; defences are close to a coin toss. */
export const POSITION_CV = {
  QB: 0.32,
  RB: 0.55,
  WR: 0.62,
  TE: 0.65,
  K: 0.45,
  DEF: 0.70,
  DL: 0.55, LB: 0.50, DB: 0.55,
};

const DEFAULT_CV = 0.55;
const BLEND_K = 3; // games of evidence needed before the player's own log dominates

export function positionalCv(position) {
  return POSITION_CV[position] ?? DEFAULT_CV;
}

/**
 * Coefficient of variation for one player.
 * @param {string} position
 * @param {number[]} samples weekly points, bye weeks already excluded
 */
export function playerCv(position, samples = []) {
  const posCv = positionalCv(position);
  const clean = samples.filter((s) => Number.isFinite(s));
  const n = clean.length;
  if (n < 2) return posCv;

  const mean = clean.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0.5) return posCv; // a CV around zero points is meaningless

  // Sample standard deviation (n-1), so a two-game log isn't overconfident.
  const variance = clean.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const ownCv = Math.sqrt(variance) / mean;

  const w = n / (n + BLEND_K);
  const blended = w * ownCv + (1 - w) * posCv;

  // Clamp: real fantasy weeks are neither perfectly predictable nor infinite.
  return Math.min(1.4, Math.max(0.15, blended));
}

/**
 * Standard deviation in points for a player projected at `mean`.
 * Very low projections still carry a points floor of uncertainty, otherwise a
 * 1-point projection simulates as a certainty.
 */
export function playerSd(position, mean, samples = []) {
  const cv = playerCv(position, samples);
  return Math.max(0.75, cv * Math.max(0, mean));
}
