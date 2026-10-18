// Floor and ceiling for a projection: a bad week and a good week, from how far
// players at the same position have really swung from their own average.
// The multipliers are the 20th and 80th percentile of (a week's points) over
// (that player's average in his OTHER games), so one big game cannot set its
// own yardstick. Positions without enough games fall back to fixed defaults.

/** Used until a position has enough games in this league to measure. */
export const DEFAULT_SPREAD = {
  QB: { lo: 0.62, hi: 1.38 },
  RB: { lo: 0.4, hi: 1.7 },
  WR: { lo: 0.35, hi: 1.8 },
  TE: { lo: 0.35, hi: 1.8 },
  K: { lo: 0.4, hi: 1.7 },
  DEF: { lo: 0.3, hi: 1.9 },
};
const FALLBACK = { lo: 0.4, hi: 1.7 };
const MIN_GAMES = 4;      // games a player needs before he adds to the sample
const MIN_SAMPLE = 40;    // ratios a position needs before its own numbers beat the defaults

/** Linear-interpolated percentile of an ascending list; q in 0..1. */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Spread multipliers per position from weekly results.
 * @param {Map<string,{points:number,played:boolean,onBye?:boolean}[]>} resultsByPlayer
 * @param {(id:string)=>string|undefined} positionOf
 */
export function buildSpreads(resultsByPlayer, positionOf) {
  const ratios = {};
  for (const [id, games] of resultsByPlayer || []) {
    const pos = positionOf(id);
    if (!pos) continue;
    const pts = games.filter((g) => g.played && !g.onBye).map((g) => Number(g.points) || 0);
    if (pts.length < MIN_GAMES) continue;
    const total = pts.reduce((a, b) => a + b, 0);
    for (const x of pts) {
      const others = (total - x) / (pts.length - 1);
      if (others < 3) continue; // a near-zero average makes any ratio meaningless
      (ratios[pos] ||= []).push(x / others);
    }
  }
  const out = {};
  for (const pos of new Set([...Object.keys(DEFAULT_SPREAD), ...Object.keys(ratios)])) {
    const list = (ratios[pos] || []).sort((a, b) => a - b);
    const base = DEFAULT_SPREAD[pos] || FALLBACK;
    if (list.length < MIN_SAMPLE) { out[pos] = { ...base, n: list.length, measured: false }; continue; }
    out[pos] = {
      lo: Math.min(0.95, percentile(list, 0.2)),
      hi: Math.max(1.05, percentile(list, 0.8)),
      n: list.length,
      measured: true,
    };
  }
  return out;
}

const cache = new WeakMap();

/** Spreads for a context, computed once per context. */
export function spreadsFor(ctx) {
  if (!ctx || typeof ctx !== 'object') return buildSpreads(null, () => null);
  if (!cache.has(ctx)) cache.set(ctx, buildSpreads(ctx.resultsByPlayer, (id) => ctx.playerOf?.(id)?.position));
  return cache.get(ctx);
}

const r1 = (x) => Math.round(x * 10) / 10;

/** A projection's bad week and good week. A zero projection (bye, ruled out) has no range. */
export function floorCeiling(ctx, position, projected) {
  const p = Number(projected) || 0;
  if (p <= 0) return { floor: 0, ceiling: 0 };
  const s = spreadsFor(ctx)[position] || FALLBACK;
  return { floor: r1(p * s.lo), ceiling: r1(p * s.hi) };
}
