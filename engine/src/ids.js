import { getText } from './http.js';
import { TTL } from './cache.js';
import { parseCsv } from './csv.js';

// db_playerids.csv maps sleeper_id <-> gsis_id <-> pfr_id. We need it because
// nflverse is keyed by gsis (and snap counts by pfr), while Sleeper is keyed by
// its own ids. The file is CORS-blocked in browsers, so this must stay
// server-side — the frontend never fetches it directly.
const URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';

const WANTED = ['sleeper_id', 'gsis_id', 'pfr_id', 'name', 'position', 'team', 'merge_name'];

let memo = null;

/**
 * @returns {{ sleeperToGsis: Map, gsisToSleeper: Map, sleeperToPfr: Map, pfrToSleeper: Map }}
 */
export async function getCrosswalk() {
  if (memo) return memo;
  const text = await getText(URL, { key: 'ids:db_playerids', ttl: TTL.IDS });
  const rows = parseCsv(text, WANTED);

  const sleeperToGsis = new Map();
  const gsisToSleeper = new Map();
  const sleeperToPfr = new Map();
  const pfrToSleeper = new Map();

  for (const r of rows) {
    const sid = clean(r.sleeper_id);
    const gsis = clean(r.gsis_id);
    const pfr = clean(r.pfr_id);
    if (sid && gsis) {
      sleeperToGsis.set(sid, gsis);
      if (!gsisToSleeper.has(gsis)) gsisToSleeper.set(gsis, sid);
    }
    if (sid && pfr) {
      sleeperToPfr.set(sid, pfr);
      if (!pfrToSleeper.has(pfr)) pfrToSleeper.set(pfr, sid);
    }
  }

  memo = { sleeperToGsis, gsisToSleeper, sleeperToPfr, pfrToSleeper, rows: rows.length };
  return memo;
}

/**
 * Build lookups for one league's players, preferring the gsis_id Sleeper already
 * carries and falling back to the crosswalk.
 */
export async function buildIdMaps(players) {
  const cw = await getCrosswalk();
  const sleeperToGsis = new Map();
  const gsisToSleeper = new Map();
  const sleeperToPfr = new Map();
  const pfrToSleeper = new Map();

  for (const p of Object.values(players)) {
    const gsis = clean(p.gsis_id) || cw.sleeperToGsis.get(p.player_id) || null;
    if (gsis) {
      sleeperToGsis.set(p.player_id, gsis);
      gsisToSleeper.set(gsis, p.player_id);
    }
    const pfr = cw.sleeperToPfr.get(p.player_id);
    if (pfr) {
      sleeperToPfr.set(p.player_id, pfr);
      pfrToSleeper.set(pfr, p.player_id);
    }
  }
  return { sleeperToGsis, gsisToSleeper, sleeperToPfr, pfrToSleeper };
}

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' || s === 'NA' ? null : s;
}
