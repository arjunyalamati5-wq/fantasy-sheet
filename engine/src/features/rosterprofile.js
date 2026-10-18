// Roster facts for the locker room and the home page: how old the roster is,
// who on it is hurt, whether the team is a contender or a rebuilder, and the
// trade value and usage columns on the roster table.

import { solveLineup } from '../lineup.js';
import { setStarters } from './lineup.js';
import { ageOf, teamProfiles, leagueKind, futurePicks } from './dynasty.js';
import { leagueOddsFor } from './oddsim.js';
import { dynastyMarketForContext } from '../fantasycalc.js';
import { getTradedPicks } from '../sleeper.js';

const AGE_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
const one = (n) => Math.round(n * 10) / 10;

/**
 * Average age by position for one roster against the whole league, from
 * Sleeper birth dates (their age field when a date is missing). Kickers and
 * defences are left out: their age says nothing about a roster.
 */
export function ageProfile(ctx, rosterId = ctx.myRoster?.roster_id, now = new Date()) {
  const agesOn = (id, pos) => ctx.playersOn(id).filter((p) => p.position === pos)
    .map((p) => ageOf(p, now)).filter((a) => a != null);
  const rows = AGE_POSITIONS.map((position) => {
    const mine = agesOn(rosterId, position);
    const league = ctx.rosters.flatMap((r) => agesOn(r.roster_id, position));
    const m = avg(mine); const l = avg(league);
    return {
      position, players: mine.length,
      mine: m == null ? null : one(m), league: l == null ? null : one(l),
      diff: m == null || l == null ? null : one(m - l),
    };
  });
  const all = (id) => AGE_POSITIONS.flatMap((pos) => agesOn(id, pos));
  const m = avg(all(rosterId)); const l = avg(ctx.rosters.flatMap((r) => all(r.roster_id)));
  if (m == null) {
    return { available: false, rows, mine: null, league: null, diff: null, sentence: 'Ages are not available for this roster yet.' };
  }
  const diff = one(m - (l ?? m));
  const rel = Math.abs(diff) < 0.3 ? 'about the same as the league'
    : `${Math.abs(diff).toFixed(1)} years ${diff < 0 ? 'younger' : 'older'} than the league's ${one(l).toFixed(1)}`;
  return {
    available: true, rows, mine: one(m), league: l == null ? null : one(l), diff,
    sentence: `Your roster averages ${one(m).toFixed(1)} years, ${rel}.`,
  };
}

const HURT = new Set(['Out', 'IR', 'PUP', 'Doubtful', 'Questionable', 'Sus', 'NA', 'DNR', 'Probable']);

/** Starters carrying an injury designation, worst first. */
export function injuryFlags(ctx, rosterId = ctx.myRoster?.roster_id) {
  const ids = setStarters(ctx, rosterId).filter(Boolean);
  const starters = ids.length ? ids.map((id) => ctx.playerOf(id)).filter(Boolean)
    : solveLineup(ctx.slots, ctx.playersOn(rosterId), (p) => ctx.valueOf(p.player_id))
      .assignments.map((a) => a.player).filter(Boolean);
  const order = ['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'Doubtful', 'Questionable', 'Probable'];
  const flags = [];
  for (const p of starters) {
    const inj = ctx.injuryByPlayer?.get(p.player_id);
    const status = ctx.weekStatusOf?.(p.player_id) || inj?.sleeperStatus || inj?.reportStatus;
    if (!status || !HURT.has(status)) continue;
    flags.push({
      player_id: p.player_id, name: p.name, position: p.position, status,
      bodyPart: inj?.bodyPart || null, practice: inj?.practiceStatus || null,
    });
  }
  flags.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return {
    flags, starters: starters.length,
    sentence: flags.length ? `${flags.length} of your ${starters.length} starters ${flags.length === 1 ? 'carries' : 'carry'} an injury flag.` : 'No injury flags on your starters.',
  };
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);

/** Contender or rebuilder, the age profile and the injury flags: the home page's three blocks in one call. */
export async function profileReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const kind = leagueKind(ctx.league);
  let dynasty = null; let picksHeld = null;
  if (kind !== 'redraft') {
    dynasty = await withTimeout(dynastyMarketForContext(ctx), 4000);
    const traded = await withTimeout(getTradedPicks(ctx.league.league_id), 4000);
    const held = futurePicks(ctx, { tradedPicks: traded || [], picks: dynasty?.picks || null });
    if (dynasty) picksHeld = new Map(held.teams.map((t) => [String(t.rosterId), t.value || 0]));
  }
  const odds = await leagueOddsFor(ctx);
  const profiles = teamProfiles(ctx, { dynasty, picksHeld, odds });
  const mine = profiles.find((p) => String(p.rosterId) === String(rosterId)) || null;
  return {
    kind, mine,
    league: profiles.map((p) => ({ rosterId: p.rosterId, teamName: p.teamName, isMine: p.isMine, label: p.label, word: p.word, quadrantText: p.quadrantText })),
    oddsUsed: Boolean(odds),
    age: ageProfile(ctx, rosterId),
    injuries: injuryFlags(ctx, rosterId),
  };
}

// ---------------------------------------------------------------- roster table extras

/** The lead's usage store, if it exists yet; null otherwise. */
export async function loadUsageStore(season) {
  try {
    const mod = await import('../usage/store.js');
    if (typeof mod.loadUsage !== 'function') return null;
    const u = await mod.loadUsage(season);
    return u && u.available ? u : null;
  } catch { return null; }
}

const share = (v) => (v == null || !Number.isFinite(Number(v)) ? null : (Number(v) > 1 ? Number(v) / 100 : Number(v)));

/** Average snap and target share for a player over the last four completed weeks of the usage store. */
export function usageFromStore(store, pid, week) {
  if (!store?.weekly) return null;
  const rows = store.weekly.filter((r) => String(r.pid) === String(pid) && r.week < week && r.week >= week - 4);
  if (!rows.length) return null;
  const mean = (key) => avg(rows.map((r) => share(r[key])).filter((v) => v != null));
  const snap = mean('snap_pct'); const tgt = mean('tgt_share');
  return { snap, target: tgt, games: rows.length };
}

/**
 * Add trade value (FantasyCalc) and usage (snap share, target share) to the
 * roster table rows. Either column is simply absent when its source is.
 * @returns {{rows, columns:{tradeValue:boolean, usage:boolean}}}
 */
export async function enrichRoster(ctx, rows, { market = null, store } = {}) {
  const usageStore = store !== undefined ? store : await loadUsageStore(ctx.season);
  let anyUsage = false; let anyValue = false;
  const out = rows.map((p) => {
    const m = market?.get(String(p.player_id));
    let usage = null;
    if (p.snapShare != null || p.targetShare != null) {
      usage = { snap: p.snapShare ?? null, target: p.targetShare ?? null, source: 'nflverse' };
    } else {
      const u = usageFromStore(usageStore, p.player_id, ctx.week);
      if (u) usage = { snap: u.snap, target: u.target, source: 'usage store' };
    }
    if (usage) anyUsage = true;
    if (m) anyValue = true;
    return { ...p, tradeValue: m ? { value: m.value, posRank: m.posRank ?? null } : null, usage };
  });
  return { rows: out, columns: { tradeValue: anyValue, usage: anyUsage } };
}
