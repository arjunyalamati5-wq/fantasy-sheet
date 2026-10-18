// Lineup solver. Greedy "best player into the best slot" strands the only TE in
// a FLEX and leaves the TE slot empty, which costs a legal starter. We fill the
// most-restrictive slots first, then run a repair pass that searches for
// reassignment chains until no further improvement exists.

const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);

/** Which roster positions may legally fill each slot. */
export const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  DL: ['DL', 'DE', 'DT'],
  LB: ['LB'],
  DB: ['DB', 'CB', 'S'],
  FLEX: ['RB', 'WR', 'TE'],
  WRT: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  QB_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S'],
};

/** Plain-language slot names for the UI. */
export const SLOT_LABELS = {
  FLEX: 'Flex (RB/WR/TE)',
  WRT: 'Flex (RB/WR/TE)',
  WRRB_FLEX: 'Flex (RB/WR)',
  REC_FLEX: 'Flex (WR/TE)',
  SUPER_FLEX: 'Superflex (QB/RB/WR/TE)',
  QB_FLEX: 'Superflex (QB/RB/WR/TE)',
  IDP_FLEX: 'IDP Flex',
  DEF: 'Defense',
  K: 'Kicker',
};

export function slotLabel(slot) {
  return SLOT_LABELS[slot] || slot;
}

/** Starting slots only — drop bench, IR and taxi squad. */
export function startingSlots(rosterPositions = []) {
  return rosterPositions.filter((p) => !BENCH_SLOTS.has(p));
}

export function eligiblePositions(slot) {
  return SLOT_ELIGIBILITY[slot] || [slot];
}

export function isEligible(slot, position) {
  if (!position) return false;
  return eligiblePositions(slot).includes(position);
}

/**
 * A player's position may be listed several ways by Sleeper (fantasy_positions
 * is an array; position is a single string). Accept either.
 */
function positionsOf(player) {
  if (!player) return [];
  if (Array.isArray(player.fantasy_positions) && player.fantasy_positions.length) {
    return player.fantasy_positions;
  }
  return player.position ? [player.position] : [];
}

export function playerFitsSlot(slot, player) {
  const allowed = eligiblePositions(slot);
  return positionsOf(player).some((p) => allowed.includes(p));
}

/**
 * How many starting slots demand each position. A three-way flex counts as a
 * third of a slot toward each of RB/WR/TE, which is what makes replacement
 * level land in a sane place.
 */
export function slotDemand(slots) {
  const demand = {};
  for (const slot of slots) {
    const elig = eligiblePositions(slot);
    const share = 1 / elig.length;
    for (const pos of elig) demand[pos] = (demand[pos] || 0) + share;
  }
  return demand;
}

/**
 * Solve for the highest-scoring legal lineup.
 * @param {string[]} slots    starting slots, e.g. ['QB','RB','RB','WR','WR','TE','FLEX']
 * @param {Object[]} players  candidate players
 * @param {(p)=>number} valueOf  points/value for a player
 * @param {Object} opts       { exclude: Set<player_id>, pinned: Array<player|null> per slot }
 * @returns {{assignments: Array, total: number, unused: Array}}
 */
export function solveLineup(slots, players, valueOf, opts = {}) {
  const exclude = opts.exclude || new Set();
  if (opts.pinned?.some(Boolean)) return solvePinned(slots, players, valueOf, opts.pinned, exclude);
  const pool = players.filter((p) => p && !exclude.has(p.player_id));

  const value = new Map();
  for (const p of pool) value.set(p.player_id, Number(valueOf(p)) || 0);
  const v = (p) => (p ? value.get(p.player_id) || 0 : 0);

  // Eligibility per slot index.
  const eligibleFor = slots.map((slot) => pool.filter((p) => playerFitsSlot(slot, p)));

  // --- Pass 1: fill the most restrictive slots first. ---------------------
  // Restrictiveness = how few players could legally fill it. The only TE on a
  // roster makes the TE slot maximally restrictive, so it gets served before
  // any FLEX can eat him.
  const order = slots
    .map((slot, i) => ({ i, slot, n: eligibleFor[i].length }))
    .sort((a, b) => a.n - b.n || eligiblePositions(a.slot).length - eligiblePositions(b.slot).length);

  const assigned = new Array(slots.length).fill(null);
  const used = new Set();
  for (const { i } of order) {
    let best = null;
    for (const p of eligibleFor[i]) {
      if (used.has(p.player_id)) continue;
      if (!best || v(p) > v(best)) best = p;
    }
    if (best) {
      assigned[i] = best;
      used.add(best.player_id);
    }
  }

  // --- Pass 2: repair. ----------------------------------------------------
  // The greedy pass above is good but not guaranteed. Repairing it by hand —
  // "move this man here, shuffle that one there" — explodes combinatorially
  // once a lineup carries three flex slots, so the repair is done exactly
  // instead: this is an assignment problem (slots to players, maximise total),
  // and the Hungarian algorithm solves it in polynomial time. A greedy mistake
  // in pass 1 therefore cannot survive into the answer.
  const optimalAssignment = solveAssignment(slots, pool, v);

  const greedyTotal = assigned.reduce((s2, p) => s2 + v(p), 0);
  const exactTotal = optimalAssignment.reduce((s2, p) => s2 + v(p), 0);
  if (exactTotal > greedyTotal + 1e-9) {
    for (let i = 0; i < slots.length; i++) assigned[i] = optimalAssignment[i];
    used.clear();
    for (const p of assigned) if (p) used.add(p.player_id);
  }

  const assignments = slots.map((slot, i) => ({
    slot,
    slotLabel: slotLabel(slot),
    index: i,
    player: assigned[i],
    points: assigned[i] ? round2(v(assigned[i])) : 0,
  }));

  const total = round2(assignments.reduce((s, a) => s + a.points, 0));
  const unused = pool.filter((p) => !used.has(p.player_id));
  return { assignments, total, unused };
}

/**
 * Some starters cannot move: their game has kicked off. Hold them in their
 * slots and solve the open slots exactly, with everyone still movable.
 */
function solvePinned(slots, players, valueOf, pinned, exclude) {
  const pinnedIds = new Set(pinned.filter(Boolean).map((p) => p.player_id));
  const open = slots.map((_, i) => i).filter((i) => !pinned[i]);
  const sub = solveLineup(open.map((i) => slots[i]), players, valueOf, {
    exclude: new Set([...exclude, ...pinnedIds]),
  });
  const openPlayer = new Map(open.map((slotIndex, k) => [slotIndex, sub.assignments[k].player]));

  const assignments = slots.map((slot, i) => {
    const player = pinned[i] || openPlayer.get(i) || null;
    return { slot, slotLabel: slotLabel(slot), index: i, player, points: player ? round2(Number(valueOf(player)) || 0) : 0 };
  });
  const total = round2(assignments.reduce((s, a) => s + a.points, 0));
  return { assignments, total, unused: sub.unused };
}

/**
 * Score a lineup the manager has actually set. Sleeper's `starters` array is
 * ordered to match roster_positions, so we zip positionally rather than summing
 * the set — summing can report a total above the true optimum when a player
 * sits in a slot he isn't eligible for.
 */
export function scoreSetLineup(slots, starters = [], valueOf, playerById = null) {
  const assignments = slots.map((slot, i) => {
    const id = starters[i];
    const player = id && id !== '0' ? (playerById ? playerById(id) : { player_id: id }) : null;
    return {
      slot,
      slotLabel: slotLabel(slot),
      index: i,
      player,
      points: player ? round2(Number(valueOf(player)) || 0) : 0,
      empty: !player,
      illegal: player ? !playerFitsSlot(slot, player) : false,
    };
  });
  const total = round2(assignments.reduce((s, a) => s + a.points, 0));
  return { assignments, total };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Exact maximum-weight assignment of players to slots (Hungarian / Kuhn-Munkres,
 * O(slots^2 x players)). Ineligible pairings carry a prohibitive cost, so a slot
 * is left empty rather than filled illegally.
 *
 * @returns {Array} player (or null) per slot index
 */
function solveAssignment(slots, pool, v) {
  const n = slots.length;              // rows
  const m = Math.max(pool.length, n);  // columns, padded so n <= m
  if (n === 0) return [];

  const BIG = 1e7; // cost of an illegal or non-existent pairing
  const cost = (i, j) => {
    if (j >= pool.length) return BIG;                       // padding column
    if (!playerFitsSlot(slots[i], pool[j])) return BIG;      // illegal
    return -v(pool[j]);                                      // maximise value
  };

  const INF = Infinity;
  const u = new Float64Array(n + 1);
  const vv = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);   // p[j] = row matched to column j (1-indexed)
  const way = new Int32Array(m + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);

    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - vv[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; vv[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const out = new Array(n).fill(null);
  for (let j = 1; j <= m; j++) {
    const row = p[j];
    if (row === 0) continue;
    const slotIndex = row - 1;
    const playerIndex = j - 1;
    if (playerIndex >= pool.length) continue;                       // padding
    if (!playerFitsSlot(slots[slotIndex], pool[playerIndex])) continue; // illegal
    out[slotIndex] = pool[playerIndex];
  }
  return out;
}
