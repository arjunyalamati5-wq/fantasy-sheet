// Bye and injury planner: for every week left through the fantasy playoffs, where
// the lineup has holes (a bye, a player out or on IR), what the lineup scores
// without those players, and the best free agent to fill each hole THAT week.
// Reads the shared context; an off player is excluded, never zeroed by a guess.

import { solveLineup, eligiblePositions, playerFitsSlot } from '../lineup.js';
import { round2 } from '../scoring.js';
import { outInWeek, availabilityFactor, IR_DEFAULT_WEEKS, LAST_WEEK } from '../availability.js';
import { suggestBid } from '../faab.js';
import { faabContext } from './waivers.js';

const PLAYOFF_ROUNDS = 3;
/** A starter worth less than this share of the usual one is a hole, not a lineup. */
export const HOLE_SHARE = 0.6;
const POOL_PER_POSITION = 30;
const EXTRA_WEEK_WEIGHT = 0.5;
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const nameOf = (p) => p.name || p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || p.player_id;
const who = (p) => ({ player_id: p.player_id, name: nameOf(p), position: p.position, team: p.team || null });

/** Weeks the planner covers: this week through the third playoff week (never past 18). */
export function plannerWeeks(ctx) {
  const start = Number(ctx.week) || 1;
  const end = Math.min(LAST_WEEK, (Number(ctx.playoffWeekStart) || 15) + PLAYOFF_ROUNDS - 1);
  const out = [];
  for (let w = start; w <= end; w++) out.push(w);
  return out;
}

/** Why a player is off in a week ('LV bye', 'IR, back week 10', 'Out'), or null when he plays. */
export function offReason(ctx, p, week) {
  if (p.team && ctx.schedule?.isOnBye?.(p.team, week)) return `${p.team} bye`;
  const inj = ctx.injuryByPlayer?.get(p.player_id);
  if (!inj) return null;
  const returnWeek = ctx.irReturn?.get(p.player_id);
  if (!outInWeek({ status: inj.sleeperStatus, currentWeek: ctx.week, week, returnWeek })) return null;
  const status = inj.sleeperStatus;
  const long = status === 'IR' || status === 'PUP' || status === 'NA';
  if (!long) return status === 'Sus' ? 'Suspended' : 'Out';
  const back = Number(returnWeek);
  const backWeek = Number.isInteger(back) && back > ctx.week ? back : Number(ctx.week) + IR_DEFAULT_WEEKS;
  return `${status}, back week ${backWeek}`;
}

/** Expected points in a week: nothing when off, the usual value (trimmed for this week's designation). */
function pointsIn(ctx, p, week) {
  if (offReason(ctx, p, week)) return 0;
  const base = ctx.valueOf(p.player_id);
  if (Number(week) === Number(ctx.week)) return base * availabilityFactor(ctx.weekStatusOf?.(p.player_id) || null);
  return base;
}

const rangeText = (weeks) => {
  const out = [];
  let i = 0;
  while (i < weeks.length) {
    let j = i;
    while (j + 1 < weeks.length && weeks[j + 1] === weeks[j] + 1) j++;
    out.push(j > i ? `${weeks[i]}–${weeks[j]}` : String(weeks[i]));
    i = j + 1;
  }
  return out.join(', ');
};

/**
 * The full planner for one roster.
 * @param {object} [opts] { faab: precomputed faabContext (or null) }
 */
export async function plannerReport(ctx, rosterId = ctx.myRoster?.roster_id, opts = {}) {
  const weeks = plannerWeeks(ctx);
  const myPlayers = ctx.playersOn(rosterId);
  const playoffStart = Number(ctx.playoffWeekStart) || 15;
  const faab = opts.faab !== undefined ? opts.faab : (ctx.league?.settings ? await faabContext(ctx, rosterId) : null);

  // The usual lineup: everyone healthy, no byes. Holes are measured against it.
  const usual = solveLineup(ctx.slots, myPlayers, (p) => ctx.valueOf(p.player_id));
  const usualIds = new Set(usual.assignments.filter((a) => a.player).map((a) => a.player.player_id));

  // The lineup in every week, with off players excluded.
  const plan = weeks.map((week) => {
    const off = myPlayers.map((p) => ({ p, reason: offReason(ctx, p, week) })).filter((x) => x.reason);
    const offIds = new Set(off.map((x) => x.p.player_id));
    const solved = solveLineup(ctx.slots, myPlayers, (p) => pointsIn(ctx, p, week), { exclude: offIds });
    return { week, off, solved };
  });

  // Weeks each player starts, so a drop never costs a coming starter.
  const startsIn = new Map();
  for (const wk of plan) {
    for (const a of wk.solved.assignments) {
      if (!a.player) continue;
      if (!startsIn.has(a.player.player_id)) startsIn.set(a.player.player_id, new Set());
      startsIn.get(a.player.player_id).add(wk.week);
    }
  }

  // Holes per week.
  for (const wk of plan) {
    const missingPool = wk.off.filter((x) => usualIds.has(x.p.player_id));
    wk.holes = [];
    wk.solved.assignments.forEach((a, i) => {
      const usualA = usual.assignments[i];
      if (!usualA?.player || usualA.points <= 0) return;
      if (a.player && a.points >= HOLE_SHARE * usualA.points) return;
      // Who is missing: an unclaimed off starter who fits this slot, else any.
      let k = missingPool.findIndex((x) => playerFitsSlot(a.slot, x.p));
      if (k < 0) k = missingPool.length ? 0 : -1;
      const miss = k >= 0 ? missingPool.splice(k, 1)[0] : null;
      wk.holes.push({
        slot: a.slot, slotLabel: a.slotLabel, index: i,
        positions: eligiblePositions(a.slot),
        missing: miss ? { ...who(miss.p), reason: miss.reason } : (usualA.player ? { ...who(usualA.player), reason: 'Thin roster' } : null),
        usualPoints: round2(usualA.points), points: round2(a.points),
        fill: null,
      });
    });
  }

  // Free agents who could fill a hole, best few per position.
  const pool = ctx.freeAgents()
    .sort((a, b) => ctx.valueOf(b.player_id) - ctx.valueOf(a.player_id));
  const perPos = new Map();
  const candidates = [];
  for (const p of pool) {
    const n = perPos.get(p.position) || 0;
    if (!p.team || n >= POOL_PER_POSITION || ctx.valueOf(p.player_id) <= 0) continue;
    perPos.set(p.position, n + 1);
    candidates.push(p);
  }
  const rosterFull = !Array.isArray(ctx.rosterPositions) || ctx.rosterPositions.length === 0
    || myPlayers.length >= ctx.rosterPositions.length;

  for (const wk of plan) {
    const usedAdds = new Set();
    const usedDrops = new Set();
    for (const hole of wk.holes) {
      const fitsHole = (p) => hole.positions.includes(p.position);
      let best = null;
      for (const c of candidates) {
        if (usedAdds.has(c.player_id) || !fitsHole(c)) continue;
        const here = pointsIn(ctx, c, wk.week);
        if (here <= hole.points) continue;
        // Later weeks he also plays while a hole he fits is still open.
        const covers = [wk.week];
        let extra = 0;
        for (const other of plan) {
          if (other.week <= wk.week) continue;
          if (!other.holes.some((h) => h.positions.includes(c.position))) continue;
          const v = pointsIn(ctx, c, other.week);
          if (v <= 0) continue;
          covers.push(other.week);
          extra += v;
        }
        const score = here + EXTRA_WEEK_WEIGHT * extra;
        if (!best || score > best.score + 1e-9) best = { c, here, covers, score };
      }
      if (!best) continue;
      usedAdds.add(best.c.player_id);

      // A fill is a short-term pickup: price it at the league's typical claim
      // for his position, scaled by the share of the weeks left he would
      // actually start for you, and claim it the week before it is needed.
      const fillBid = (cand, lineupGain, holeWeek) => {
        const base = suggestBid({ position: cand.c.position, value: ctx.valueOf(cand.c.player_id), wouldStart: false, lineupGain }, faab.history, faab);
        const weeksLeft = Math.max(1, plan.length);
        const share = Math.min(1, (cand.covers?.length || 1) / weeksLeft);
        const typical = base.typical ?? base.suggested ?? 0;
        const suggested = Math.min(faab.remaining, Math.max(faab.minBid || 0, Math.round(typical * share)));
        const weeksText = (cand.covers?.length || 1) === 1 ? 'one week' : `${cand.covers.length} weeks`;
        const when = holeWeek > ctx.week + 1 ? ` Put the claim in during week ${holeWeek - 1}; no need to spend now.` : '';
        return {
          ...base,
          suggested,
          basis: 'fill',
          text: `He fills ${weeksText} of the ${weeksLeft} left, so bid about $${suggested.toLocaleString()} (a full-time ${cand.c.position} claim in your league typically goes for $${Number(typical).toLocaleString()}).${when} You have $${faab.remaining.toLocaleString()} left.`,
        };
      };

      let drop = null;
      if (rosterFull) {
        const needed = (p) => usualIds.has(p.player_id)
          || [...(startsIn.get(p.player_id) || [])].some((w) => w >= wk.week);
        const options = myPlayers
          .filter((p) => !needed(p) && !usedDrops.has(p.player_id) && !ctx.isLocked?.(p.player_id))
          .sort((a, b) => ctx.valueOf(a.player_id) - ctx.valueOf(b.player_id));
        if (options[0]) { drop = who(options[0]); usedDrops.add(drop.player_id); }
      }

      const gain = round2(best.here - hole.points);
      hole.fill = {
        ...who(best.c),
        points: round2(best.here),
        gain,
        covers: best.covers,
        coversText: rangeText(best.covers),
        drop,
        bid: faab ? fillBid(best, gain, wk.week) : null,
        whatIf: [`a.${best.c.player_id}`, ...(drop ? [`d.${drop.player_id}`] : [])],
      };
    }
  }

  // Assemble the weeks.
  const outWeeks = plan.map((wk) => ({
    week: wk.week,
    playoff: wk.week >= playoffStart,
    usualTotal: round2(usual.total),
    total: round2(wk.solved.total),
    delta: round2(wk.solved.total - usual.total),
    holes: wk.holes,
    off: wk.off.map((x) => ({ ...who(x.p), reason: x.reason, usual: usualIds.has(x.p.player_id) })),
    lineup: wk.solved.assignments.map((a) => ({
      slot: a.slot, slotLabel: a.slotLabel,
      player: a.player ? who(a.player) : null,
      points: a.points,
    })),
  }));

  const losing = outWeeks.filter((w) => w.holes.length > 0);
  const worst = [...losing]
    .sort((a, b) => a.delta - b.delta || b.holes.length - a.holes.length)
    .slice(0, 3)
    .map((w) => ({ week: w.week, loss: round2(-w.delta), holes: w.holes.length, playoff: w.playoff }));
  const pointsAtRisk = round2(losing.reduce((s, w) => s + Math.max(0, -w.delta), 0));

  return {
    week: Number(ctx.week), playoffWeekStart: playoffStart, weeks: outWeeks,
    summary: {
      weeksLeft: outWeeks.length, weeksWithHoles: losing.length, worst, pointsAtRisk,
      usualTotal: round2(usual.total), planAhead: planAhead(ctx, losing),
    },
    faab: faab ? { budget: faab.budget, remaining: faab.remaining } : null,
    emptyMessage: losing.length === 0 ? 'No holes in any week left.' : null,
  };
}

/** One line per notable week: how many starters are off, why, and the position to add by when. */
function planAhead(ctx, losing) {
  const lines = [];
  const notable = [...losing]
    .sort((a, b) => b.holes.length - a.holes.length || a.delta - b.delta)
    .slice(0, 4)
    .sort((a, b) => a.week - b.week);
  for (const w of notable) {
    const missing = w.holes.map((h) => h.missing).filter(Boolean);
    const reasons = missing.map((m) => (/bye$/.test(m.reason) ? 'bye' : 'out'));
    const why = reasons.length && reasons.every((r) => r === 'bye') ? 'on bye'
      : reasons.length && reasons.every((r) => r === 'out') ? 'out' : 'off';
    const n = w.holes.length;
    const count = n === 1 ? 'one starter' : `${WORDS[n] || n} starters`;
    const pos = [...new Set(w.holes.map((h) => (h.missing?.position || h.positions[0])))].join(' or ');
    const by = w.week - 1 < ctx.week ? 'now' : `by week ${w.week - 1}`;
    lines.push(`Week ${w.week}${w.playoff ? ' (playoffs)' : ''}: ${count} ${why}, about ${round2(-w.delta)} points down. Pick up a ${pos} ${by}.`);
  }
  return lines;
}
