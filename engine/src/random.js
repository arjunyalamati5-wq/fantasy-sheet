/** Deterministic PRNG so simulations are reproducible and testable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller, drawing from the supplied uniform source. */
export function normal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A weekly fantasy score: non-negative and right-skewed (a ceiling game is
 * further from the median than a floor game). Lognormal with the requested
 * mean and standard deviation, which beats a normal that can go negative.
 */
export function lognormalScore(rand, mean, sd) {
  // A projection of exactly zero is a player ruled out or on bye: he scores
  // nothing, and drawing nothing keeps the random stream the same as the live
  // simulator's, which leaves him out altogether.
  if (mean === 0) return 0;
  if (!(mean > 0)) return Math.max(0, mean + sd * normal(rand) * 0.5);
  const variance = sd * sd;
  const sigma2 = Math.log(1 + variance / (mean * mean));
  const sigma = Math.sqrt(sigma2);
  const mu = Math.log(mean) - sigma2 / 2;
  return Math.exp(mu + sigma * normal(rand));
}

/** Seed derived from a string, so a given matchup always simulates the same way. */
export function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
