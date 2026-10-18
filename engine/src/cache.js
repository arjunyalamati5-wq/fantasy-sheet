import { IS_NODE, fsp as fs, pathMod as path, cryptoMod as crypto, cwd, STATIC_BASE } from './platform.js';

const CACHE_DIR = IS_NODE ? path.join(cwd(), '.cache') : '';

export const TTL = {
  MINUTE: 60_000,
  STATE: 10 * 60_000,       // current week rolls over slowly
  LEAGUE: 30 * 60_000,      // rosters change on waivers/trades
  MATCHUPS_LIVE: 30_000,    // the in-progress week moves every play during games
  MATCHUPS_PAST: 12 * 60 * 60_000,
  PLAYERS: 12 * 60 * 60_000, // ~5MB catalogue, per Sleeper's own guidance
  PROJECTIONS: 60 * 60_000,
  NFLVERSE: 6 * 60 * 60_000,
  TRENDING: 30 * 60_000,
  IDS: 7 * 24 * 60 * 60_000, // crosswalk barely moves
  NEWS: 15 * 60_000,
  REDDIT: 30 * 60_000, // Reddit rate-limits hard; do not go below this
  SCOREBOARD: 30_000,       // game clock and score, polled by the live score bug
  SEASON_PROJ: 12 * 60 * 60_000, // ADP moves slowly in season
  DRAFT: 24 * 60 * 60_000,       // a completed draft never changes
};

function keyToFile(key) {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  return path.join(CACHE_DIR, `${safe}.${hash}.json`);
}

async function ensureDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

// ---- In a browser: memory, then IndexedDB, then the site's seed file ----
// The published site ships a seed of slow-to-compute or finished-week entries
// (hot-take backtests, charting summaries, past weeks' stats); everything
// else is fetched live and kept in IndexedDB so a return visit does not
// download it again.
const memory = new Map(); // key -> { at, value }
let dbPromise = null;
function db() {
  if (IS_NODE || typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ||= new Promise((resolve) => {
    const req = indexedDB.open('ff-engine', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}
const idb = async (mode, fn) => {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction('cache', mode);
      const req = fn(tx.objectStore('cache'));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
};
// The seed index maps a cache key to a file under data/seed/, fetched only
// when that key is first asked for.
let seedIndex = null;
function seedFile(key) {
  seedIndex ||= fetch(`${STATIC_BASE}data/seed/index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return seedIndex.then((idx) => (idx[key]
    ? fetch(`${STATIC_BASE}data/seed/${idx[key]}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    : null));
}

async function browserGet(key) {
  if (memory.has(key)) return memory.get(key);
  const stored = await idb('readonly', (st) => st.get(key));
  const seeded = await seedFile(key);
  // Whichever copy is newer wins; the seed is rebuilt with every publish.
  const entry = stored && seeded ? (stored.at >= seeded.at ? stored : seeded) : stored || seeded;
  if (entry) memory.set(key, entry);
  return entry;
}

async function browserSet(key, value) {
  const entry = { at: Date.now(), value };
  memory.set(key, entry);
  await idb('readwrite', (st) => st.put(entry, key));
}

/** Read a cache entry. Returns { value, age, stale } or null when absent. */
export async function cacheGet(key, ttl) {
  try {
    const entry = IS_NODE ? JSON.parse(await fs.readFile(keyToFile(key), 'utf8')) : await browserGet(key);
    if (!entry) return null;
    const age = Date.now() - entry.at;
    return { value: entry.value, age, stale: age > ttl };
  } catch {
    return null;
  }
}

export async function cacheSet(key, value) {
  if (!IS_NODE) return browserSet(key, value);
  await ensureDir();
  const file = keyToFile(key);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ at: Date.now(), value }));
  await fs.rename(tmp, file); // atomic, so a crash can't leave a torn cache file
}

/**
 * Fetch-through cache. On a fresh hit, returns the cached value. On a miss or
 * stale entry, calls `producer`. If `producer` throws but a stale entry exists,
 * the stale value is served rather than failing the whole request — remote
 * sources go down and an old number beats no page.
 */
export async function cached(key, ttl, producer, { serveStale = true } = {}) {
  const hit = await cacheGet(key, ttl);
  if (hit && !hit.stale) return hit.value;
  try {
    const value = await producer();
    await cacheSet(key, value);
    return value;
  } catch (err) {
    // Live feeds opt out: an old score passed off as the current one is worse
    // than a failure the caller can see and say so.
    if (hit && serveStale) {
      console.warn(`[cache] ${key}: refresh failed (${err.message}), serving stale copy`);
      return hit.value;
    }
    throw err;
  }
}

export async function cacheClear() {
  if (!IS_NODE) { memory.clear(); await idb('readwrite', (st) => st.clear()); return; }
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
  await ensureDir();
}

export async function cacheStats() {
  if (!IS_NODE) return { entries: memory.size, bytes: 0 };
  try {
    const files = await fs.readdir(CACHE_DIR);
    let bytes = 0;
    for (const f of files) {
      const st = await fs.stat(path.join(CACHE_DIR, f));
      bytes += st.size;
    }
    return { entries: files.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

// ---- Stats for the Front office. Reads only; cached() is untouched. ----

/**
 * Which kind of data a cache file holds, without the league or user ids in
 * its name. The server cache is shared, so a label never names a league.
 */
export function cacheGroup(fileName) {
  const n = String(fileName).toLowerCase();
  const rules = [
    [/^sleeper_players/, 'Sleeper player catalogue'],
    [/api\.sleeper\.com|^stats_|^proj/, 'Sleeper stats and projections (undocumented)'],
    [/sleeper/, 'Sleeper league data'],
    [/fantasycalc|^market/, 'FantasyCalc values'],
    [/nflverse_stats|nflverse_snaps|nflverse_inj|nflverse_games|nflverse/, 'nflverse usage data'],
    [/ftn|pbp|participation|charting|github\.com_nflverse/, 'nflverse charting and play-by-play'],
    [/dynastyprocess|db_playerids|^ids/, 'Player id crosswalk'],
    [/open-meteo|weather/, 'Weather'],
    [/espn/, 'ESPN'],
    [/reddit/, 'Reddit'],
    [/news/, 'News'],
  ];
  for (const [re, label] of rules) if (re.test(n)) return label;
  return 'Other';
}

/** Group [{name, bytes, mtimeMs}] by kind: { group, entries, bytes, oldestAge, newestAge }. */
export function groupCacheFiles(files, now = Date.now()) {
  const groups = new Map();
  for (const f of files) {
    const label = cacheGroup(f.name);
    const g = groups.get(label) || { group: label, entries: 0, bytes: 0, oldestAge: 0, newestAge: Infinity };
    const age = Math.max(0, now - (Number(f.mtimeMs) || now));
    g.entries += 1;
    g.bytes += Number(f.bytes) || 0;
    g.oldestAge = Math.max(g.oldestAge, age);
    g.newestAge = Math.min(g.newestAge, age);
    groups.set(label, g);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

export async function cacheGroups(now = Date.now()) {
  if (!IS_NODE) return [];
  try {
    const names = (await fs.readdir(CACHE_DIR)).filter((f) => f.endsWith('.json'));
    const files = [];
    for (const name of names) {
      try {
        const st = await fs.stat(path.join(CACHE_DIR, name));
        files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* removed while listing */ }
    }
    return groupCacheFiles(files, now);
  } catch {
    return [];
  }
}
