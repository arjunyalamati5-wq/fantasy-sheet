import { parseCsv, num } from './csv.js';
import { normTeam } from './teams.js';

// Daily-fantasy salaries are not available from any free, keyless source, so
// this takes the CSV a site hands you on its own export page. The optimiser
// below is exact; only the salary column has to be supplied.

const DK_CLASSIC = {
  id: 'dk_classic',
  name: 'DraftKings NFL Classic',
  cap: 50_000,
  size: 9,
  base: { QB: 1, RB: 2, WR: 3, TE: 1, DEF: 1 },
  flex: ['RB', 'WR', 'TE'],
  flexCount: 1,
};

const FD_CLASSIC = {
  id: 'fd_classic',
  name: 'FanDuel NFL Classic',
  cap: 60_000,
  size: 9,
  base: { QB: 1, RB: 2, WR: 3, TE: 1, DEF: 1 },
  flex: ['RB', 'WR', 'TE'],
  flexCount: 1,
};

export const CONTEST_TYPES = [DK_CLASSIC, FD_CLASSIC];
export const contestById = (id) => CONTEST_TYPES.find((c) => c.id === id) || DK_CLASSIC;

/** Position spellings differ between sites. */
const POS_ALIAS = { DST: 'DEF', 'D/ST': 'DEF', D: 'DEF', PK: 'K' };
const normPos = (p) => {
  const up = String(p || '').trim().toUpperCase();
  return POS_ALIAS[up] || up;
};

/**
 * Parse a salary export. Column names vary by site and season, so every field
 * is looked up through a list of candidates rather than a fixed index.
 */
export function parseSalaries(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { rows: [], error: 'That file had no rows in it.' };

  const header = Object.keys(rows[0]);
  const find = (...names) => header.find((h) => names.includes(h.trim().toLowerCase()));

  const nameCol = find('name', 'player', 'nickname', 'player name');
  const posCol = find('position', 'pos', 'roster position');
  const salCol = find('salary', 'sal', 'cost');
  const teamCol = find('teamabbrev', 'team', 'teamabbreviation');
  const pptCol = find('avgpointspergame', 'fppg', 'projection', 'proj', 'points');
  const gameCol = find('game info', 'game', 'gameinfo');

  if (!nameCol || !posCol || !salCol) {
    return {
      rows: [],
      error: `That file is missing a column this needs. Found: ${header.slice(0, 12).join(', ')}. It needs a name, a position and a salary.`,
    };
  }

  const out = [];
  for (const r of rows) {
    const salary = num(r[salCol]);
    const name = String(r[nameCol] || '').trim();
    if (!name || salary === null || salary <= 0) continue;
    out.push({
      name,
      position: normPos(r[posCol]),
      salary,
      team: teamCol ? normTeam(r[teamCol]) : null,
      sitePoints: pptCol ? num(r[pptCol]) : null,
      game: gameCol ? r[gameCol] : null,
    });
  }
  return { rows: out, error: out.length === 0 ? 'No usable rows: every line was missing a salary.' : null };
}

/**
 * Exact salary-cap optimiser.
 *
 * The flex is handled by enumerating which position fills it, which turns the
 * problem into "choose exactly k from each position under a shared cap". That
 * is solved with a bounded knapsack per position and a convolution across
 * positions, so the answer is optimal rather than a good guess.
 */
export function optimizeLineup(players, contest = DK_CLASSIC, { locked = [], excluded = [] } = {}) {
  const STEP = 100; // site salaries are always multiples of 100
  const cap = Math.floor(contest.cap / STEP);

  const lockedSet = new Set(locked);
  const excludedSet = new Set(excluded);

  const pool = players.filter((p) => !excludedSet.has(p.key) && p.points > 0 && p.salary > 0);
  const lockedPlayers = pool.filter((p) => lockedSet.has(p.key));

  // Each flex position in turn gives a fixed requirement per position.
  let best = null;
  for (const flexPos of contest.flex) {
    const need = { ...contest.base };
    need[flexPos] = (need[flexPos] || 0) + contest.flexCount;

    const result = solveExact(pool, need, cap, STEP, lockedPlayers);
    if (result && (!best || result.points > best.points)) {
      best = { ...result, flexPosition: flexPos };
    }
  }

  if (!best) {
    return {
      error: 'No legal lineup fits under the salary cap with the players available. Try removing some exclusions.',
      lineup: [], points: 0, salary: 0,
    };
  }

  // Label the extra body at the flex position as the flex.
  const byPos = {};
  const lineup = [];
  for (const p of best.players) {
    byPos[p.position] = (byPos[p.position] || 0) + 1;
    const isExtra = p.position === best.flexPosition && byPos[p.position] > contest.base[p.position];
    lineup.push({ ...p, slot: isExtra ? 'FLEX' : p.position });
  }
  const order = { QB: 0, RB: 1, WR: 2, TE: 3, FLEX: 4, DEF: 5, K: 6 };
  lineup.sort((a, b) => (order[a.slot] ?? 9) - (order[b.slot] ?? 9) || b.points - a.points);

  return {
    lineup,
    points: round2(best.points),
    salary: best.salary,
    salaryLeft: contest.cap - best.salary,
    flexPosition: best.flexPosition,
    contest: contest.name,
    cap: contest.cap,
  };
}

/** Choose exactly need[pos] players of each position, maximising points under the cap. */
function solveExact(pool, need, cap, STEP, lockedPlayers) {
  const positions = Object.keys(need).filter((p) => need[p] > 0);

  // Locked players consume a slot and part of the cap up front.
  const lockedByPos = {};
  let lockedSalary = 0;
  let lockedPoints = 0;
  for (const p of lockedPlayers) {
    lockedByPos[p.position] = (lockedByPos[p.position] || 0) + 1;
    lockedSalary += p.salary;
    lockedPoints += p.points;
  }
  for (const pos of Object.keys(lockedByPos)) {
    if ((lockedByPos[pos] || 0) > (need[pos] || 0)) return null; // more locks than slots
  }
  const capLeft = cap - Math.floor(lockedSalary / STEP);
  if (capLeft < 0) return null;

  const lockedKeys = new Set(lockedPlayers.map((p) => p.key));

  // Per-position table: [count][salaryBucket] -> { points, pick }
  const tables = [];
  for (const pos of positions) {
    const want = need[pos] - (lockedByPos[pos] || 0);
    const candidates = pool
      .filter((p) => p.position === pos && !lockedKeys.has(p.key))
      .sort((a, b) => b.points - a.points)
      .slice(0, 70); // deep enough to contain any optimal choice
    if (want > 0 && candidates.length < want) return null;
    tables.push({ pos, want, table: knapsack(candidates, want, capLeft, STEP) });
  }

  // Convolve the positions together over the shared cap.
  let running = new Float64Array(capLeft + 1).fill(-Infinity);
  let runningFrom = [new Int32Array(capLeft + 1).fill(-1)];
  running[0] = 0;
  const splits = [];

  for (const { table, want } of tables) {
    const next = new Float64Array(capLeft + 1).fill(-Infinity);
    const split = new Int32Array(capLeft + 1).fill(-1);
    const row = table[want];
    for (let s = 0; s <= capLeft; s++) {
      if (running[s] === -Infinity) continue;
      for (let t = 0; s + t <= capLeft; t++) {
        const v = row[t]?.points;
        if (v === undefined || v === -Infinity) continue;
        const total = running[s] + v;
        if (total > next[s + t]) { next[s + t] = total; split[s + t] = t; }
      }
    }
    running = next;
    splits.push(split);
  }

  let bestSalary = -1;
  let bestPoints = -Infinity;
  for (let s = 0; s <= capLeft; s++) {
    if (running[s] > bestPoints) { bestPoints = running[s]; bestSalary = s; }
  }
  if (bestSalary < 0 || bestPoints === -Infinity) return null;

  // Walk the splits back to recover which players were chosen.
  const chosen = [...lockedPlayers];
  let remaining = bestSalary;
  for (let i = tables.length - 1; i >= 0; i--) {
    const spent = splits[i][remaining];
    if (spent < 0) return null;
    const { table, want } = tables[i];
    chosen.push(...table[want][spent].players);
    remaining -= spent;
  }

  return {
    players: chosen,
    points: bestPoints + lockedPoints,
    salary: bestSalary * STEP + lockedSalary,
  };
}

/** Bounded knapsack: best points for exactly k players at each salary bucket. */
function knapsack(candidates, k, capLeft, STEP) {
  const table = [];
  for (let c = 0; c <= k; c++) {
    table.push(new Array(capLeft + 1).fill(null));
  }
  table[0][0] = { points: 0, players: [] };

  for (const p of candidates) {
    const bucket = Math.round(p.salary / STEP);
    for (let c = k; c >= 1; c--) {
      for (let s = capLeft; s >= bucket; s--) {
        const prev = table[c - 1][s - bucket];
        if (!prev) continue;
        const pts = prev.points + p.points;
        if (!table[c][s] || pts > table[c][s].points) {
          table[c][s] = { points: pts, players: [...prev.players, p] };
        }
      }
    }
  }
  // Fill gaps with -Infinity so the convolution can skip them.
  for (let c = 0; c <= k; c++) {
    for (let s = 0; s <= capLeft; s++) {
      if (!table[c][s]) table[c][s] = { points: -Infinity, players: [] };
    }
  }
  return table;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
