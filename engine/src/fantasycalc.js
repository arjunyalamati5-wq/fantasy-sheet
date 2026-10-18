import { getJson } from './http.js';

// FantasyCalc publishes crowd-sourced trade values from real trades, free and
// keyless. We use the redraft values, keyed by Sleeper id, as a second opinion
// next to the lineup-based trade grade.

const BASE = 'https://api.fantasycalc.com/values/current';
export const MARKET_TTL = 6 * 60 * 60_000;
export const MARKET_CREDIT = 'Market values: FantasyCalc';

/** Map a league onto FantasyCalc's three knobs. */
export function marketParams({ rosterPositions = [], scoring = {}, numTeams } = {}) {
  const qbSlots = rosterPositions.filter((s) => s === 'QB').length;
  const superflex = rosterPositions.includes('SUPER_FLEX');
  const rec = Number(scoring?.rec);
  const recVal = Number.isFinite(rec) ? rec : 1;
  // Nearest of 0 / 0.5 / 1 (a 0.25 tie rounds up, toward the fuller PPR bucket).
  const ppr = [0, 0.5, 1].reduce((best, c) => (Math.abs(c - recVal) < Math.abs(best - recVal) - 1e-9 ? c : best), 0);
  const teams = Math.round(Number(numTeams));
  return {
    numTeams: Number.isFinite(teams) && teams >= 2 ? Math.min(teams, 32) : 12,
    numQbs: superflex || qbSlots >= 2 ? 2 : 1,
    ppr,
  };
}

export function marketUrl({ numTeams, numQbs, ppr, isDynasty = false }) {
  return `${BASE}?isDynasty=${isDynasty ? 'true' : 'false'}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;
}

/** Raw FantasyCalc rows -> Map sleeperId -> { value, rank, posRank, trend30 }. */
export function parseMarket(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const id = r?.player?.sleeperId;
    const value = Number(r?.value);
    if (!id || !Number.isFinite(value)) continue;
    out.set(String(id), {
      value: Math.round(value),
      rank: r.overallRank ?? null,
      posRank: r.positionRank ?? null,
      trend30: Number.isFinite(Number(r.trend30Day)) ? Number(r.trend30Day) : 0,
      position: r.player.position || null,
    });
  }
  return out;
}

/** Market values for a league's settings, or null when the source is down. */
export async function getMarketValues(params) {
  try {
    const rows = await getJson(marketUrl(params), {
      key: `fantasycalc:${params.isDynasty ? 'dyn:' : ''}${params.numQbs}:${params.numTeams}:${params.ppr}`,
      ttl: MARKET_TTL,
      timeout: 15_000,
    });
    const map = parseMarket(rows);
    return map.size ? map : null;
  } catch (err) {
    console.warn(`[fantasycalc] unavailable: ${err.message}`);
    return null;
  }
}

/** Convenience: values for a loaded league context. */
export function marketForContext(ctx) {
  return getMarketValues(marketParams({
    rosterPositions: ctx.rosterPositions, scoring: ctx.scoring, numTeams: ctx.numTeams,
  }));
}

// ---------------------------------------------------------------- dynasty picks

const ROUND_NAMES = { 1: '1st', 2: '2nd', 3: '3rd' };
export const roundName = (round) => ROUND_NAMES[round] || `${round}th`;

/**
 * Draft picks in FantasyCalc dynasty rows are players named like "2027 1st"
 * (or "2027 Early 1st", "2027 Pick 1.05"). Returns Map "season|round" -> value:
 * the plain "2027 1st" row when there is one, otherwise the mean of its
 * early/mid/late rows. Exact-slot rows ("Pick 1.05") are ignored.
 */
export function parsePickValues(rows) {
  const plain = new Map();
  const tiers = new Map();
  if (!Array.isArray(rows)) return plain;
  for (const r of rows) {
    const m = /^\s*(20\d\d)\s+(?:(early|mid|late)\s+)?(\d{1,2})(?:st|nd|rd|th)\s*$/i.exec(String(r?.player?.name || ''));
    const value = Number(r?.value);
    if (!m || !Number.isFinite(value)) continue;
    const key = `${m[1]}|${Number(m[3])}`;
    if (m[2]) {
      if (!tiers.has(key)) tiers.set(key, []);
      tiers.get(key).push(value);
    } else {
      plain.set(key, Math.round(value));
    }
  }
  for (const [key, list] of tiers) {
    if (!plain.has(key)) plain.set(key, Math.round(list.reduce((a, b) => a + b, 0) / list.length));
  }
  return plain;
}

/**
 * Dynasty values for players and picks, or null when the source is down.
 * @returns {Promise<{values: Map, picks: Map}|null>}
 */
export async function getDynastyMarket(params) {
  const p = { ...params, isDynasty: true };
  try {
    const rows = await getJson(marketUrl(p), {
      key: `fantasycalc:dyn:${p.numQbs}:${p.numTeams}:${p.ppr}`,
      ttl: MARKET_TTL,
      timeout: 15_000,
    });
    const values = parseMarket(rows);
    return values.size ? { values, picks: parsePickValues(rows) } : null;
  } catch (err) {
    console.warn(`[fantasycalc] dynasty values unavailable: ${err.message}`);
    return null;
  }
}

export function dynastyMarketForContext(ctx) {
  return getDynastyMarket(marketParams({
    rosterPositions: ctx.rosterPositions, scoring: ctx.scoring, numTeams: ctx.numTeams,
  }));
}
