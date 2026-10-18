import { slotDemand, solveLineup, startingSlots } from '../lineup.js';

// Pure draft arithmetic: value over replacement, tiers, snake order, needs,
// who is likely to be gone, and a draft grade. No network, no clock, no state,
// so every number here is unit-testable with a handful of fake players.

const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ------------------------------------------------------------ replacement level

/**
 * How many players of each position the league starts, all teams together.
 * A flex slot is shared by the positions that may fill it, so a FLEX that RB,
 * WR and TE can fill counts as a third of a starter at each.
 */
export function startersByPosition(rosterPositions, numTeams) {
  const slots = startingSlots(rosterPositions || []);
  const demand = slotDemand(slots);
  const out = {};
  for (const [pos, perTeam] of Object.entries(demand)) {
    out[pos] = { perTeam: round2(perTeam), league: Math.max(1, Math.round(perTeam * numTeams)) };
  }
  return out;
}

/**
 * Replacement level per position: the projected points of the last starter the
 * league can field there, i.e. what a manager gets by taking nobody special.
 * `rows` need { position, points }. A position with fewer players than starter
 * spots has no real replacement, so it falls back to its worst player.
 */
export function replacementLevels(rows, rosterPositions, numTeams) {
  const starters = startersByPosition(rosterPositions, numTeams);
  const out = [];
  for (const [position, s] of Object.entries(starters)) {
    const pts = rows.filter((r) => r.position === position && Number.isFinite(r.points))
      .map((r) => r.points).sort((a, b) => b - a);
    if (!pts.length) continue;
    const idx = Math.min(s.league, pts.length) - 1;
    out.push({
      position,
      startersPerTeam: s.perTeam,
      startersInLeague: s.league,
      replacementRank: idx + 1,
      replacementPoints: round1(pts[idx]),
    });
  }
  return out.sort((a, b) => b.startersInLeague - a.startersInLeague || a.position.localeCompare(b.position));
}

/**
 * Rank every player by value over replacement. A position the league never
 * starts is left out. Sorted by VOR, then points, then name (so ties never
 * reshuffle between requests).
 */
export function rankByVor(rows, levels) {
  const base = new Map(levels.map((l) => [l.position, l.replacementPoints]));
  const ranked = rows
    .filter((r) => base.has(r.position) && Number.isFinite(r.points))
    .map((r) => ({ ...r, vor: round1(r.points - base.get(r.position)) }))
    .sort((a, b) => b.vor - a.vor || b.points - a.points || String(a.name).localeCompare(String(b.name)));
  const seen = {};
  ranked.forEach((r, i) => {
    r.rank = i + 1;
    seen[r.position] = (seen[r.position] || 0) + 1;
    r.posRank = seen[r.position];
  });
  return ranked;
}

// ----------------------------------------------------------------------- tiers

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Split one position's VOR-sorted list into tiers at its natural gaps: a break
 * goes where the drop between neighbours is more than `factor` times the
 * typical (median) drop, biggest drops first, at most `maxTiers` tiers, and
 * never leaving a lone player stranded below the first tier.
 * @returns {number[]} indexes where a new tier starts (never 0)
 */
export function tierBreaks(vors, { factor = 2, maxTiers = 6, minSize = 2 } = {}) {
  if (vors.length < 3) return [];
  const gaps = [];
  for (let i = 1; i < vors.length; i++) gaps.push({ at: i, gap: vors[i - 1] - vors[i] });
  const typical = median(gaps.map((g) => g.gap));
  const floor = Math.max(typical * factor, 0.5);
  const candidates = gaps.filter((g) => g.gap > floor).sort((a, b) => b.gap - a.gap || a.at - b.at);

  const accepted = [];
  for (const c of candidates) {
    if (accepted.length >= maxTiers - 1) break;
    const trial = [...accepted, c.at].sort((a, b) => a - b);
    const edges = [0, ...trial, vors.length];
    let ok = true;
    for (let k = 1; k < edges.length; k++) {
      const size = edges[k] - edges[k - 1];
      if (size < (k === 1 ? 1 : minSize)) { ok = false; break; }
    }
    if (ok) accepted.push(c.at);
  }
  return accepted.sort((a, b) => a - b);
}

/**
 * Assign tiers within each position and summarise them.
 * Only players worth drafting enter a tier: those above replacement, plus the
 * first `depth` of each position, so the tail never makes tiers of its own.
 * @returns {{ ranked: Array, tiers: Array }}
 */
export function assignTiers(ranked, opts = {}) {
  const byPos = new Map();
  for (const r of ranked) {
    if (!byPos.has(r.position)) byPos.set(r.position, []);
    byPos.get(r.position).push(r);
  }
  const tiers = [];
  for (const [position, list] of byPos) {
    const pool = list.filter((r, i) => r.vor > 0 || i < 3);
    const breaks = tierBreaks(pool.map((r) => r.vor), opts);
    const edges = [0, ...breaks, pool.length];
    for (let k = 0; k < edges.length - 1; k++) {
      const members = pool.slice(edges[k], edges[k + 1]);
      for (const m of members) m.tier = k + 1;
      tiers.push({
        position,
        tier: k + 1,
        count: members.length,
        vorHigh: members[0].vor,
        vorLow: members[members.length - 1].vor,
        gapBefore: k === 0 ? null : round1(pool[edges[k] - 1].vor - members[0].vor),
        players: members.map((m) => ({ id: m.id, name: m.name, team: m.team ?? null, vor: m.vor, adp: m.adp ?? null })),
      });
    }
    for (const r of list) if (r.tier == null) r.tier = null; // below the pool: untiered
  }
  return { ranked, tiers };
}

// ---------------------------------------------------------------- draft order

/**
 * Which draft slot picks at overall pick `pickNo`.
 * snake alternates; linear repeats; reversalRound (third-round reversal) makes
 * that round run the same way as the one before it.
 */
export function slotForPick(pickNo, teams, { type = 'snake', reversalRound = 0 } = {}) {
  const round = Math.ceil(pickNo / teams);
  const idx = ((pickNo - 1) % teams) + 1;
  if (type === 'linear') return idx;
  const eff = reversalRound > 0 && round >= reversalRound ? round - 1 : round;
  return eff % 2 === 1 ? idx : teams - idx + 1;
}

/**
 * The full pick order, with traded picks applied.
 * @param slotToRoster  { slot: rosterId }
 * @param tradedPicks   Sleeper rows { round, roster_id (original), owner_id (now) }
 * @returns [{ pickNo, round, slot, originalRosterId, rosterId, traded }]
 */
export function buildOrder({ teams, rounds, type = 'snake', reversalRound = 0, slotToRoster = {}, tradedPicks = [] }) {
  const owner = new Map(); // `${round}:${originalRosterId}` -> current owner
  for (const t of tradedPicks || []) {
    if (t?.round == null || t.roster_id == null || t.owner_id == null) continue;
    owner.set(`${t.round}:${t.roster_id}`, Number(t.owner_id));
  }
  const out = [];
  for (let pickNo = 1; pickNo <= teams * rounds; pickNo++) {
    const round = Math.ceil(pickNo / teams);
    const slot = slotForPick(pickNo, teams, { type, reversalRound });
    const original = slotToRoster[slot] != null ? Number(slotToRoster[slot]) : null;
    const now = original != null && owner.has(`${round}:${original}`) ? owner.get(`${round}:${original}`) : original;
    out.push({ pickNo, round, slot, originalRosterId: original, rosterId: now, traded: original != null && now !== original });
  }
  return out;
}

/** Pick numbers a roster holds from `fromPick` on. */
export function picksOf(order, rosterId, fromPick = 1) {
  return order.filter((p) => p.pickNo >= fromPick && p.rosterId != null && String(p.rosterId) === String(rosterId)).map((p) => p.pickNo);
}

// ---------------------------------------------------------------------- needs

/**
 * The starting slots a set of players cannot yet fill, solved as a real lineup
 * (so a lone TE is not counted twice as TE and flex).
 * @param mine  [{ id, position, points }]
 */
export function startingNeeds(rosterPositions, mine) {
  const slots = startingSlots(rosterPositions || []);
  const players = mine.map(asLineupPlayer);
  const { assignments } = solveLineup(slots, players, (p) => p.points || 0);
  const open = assignments.filter((a) => !a.player).map((a) => a.slot);
  const counts = {};
  for (const s of open) counts[s] = (counts[s] || 0) + 1;
  return { open, counts, filled: open.length === 0, total: slots.length };
}

function asLineupPlayer(p) {
  return { player_id: p.id, name: p.name, position: p.position, fantasy_positions: [p.position], points: p.points || 0 };
}

/** Positions that would fill an open slot, for nudging a pick toward need. */
export function positionsNeeded(openSlots, eligibleOf) {
  const out = new Set();
  for (const s of openSlots) for (const p of eligibleOf(s)) out.add(p);
  return out;
}

// ----------------------------------------------------------- runs & likely gone

/** Picks by position over the last `window` picks. A run is `runAt`+ of one position. */
export function positionalRuns(picks, { window = 10, runAt = 4 } = {}) {
  const recent = picks.slice(-window);
  const counts = {};
  for (const p of recent) if (p.position) counts[p.position] = (counts[p.position] || 0) + 1;
  const rows = Object.entries(counts)
    .map(([position, count]) => ({ position, count, run: count >= runAt }))
    .sort((a, b) => b.count - a.count || a.position.localeCompare(b.position));
  return { window: recent.length, rows, runs: rows.filter((r) => r.run).map((r) => r.position) };
}

/**
 * Players still on the board whose ADP is earlier than your next pick: the
 * room's own numbers say they will not wait for you.
 */
export function likelyGone(available, nextPickNo) {
  if (!Number.isFinite(nextPickNo)) return [];
  return available
    .filter((p) => Number.isFinite(p.adp) && p.adp < nextPickNo)
    .sort((a, b) => a.adp - b.adp);
}

/** Value of a pick: the pick number against ADP. Positive means he lasted longer than the room expected. */
export function pickValue(pickNo, adp) {
  if (!Number.isFinite(adp)) return null;
  const delta = round1(pickNo - adp);
  const threshold = Math.max(4, Math.round(adp * 0.12));
  return { delta, kind: delta <= -threshold ? 'reach' : delta >= threshold ? 'steal' : 'fair' };
}

// ----------------------------------------------------------------- draft grade

/**
 * Project every team's starting lineup from what it drafted and compare each
 * with the median team. A team with no picks yet projects to zero, and is
 * left out of the medians so a half-finished draft is not graded on blanks.
 * @param picksByRoster Map or object: rosterId -> [{ id, position, points }]
 */
export function gradeDraft(rosterPositions, picksByRoster) {
  const entries = picksByRoster instanceof Map ? [...picksByRoster.entries()] : Object.entries(picksByRoster);
  const slots = startingSlots(rosterPositions || []);
  const teams = entries.map(([rosterId, picks]) => {
    const { assignments, total } = solveLineup(slots, picks.map(asLineupPlayer), (p) => p.points || 0);
    const byPosition = {};
    for (const a of assignments) if (a.player) byPosition[a.player.position] = round1((byPosition[a.player.position] || 0) + a.points);
    return { rosterId: String(rosterId), picks: picks.length, total: round1(total), byPosition, open: assignments.filter((a) => !a.player).length };
  });
  const counted = teams.filter((t) => t.picks > 0);
  const medianTotal = round1(median(counted.map((t) => t.total)));
  const positions = [...new Set(counted.flatMap((t) => Object.keys(t.byPosition)))].sort();
  const medianByPosition = {};
  for (const pos of positions) medianByPosition[pos] = round1(median(counted.map((t) => t.byPosition[pos] || 0)));
  const graded = teams.map((t) => ({ ...t, vsMedian: t.picks ? round1(t.total - medianTotal) : null }))
    .sort((a, b) => b.total - a.total);
  graded.forEach((t, i) => { t.rank = t.picks ? i + 1 : null; });
  return { teams: graded, medianTotal, medianByPosition, positions };
}

// ------------------------------------------------------------------- countdown

/** Time until a start time (ms epoch), in parts. */
export function countdown(startTime, now = Date.now()) {
  const t = Number(startTime);
  if (!Number.isFinite(t) || t <= 0) return { state: 'unset', startTime: null };
  const ms = t - now;
  if (ms <= 0) return { state: 'started', startTime: t, msUntil: 0 };
  const mins = Math.floor(ms / 60_000);
  return { state: 'upcoming', startTime: t, msUntil: ms, days: Math.floor(mins / 1440), hours: Math.floor((mins % 1440) / 60), minutes: mins % 60 };
}
