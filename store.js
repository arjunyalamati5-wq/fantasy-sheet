// Shared client state and the API wrapper.

import { createAccountStore, normalizeInterval } from './accounts.js';

export const state = {
  username: localStorage.getItem('ff.username') || '',
  leagueId: localStorage.getItem('ff.leagueId') || '',
  leagueName: localStorage.getItem('ff.leagueName') || '',
  rosterId: null,
  tab: location.hash.slice(1) || 'lineup',
  overview: null,
  cache: new Map(),
};

// ---------------------------------------------------------------- static site
// On the published site (GitHub Pages) there is no server: the same engine
// runs in a worker inside this page. engineCall answers in fetch's shape so
// everything above it is unchanged.
const STATIC = typeof window !== 'undefined' && Boolean(window.FF_STATIC);
let engine = null;
let engineSeq = 0;
const engineWaiting = new Map();
function engineWorker() {
  if (!engine) {
    engine = new Worker(new URL('engine-worker.js', document.baseURI), { type: 'module' });
    engine.onmessage = (e) => {
      const { id, ok, data, status, error } = e.data || {};
      const done = engineWaiting.get(id);
      if (!done) return;
      engineWaiting.delete(id);
      done(ok ? { status: 200, data } : { status, data: { error } });
    };
  }
  return engine;
}
function engineCall(path, query, options = {}) {
  const id = ++engineSeq;
  const body = options.body ? JSON.parse(options.body) : undefined;
  return new Promise((resolve) => {
    engineWaiting.set(id, ({ status, data }) => resolve({
      ok: status >= 200 && status < 300, status,
      headers: new Headers(), json: async () => data,
    }));
    engineWorker().postMessage({ id, path, query, body, method: options.method || 'GET' });
  });
}
export const isStaticSite = () => STATIC;

export async function api(path, params = {}, options = {}) {
  const url = new URL(`/api/${path}`, location.origin);
  // The what-if lab and IR return weeks ride along with every request; pass
  // wi: null to ask for the real league.
  const wi = 'wi' in params ? params.wi : whatIf();
  const merged = { league: state.leagueId, username: state.username, roster: state.rosterId, ir: irParam(), ...params, wi };
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = STATIC ? await engineCall(path, url.searchParams.toString(), options) : await fetch(url, options);
  // The offline worker marks answers it served from its saved copy.
  if (res.headers.get('x-ff-offline') === '1') window.dispatchEvent(new CustomEvent('ff:offline'));
  const data = await res.json().catch(() => ({ error: 'The server sent something unreadable.' }));
  if (!res.ok) {
    // A what-if can go stale (the player you "added" was picked up for real).
    // Drop it, say so, and ask again for the real league rather than failing.
    if (res.status === 400 && wi && /^What-if:/.test(data.error || '') && !('wi' in params)) {
      setWhatIf('', { reason: data.error });
      return api(path, params, options);
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------------------------------------------------------------- what-if lab

const wiKey = () => `ff.whatif.${state.leagueId}`;
const readLS = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };

/** The current scenario string for this league ('' when none). */
export function whatIf() { return state.leagueId ? readLS(wiKey()) : ''; }

/** Replace the scenario. Fires `ff:whatif-changed` so pages and the banner redraw. */
export function setWhatIf(value, detail = {}) {
  try {
    if (value) localStorage.setItem(wiKey(), value); else localStorage.removeItem(wiKey());
  } catch { /* storage blocked: the scenario lasts this page only */ }
  state.cache.clear();
  window.dispatchEvent(new CustomEvent('ff:whatif-changed', { detail: { value, ...detail } }));
}

/**
 * Add one item to the scenario, replacing any item it conflicts with: a pick
 * for the same week and game, or the same player added/dropped again.
 * `conflicts` is an optional list of items to remove first (e.g. the other
 * team's pick for that game).
 */
export function whatIfToggle(item, { conflicts = [] } = {}) {
  const items = whatIf().split(';').filter(Boolean);
  const has = items.includes(item);
  const kept = items.filter((x) => x !== item && !conflicts.includes(x));
  setWhatIf((has ? kept : [...kept, item]).join(';'));
  return !has;
}

/** IR return weeks set in the locker room, as the server's ir= list. */
function irParam() {
  if (!state.leagueId) return '';
  try {
    const m = JSON.parse(readLS(`ff.irReturn.${state.leagueId}`) || '{}');
    return Object.entries(m).filter(([, w]) => Number(w) > 0).map(([pid, w]) => `${pid}:${w}`).join(',');
  } catch { return ''; }
}

export function post(path, body) {
  return api(path, {}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leagueId: state.leagueId, username: state.username, ...body }),
  });
}

const FRESH_MS = 60_000;

/** Cached GET, keyed by everything that changes the answer. */
export function load(path, params = {}) {
  const key = `${path}|${JSON.stringify(params)}|${state.leagueId}|${state.rosterId}|${whatIf()}|${irParam()}`;
  // Answers go stale with the clock (a game kicks off, a lineup locks), so a
  // tab left open refetches after a minute instead of for the whole session.
  const hit = state.cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const promise = api(path, params).catch((err) => {
    // A newer call may already have replaced this entry (a fresh fetch, or
    // clearCache()); only remove it if it is still the one we set below.
    if (state.cache.get(key)?.promise === promise) state.cache.delete(key);
    throw err;
  });
  const entry = { promise, at: Date.now(), size: 0 };
  state.cache.set(key, entry);
  // Remember roughly how big the answer is, for the Front office's cache table.
  promise.then((d) => { try { entry.size = JSON.stringify(d).length; } catch { /* unmeasurable */ } }, () => {});
  return promise;
}

export function clearCache() { state.cache.clear(); }

/** Drop one report's cached answers, so the next load() asks the server again. */
export function forget(path) {
  for (const key of state.cache.keys()) if (key.startsWith(`${path}|`)) state.cache.delete(key);
}

// ---------------------------------------------------------------- accounts

/** Linked Sleeper accounts for this device (see accounts.js). */
export const accounts = createAccountStore({
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
});

/** The leagues the active account follows: [{ id, name, season }]. The header picker lists these. */
export function followedLeagues() { return accounts.followedLeagues(); }

/** After an account or league change: pull ff.* into `state` and drop answers for the old league. */
export function applyAccount() {
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  state.username = read('ff.username');
  state.leagueId = read('ff.leagueId');
  state.leagueName = read('ff.leagueName');
  state.rosterId = null;
  state.overview = null;
  clearCache();
}

/** What the browser is holding in memory for this page: entry count and rough size. */
export function browserCacheStats() {
  let bytes = 0;
  let entries = 0;
  let oldest = 0;
  const now = Date.now();
  for (const v of state.cache.values()) {
    entries += 1;
    oldest = Math.max(oldest, now - v.at);
    if (v.size) bytes += v.size;
  }
  return { entries, bytes, oldestAge: oldest };
}

// ---------------------------------------------------------------- auto refresh

const AUTO_KEY = 'ff.autoRefresh';
let autoTick = null;
let autoTimer = null;
let lastTick = Date.now();

export function autoRefreshMinutes() {
  try { return normalizeInterval(localStorage.getItem(AUTO_KEY)); } catch { return 0; }
}

function scheduleAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  const min = autoRefreshMinutes();
  if (!autoTick || !min) return;
  autoTimer = setInterval(fireAuto, min * 60_000);
}

function fireAuto() {
  // A hidden tab does no work; it catches up when it is shown again.
  if (typeof document !== 'undefined' && document.hidden) return;
  lastTick = Date.now();
  try { autoTick?.(); } catch (err) { console.error(err); }
}

/** Change the interval (0 = off) and apply it now. */
export function setAutoRefreshMinutes(min) {
  const v = normalizeInterval(min);
  try { if (v) localStorage.setItem(AUTO_KEY, String(v)); else localStorage.removeItem(AUTO_KEY); } catch { /* stays for this visit only */ }
  lastTick = Date.now();
  scheduleAuto();
  return v;
}

/**
 * Begin refreshing on the saved interval while the tab is open. `onTick`
 * should drop the browser cache and redraw the current page. Safe to call
 * once at boot; returns a stop function.
 */
export function startAutoRefresh(onTick) {
  autoTick = onTick;
  lastTick = Date.now();
  scheduleAuto();
  const onVisible = () => {
    const min = autoRefreshMinutes();
    if (!document.hidden && min && Date.now() - lastTick >= min * 60_000) fireAuto();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(autoTimer);
    autoTick = null;
  };
}
