import { lineupReport } from './lineup.js';
import { playerFitsSlot } from '../lineup.js';
import { getNews } from '../espn.js';
import { buildMatcher } from '../mentions.js';
import { round2 } from '../scoring.js';

// Game-day alerts for MY set lineup.
//
// Freshness, honestly: injury designations come from Sleeper's player
// catalogue (cached 12 h, as Sleeper asks: that file is ~5 MB and meant to be
// fetched about once a day) and the nflverse injury report (6 h). Neither
// moves on game day, so the freshest cheap signal is ESPN's news feed
// (cached 15 min): a headline that names one of my starters and says
// "ruled out" / "inactive" / "will not play" becomes an alert of its own.
// The set lineup itself comes from live matchups (30 s), so lineup changes
// are always current. Pass `news` to inject articles in tests.

const OUT = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR']);
const WORDS = { Sus: 'suspended', IR: 'on injured reserve', PUP: 'on the PUP list', NA: 'not active', DNR: 'out (did not report)' };
const QUESTIONABLE = new Set(['Questionable', 'Probable']);
const RANK = { Probable: 1, Questionable: 2, Doubtful: 3, Out: 4, IR: 4, PUP: 4, Sus: 4, NA: 4, DNR: 4 };
const OUT_HEADLINE = /\b(ruled out|will not play|won'?t play|inactive|declared out|placed on (injured reserve|ir)|downgraded to (out|doubtful)|sidelined)\b/i;

export const NEAR_MS = 90 * 60_000;
export const FAST_POLL_MS = 2 * 60_000;
export const SLOW_POLL_MS = 15 * 60_000;

// Last status seen per league+roster, so a later report can say "downgraded".
const lastSeen = new Map();
const MAX_SEEN = 200;

/** How long the page should wait before asking again. */
export function nextCheckMs(starters, now = Date.now()) {
  const soon = starters.some((s) => s.kickoff && s.kickoff > now && s.kickoff - now <= NEAR_MS);
  return soon ? FAST_POLL_MS : SLOW_POLL_MS;
}

const statusOf = (p) => p?.injury?.status || null;
const unavailable = (ctx, p) => {
  if (ctx.isLocked(p.player_id) || ctx.onByeThisWeek(p.player_id)) return true;
  const inj = ctx.injuryByPlayer.get(p.player_id);
  const st = inj?.sleeperStatus || inj?.reportStatus;
  return OUT.has(st) || st === 'Doubtful';
};

function bestReplacement(ctx, slot, pool, taken) {
  let best = null;
  for (const [p, source] of pool) {
    if (taken.has(p.player_id) || !playerFitsSlot(slot, p) || unavailable(ctx, p)) continue;
    // A bench player is free to start; a free agent costs a pickup, so he must clearly win.
    const score = ctx.pointsFor(p.player_id) + (source === 'bench' ? 1.5 : 0);
    if (!best || score > best.score) best = { p, source, score };
  }
  return best;
}

export async function alertsReport(ctx, opts = {}) {
  const now = opts.now ?? Date.now();
  const rosterId = ctx.myRoster?.roster_id;
  const report = lineupReport(ctx, rosterId);
  if (report.error) return { error: report.error };

  const week = ctx.week;
  const assignments = report.set.assignments;
  const startingIds = new Set(assignments.map((a) => a.player?.player_id).filter(Boolean));
  const kickoffOf = (p) => {
    const t = p.team ? ctx.schedule.gameFor(p.team, week)?.kickoff : null;
    return Number.isFinite(t) ? t : null;
  };

  // Candidates for a swap: the bench (free to start) and the best free agents.
  const pool = [];
  for (const p of ctx.playersOn(rosterId)) if (!startingIds.has(p.player_id)) pool.push([p, 'bench']);
  const freeAgents = (ctx.freeAgents?.() || []).filter((p) => !unavailable(ctx, p))
    .sort((a, b) => ctx.pointsFor(b.player_id) - ctx.pointsFor(a.player_id)).slice(0, 80);
  for (const p of freeAgents) pool.push([p, 'free agent']);

  // News: a starter named in a "ruled out" headline.
  let news = opts.news;
  if (!news) news = (await getNews({ limit: 50 }).catch(() => ({ articles: [] }))).articles || [];
  const starters = assignments.filter((a) => a.player).map((a) => a.player);
  const matcher = buildMatcher(starters.map((p) => ctx.playerOf(p.player_id)).filter(Boolean));
  const newsOut = new Map();
  for (const a of news) {
    const headline = a.headline || '';
    if (!OUT_HEADLINE.test(headline)) continue;
    // Only the headline, clause by clause: the player must be named in the
    // same clause that says "ruled out". An article's tags list everyone it
    // mentions, so "Williams to play; Hurts, Jackson ruled out" must not
    // flag a starter who is only mentioned further down the story.
    for (const clause of headline.split(/[;:|]|\s[-\u2013\u2014]\s/)) {
      if (!OUT_HEADLINE.test(clause)) continue;
      for (const m of matcher(clause)) {
        const id = m?.player_id ?? m;
        if (!newsOut.has(id)) newsOut.set(id, a);
      }
    }
  }

  const seenKey = `${ctx.league?.league_id}:${rosterId}:${week}`;
  const before = lastSeen.get(seenKey) || null;
  const after = new Map();
  const taken = new Set();
  const alerts = [];

  const swapFor = (slot, out) => {
    const best = bestReplacement(ctx, slot, pool, taken);
    if (!best) return null;
    taken.add(best.p.player_id);
    return {
      in: { player_id: best.p.player_id, name: best.p.name, position: best.p.position, team: best.p.team, projected: round2(ctx.pointsFor(best.p.player_id)), source: best.source },
      out: out ? { player_id: out.player_id, name: out.name, position: out.position } : null,
      slot,
      pointsGained: round2(ctx.pointsFor(best.p.player_id) - (out ? ctx.pointsFor(out.player_id) : 0)),
    };
  };

  for (const a of assignments) {
    if (!a.player) {
      alerts.push({
        id: `slot${a.index ?? a.slot}:empty:${week}`, level: 'urgent', player: null, status: 'Empty',
        text: `Your ${a.slotLabel} slot is empty. That is a guaranteed zero.`, kickoff: null, swap: swapFor(a.slot, null),
      });
      continue;
    }
    const p = a.player;
    if (ctx.isLocked(p.player_id)) continue; // his game has started: nothing can change
    const kick = kickoffOf(p);
    const kickoff = kick ? new Date(kick).toISOString() : null;
    const day = kick ? new Date(kick).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }) : 'this week';
    const status = statusOf(p);
    if (status) after.set(p.player_id, status);
    let raised = false;

    const push = (level, st, text) => {
      raised = true;
      alerts.push({ id: `${p.player_id}:${st}:${week}`, level, player: { player_id: p.player_id, name: p.name, position: p.position, team: p.team }, status: st, text, kickoff, slot: a.slot, swap: swapFor(a.slot, p) });
    };

    if (p.onBye) {
      push('urgent', 'Bye', `${p.name} is on bye this week and will score nothing.`);
    } else if (status && (OUT.has(status) || status === 'Doubtful')) {
      const prior = before?.get(p.player_id);
      const down = prior !== undefined ? (RANK[status] || 0) > (RANK[prior] || 0) : false;
      const label = status === 'Out' ? 'ruled out' : status === 'Doubtful' ? 'listed doubtful' : (WORDS[status] || status);
      const text = down && prior ? `${p.name} was downgraded from ${prior} to ${status}.`
        : `${p.name} is ${label} for ${day}.`;
      push('urgent', status, text);
    } else if (status && QUESTIONABLE.has(status)) {
      const prior = before?.get(p.player_id);
      const down = prior !== undefined && (RANK[status] || 0) > (RANK[prior] || 0);
      push('warn', status, `${p.name} is ${status.toLowerCase()} for ${day}${down ? ' (downgraded)' : ''}${p.injury?.practiceStatus ? `, practice: ${p.injury.practiceStatus}` : ''}.`);
    }

    const story = newsOut.get(p.player_id);
    if (story && !(status && (OUT.has(status)))) {
      alerts.push({
        id: `${p.player_id}:news-out:${week}`, level: raised ? 'info' : 'urgent',
        player: { player_id: p.player_id, name: p.name, position: p.position, team: p.team }, status: 'News',
        text: `News: ${story.headline}`, kickoff, slot: a.slot, link: story.link || null,
        swap: raised ? null : swapFor(a.slot, p),
      });
    }
  }

  lastSeen.set(seenKey, after);
  while (lastSeen.size > MAX_SEEN) lastSeen.delete(lastSeen.keys().next().value);

  const upcoming = starters.filter((p) => !ctx.isLocked(p.player_id)).map((p) => ({ kickoff: kickoffOf(p) }));
  const order = { urgent: 0, warn: 1, info: 2 };
  alerts.sort((x, y) => order[x.level] - order[y.level]);
  const nextMs = nextCheckMs(upcoming, now);
  return {
    week, rosterId, asOf: new Date(now).toISOString(),
    alerts, nextCheckMs: nextMs,
    sources: 'Sleeper injury designations (up to 12 h old), the official injury report (up to 6 h) and ESPN news (15 min).',
  };
}
