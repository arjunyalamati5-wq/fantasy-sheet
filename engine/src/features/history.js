// League history: follow the league back through its past seasons by walking
// `previous_league_id`, then read each season's champion, the standings, every
// regular-season matchup (for head-to-head and the best single week) and
// stitch managers together across seasons by their Sleeper user id, since
// roster numbers can change from year to year.

import {
  getLeague, getRosters, getLeagueUsers, getMatchups, getWinnersBracket, getUser,
} from '../sleeper.js';

export const HISTORY_TTL = 12 * 60 * 60_000;
export const MAX_SEASONS = 10;
const CONCURRENCY = 3;

const defaultDeps = { getLeague, getRosters, getLeagueUsers, getMatchups, getWinnersBracket, getUser };
const r2 = (n) => Math.round(n * 100) / 100;
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']; const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/** The league ids from this one back to the first season, newest first. Stops on a loop, a missing link or the cap. */
export async function walkChain(leagueId, { getLeague: get = getLeague, max = MAX_SEASONS } = {}) {
  const seen = new Set();
  const out = [];
  let id = String(leagueId);
  while (id && id !== '0' && !seen.has(id) && out.length < max) {
    seen.add(id);
    let league;
    try { league = await get(id); } catch { league = null; }
    if (!league || !league.league_id) break;
    out.push(league);
    id = league.previous_league_id ? String(league.previous_league_id) : '';
  }
  return out;
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

/** Bracket placements from a winners bracket: champion (p=1), runner-up, third, fourth. */
export function placements(bracket) {
  const out = { champion: null, runnerUp: null, third: null, fourth: null };
  for (const m of Array.isArray(bracket) ? bracket : []) {
    if (m.p === 1 && m.w != null) { out.champion = m.w; out.runnerUp = m.l ?? null; }
    if (m.p === 3 && m.w != null) { out.third = m.w; out.fourth = m.l ?? null; }
  }
  return out;
}

const teamLabel = (user, rosterId) => user?.metadata?.team_name || user?.display_name || `Roster ${rosterId}`;

/** One finished season, read from Sleeper. */
async function readSeason(league, deps) {
  const lid = league.league_id;
  const regEnd = Math.min(18, Math.max(1, (Number(league.settings?.playoff_week_start) || 15) - 1));
  const [rosters, users, bracket] = await Promise.all([
    deps.getRosters(lid).catch(() => []), deps.getLeagueUsers(lid).catch(() => []), deps.getWinnersBracket(lid).catch(() => null),
  ]);
  const weeks = Array.from({ length: regEnd }, (_, i) => i + 1);
  const matchups = await pool(weeks, 4, (w) => Promise.resolve(deps.getMatchups(lid, w)).catch(() => []));
  return { league, rosters: rosters || [], users: users || [], bracket, matchups: matchups.map((m, i) => ({ week: i + 1, entries: Array.isArray(m) ? m : [] })) };
}

/**
 * Pure assembly of the history from the raw seasons (newest first), so it can
 * be tested without a network. `userId` marks which manager is "you".
 */
export function assembleHistory(raw, userId) {
  const owners = new Map(); // ownerId -> aggregate
  const seasons = [];
  const h2h = new Map();    // opponent ownerId -> record vs you
  let bestWeek = null; let yourBestWeek = null;

  const ownerAgg = (ownerId, name) => {
    if (!owners.has(ownerId)) owners.set(ownerId, { ownerId, name, w: 0, l: 0, t: 0, pf: 0, titles: 0, seasons: 0, runnerUps: 0 });
    return owners.get(ownerId);
  };

  for (const s of raw) {
    const season = String(s.league.season);
    const userById = new Map(s.users.map((u) => [u.user_id, u]));
    const ownerOfRoster = new Map(); const nameOfRoster = new Map();
    for (const r of s.rosters) {
      const u = userById.get(r.owner_id);
      ownerOfRoster.set(String(r.roster_id), r.owner_id || null);
      nameOfRoster.set(String(r.roster_id), teamLabel(u, r.roster_id));
    }
    const place = placements(s.bracket);
    const standings = s.rosters.map((r) => {
      const st = r.settings || {};
      return {
        rosterId: r.roster_id, ownerId: r.owner_id || null,
        w: st.wins || 0, l: st.losses || 0, t: st.ties || 0,
        pf: r2((st.fpts || 0) + (st.fpts_decimal || 0) / 100),
      };
    }).sort((a, b) => (b.w + 0.5 * b.t) - (a.w + 0.5 * a.t) || b.pf - a.pf);
    standings.forEach((x, i) => { x.rank = i + 1; });

    const nameFor = (rosterId) => nameOfRoster.get(String(rosterId)) || null;
    const championRow = place.champion != null ? standings.find((x) => String(x.rosterId) === String(place.champion)) : null;
    const mineRow = userId ? standings.find((x) => x.ownerId === userId) : null;

    let finish = null;
    if (mineRow) {
      const id = String(mineRow.rosterId);
      if (String(place.champion) === id) finish = { place: 1, text: 'Champion', source: 'playoffs' };
      else if (String(place.runnerUp) === id) finish = { place: 2, text: 'Runner-up', source: 'playoffs' };
      else if (String(place.third) === id) finish = { place: 3, text: 'Third place', source: 'playoffs' };
      else if (String(place.fourth) === id) finish = { place: 4, text: 'Fourth place', source: 'playoffs' };
      else finish = { place: mineRow.rank, text: `${ordinal(mineRow.rank)} in the regular season`, source: 'regular season' };
    }

    for (const x of standings) {
      if (!x.ownerId) continue;
      const a = ownerAgg(x.ownerId, nameFor(x.rosterId));
      a.w += x.w; a.l += x.l; a.t += x.t; a.pf = r2(a.pf + x.pf); a.seasons += 1;
      if (String(place.champion) === String(x.rosterId)) a.titles += 1;
      if (String(place.runnerUp) === String(x.rosterId)) a.runnerUps += 1;
    }

    for (const wk of s.matchups) {
      const byId = new Map();
      for (const e of wk.entries) {
        const pts = Number(e.points);
        if (Number.isFinite(pts) && pts > 0) {
          const ownerId = ownerOfRoster.get(String(e.roster_id));
          const cand = { points: r2(pts), week: wk.week, season, ownerId, teamName: nameFor(e.roster_id), isYou: Boolean(userId && ownerId === userId) };
          if (!bestWeek || cand.points > bestWeek.points) bestWeek = cand;
          if (cand.isYou && (!yourBestWeek || cand.points > yourBestWeek.points)) yourBestWeek = cand;
        }
        if (e.matchup_id == null) continue;
        if (!byId.has(e.matchup_id)) byId.set(e.matchup_id, []);
        byId.get(e.matchup_id).push(e);
      }
      if (!userId) continue;
      for (const pair of byId.values()) {
        if (pair.length !== 2) continue;
        const [a, b] = pair;
        const oa = ownerOfRoster.get(String(a.roster_id)); const ob = ownerOfRoster.get(String(b.roster_id));
        const pa = Number(a.points); const pb = Number(b.points);
        if (!(pa > 0 || pb > 0)) continue; // not played
        const youSide = oa === userId ? [pa, pb, ob, b] : ob === userId ? [pb, pa, oa, a] : null;
        if (!youSide || !youSide[2] || youSide[2] === userId) continue;
        const [mine, theirs, opp, oppEntry] = youSide;
        if (!h2h.has(opp)) h2h.set(opp, { ownerId: opp, name: nameFor(oppEntry.roster_id), w: 0, l: 0, t: 0, pointsFor: 0, pointsAgainst: 0 });
        const rec = h2h.get(opp);
        rec.name = rec.name || nameFor(oppEntry.roster_id);
        if (mine > theirs) rec.w++; else if (theirs > mine) rec.l++; else rec.t++;
        rec.pointsFor = r2(rec.pointsFor + mine); rec.pointsAgainst = r2(rec.pointsAgainst + theirs);
      }
    }

    seasons.push({
      season, leagueId: s.league.league_id, name: s.league.name,
      champion: championRow ? { rosterId: championRow.rosterId, ownerId: championRow.ownerId, teamName: nameFor(championRow.rosterId), isYou: Boolean(userId && championRow.ownerId === userId) } : null,
      you: mineRow ? {
        rosterId: mineRow.rosterId, teamName: nameFor(mineRow.rosterId), finish: finish.text, place: finish.place, finishSource: finish.source,
        record: `${mineRow.w}-${mineRow.l}${mineRow.t ? `-${mineRow.t}` : ''}`, w: mineRow.w, l: mineRow.l, t: mineRow.t, pointsFor: mineRow.pf,
      } : null,
    });
  }

  // Newest names win: raw is newest first, so re-read names from the first season each manager appears in.
  const allTime = [...owners.values()].map((a) => ({
    ...a, winPct: a.w + a.l + a.t ? r2((a.w + 0.5 * a.t) / (a.w + a.l + a.t)) : 0, pf: r2(a.pf), isYou: Boolean(userId && a.ownerId === userId),
  })).sort((a, b) => b.winPct - a.winPct || b.pf - a.pf);
  allTime.forEach((a, i) => { a.rank = i + 1; });

  const headToHead = [...h2h.values()].map((x) => ({ ...x, games: x.w + x.l + x.t }))
    .sort((a, b) => b.games - a.games || b.w - a.w);

  return { seasons, allTime, headToHead, bestWeek, yourBestWeek };
}

/**
 * The league's history. Unplayed seasons (the league's current one, still in
 * progress) are left out; the chain starts from it and runs back.
 * @param {{leagueId: string, username?: string}} p
 */
export async function buildHistory({ leagueId, username }, deps = defaultDeps, { max = MAX_SEASONS } = {}) {
  let userId = null;
  if (username) {
    try { userId = (await deps.getUser(username))?.user_id || null; } catch { userId = null; }
  }
  const chain = await walkChain(leagueId, { getLeague: deps.getLeague, max });
  if (!chain.length) return { available: false, message: 'That league could not be found on Sleeper.', seasons: [] };
  const finished = chain.filter((l, i) => !(i === 0 && l.status && l.status !== 'complete'));
  const raw = await pool(finished, CONCURRENCY, (l) => readSeason(l, deps));
  const out = assembleHistory(raw, userId);
  return {
    available: out.seasons.length > 0,
    message: out.seasons.length ? null : 'This league has no finished seasons on Sleeper yet. History fills in once a season is complete.',
    chainLength: chain.length,
    youFound: Boolean(userId),
    ...out,
  };
}

// Past seasons are final: keep the finished history in memory for twelve hours.
const memory = new Map();
const MAX_CACHED = 50;

export function historyReport(params, { now = Date.now, deps = defaultDeps } = {}) {
  const key = `${params.leagueId}|${String(params.username || '').toLowerCase()}`;
  const hit = memory.get(key);
  if (hit && now() - hit.at < HISTORY_TTL) return hit.promise;
  while (memory.size >= MAX_CACHED) memory.delete(memory.keys().next().value);
  const entry = { at: now(), promise: null };
  entry.promise = buildHistory(params, deps).catch((err) => {
    if (memory.get(key) === entry) memory.delete(key);
    throw err;
  });
  memory.set(key, entry);
  return entry.promise;
}

export function clearHistoryCache() { memory.clear(); }
