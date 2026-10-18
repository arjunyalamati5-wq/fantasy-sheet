// Playoff and title odds as a library: the league's real remaining pairings
// and each team's strength, run through src/season.js with a FIXED seed so two
// runs (before and after a trade) differ only by the rosters, not by luck.

import { simulateSeason } from '../season.js';
import { teamStrength } from '../context.js';
import { getMatchups } from '../sleeper.js';

export const ODDS_RUNS = 3000;
export const ODDS_SEED = 20261017;

/** Group a week's matchup entries into [rosterA, rosterB] pairs. */
export function pairsFrom(entries = []) {
  const byMatchup = new Map();
  for (const e of entries) {
    if (e.matchup_id == null) continue;
    if (!byMatchup.has(e.matchup_id)) byMatchup.set(e.matchup_id, []);
    byMatchup.get(e.matchup_id).push(e.roster_id);
  }
  const pairs = [];
  for (const ids of byMatchup.values()) if (ids.length === 2) pairs.push([ids[0], ids[1]]);
  return pairs;
}

/** The regular-season weeks still to play, with the league's real pairings. */
export async function remainingPairings(ctx) {
  const last = (ctx.playoffWeekStart || 15) - 1;
  const out = [];
  for (let w = ctx.week; w <= last; w++) {
    const entries = w === ctx.week ? ctx.currentMatchups : await getMatchups(ctx.league.league_id, w);
    const pairs = pairsFrom(entries);
    if (pairs.length) out.push({ week: w, pairs });
  }
  return out;
}

const divisionOf = (r) => {
  const d = Number(r.settings?.division);
  return Number.isFinite(d) && d > 0 ? d : null;
};

/**
 * Simulate the rest of the season.
 * @param {Object} opts
 * @param {Map<string,{mean,sd}>} [opts.strengths] rosterId -> strength, overriding the current roster's
 * @returns simulateSeason() result (teams carry playoffOdds / titleOdds)
 */
export function simulateOdds(ctx, remainingWeeks, { runs = ODDS_RUNS, seed = ODDS_SEED, strengths = new Map() } = {}) {
  const teams = ctx.rosters.map((r) => {
    const s = r.settings || {};
    const st = strengths.get(String(r.roster_id)) || teamStrength(ctx, r.roster_id);
    return {
      rosterId: r.roster_id,
      name: ctx.teamName(r),
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      pointsFor: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      mean: st.mean, sd: st.sd,
    };
  });
  const ids = [...new Set(ctx.rosters.map(divisionOf).filter((d) => d !== null))];
  return simulateSeason({
    teams, remainingWeeks, playoffTeams: ctx.playoffTeams, runs, seed,
    divisions: ids.length >= 2 ? ctx.rosters.map(divisionOf) : undefined,
  });
}

/**
 * Blend two strengths by how many of the remaining weeks the new one covers.
 * A trade takes effect NEXT week, so the current week still plays with the old
 * roster: with n weeks left, the new roster covers n-1 of them.
 */
export function blendStrength(oldS, newS, newWeeks, totalWeeks) {
  if (!(totalWeeks > 0) || newWeeks <= 0) return { ...oldS };
  const f = Math.min(1, newWeeks / totalWeeks);
  return {
    mean: oldS.mean * (1 - f) + newS.mean * f,
    sd: Math.sqrt(oldS.sd ** 2 * (1 - f) + newS.sd ** 2 * f),
  };
}

const slice = (t) => (t ? { playoff: t.playoffOdds, title: t.titleOdds, wins: t.projectedWins } : null);

/**
 * Your playoff odds (and theirs) before and after a trade that takes effect
 * next week. Same seed both times, so the difference is the trade.
 * @param {object[]} myAfter    my players once the trade is done
 * @param {object[]} theirAfter their players once the trade is done
 * @param {Array} [remainingWeeks] injected pairings (tests); fetched otherwise
 */
export async function tradeOdds(ctx, { rosterId, partnerId, myAfter, theirAfter }, { remainingWeeks, runs = ODDS_RUNS } = {}) {
  const weeks = remainingWeeks || await remainingPairings(ctx);
  const totalWeeks = weeks.length;
  const afterWeeks = weeks.filter((w) => w.week > ctx.week).length;
  if (!totalWeeks) {
    return { available: false, reason: 'The regular season is over, so a trade no longer moves anyone\'s playoff odds.' };
  }
  const strengths = {
    meOld: teamStrength(ctx, rosterId),
    meNew: teamStrength(ctx, rosterId, { players: myAfter }),
    themOld: teamStrength(ctx, partnerId),
    themNew: teamStrength(ctx, partnerId, { players: theirAfter }),
  };
  const base = new Map(ctx.rosters.map((r) => [String(r.roster_id), teamStrength(ctx, r.roster_id)]));
  const before = simulateOdds(ctx, weeks, { runs, strengths: base });
  const changed = new Map(base);
  changed.set(String(rosterId), blendStrength(strengths.meOld, strengths.meNew, afterWeeks, totalWeeks));
  changed.set(String(partnerId), blendStrength(strengths.themOld, strengths.themNew, afterWeeks, totalWeeks));
  const after = simulateOdds(ctx, weeks, { runs, strengths: changed });
  const pick = (res, id) => res.teams.find((t) => String(t.rosterId) === String(id));
  const side = (id) => {
    const b = slice(pick(before, id)); const a = slice(pick(after, id));
    return {
      rosterId: id,
      playoffBefore: b.playoff, playoffAfter: a.playoff, playoffChange: a.playoff - b.playoff,
      titleBefore: b.title, titleAfter: a.title, titleChange: a.title - b.title,
    };
  };
  return {
    available: true,
    me: side(rosterId),
    them: side(partnerId),
    // Everyone's playoff odds before the trade (rosterId -> 0..1), for team labels.
    leagueBefore: Object.fromEntries(before.teams.map((t) => [String(t.rosterId), t.playoffOdds])),
    runs, seed: ODDS_SEED,
    weeksLeft: totalWeeks,
    weeksAffected: afterWeeks,
    note: afterWeeks === 0
      ? 'Only this week is left, and trades take effect next week, so the odds do not move.'
      : `Simulated ${runs.toLocaleString('en-US')} seasons twice with the same dice. Trades take effect next week, so the new rosters play the last ${afterWeeks} of ${totalWeeks} weeks.`,
  };
}

const memo = new WeakMap();
/**
 * Everyone's playoff odds right now (rosterId -> 0..1), or null when the
 * season is over or the pairings are unavailable. Kept per context object, so
 * several views in one request window share a single simulation.
 */
export function leagueOddsFor(ctx, opts = {}) {
  if (!memo.has(ctx)) {
    memo.set(ctx, (async () => {
      try {
        const weeks = opts.remainingWeeks || await remainingPairings(ctx);
        if (!weeks.length) return null;
        const res = simulateOdds(ctx, weeks, { runs: opts.runs || ODDS_RUNS });
        return Object.fromEntries(res.teams.map((t) => [String(t.rosterId), t.playoffOdds]));
      } catch { return null; }
    })());
  }
  return memo.get(ctx);
}
