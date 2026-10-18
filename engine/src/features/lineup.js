import { scoreSetLineup, slotLabel, playerFitsSlot, solveLineup } from '../lineup.js';
import { round2 } from '../scoring.js';
import { displayTeam } from '../teams.js';
import { floorCeiling } from './floors.js';
import { gradeGame, nextMatchup } from './oppgrade.js';
import { horizonWeeks, weeklyPoints, lastRegularWeek } from './horizon.js';

/** Injury statuses that mean "he may not play at all". */
const SERIOUS = new Set(['Out', 'IR', 'PUP', 'Doubtful', 'Sus', 'NA', 'DNR']);
const QUESTIONABLE = new Set(['Questionable', 'Probable']);

/**
 * The lineup a manager has set, as player ids in slot order. For the week
 * being played, Sleeper's live matchups carry it (cached 30 s) and win over
 * the roster's own copy (cached 30 min), so a lineup change shows up within a
 * poll. Other weeks, or no matchup entry, fall back to the roster.
 */
export function setStarters(ctx, rosterId) {
  const current = !ctx.state || Number(ctx.week) === Number(ctx.state.week);
  if (current) {
    const entry = (ctx.currentMatchups || []).find((m) => String(m.roster_id) === String(rosterId));
    if (Array.isArray(entry?.starters) && entry.starters.length) return entry.starters;
  }
  return ctx.rosterOf(rosterId)?.starters || [];
}

export function lineupReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const roster = ctx.rosterOf(rosterId);
  if (!roster) return { error: 'No roster found' };

  const pointsFor = (p) => ctx.pointsFor(p.player_id);
  const set = scoreSetLineup(ctx.slots, setStarters(ctx, rosterId), pointsFor, (id) => ctx.playerOf(id));

  // Once a game kicks off Sleeper freezes everyone in it: a starter cannot
  // leave his slot and a bench player cannot come in. Solve around both, so
  // every suggested change is one the manager can still make.
  const starterIds = new Set(set.assignments.map((a) => a.player?.player_id).filter(Boolean));
  const pinned = set.assignments.map((a) => (a.player && ctx.isLocked(a.player.player_id) ? a.player : null));
  const lockedBench = new Set(ctx.playersOn(rosterId)
    .filter((p) => !starterIds.has(p.player_id) && ctx.isLocked(p.player_id))
    .map((p) => p.player_id));
  const optimal = ctx.solveFor(rosterId, pointsFor, { pinned, exclude: lockedBench });

  const decorate = (a) => ({
    slot: a.slot,
    slotLabel: slotLabel(a.slot),
    index: a.index,
    points: a.points,
    empty: !a.player,
    illegal: a.illegal || false,
    player: a.player ? describe(ctx, a.player) : null,
  });

  const swaps = pairSwaps(optimal.assignments, set.assignments).map(({ slot, inA, outA, via }) => ({
    slot,
    slotLabel: slotLabel(slot),
    startInstead: describe(ctx, inA.player),
    bench: outA.player ? describe(ctx, outA.player) : null,
    gain: round2(inA.points - outA.points),
    reasons: [
      // A slide between two slots of the same kind (WR to WR) is no move at all in Sleeper.
      ...via.filter((m) => m.from !== m.to)
        .map((m) => `Move ${m.player.name} from ${slotLabel(m.from)} to ${slotLabel(m.to)} to make room.`),
      ...swapReasons(ctx, inA.player, outA.player, slot),
    ],
  }));
  swaps.sort((a, b) => b.gain - a.gain);

  const alerts = [];
  for (const a of set.assignments) {
    if (!a.player) {
      alerts.push({ level: 'error', slot: a.slot, message: `Your ${slotLabel(a.slot)} slot is empty. That is a guaranteed zero.` });
      continue;
    }
    const p = a.player;
    // His game is under way: nothing about him can be changed any more.
    if (ctx.isLocked(p.player_id)) continue;
    if (ctx.onByeThisWeek(p.player_id)) {
      alerts.push({ level: 'error', slot: a.slot, player: p.name, message: `${p.name} is on bye this week and will score nothing.` });
    }
    const inj = ctx.injuryByPlayer.get(p.player_id);
    if (inj) {
      const status = inj.sleeperStatus || inj.reportStatus;
      if (status && SERIOUS.has(status)) {
        alerts.push({ level: 'error', slot: a.slot, player: p.name, message: `${p.name} is listed ${status}${inj.bodyPart ? ` (${inj.bodyPart})` : ''}. Find a replacement.` });
      } else if (status && QUESTIONABLE.has(status)) {
        alerts.push({ level: 'warn', slot: a.slot, player: p.name, message: `${p.name} is ${status}${inj.bodyPart ? ` (${inj.bodyPart})` : ''}${inj.practiceStatus ? `, practice: ${inj.practiceStatus}` : ''}. Check before kickoff.` });
      }
    }
    if (a.illegal) {
      alerts.push({ level: 'error', slot: a.slot, player: p.name, message: `${p.name} is a ${p.position} sitting in your ${slotLabel(a.slot)} slot, which he cannot fill.` });
    }
  }

  const inOptimal = new Set(optimal.assignments.map((a) => a.player?.player_id).filter(Boolean));
  const bench = ctx.playersOn(rosterId)
    .filter((p) => !inOptimal.has(p.player_id))
    .map((p) => describe(ctx, p))
    .sort((a, b) => b.projected - a.projected);

  return {
    rosterId,
    teamName: ctx.teamName(roster),
    week: ctx.week,
    roster: rosterTable(ctx, rosterId, new Set(set.assignments.map((a) => a.player?.player_id).filter(Boolean))),
    plan: {
      weeks: horizonWeeks(ctx, 'ros'),
      lastRegularWeek: lastRegularWeek(ctx),
      week: ctx.week,
      best: bestLineupFor(ctx, rosterId, { week: ctx.week }),
    },
    optimal: { total: optimal.total, assignments: optimal.assignments.map(decorate) },
    set: { total: set.total, assignments: set.assignments.map(decorate) },
    pointsLeftOnBench: round2(Math.max(0, optimal.total - set.total)),
    swaps,
    alerts,
    bench,
    locked: { starters: pinned.filter(Boolean).length, bench: lockedBench.size },
    // Did kickoff rule out a better lineup? Only then is "no moves left" true.
    blockedByLocks: (pinned.some(Boolean) || lockedBench.size > 0)
      && ctx.solveFor(rosterId, pointsFor).total - optimal.total > 0.05,
  };
}

/**
 * The changes as a manager would make them: each player the best lineup adds,
 * paired with the one he really replaces. Start from the slot the best lineup
 * gives him; whoever holds that slot now either leaves the lineup (that is the
 * pair) or just moves to another slot in the best lineup, so follow him there,
 * and so on. Those chains are exactly the rearrangement the solver found, so
 * the gains add up to the points left on the bench, and none can be negative
 * when the set lineup is legal (undoing one chain would beat the optimum).
 * When the new player can fill the dropped player's own slot the move is a
 * straight swap; otherwise `via` lists who has to slide over to make room.
 */
export function pairSwaps(optimalAssignments, setAssignments) {
  const optimalSlotOf = new Map();
  optimalAssignments.forEach((a, i) => { if (a.player) optimalSlotOf.set(a.player.player_id, i); });
  const inSet = new Set(setAssignments.map((a) => a.player?.player_id).filter(Boolean));

  const pairs = [];
  optimalAssignments.forEach((inA, start) => {
    if (!inA.player || inSet.has(inA.player.player_id)) return; // not a newcomer
    const via = [];
    let i = start;
    // Each step moves to a different slot, so a chain is never longer than the lineup.
    for (let step = 0; step < setAssignments.length; step++) {
      const held = setAssignments[i];
      const next = held.player ? optimalSlotOf.get(held.player.player_id) : undefined;
      if (next === undefined) {
        // He leaves the lineup (or the slot was empty): that is the pair.
        const direct = playerFitsSlot(held.slot, inA.player);
        pairs.push({ slot: direct ? held.slot : inA.slot, inA, outA: held, via: direct ? [] : via });
        return;
      }
      via.push({ player: held.player, from: held.slot, to: optimalAssignments[next].slot });
      i = next;
    }
  });
  return pairs;
}

function swapReasons(ctx, inP, outP, slot) {
  const reasons = [];
  const inPts = ctx.pointsFor(inP.player_id);
  if (!outP) {
    reasons.push(`Your ${slotLabel(slot)} slot is empty; ${inP.name} projects ${inPts.toFixed(1)} points.`);
    return reasons;
  }
  const outPts = ctx.pointsFor(outP.player_id);

  if (ctx.onByeThisWeek(outP.player_id)) {
    reasons.push(`${outP.name} is on bye.`);
  }
  const inj = ctx.injuryByPlayer.get(outP.player_id);
  const status = inj?.sleeperStatus || inj?.reportStatus;
  if (status && (SERIOUS.has(status) || QUESTIONABLE.has(status))) {
    reasons.push(`${outP.name} is listed ${status}${inj.bodyPart ? ` (${inj.bodyPart})` : ''}.`);
  }
  if (inPts > outPts) {
    // Take the gap between the numbers as printed, so the sentence adds up:
    // 10.3 against 10.2 is 0.1 more, whatever the unrounded values were.
    const inR = Math.round(inPts * 10) / 10;
    const outR = Math.round(outPts * 10) / 10;
    const edge = inR > outR ? `${(inR - outR).toFixed(1)} more points` : 'a fraction of a point more';
    reasons.push(`${inP.name} projects ${edge} this week (${inR.toFixed(1)} against ${outR.toFixed(1)}).`);
  }

  const inUsage = ctx.usageByPlayer.get(inP.player_id);
  const outUsage = ctx.usageByPlayer.get(outP.player_id);
  if (inUsage?.snapShare != null && outUsage?.snapShare != null
      && inUsage.snapShare > outUsage.snapShare + 0.1) {
    reasons.push(`${inP.name} is playing ${(inUsage.snapShare * 100).toFixed(0)}% of snaps against ${(outUsage.snapShare * 100).toFixed(0)}% for ${outP.name}.`);
  }
  if (reasons.length === 0) {
    reasons.push(`${inP.name} grades out slightly ahead on the blended projection.`);
  }
  return reasons;
}

/** Shared player shape used by every view. */
export function describe(ctx, p) {
  const v = ctx.valuations.byId.get(p.player_id);
  const usage = ctx.usageByPlayer.get(p.player_id);
  const inj = ctx.injuryByPlayer.get(p.player_id);
  const game = ctx.schedule.gameFor(p.team, ctx.week);
  return {
    player_id: p.player_id,
    name: p.name,
    position: p.position,
    team: displayTeam(p.team),
    projected: round2(ctx.pointsFor(p.player_id)),
    value: v?.value ?? 0,
    vor: v?.vor ?? 0,
    gamesPlayed: v?.gamesPlayed ?? 0,
    seasonAverage: v?.rawMean !== null && v?.rawMean !== undefined ? round2(v.rawMean) : null,
    resultsWeight: v?.resultsWeight ?? 0,
    onBye: ctx.onByeThisWeek(p.player_id),
    locked: ctx.isLocked(p.player_id),
    weather: ctx.weatherFor?.(p.team) ?? null,
    opponent: game ? (game.isHome ? `vs ${displayTeam(game.opponent)}` : `at ${displayTeam(game.opponent)}`) : null,
    gameTotal: game?.totalLine ?? null,
    injury: inj ? {
      status: inj.sleeperStatus || inj.reportStatus,
      bodyPart: inj.bodyPart,
      practiceStatus: inj.practiceStatus,
    } : null,
    snapShare: usage?.snapShare ?? null,
    targetShare: usage?.targetShare ?? null,
    targetsPerGame: usage?.targetsPerGame ?? null,
    carriesPerGame: usage?.carriesPerGame ?? null,
  };
}

// ---------------------------------------------------------------- the locker room

const POSITION_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };

/**
 * Every player on the roster in one table: his average, next week's projection
 * with a bad week and a good week, what is left of the regular season, and the
 * next opponent graded soft, average or tough.
 */
export function rosterTable(ctx, rosterId, starterIds = new Set()) {
  const weeks = horizonWeeks(ctx, 'ros');
  return ctx.playersOn(rosterId).map((p) => {
    const d = describe(ctx, p);
    const { floor, ceiling } = floorCeiling(ctx, p.position, d.projected);
    return {
      ...d,
      isStarter: starterIds.has(p.player_id),
      floor,
      ceiling,
      rosTotal: round2(weeks.reduce((sum, w) => sum + weeklyPoints(ctx, p, w), 0)),
      rosWeeks: weeks.filter((w) => !ctx.schedule?.isOnBye?.(p.team, w)).length,
      nextGame: nextMatchup(ctx, p),
    };
  }).sort((a, b) => (POSITION_ORDER[a.position] ?? 9) - (POSITION_ORDER[b.position] ?? 9) || b.projected - a.projected);
}

/** A player as seen in one particular week: his points, range, opponent and grade for that week. */
export function describeWeek(ctx, p, week) {
  const pts = round2(weeklyPoints(ctx, p, week));
  const onBye = Boolean(p.team && ctx.schedule?.isOnBye?.(p.team, week));
  const game = gradeGame(ctx, p, week);
  const { floor, ceiling } = floorCeiling(ctx, p.position, pts);
  return {
    ...describe(ctx, p),
    projected: pts,
    onBye,
    locked: Number(week) === Number(ctx.week) ? ctx.isLocked(p.player_id) : false,
    opponent: game ? game.opponent : null,
    grade: game?.grade ?? null,
    gradeRatio: game?.ratio ?? null,
    floor,
    ceiling,
  };
}

/** A pin lifts a player above any real score, so he starts if any legal slot allows. */
const PIN_BONUS = 1000;
const MAX_IDS = 40;

/**
 * The best legal lineup for any week, with your say-so applied: players you
 * pin start whenever a slot can legally hold them, players you bench stay out.
 * Points are the week's expected points (the projection for the week being
 * viewed, the blended per-game value for later weeks, nothing on a bye).
 * Unknown ids are ignored, and a player both pinned and benched is benched.
 */
export function bestLineupFor(ctx, rosterId, { week = ctx.week, pin = [], bench = [] } = {}) {
  const players = ctx.playersOn(rosterId);
  const onRoster = new Set(players.map((p) => p.player_id));
  const benched = new Set([...bench].slice(0, MAX_IDS).map(String).filter((id) => onRoster.has(id)));
  const pinned = new Set([...pin].slice(0, MAX_IDS).map(String).filter((id) => onRoster.has(id) && !benched.has(id)));
  const pts = (p) => weeklyPoints(ctx, p, week);

  const free = solveLineup(ctx.slots, players, pts);
  const solved = solveLineup(
    ctx.slots, players,
    (p) => pts(p) + (pinned.has(p.player_id) ? PIN_BONUS : 0),
    { exclude: benched },
  );

  const toRow = (p) => ({
    ...describeWeek(ctx, p, week),
    pinned: pinned.has(p.player_id),
    benched: benched.has(p.player_id),
  });
  const assignments = solved.assignments.map((a) => ({
    slot: a.slot,
    slotLabel: slotLabel(a.slot),
    index: a.index,
    empty: !a.player,
    points: a.player ? round2(pts(a.player)) : 0,
    player: a.player ? toRow(a.player) : null,
  }));
  const started = new Set(assignments.map((a) => a.player?.player_id).filter(Boolean));
  const total = round2(assignments.reduce((sum, a) => sum + a.points, 0));
  const freeTotal = round2(free.total);

  return {
    week: Number(week),
    total,
    unconstrainedTotal: freeTotal,
    // What your pins and benches cost against the unconstrained best lineup.
    cost: round2(Math.max(0, freeTotal - total)),
    assignments,
    bench: players.filter((p) => !started.has(p.player_id)).map(toRow)
      .sort((a, b) => b.projected - a.projected),
    pins: [...pinned],
    benches: [...benched],
    // Pins that no legal slot could hold.
    unplaced: [...pinned].filter((id) => !started.has(id)),
  };
}
