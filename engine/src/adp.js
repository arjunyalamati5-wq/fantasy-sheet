import { getJsonSoft } from './http.js';
import { TTL } from './cache.js';
import { normTeam } from './teams.js';

// Season-long projections carry average draft position alongside a full-season
// stat line. Both are needed for the draft tools.
const INTERNAL = 'https://api.sleeper.com';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** Which ADP column suits a league's shape. */
export function adpKeyFor({ slots = [], scoring = {} } = {}) {
  const superflex = slots.some((s) => s === 'SUPER_FLEX' || s === 'QB_FLEX');
  if (superflex) return ['adp_2qb', 'adp_ppr'];
  const rec = scoring.rec ?? 1;
  if (rec >= 1) return ['adp_ppr', 'adp_half_ppr', 'adp_std'];
  if (rec >= 0.5) return ['adp_half_ppr', 'adp_ppr', 'adp_std'];
  return ['adp_std', 'adp_half_ppr', 'adp_ppr'];
}

/**
 * Season-long projections keyed by sleeper player_id:
 * { stats, adp: {...}, seasonStats }
 */
export async function getSeasonProjections(season) {
  const q = POSITIONS.map((p) => `position[]=${p}`).join('&');
  const rows = await getJsonSoft(
    `${INTERNAL}/projections/nfl/${season}?season_type=regular&${q}`,
    { key: `season-proj:${season}`, ttl: TTL.SEASON_PROJ, timeout: 90_000 },
    null
  );
  const out = {};
  if (!Array.isArray(rows)) return { available: false, byPlayer: out };

  for (const r of rows) {
    const id = r.player_id || r.player?.player_id;
    if (!id || !r.stats) continue;
    out[id] = {
      stats: r.stats,
      team: normTeam(r.team || r.player?.team),
      position: r.player?.position || null,
      name: r.player
        ? [r.player.first_name, r.player.last_name].filter(Boolean).join(' ')
        : null,
    };
  }
  return { available: Object.keys(out).length > 0, byPlayer: out };
}

/** Read the best available ADP for a player, trying each key in order. */
export function readAdp(stats, keys) {
  if (!stats) return null;
  for (const k of keys) {
    const v = stats[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}
