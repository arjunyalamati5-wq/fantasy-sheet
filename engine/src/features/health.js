// Data health: one probe per source the app reads, run in parallel with a
// timeout each, graded ok / warn / fail. Nothing here reads a cache for the
// network rows, since the point is whether the source answers right now.

import { fsp as fs, pathMod as path, cwd, IS_NODE } from '../platform.js';
import { browserUrl } from '../http.js';
import { cacheGet, TTL } from '../cache.js';
import { _urls } from '../nflverse.js';
import { urls as chartingUrls } from '../charting.js';
import { marketUrl } from '../fantasycalc.js';

const V1 = 'https://api.sleeper.app/v1';
const INTERNAL = 'https://api.sleeper.com';
const SLOW_MS = 4000;
const TIMEOUT_MS = 12_000;
const RESULT_TTL = 2 * 60_000;

/**
 * Grade one probe. Words matter more than colour in the UI, so the level is a
 * plain string and every non-ok level carries a reason.
 *   status: HTTP status (0 when nothing answered), error: a thrown message,
 *   problem: what the body validator disliked, empty: answered with no data.
 */
export function gradeProbe({ status = 0, error = null, problem = null, empty = false, ms = 0, slowMs = SLOW_MS } = {}) {
  if (error) return { level: 'fail', reason: /abort|timeout/i.test(error) ? 'It did not answer in time.' : `It could not be reached (${error}).` };
  if (status === 429) return { level: 'warn', reason: 'It is rate limiting requests right now.' };
  if (status < 200 || status >= 300) {
    if (status >= 500) return { level: 'fail', reason: `The server is failing (HTTP ${status}).` };
    return { level: 'fail', reason: status === 404 ? 'The address no longer exists (HTTP 404).' : `It refused the request (HTTP ${status}).` };
  }
  if (problem) return { level: 'warn', reason: problem };
  if (empty) return { level: 'warn', reason: 'It answered, but with no data.' };
  if (ms > slowMs) return { level: 'warn', reason: `It answered slowly (${(ms / 1000).toFixed(1)} s).` };
  return { level: 'ok', reason: 'Working.' };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const needKeys = (...keys) => ({ json }) => (isObj(json) ? (keys.every((k) => k in json) ? null : `The reply is missing "${keys.find((k) => !(k in json))}".`) : 'The reply is not the expected shape.');
const needArray = ({ json, truncated, text }) => {
  if (Array.isArray(json)) return null;
  if (truncated && text.trimStart().startsWith('[')) return null;
  return 'The reply is not a list.';
};
const looksLikeJson = ({ json, text }) => (json !== undefined || /^\s*[[{]/.test(text) ? null : 'The reply is not JSON.');
const looksLikeCsv = ({ text }) => (/^[A-Za-z_"][^\n]*,[^\n]*\n/.test(text) ? null : 'The file does not look like a CSV any more.');

/** Probe specs. `url(ctx)` returns null when something it needs is missing. */
export function buildSpecs() {
  const doc = 'https://docs.sleeper.com/';
  const nfl = 'https://github.com/nflverse/nflverse-data/releases';
  const S = (id, label, extra) => ({ id, label, documented: true, link: doc, ...extra });
  const U = (id, label, extra) => ({ id, label, documented: false, link: doc, ...extra });
  return [
    S('state', 'Sleeper: NFL state', { group: 'Sleeper', url: () => `${V1}/state/nfl`, check: needKeys('season', 'week'), impact: 'The current week and season come from here, so every page depends on it.' }),
    S('user', 'Sleeper: user', { group: 'Sleeper', url: (c) => (c.username ? `${V1}/user/${encodeURIComponent(c.username)}` : null), check: needKeys('user_id'), needs: 'a username', impact: 'Finding your leagues and your team depends on this.' }),
    S('userLeagues', 'Sleeper: your leagues', { group: 'Sleeper', after: 'user', url: (c) => (c.userId && c.season ? `${V1}/user/${c.userId}/leagues/nfl/${c.season}` : null), check: needArray, needs: 'a username', impact: 'The league list on the setup screen depends on this.' }),
    S('league', 'Sleeper: league', { group: 'Sleeper', url: (c) => (c.league ? `${V1}/league/${c.league}` : null), check: needKeys('league_id', 'scoring_settings'), needs: 'a league', impact: 'Scoring rules and roster slots come from here.' }),
    S('rosters', 'Sleeper: rosters', { group: 'Sleeper', url: (c) => (c.league ? `${V1}/league/${c.league}/rosters` : null), check: needArray, needs: 'a league', impact: 'Who owns whom, and every lineup and trade page, depends on this.' }),
    S('users', 'Sleeper: league managers', { group: 'Sleeper', url: (c) => (c.league ? `${V1}/league/${c.league}/users` : null), check: needArray, needs: 'a league', impact: 'Manager names and team names come from here.' }),
    S('matchups', 'Sleeper: this week\'s matchups', { group: 'Sleeper', after: 'state', url: (c) => (c.league && c.week ? `${V1}/league/${c.league}/matchups/${c.week}` : null), check: needArray, allowEmpty: true, needs: 'a league', impact: 'Scores, opponents and win odds depend on this.' }),
    S('transactions', 'Sleeper: transactions', { group: 'Sleeper', after: 'state', url: (c) => (c.league && c.week ? `${V1}/league/${c.league}/transactions/${c.week}` : null), check: needArray, allowEmpty: true, needs: 'a league', impact: 'The trade and waiver history depends on this.' }),
    S('tradedPicks', 'Sleeper: traded picks', { group: 'Sleeper', url: (c) => (c.league ? `${V1}/league/${c.league}/traded_picks` : null), check: needArray, allowEmpty: true, needs: 'a league', impact: 'Pick ownership in trades depends on this.' }),
    S('drafts', 'Sleeper: drafts', { group: 'Sleeper', url: (c) => (c.league ? `${V1}/league/${c.league}/drafts` : null), check: needArray, allowEmpty: true, needs: 'a league', impact: 'Draft recaps and keeper context depend on this.' }),
    S('trendingAdd', 'Sleeper: trending adds', { group: 'Sleeper', url: () => `${V1}/players/nfl/trending/add?lookback_hours=24&limit=5`, check: needArray, impact: 'The waiver buzz depends on this.' }),
    S('trendingDrop', 'Sleeper: trending drops', { group: 'Sleeper', url: () => `${V1}/players/nfl/trending/drop?lookback_hours=24&limit=5`, check: needArray, impact: 'The drop signals depend on this.' }),
    U('stats', 'Sleeper: weekly stats', { group: 'Sleeper, undocumented', after: 'state', url: (c) => (c.season && c.week ? `${INTERNAL}/stats/nfl/${c.season}/${Math.max(1, c.week - 1)}?season_type=regular&position[]=QB` : null), check: looksLikeJson, range: true, impact: 'Scoring history and model inputs depend on this. Without it the app shows results only.' }),
    U('projections', 'Sleeper: projections', { group: 'Sleeper, undocumented', after: 'state', url: (c) => (c.season && c.week ? `${INTERNAL}/projections/nfl/${c.season}/${c.week}?season_type=regular&position[]=QB` : null), check: looksLikeJson, range: true, impact: 'Projected points depend on this. Without it the app falls back to past results.' }),
    { id: 'fantasycalc', label: 'FantasyCalc: redraft values', group: 'Values', documented: false, link: 'https://fantasycalc.com/', url: () => marketUrl({ numTeams: 12, numQbs: 1, ppr: 1 }), check: needArray, range: true, impact: 'The market side of trade grades depends on this.' },
    { id: 'nfl-schedule', label: 'nflverse: schedule', group: 'nflverse', documented: true, link: nfl, after: 'state', url: () => _urls.gamesUrl(), check: looksLikeCsv, range: true, impact: 'Opponents, byes and kickoff times depend on this.' },
    { id: 'nfl-injuries', label: 'nflverse: injury reports', group: 'nflverse', documented: true, link: nfl, after: 'state', url: (c) => (c.season ? _urls.injuriesUrl(c.season) : null), check: looksLikeCsv, range: true, impact: 'Practice participation and game status depend on this.' },
    { id: 'nfl-snaps', label: 'nflverse: snap counts', group: 'nflverse', documented: true, link: nfl, after: 'state', url: (c) => (c.season ? _urls.snapsUrl(c.season) : null), check: looksLikeCsv, range: true, impact: 'Snap share depends on this.' },
    { id: 'nfl-stats', label: 'nflverse: weekly player stats', group: 'nflverse', documented: true, link: nfl, after: 'state', url: (c) => (c.season ? _urls.statsUrl(c.season) : null), check: looksLikeCsv, range: true, impact: 'Targets, carries and usage trends depend on this.' },
    { id: 'nfl-ftn', label: 'nflverse: FTN charting', group: 'nflverse', documented: true, link: nfl, after: 'state', url: (c) => (c.season ? chartingUrls.ftn(c.season) : null), check: looksLikeCsv, range: true, impact: 'Box counts and play-action rates depend on this.' },
    { id: 'meteo', label: 'Open-Meteo: forecast', group: 'Weather', documented: true, link: 'https://open-meteo.com/en/docs', url: () => 'https://api.open-meteo.com/v1/forecast?latitude=40.8&longitude=-74.0&hourly=temperature_2m&forecast_days=1', check: needKeys('hourly'), impact: 'Wind and rain flags on game days depend on this.' },
  ];
}

/** Read a response without downloading a whole season file. */
async function readLimited(res, limit) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, limit), truncated: text.length > limit, size: Buffer.byteLength(text) };
  }
  const dec = new TextDecoder();
  let text = '';
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    text += dec.decode(value, { stream: true });
    if (size >= limit) { truncated = true; await reader.cancel().catch(() => {}); break; }
  }
  return { text, truncated, size };
}

export async function probe(spec, url, { fetchImpl = fetch, now = Date.now, timeout = TIMEOUT_MS } = {}) {
  const started = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = { 'user-agent': 'fantasy-football-analysis/1.0 (+node)' };
    if (spec.range) headers.range = 'bytes=0-4095';
    // On the static site nflverse is read from the copies shipped with it.
    const res = await fetchImpl(IS_NODE ? url : browserUrl(url), { signal: ctrl.signal, headers: IS_NODE ? headers : {}, redirect: 'follow' });
    const limit = spec.range ? 8192 : 2_000_000;
    const body = res.status >= 200 && res.status < 300 ? await readLimited(res, limit) : { text: '', truncated: false, size: 0 };
    const total = Number((res.headers?.get?.('content-range') || '').split('/')[1]) || Number(res.headers?.get?.('content-length')) || body.size;
    let json;
    if (!body.truncated) { try { json = JSON.parse(body.text); } catch { /* not JSON */ } }
    return { status: res.status, ms: now() - started, bytes: total, ...body, json };
  } catch (err) {
    return { status: 0, ms: now() - started, bytes: 0, error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'failed') };
  } finally {
    clearTimeout(timer);
  }
}

function rowFor(spec, result) {
  let problem = null;
  let empty = false;
  if (!result.error && result.status >= 200 && result.status < 300) {
    problem = spec.check ? spec.check(result) : null;
    empty = !problem && Array.isArray(result.json) && result.json.length === 0 && !spec.allowEmpty;
  }
  const { level, reason } = gradeProbe({ status: result.status, error: result.error, problem, empty, ms: result.ms });
  return {
    id: spec.id, group: spec.group, label: spec.label, level,
    message: level === 'ok' ? 'Working.' : `${reason} ${spec.impact}`,
    impact: spec.impact,
    status: result.status || null, ms: result.ms, bytes: result.bytes || 0,
    documented: spec.documented, link: spec.link,
  };
}

const skipped = (spec) => ({
  id: spec.id, group: spec.group, label: spec.label, level: 'warn',
  message: `Not checked: ${spec.needs ? `pick ${spec.needs} first` : 'a value it needs is missing'}. ${spec.impact}`,
  impact: spec.impact, status: null, ms: 0, bytes: 0, documented: spec.documented, link: spec.link,
});

/** Grade the local usage-data manifest and unmatched list (built by the data job). */
export function gradeManifest(manifest, { now = Date.now(), season = null, week = null } = {}) {
  const base = {
    id: 'manifest', group: 'Local data', label: 'Usage data build (data/nflverse)', documented: true, link: null,
    status: null, ms: 0, bytes: 0, impact: 'Snap share, route and target trends depend on this.',
  };
  if (!manifest || typeof manifest !== 'object') {
    return { ...base, level: 'warn', message: 'No usage data has been built yet, so the app reads the public files directly. Snap share depends on this.' };
  }
  const built = Date.parse(manifest.generatedAt);
  const days = Number.isFinite(built) ? (now - built) / 86_400_000 : null;
  const notes = [];
  let level = 'ok';
  if (days === null) { level = 'warn'; notes.push('It has no build date.'); }
  else if (days > 8) { level = 'warn'; notes.push(`It was built ${Math.floor(days)} days ago.`); }
  if (season && manifest.season && String(manifest.season) !== String(season)) { level = 'warn'; notes.push(`It covers ${manifest.season}, not ${season}.`); }
  else if (week && Number(manifest.throughWeek) && Number(manifest.throughWeek) < Number(week) - 2) { level = 'warn'; notes.push(`It stops at week ${manifest.throughWeek}.`); }
  const un = Number(manifest.unmatchedCount) || 0;
  if (un > 0) { level = 'warn'; notes.push(`${un} player${un === 1 ? '' : 's'} could not be matched to a Sleeper id.`); }
  const n = Array.isArray(manifest.sources) ? manifest.sources.length : 0;
  const head = `Built ${days === null ? 'at an unknown time' : days < 1 ? 'today' : `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'} ago`}, ${manifest.season ?? '?'} through week ${manifest.throughWeek ?? '?'}, ${n} source${n === 1 ? '' : 's'}.`;
  return { ...base, level, message: level === 'ok' ? head : `${head} ${notes.join(' ')} Snap share depends on this.` };
}

async function readJsonFile(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

export async function runHealth(params = {}, deps = {}) {
  const { fetchImpl = fetch, now = Date.now, dataDir = IS_NODE ? path.join(cwd(), 'data', 'nflverse') : 'data/nflverse', cacheRead = cacheGet } = deps;
  const ctx = { league: params.league || null, username: params.username || null, season: null, week: null, userId: null };
  const specs = buildSpecs();
  const out = new Map();
  const run = async (spec) => {
    const url = spec.url(ctx);
    if (!url) { out.set(spec.id, skipped(spec)); return null; }
    const result = await probe(spec, url, { fetchImpl, now });
    out.set(spec.id, rowFor(spec, result));
    return result;
  };
  // State and user first: other URLs need the season, week and user id.
  const [stateRes, userRes] = await Promise.all([run(specs[0]), run(specs[1])]);
  if (isObj(stateRes?.json)) { ctx.season = String(stateRes.json.season); ctx.week = Number(stateRes.json.week) || 1; }
  if (isObj(userRes?.json)) ctx.userId = userRes.json.user_id;
  await Promise.all(specs.slice(2).map(run));

  const rows = specs.map((s) => out.get(s.id));
  const cacheFile = await cacheRead('sleeper:players:nfl', TTL.PLAYERS);
  rows.splice(4, 0, cacheFile
    ? { id: 'players', group: 'Sleeper', label: 'Sleeper: player catalogue (saved copy)', level: cacheFile.stale ? 'warn' : 'ok',
        message: cacheFile.stale ? `The saved copy is ${Math.round(cacheFile.age / 3_600_000)} hours old and will refresh on the next visit. Every player name and team depends on this.` : 'Saved copy is fresh.',
        impact: 'Every player name and team comes from this catalogue.', status: null, ms: 0, bytes: 0, documented: true, link: 'https://docs.sleeper.com/' }
    : { id: 'players', group: 'Sleeper', label: 'Sleeper: player catalogue (saved copy)', level: 'warn',
        message: 'Not downloaded yet. It is fetched, about 5 MB, the first time a league loads. Every player name and team depends on this.',
        impact: 'Every player name and team comes from this catalogue.', status: null, ms: 0, bytes: 0, documented: true, link: 'https://docs.sleeper.com/' });

  const manifest = await readJsonFile(path.join(dataDir, 'manifest.json'));
  rows.push(gradeManifest(manifest, { now: now(), season: ctx.season, week: ctx.week }));
  const unmatchedRaw = await readJsonFile(path.join(dataDir, 'unmatched.json'));
  const unmatched = (Array.isArray(unmatchedRaw) ? unmatchedRaw : (unmatchedRaw?.players || []))
    .filter(isObj).slice(0, 200)
    .map((u) => ({ name: String(u.name ?? ''), team: String(u.team ?? ''), pos: String(u.pos ?? ''), reason: String(u.reason ?? '') }));

  const tally = { ok: 0, warn: 0, fail: 0 };
  for (const r of rows) tally[r.level] += 1;
  return { checkedAt: new Date(now()).toISOString(), season: ctx.season, week: ctx.week, tally, rows, unmatched, unmatchedCount: Number(manifest?.unmatchedCount) || unmatched.length };
}

const resultCache = new Map();
/** runHealth, remembered for two minutes per league and user. */
export function healthReport(params, deps = {}) {
  const key = `${params.league || ''}|${params.username || ''}`;
  const hit = resultCache.get(key);
  const t = (deps.now || Date.now)();
  if (hit && t - hit.at < RESULT_TTL) return hit.promise;
  const promise = runHealth(params, deps).catch((e) => { resultCache.delete(key); throw e; });
  resultCache.set(key, { at: t, promise });
  if (resultCache.size > 20) resultCache.delete(resultCache.keys().next().value);
  return promise;
}
export const _resetHealthCache = () => resultCache.clear();
