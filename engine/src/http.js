import { IS_NODE, STATIC_BASE } from './platform.js';
import { cached } from './cache.js';

const UA = 'fantasy-football-analysis/1.0 (+node)';

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

async function withRetry(fn, { attempts = 3, baseDelay = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A 404 is an answer, not a transient failure. Don't burn retries on it.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelay * 2 ** i));
    }
  }
  throw lastErr;
}

/**
 * In a browser, nflverse's release files cannot be fetched (GitHub sends no
 * CORS header), so the published site carries copies under data/mirror/.
 */
export function browserUrl(url) {
  const m = /^https:\/\/github\.com\/nflverse\/nflverse-data\/releases\/download\/[^/]+\/([^/?#]+)$/.exec(url);
  return m ? `${STATIC_BASE}data/mirror/${m[1]}` : url;
}

async function rawFetch(url, { timeout = 60_000, accept = 'application/json', headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(IS_NODE ? url : browserUrl(url), {
      signal: ctrl.signal,
      // Browsers set their own user-agent; a page may not.
      headers: IS_NODE ? { 'user-agent': UA, accept, ...headers } : { accept, ...headers },
      redirect: 'follow',
    });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON through the disk cache. */
export function getJson(url, { key = url, ttl, timeout, serveStale = true } = {}) {
  return cached(key, ttl, () =>
    withRetry(async () => {
      const res = await rawFetch(url, { timeout });
      return res.json();
    }), { serveStale });
}

/** GET text (CSV) through the disk cache. */
export function getText(url, { key = url, ttl, timeout = 120_000, headers } = {}) {
  return cached(key, ttl, () =>
    withRetry(async () => {
      const res = await rawFetch(url, { timeout, accept: 'text/csv,text/plain,application/atom+xml,*/*', headers });
      return res.text();
    })
  );
}

/**
 * For undocumented or optional sources. Returns `fallback` instead of throwing,
 * so one dead endpoint degrades a feature rather than taking down the page.
 */
export async function getJsonSoft(url, opts = {}, fallback = null) {
  try {
    return await getJson(url, opts);
  } catch (err) {
    console.warn(`[http] optional source unavailable: ${url} (${err.message})`);
    return fallback;
  }
}

export async function getTextSoft(url, opts = {}, fallback = null) {
  try {
    return await getText(url, opts);
  } catch (err) {
    console.warn(`[http] optional source unavailable: ${url} (${err.message})`);
    return fallback;
  }
}

export { HttpError };
