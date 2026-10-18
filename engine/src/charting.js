// Charting data from nflverse (free): FTN charting (box counts, blitzers),
// play-by-play (who ran or was targeted, yards) and NFL Next Gen Stats
// participation (man or zone coverage, 2025 and earlier). Each season is
// streamed once and boiled down to a small per-week summary, then cached.
//
//   FTN charting: CC-BY-SA 4.0, nflverse GitHub release "ftn_charting".
//   play-by-play and participation: CC-BY 4.0, nflverse GitHub releases.
//
// Summary shape (JSON, keyed by GSIS id for players and by team for teams):
//   rush[gsis][week]  = { team, c, yds, cl, yl, cs, ys }   carries, light-box carries/yards, stacked-box carries/yards
//   def[team][week]   = { rush, light, stacked, pass, blitz }   what that DEFENCE faced
//   rcv[gsis][week]   = { team, tMan, yMan, tZone, yZone }      coverage only
//   cov[team][week]   = { n, man }   pass plays with a coverage label, and how many were man (as a defence)
//   off[team][week]   = { man, zone }   targets the OFFENCE threw into each coverage
// The helpers further down only ever read weeks BEFORE the week they are asked
// about, which is what keeps the hot-take backtest honest.

import { IS_NODE } from './platform.js';
const [fs, zlib, readline, streamMod] = IS_NODE
  ? await Promise.all(['node:fs', 'node:zlib', 'node:readline', 'node:stream'].map((m) => import(m)))
  : [null, null, null, null];
const Readable = streamMod?.Readable;
import { cached } from './cache.js';
import { normTeam } from './teams.js';

const RELEASES = 'https://github.com/nflverse/nflverse-data/releases/download';
export const urls = {
  ftn: (s) => `${RELEASES}/ftn_charting/ftn_charting_${s}.csv`,
  pbp: (s) => `${RELEASES}/pbp/play_by_play_${s}.csv.gz`,
  part: (s) => `${RELEASES}/pbp_participation/pbp_participation_${s}.csv`,
};

/** Defenders in the box: this many or fewer is a light box, this many or more is stacked. */
export const LIGHT_BOX_MAX = 6;
export const STACKED_BOX_MIN = 8;
/** The newest season nflverse has published participation (coverage) data for. */
export const COVERAGE_LAST_SEASON = 2025;
export const LAST_REGULAR_WEEK = 18;

const FINISHED_TTL = 30 * 24 * 60 * 60_000;
const CURRENT_TTL = 12 * 60 * 60_000;
const SCHEMA = 1;

/** The NFL season a date belongs to: January to February still count as the season before. */
export function currentSeason(now = new Date()) {
  return now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ---------------------------------------------------------------- CSV lines

/**
 * Split one CSV record into fields: quoted fields, embedded commas and ""
 * escapes are handled. A record with no quote takes a fast split.
 */
export function parseCsvLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let field = '';
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) break; // unterminated quote: keep what we have
        if (line[i] === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        field += line[i++];
      }
      // Anything between the closing quote and the comma is kept as-is.
      while (i < n && line[i] !== ',') field += line[i++];
    } else {
      while (i < n && line[i] !== ',') field += line[i++];
    }
    out.push(field);
    field = '';
    i++; // past the comma
  }
  return out;
}

/** Records from an async iterable of lines; a quoted field spanning lines is rejoined. */
export async function* csvRecords(lines) {
  let pending = null;
  for await (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const text = pending === null ? line : `${pending}\n${line}`;
    // An odd number of quotes means a quoted field is still open.
    let quotes = 0;
    for (let i = text.indexOf('"'); i !== -1; i = text.indexOf('"', i + 1)) quotes++;
    if (quotes % 2 === 1) { pending = text; continue; }
    pending = null;
    if (text === '') continue;
    yield parseCsvLine(text);
  }
  if (pending !== null) yield parseCsvLine(pending);
}

/**
 * Rows as objects holding only `wanted` columns, found by header name.
 * Throws when a wanted column is missing, so a renamed column is loud.
 */
export async function* csvObjects(lines, wanted) {
  let idx = null;
  for await (const rec of csvRecords(lines)) {
    if (!idx) {
      const header = rec.map((h) => h.replace(/^﻿/, ''));
      idx = wanted.map((name) => [name, header.indexOf(name)]);
      const missing = idx.filter(([, i]) => i < 0).map(([name]) => name);
      if (missing.length) throw new Error(`charting: missing column(s) ${missing.join(', ')}`);
      continue;
    }
    const o = {};
    for (const [name, i] of idx) o[name] = rec[i] ?? '';
    yield o;
  }
}

// ---------------------------------------------------------------- sources

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status} for ${url}`); this.status = status; }
}

/**
 * Lines from a source: an http(s) URL (redirects followed), a file path, an
 * array of lines (tests), or a function returning any of those. `.gz` is gunzipped.
 */
export function linesOf(source) {
  if (typeof source === 'function') return linesOf(source());
  if (Array.isArray(source)) return source;
  if (typeof source?.[Symbol.asyncIterator] === 'function') return source;
  if (!IS_NODE) return browserLines(source);
  return (async function* () {
    let stream;
    if (/^https?:\/\//.test(source)) {
      const res = await fetch(source, { redirect: 'follow', headers: { 'user-agent': 'fantasy-football-analysis/1.0 (+node)' } });
      if (!res.ok) throw new HttpError(res.status, source);
      stream = Readable.fromWeb(res.body);
    } else {
      stream = fs.default.createReadStream(source);
    }
    if (source.endsWith('.gz')) stream = stream.pipe(zlib.default.createGunzip());
    yield* readline.default.createInterface({ input: stream, crlfDelay: Infinity });
  })();
}

/** In a browser: fetch a text file (gunzipping .gz) and yield its lines. */
async function* browserLines(source) {
  const res = await fetch(source);
  if (!res.ok) throw new HttpError(res.status, source);
  let body = res.body;
  if (source.endsWith('.gz') && typeof DecompressionStream !== 'undefined') body = body.pipeThrough(new DecompressionStream('gzip'));
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    const lines = rest.split('\n');
    rest = lines.pop();
    yield* lines;
  }
  if (rest) yield rest;
}

// ---------------------------------------------------------------- build

const bump = (obj, k1, k2, init) => {
  const a = (obj[k1] ||= {});
  return (a[k2] ||= init());
};
const yardsOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * One season's summary from three line sources: { ftn, pbp, part }. `part` is
 * optional (no coverage data). Regular season only.
 */
export async function buildSeasonSummary(season, { ftn, pbp, part = null }) {
  // 1. Plays: only the runs and passes, keyed by game and play id.
  const plays = new Map();
  for await (const r of csvObjects(linesOf(pbp), ['play_id', 'game_id', 'week', 'posteam', 'defteam', 'play_type', 'yards_gained', 'receiver_player_id', 'rusher_player_id'])) {
    if (r.play_type !== 'run' && r.play_type !== 'pass') continue;
    const week = Number(r.week);
    if (!(week >= 1 && week <= LAST_REGULAR_WEEK)) continue;
    const off = normTeam(r.posteam);
    const def = normTeam(r.defteam);
    if (!off || !def) continue;
    plays.set(`${r.game_id}|${r.play_id}`, {
      week, off, def, run: r.play_type === 'run', yds: yardsOf(r.yards_gained),
      rusher: r.rusher_player_id || null, target: r.receiver_player_id || null,
    });
  }

  const out = { schema: SCHEMA, season, rush: {}, def: {}, rcv: {}, cov: {}, off: {}, hasCoverage: false };

  // 2. FTN charting: box count on runs, blitzers on passes.
  for await (const r of csvObjects(linesOf(ftn), ['nflverse_game_id', 'nflverse_play_id', 'n_defense_box', 'n_blitzers'])) {
    const p = plays.get(`${r.nflverse_game_id}|${r.nflverse_play_id}`);
    if (!p) continue;
    if (p.run) {
      const box = Number(r.n_defense_box);
      if (!(box >= 1)) continue; // 0 or blank is "not charted", not an empty box
      const light = box <= LIGHT_BOX_MAX;
      const stacked = box >= STACKED_BOX_MIN;
      const d = bump(out.def, p.def, p.week, () => ({ rush: 0, light: 0, stacked: 0, pass: 0, blitz: 0 }));
      d.rush++;
      if (light) d.light++;
      if (stacked) d.stacked++;
      if (p.rusher) {
        const x = bump(out.rush, p.rusher, p.week, () => ({ team: p.off, c: 0, yds: 0, cl: 0, yl: 0, cs: 0, ys: 0 }));
        x.c++; x.yds += p.yds;
        if (light) { x.cl++; x.yl += p.yds; }
        if (stacked) { x.cs++; x.ys += p.yds; }
      }
    } else if (r.n_blitzers !== '' && r.n_blitzers != null) {
      const d = bump(out.def, p.def, p.week, () => ({ rush: 0, light: 0, stacked: 0, pass: 0, blitz: 0 }));
      d.pass++;
      if (Number(r.n_blitzers) > 0) d.blitz++;
    }
  }

  // 3. Participation: man or zone coverage on pass plays.
  if (part) {
    for await (const r of csvObjects(linesOf(part), ['nflverse_game_id', 'play_id', 'defense_man_zone_type'])) {
      const kind = r.defense_man_zone_type;
      if (kind !== 'MAN_COVERAGE' && kind !== 'ZONE_COVERAGE') continue;
      const p = plays.get(`${r.nflverse_game_id}|${r.play_id}`);
      if (!p || p.run) continue;
      const man = kind === 'MAN_COVERAGE';
      const c = bump(out.cov, p.def, p.week, () => ({ n: 0, man: 0 }));
      c.n++;
      if (man) c.man++;
      if (p.target) {
        const o = bump(out.off, p.off, p.week, () => ({ man: 0, zone: 0 }));
        o[man ? 'man' : 'zone']++;
        const x = bump(out.rcv, p.target, p.week, () => ({ team: p.off, tMan: 0, yMan: 0, tZone: 0, yZone: 0 }));
        if (man) { x.tMan++; x.yMan += p.yds; } else { x.tZone++; x.yZone += p.yds; }
      }
    }
    out.hasCoverage = true;
  }
  return out;
}

const memo = new Map();

/**
 * A season's summary through the cache (12h for the live season, a month for a
 * finished one). `source` ({ ftn, pbp, part }) overrides the nflverse URLs for
 * tests and offline runs and skips the cache. `coverage: false` leaves out
 * the participation file.
 */
export function getSeasonCharting(season, { source = null, coverage = true, force = false, now = new Date() } = {}) {
  const wantCoverage = coverage && season <= COVERAGE_LAST_SEASON;
  if (source) {
    return buildSeasonSummary(season, { ftn: source.ftn, pbp: source.pbp, part: wantCoverage ? source.part ?? null : null });
  }
  const key = `charting:v${SCHEMA}:${season}:${wantCoverage ? 'cov' : 'nocov'}`;
  if (memo.has(key) && !force) return memo.get(key);
  const ttl = season < currentSeason(now) ? FINISHED_TTL : CURRENT_TTL;
  const p = cached(key, ttl, () => buildSeasonSummary(season, {
    ftn: urls.ftn(season), pbp: urls.pbp(season), part: wantCoverage ? urls.part(season) : null,
  })).catch((err) => { memo.delete(key); throw err; });
  memo.set(key, p);
  return p;
}

export function resetCharting() { memo.clear(); }

// ---------------------------------------------------------------- index

/**
 * Re-key a summary's players from GSIS to Sleeper ids so it lines up with the
 * hot-take records. Unmapped players are dropped.
 */
export function indexSummary(summary, gsisToSleeper) {
  if (!summary) return null;
  const remap = (byGsis) => {
    const m = new Map();
    for (const [gsis, weeks] of Object.entries(byGsis || {})) {
      const sid = gsisToSleeper.get(gsis);
      if (sid) m.set(sid, weeks);
    }
    return m;
  };
  return {
    season: summary.season,
    hasCoverage: Boolean(summary.hasCoverage),
    rush: remap(summary.rush),
    rcv: remap(summary.rcv),
    def: summary.def || {},
    cov: summary.cov || {},
    off: summary.off || {},
  };
}

// ---------------------------------------------------------------- reads (before a week only)

const before = (byWeek, week) => Object.entries(byWeek || {}).filter(([w]) => Number(w) < week).map(([, v]) => v);
const add = (rows, keys) => {
  const t = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) for (const k of keys) t[k] += r[k] || 0;
  return t;
};
const DEF_KEYS = ['rush', 'light', 'stacked', 'pass', 'blitz'];

/** What a defence has faced on runs and passes in weeks before `week`. */
export function defenseBox(idx, team, week) {
  const rows = before(idx?.def?.[team], week).filter((r) => r.rush > 0);
  if (!rows.length) return null;
  const t = add(rows, DEF_KEYS);
  return {
    games: rows.length, rush: t.rush, lightShare: t.light / t.rush, stackedShare: t.stacked / t.rush,
    light: t.light, stacked: t.stacked,
    blitzRate: t.pass ? t.blitz / t.pass : null,
  };
}

const leagueBoxMemo = new WeakMap();
/** The league-wide rushing picture before `week`: box shares and yards a carry by box type. */
export function leagueBox(idx, week) {
  let byWeek = leagueBoxMemo.get(idx);
  if (!byWeek) { byWeek = new Map(); leagueBoxMemo.set(idx, byWeek); }
  if (byWeek.has(week)) return byWeek.get(week);
  let rush = 0; let light = 0; let stacked = 0;
  for (const weeks of Object.values(idx.def)) {
    const t = add(before(weeks, week), DEF_KEYS);
    rush += t.rush; light += t.light; stacked += t.stacked;
  }
  let cl = 0; let yl = 0; let cs = 0; let ys = 0; let c = 0; let yds = 0;
  for (const weeks of idx.rush.values()) {
    const t = add(before(weeks, week), ['c', 'yds', 'cl', 'yl', 'cs', 'ys']);
    cl += t.cl; yl += t.yl; cs += t.cs; ys += t.ys; c += t.c; yds += t.yds;
  }
  const res = rush ? {
    rush, lightShare: light / rush, stackedShare: stacked / rush,
    lightYpc: cl ? yl / cl : null, stackedYpc: cs ? ys / cs : null, ypc: c ? yds / c : null,
  } : null;
  byWeek.set(week, res);
  return res;
}

/** A back's rushing against light and stacked boxes, from weeks before `week`. */
export function rusherBox(idx, id, week) {
  const rows = before(idx?.rush?.get(id), week);
  if (!rows.length) return null;
  const t = add(rows, ['c', 'yds', 'cl', 'yl', 'cs', 'ys']);
  const otherC = t.c - t.cl;
  return {
    games: rows.length, carries: t.c, yds: t.yds,
    lightCarries: t.cl, lightYds: t.yl, lightYpc: t.cl ? t.yl / t.cl : null,
    stackedCarries: t.cs, stackedYds: t.ys, stackedYpc: t.cs ? t.ys / t.cs : null,
    otherCarries: otherC, otherYpc: otherC ? (t.yds - t.yl) / otherC : null,
  };
}

/** How often a defence plays man on pass plays that have a coverage label, before `week`. */
export function defenseCoverage(idx, team, week) {
  const rows = before(idx?.cov?.[team], week);
  if (!rows.length) return null;
  const t = add(rows, ['n', 'man']);
  return t.n ? { games: rows.length, plays: t.n, manShare: t.man / t.n } : null;
}

export function leagueCoverage(idx, week) {
  let n = 0; let man = 0;
  for (const weeks of Object.values(idx.cov)) {
    const t = add(before(weeks, week), ['n', 'man']);
    n += t.n; man += t.man;
  }
  return n ? { plays: n, manShare: man / n } : null;
}

/**
 * A receiver's share of his team's targets into man and into zone, from weeks
 * before `week` (only weeks in which he was targeted, the same weeks for both).
 */
export function receiverCoverage(idx, id, week) {
  const rows = Object.entries(idx?.rcv?.get(id) || {}).filter(([w]) => Number(w) < week);
  if (!rows.length) return null;
  const t = add(rows.map(([, v]) => v), ['tMan', 'yMan', 'tZone', 'yZone']);
  let tmMan = 0; let tmZone = 0;
  for (const [w, v] of rows) {
    const o = idx.off?.[v.team]?.[w];
    if (o) { tmMan += o.man; tmZone += o.zone; }
  }
  if (!tmMan || !tmZone) return null;
  return {
    games: rows.length, tMan: t.tMan, tZone: t.tZone, tmMan, tmZone,
    manShare: t.tMan / tmMan, zoneShare: t.tZone / tmZone,
    manYpt: t.tMan ? t.yMan / t.tMan : null, zoneYpt: t.tZone ? t.yZone / t.tZone : null,
  };
}
