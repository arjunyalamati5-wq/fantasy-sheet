import { getSeasonProjections, adpKeyFor, readAdp } from '../adp.js';
import { scoreStats, round2 } from '../scoring.js';
import { slotDemand, solveLineup, startingSlots } from '../lineup.js';
import { mulberry32 } from '../random.js';

/**
 * Mock draft. The other managers draft off real ADP with a little randomness,
 * the way a room actually behaves — mostly by the board, occasionally reaching
 * for a need. You pick from what is left.
 *
 * Every player is valued in THIS league's scoring, so a superflex or
 * tight-end-premium league produces a different board from the default one.
 */
export async function buildMockDraft(ctx, { teams = ctx.numTeams, rounds = null, mySlot = 1, seed = null } = {}) {
  const season = await getSeasonProjections(ctx.season);
  if (!season.available) {
    return { available: false, emptyMessage: 'Season-long projections are unavailable right now, so a mock draft cannot be built.' };
  }

  const adpKeys = adpKeyFor({ slots: ctx.slots, scoring: ctx.scoring });
  const starters = startingSlots(ctx.rosterPositions);
  const totalRounds = rounds || Math.max(starters.length + 6, 14);

  // The board: everyone with an ADP, valued in this league's settings.
  const board = [];
  for (const [id, row] of Object.entries(season.byPlayer)) {
    const adp = readAdp(row.stats, adpKeys);
    if (adp == null) continue;
    const p = ctx.playerOf(id);
    const position = p?.position || row.position;
    if (!position) continue;
    board.push({
      player_id: id,
      name: p?.name || row.name || `Player ${id}`,
      position,
      team: p?.team || row.team || null,
      adp,
      seasonPoints: round2(scoreStats(row.stats, ctx.scoring)),
    });
  }
  if (board.length === 0) {
    return { available: false, emptyMessage: 'No players carried an average draft position for this league type.' };
  }
  board.sort((a, b) => a.adp - b.adp);

  return {
    available: true,
    teams,
    rounds: totalRounds,
    mySlot,
    starters,
    board: board.slice(0, 400),
    adpKey: adpKeys[0],
    seed: seed ?? 1,
    note: `Other managers draft off real average draft position with some randomness. Every player's season total is scored in your league's settings, so the board reflects your scoring rather than a generic one.`,
  };
}

/**
 * Advance a mock draft: the computer picks until it is the user's turn again.
 * Stateless — the client sends the picks so far and gets the next ones back.
 */
export function runMockPicks(ctx, { board, teams, rounds, mySlot, taken = [], seed = 1 }) {
  const rand = mulberry32(seed + taken.length * 7919);
  const gone = new Set(taken.map((t) => t.player_id));
  const picks = [];

  const demand = slotDemand(startingSlots(ctx.rosterPositions));
  const rosters = new Map();
  for (const t of taken) {
    if (!rosters.has(t.slot)) rosters.set(t.slot, []);
    rosters.get(t.slot).push(t);
  }

  const totalPicks = teams * rounds;
  let pickNo = taken.length + 1;

  while (pickNo <= totalPicks) {
    const round = Math.ceil(pickNo / teams);
    const idxInRound = ((pickNo - 1) % teams) + 1;
    // Snake order.
    const slot = round % 2 === 1 ? idxInRound : teams - idxInRound + 1;
    if (slot === mySlot) break; // hand control back to the user

    const available = board.filter((p) => !gone.has(p.player_id));
    if (available.length === 0) break;

    const mine = rosters.get(slot) || [];
    const choice = pickFor(available, mine, demand, rand);
    gone.add(choice.player_id);
    const entry = { ...choice, pickNo, round, slot, byUser: false };
    picks.push(entry);
    if (!rosters.has(slot)) rosters.set(slot, []);
    rosters.get(slot).push(entry);
    pickNo++;
  }

  const onTheClock = pickNo <= totalPicks
    ? { pickNo, round: Math.ceil(pickNo / teams), yours: true }
    : null;

  return { picks, onTheClock, complete: pickNo > totalPicks };
}

/**
 * How a computer manager chooses: take the best player available by ADP, from
 * a small window rather than strictly the top, and skip a position they have
 * already filled well past what they can start.
 */
function pickFor(available, roster, demand, rand) {
  const counts = {};
  for (const p of roster) counts[p.position] = (counts[p.position] || 0) + 1;

  const viable = available.filter((p) => {
    const need = demand[p.position] || 0;
    if (need === 0) return false;              // league never starts this position
    const have = counts[p.position] || 0;
    return have < Math.ceil(need) + 2;         // stop hoarding a filled position
  });

  const pool = (viable.length ? viable : available).slice(0, 6);
  // Weighted toward the top of the window, so the board is mostly respected.
  const weights = pool.map((_, i) => 1 / (i + 1.4));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Grade the user's finished mock roster by the lineup it can actually start. */
export function gradeMockRoster(ctx, myPicks) {
  const starters = startingSlots(ctx.rosterPositions);
  const players = myPicks.map((p) => ({
    player_id: p.player_id, name: p.name, position: p.position, fantasy_positions: [p.position],
  }));
  const values = Object.fromEntries(myPicks.map((p) => [p.player_id, p.seasonPoints || 0]));
  const lineup = solveLineup(starters, players, (p) => values[p.player_id] || 0);

  const byPos = {};
  for (const p of myPicks) byPos[p.position] = (byPos[p.position] || 0) + 1;

  return {
    startingTotal: round2(lineup.total),
    assignments: lineup.assignments.map((a) => ({
      slot: a.slot,
      name: a.player?.name || null,
      position: a.player?.position || null,
      seasonPoints: a.points,
    })),
    bench: lineup.unused.map((p) => ({ name: p.name, position: p.position, seasonPoints: values[p.player_id] || 0 })),
    byPosition: byPos,
    note: 'Totals are projected points for the whole season in your league\'s scoring, counting only the players who would actually start.',
  };
}
