// The playoff bracket: built from the seeds and the league's own playoff
// settings, scored like a regular-season game, with exact title odds.
//
//  - byes for the top seeds when the field is not a power of two
//  - the usual 1v8, 4v5, 2v7, 3v6 pairings, and reseeding if the league reseeds
//  - a round's win chance is the normal CDF of the mean gap over the combined
//    spread; a two-week round adds the two weeks' means and variances
//  - exact odds walk every possible set of results, so they add to 100%
//  - a losers bracket (toilet bowl: the loser advances, or consolation: the
//    winner advances) runs on the same machinery
//  - results Sleeper has published are locked in; picks fill the open games
//
// Every team is {seed, rosterId}. "Advancing" is the word for who moves on in
// a game: the winner, except in a toilet bowl, where it is the loser.

const MAX_WALK = 4_000_000; // outcomes we are willing to enumerate exactly

export const UPSET_MIN = 0.5;
export const UPSET_MAX = 2.0;
export const LOSERS_STYLES = ['sleeper', 'toilet', 'consolation'];

// ---------------------------------------------------------------- small maths

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** The upset factor must be a number from 0.5 to 2.0; missing means 1. */
export function validateUpset(value) {
  if (value === undefined || value === null || value === '') return 1;
  const v = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(v) || v < UPSET_MIN || v > UPSET_MAX) {
    throw new RangeError(`The upset factor must be between ${UPSET_MIN} and ${UPSET_MAX}.`);
  }
  return v;
}

export function validateLosersStyle(value) {
  if (value === undefined || value === null || value === '') return 'sleeper';
  const v = String(value).trim().toLowerCase();
  if (!LOSERS_STYLES.includes(v)) throw new RangeError('The losers bracket style must be sleeper, toilet or consolation.');
  return v;
}

// ---------------------------------------------------------------- structure

/** Smallest power of two holding n teams. */
export function bracketSize(n) {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}

/**
 * Seeds in bracket order for a field of `size` (a power of two): neighbours
 * play each other, so 8 gives 1v8, 4v5, 2v7, 3v6, with 1 and 2 on opposite sides.
 */
export function seedOrder(size) {
  let order = [1];
  for (let sz = 1; sz < size; sz *= 2) order = order.flatMap((s) => [s, 2 * sz + 1 - s]);
  return order;
}

/**
 * The weeks each round is played in. roundType follows Sleeper:
 * 0 one week per round, 1 a two-week championship, 2 two weeks every round.
 */
export function roundWeeks(rounds, roundType = 0, startWeek = 15) {
  const out = [];
  let w = startWeek;
  for (let r = 0; r < rounds; r++) {
    const two = roundType === 2 || (roundType === 1 && r === rounds - 1);
    out.push(two ? [w, w + 1] : [w]);
    w += two ? 2 : 1;
  }
  return out;
}

/** Playoff settings out of a Sleeper league's settings object. */
export function playoffSettings(settings = {}, teams) {
  const s = settings || {};
  const n = Number(teams ?? s.playoff_teams) || 6;
  const start = Number(s.playoff_week_start) || 15;
  const roundType = [0, 1, 2].includes(Number(s.playoff_round_type)) ? Number(s.playoff_round_type) : 0;
  return { teams: n, startWeek: start, roundType, reseed: Number(s.playoff_seed_type) === 1 };
}

/**
 * Which way the league's own losers bracket runs, from its settings. Sleeper
 * keeps this in settings.playoff_type / a loser-bracket field; only a clear
 * value counts, otherwise null (and the caller defaults to the toilet bowl).
 */
export function leagueLosersAdvance(settings = {}) {
  const s = settings || {};
  for (const key of ['loser_bracket_type', 'losers_bracket_type', 'playoff_loser_type']) {
    const v = s[key];
    if (v === undefined || v === null) continue;
    const t = String(v).toLowerCase();
    if (t === 'toilet' || t === 'toilet_bowl' || t === '1') return 'loser';
    if (t === 'consolation' || t === '0') return 'winner';
  }
  return null;
}

/** From a Sleeper losers_bracket: loser-advances if its games feed from losers. */
export function inferLosersAdvance(items) {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    if (it?.t1_from?.l !== undefined || it?.t2_from?.l !== undefined) return 'loser';
  }
  for (const it of items) {
    if (it?.t1_from?.w !== undefined || it?.t2_from?.w !== undefined) return 'winner';
  }
  return null;
}

const roundName = (r, rounds, byes) => {
  const left = rounds - r + 1; // 1 = the final
  if (left === 1) return 'Championship';
  if (left === 2) return 'Semifinals';
  if (r === 1 && byes > 0 && rounds >= 3) return 'Wild card';
  if (left === 3) return 'Quarterfinals';
  return `Round ${r}`;
};

/**
 * Pair one round. `state` is the teams still in, in bracket order (null =
 * an empty slot, which hands the other team a bye). A reseeding league pairs
 * the best seed left with the worst after round one.
 */
function pairRound(state, r, reseed) {
  let list = state;
  if (reseed && r > 0) list = [...state].sort((a, b) => a.seed - b.seed);
  const items = [];
  const half = list.length / 2;
  for (let k = 0; k < half; k++) {
    const a = reseed && r > 0 ? list[k] : list[2 * k];
    const b = reseed && r > 0 ? list[list.length - 1 - k] : list[2 * k + 1];
    if (a && b) items.push({ game: true, a, b });
    else items.push({ game: false, team: a || b });
  }
  return items;
}

/**
 * @param {Array} seeds     rosterIds (or any ids) in seed order, best first
 * @param {Object} settings { reseed, advance: 'winner'|'loser', startWeek, roundType, weeks }
 */
export function buildBracket(seeds, settings = {}) {
  const ids = seeds.map(String);
  if (new Set(ids).size !== ids.length) throw new Error('A bracket cannot seat the same team twice.');
  const n = ids.length;
  const reseed = !!settings.reseed;
  const advance = settings.advance === 'loser' ? 'loser' : 'winner';
  const teams = ids.map((rosterId, i) => ({ seed: i + 1, rosterId }));
  const size = bracketSize(Math.max(n, 1));
  const rounds = n >= 2 ? Math.log2(size) : 0;
  const weeks = settings.weeks || roundWeeks(rounds, settings.roundType ?? 0, settings.startWeek ?? 15);

  const padded = seedOrder(size).map((s) => teams[s - 1] || null);
  const out = {
    n, size, reseed, advance, teams, locks: [], picks: [],
    byes: [], rounds: [],
  };
  if (n < 2) return out;

  // The first round with an empty slot gives its lone team a bye; shown
  // as a team that appears in a later round without a game before it.
  let state = padded;
  for (let r = 0; r < rounds; r++) {
    const symbolic = reseed && r > 0;
    const items = symbolic
      ? Array.from({ length: state.length / 2 }, () => ({ game: true, a: null, b: null }))
      : pairRound(state, r, false);
    const games = [];
    let m = 0;
    const next = [];
    for (const it of items) {
      if (!it.game) {
        next.push(it.team);
        if (r === 0) out.byes.push(it.team);
        continue;
      }
      m += 1;
      const id = `${r + 1}-${m}`;
      games.push({
        id, round: r + 1, m,
        slots: symbolic
          ? [{ reseed: 'higher' }, { reseed: 'lower' }]
          : [slotOf(it.a), slotOf(it.b)],
      });
      next.push({ from: id, seed: Infinity });
    }
    out.rounds.push({
      round: r + 1, name: roundName(r + 1, rounds, out.byes.length), weeks: weeks[r] || [(settings.startWeek ?? 15) + r],
      games,
    });
    state = next;
  }
  out.byes.sort((a, b) => a.seed - b.seed);
  return out;
}

function slotOf(x) {
  if (x.from) return { from: x.from };
  return { seed: x.seed, rosterId: x.rosterId };
}

// ---------------------------------------------------------------- game odds

const FALLBACK = { mean: 100, sd: 25 };

function weekStrength(strength, rosterId, week) {
  const s = strength?.[rosterId] ?? (strength instanceof Map ? strength.get(rosterId) : null);
  if (!s) return FALLBACK;
  if (s.weeks && s.weeks[week]) return s.weeks[week];
  return { mean: Number.isFinite(s.mean) ? s.mean : FALLBACK.mean, sd: Number.isFinite(s.sd) ? s.sd : FALLBACK.sd };
}

/** A team's total over a round's weeks: means add, so do variances. Spread is scaled by the upset factor. */
export function roundTotal(strength, rosterId, weeks, upset = 1) {
  let mean = 0;
  let variance = 0;
  for (const w of weeks) {
    const s = weekStrength(strength, rosterId, w);
    mean += s.mean;
    variance += (s.sd * upset) ** 2;
  }
  return { mean, variance };
}

/** Chance team a outscores team b over the weeks of a round. */
export function roundWinProb(strength, a, b, weeks, upset = 1) {
  const ta = roundTotal(strength, a, weeks, upset);
  const tb = roundTotal(strength, b, weeks, upset);
  const sd = Math.sqrt(ta.variance + tb.variance);
  const gap = ta.mean - tb.mean;
  if (!(sd > 0)) return gap > 0 ? 1 : gap < 0 ? 0 : 0.5;
  return normalCdf(gap / sd);
}

// ---------------------------------------------------------------- picks and locks

const PICK_RE = /^([1-9]\d?)-([1-9]\d?):(\d{1,12})$/;

/** Parse `picks=r-m:rosterId,...` into [{game, rosterId}]; anything malformed is a 400. */
export function parsePicks(text) {
  if (text === undefined || text === null || text === '') return [];
  const parts = String(text).split(',').filter((p) => p !== '');
  if (parts.length > 60) throw new RangeError('Too many picks.');
  return parts.map((p) => {
    const m = PICK_RE.exec(p.trim());
    if (!m) throw new RangeError(`"${p.slice(0, 20)}" is not a valid pick. Use round-game:team, such as 1-2:7.`);
    return { game: `${m[1]}-${m[2]}`, rosterId: m[3] };
  });
}

/**
 * Fold Sleeper's published results into a bracket. Only finished games (a
 * winner and a loser) lock; each becomes {round, advancer, other}.
 */
export function lockSleeperResults(bracket, items) {
  const locks = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.p != null && it.p !== 1) continue; // placement games are not the bracket
    if (it.w == null || it.l == null) continue;
    const w = String(it.w);
    const l = String(it.l);
    const [advancer, other] = bracket.advance === 'loser' ? [l, w] : [w, l];
    locks.push({ round: Number(it.r), advancer, other });
  }
  return { ...bracket, locks };
}

/** The teams Sleeper has actually placed in its bracket, or [] if it has none yet. */
export function sleeperTeams(items) {
  const ids = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.p != null && it.p !== 1) continue;
    for (const k of ['t1', 't2']) {
      const v = it[k];
      if (v !== null && v !== undefined && typeof v !== 'object' && !ids.includes(String(v))) ids.push(String(v));
    }
  }
  return ids;
}

/** True when each of Sleeper's first-round games is a game in this bracket. */
export function matchesSleeper(bracket, items) {
  const first = new Set();
  const state = seedOrder(bracket.size).map((s) => bracket.teams[s - 1] || null);
  for (const it of pairRound(state, 0, false)) {
    if (it.game) first.add([it.a.rosterId, it.b.rosterId].sort().join('|'));
  }
  const real = (Array.isArray(items) ? items : []).filter((x) => x && Number(x.r) === 1 && x.t1 != null && x.t2 != null && (x.p == null || x.p === 1));
  return real.length > 0 && real.every((x) => first.has([String(x.t1), String(x.t2)].sort().join('|')));
}

// ---------------------------------------------------------------- the exact walk

/**
 * Walk every possible set of results. Returns, for every team, the chance to
 * reach each round and to win it all, and for every game who can be in it.
 *
 * @param {Object} bracket   from buildBracket (with .locks from lockSleeperResults)
 * @param {Object} strength  {[rosterId]: {mean, sd}} (or {weeks:{[week]:{mean, sd}}})
 * @param {Object} opts      { upset, picks: {[gameId]: rosterId}, locks }
 */
export function exactTitleOdds(bracket, strength, opts = {}) {
  const upset = validateUpset(opts.upset);
  const picks = opts.picks || {};
  const locks = opts.locks || bracket.locks || [];
  const R = bracket.rounds.length;
  const adv = bracket.advance;
  const reseed = bracket.reseed;

  const titleOdds = {};
  const runnerUp = {};
  const reach = {};
  for (const t of bracket.teams) {
    titleOdds[t.rosterId] = 0;
    runnerUp[t.rosterId] = 0;
    reach[t.rosterId] = new Array(R + 1).fill(0);
  }
  const games = {};
  for (const rd of bracket.rounds) {
    for (const g of rd.games) {
      games[g.id] = { slots: [{}, {}], advance: {}, forced: null, forcedTo: null };
    }
  }

  if (R === 0) {
    for (const t of bracket.teams) titleOdds[t.rosterId] = 1;
    return { titleOdds, runnerUp, reach, games, total: bracket.teams.length ? 1 : 0, outcomes: 1 };
  }

  // Refuse a walk that would not finish: every open game doubles the outcomes.
  if (bracket.n - 1 - locks.length > Math.log2(MAX_WALK)) throw new RangeError('That bracket is too big to walk exactly.');

  const lockFor = (round, a, b) => locks.find((l) => l.round === round
    && ((l.advancer === a.rosterId && (l.other === b.rosterId)) || (l.advancer === b.rosterId && l.other === a.rosterId)));
  const bump = (obj, key, v) => { obj[key] = (obj[key] || 0) + v; };
  const state0 = seedOrder(bracket.size).map((s) => bracket.teams[s - 1] || null);
  let outcomes = 0;

  const walk = (state, r, prob) => {
    for (const t of state) if (t) reach[t.rosterId][r] += prob;
    if (r === R) {
      titleOdds[state[0].rosterId] += prob;
      outcomes += 1;
      return;
    }
    const items = pairRound(state, r, reseed && r > 0);
    const weeks = bracket.rounds[r].weeks;
    let m = 0;
    for (const it of items) {
      if (!it.game) continue;
      m += 1;
      const g = games[`${r + 1}-${m}`];
      it.id = `${r + 1}-${m}`;
      bump(g.slots[0], it.a.rosterId, prob);
      bump(g.slots[1], it.b.rosterId, prob);
      const lock = lockFor(r + 1, it.a, it.b);
      const pick = !lock && picks[it.id] !== undefined ? String(picks[it.id]) : null;
      let pa;
      if (lock) pa = lock.advancer === it.a.rosterId ? 1 : 0;
      else if (pick === it.a.rosterId) pa = 1;
      else if (pick === it.b.rosterId) pa = 0;
      else {
        const wins = roundWinProb(strength, it.a.rosterId, it.b.rosterId, weeks, upset);
        pa = adv === 'winner' ? wins : 1 - wins;
      }
      it.pa = pa;
      if (lock) { g.forced = 'lock'; g.forcedTo = lock.advancer; }
      else if (pick === it.a.rosterId || pick === it.b.rosterId) { g.forced = 'pick'; g.forcedTo = pick; }
    }

    const chosen = new Array(items.length);
    const go = (i, p) => {
      if (i === items.length) {
        walk(chosen.slice(), r + 1, p);
        return;
      }
      const it = items[i];
      if (!it.game) { chosen[i] = it.team; go(i + 1, p); return; }
      const g = games[it.id];
      for (const [team, other, q] of [[it.a, it.b, it.pa], [it.b, it.a, 1 - it.pa]]) {
        if (!(q > 0)) continue;
        chosen[i] = team;
        bump(g.advance, team.rosterId, p * q);
        if (r === R - 1) bump(runnerUp, other.rosterId, p * q);
        go(i + 1, p * q);
      }
    };
    go(0, prob);
  };

  walk(state0, 0, 1);
  const total = Object.values(titleOdds).reduce((s, v) => s + v, 0);
  return { titleOdds, runnerUp, reach, games, total, outcomes };
}

// ---------------------------------------------------------------- simulating (used by the season simulation)

/**
 * Play the bracket once with sampled scores. `score(seedIndex, weeks)` draws a
 * team's total for the round. A tie goes to the better seed. Teams here are
 * identified by seed number (1-based), so the caller maps seeds to teams.
 * Returns { champion, runnerUp } as seed numbers.
 */
export function playBracketOnce(plan, score) {
  const R = plan.rounds.length;
  if (R === 0) return { champion: plan.teams[0]?.seed ?? null, runnerUp: null };
  let state = plan.order;
  let runnerUp = null;
  for (let r = 0; r < R; r++) {
    const items = pairRound(state, r, plan.reseed && r > 0);
    const weeks = plan.rounds[r].weeks;
    const next = [];
    for (const it of items) {
      if (!it.game) { next.push(it.team); continue; }
      const sa = score(it.a.seed, weeks);
      const sb = score(it.b.seed, weeks);
      const aWins = sa > sb || (sa === sb && it.a.seed < it.b.seed);
      const advancer = (aWins === (plan.advance === 'winner')) ? it.a : it.b;
      if (r === R - 1) runnerUp = advancer === it.a ? it.b.seed : it.a.seed;
      next.push(advancer);
    }
    state = next;
  }
  return { champion: state[0].seed, runnerUp };
}

/** The pieces playBracketOnce needs, computed once per simulation. */
export function simPlan(bracket) {
  return {
    rounds: bracket.rounds, reseed: bracket.reseed, advance: bracket.advance, teams: bracket.teams,
    order: seedOrder(bracket.size).map((s) => bracket.teams[s - 1] || null),
  };
}

// ---------------------------------------------------------------- projected seeds

/**
 * Each team's most likely seed from the simulation, filled from the likeliest
 * pairing down so no two teams share a seed. `teams` carry seedOdds.
 */
export function projectedSeeds(teams, count) {
  const m = teams.length;
  const want = Math.min(count ?? m, m);
  const cells = [];
  teams.forEach((t) => {
    (t.seedOdds || []).forEach((p, s) => { if (s < m) cells.push({ id: String(t.rosterId), seed: s, p }); });
  });
  cells.sort((a, b) => b.p - a.p || a.seed - b.seed);
  const usedTeam = new Set();
  const seatOf = new Map();
  for (const c of cells) {
    if (usedTeam.has(c.id) || seatOf.has(c.seed)) continue;
    usedTeam.add(c.id);
    seatOf.set(c.seed, c.id);
  }
  // A team with no odds at all (nothing simulated) fills what is left, by record.
  const left = teams.filter((t) => !usedTeam.has(String(t.rosterId)));
  for (let s = 0; s < m; s++) if (!seatOf.has(s) && left.length) seatOf.set(s, String(left.shift().rosterId));
  const out = [];
  for (let s = 0; s < want; s++) out.push(seatOf.get(s));
  return out;
}

// ---------------------------------------------------------------- the whole report

/** Sort by record then points for, the order Sleeper seeds by when it is not divisional. */
const byStanding = (a, b) => ((b.wins + 0.5 * (b.ties || 0)) - (a.wins + 0.5 * (a.ties || 0))) || ((b.pointsFor || 0) - (a.pointsFor || 0));

function describe(bracket, odds, nameOf) {
  const final = bracket.rounds.length ? bracket.rounds[bracket.rounds.length - 1] : null;
  const teamRef = (rosterId) => ({ rosterId, name: nameOf(rosterId) });
  const rounds = bracket.rounds.map((rd, ri) => ({
    round: rd.round, name: rd.name, weeks: rd.weeks,
    games: rd.games.map((g) => {
      const info = odds.games[g.id];
      const slots = g.slots.map((sl, k) => {
        const cand = Object.entries(info.slots[k]).map(([rosterId, p]) => ({ rosterId, name: nameOf(rosterId), p }))
          .sort((a, b) => b.p - a.p);
        const sure = cand.length === 1 && cand[0].p > 0.999999 ? cand[0] : null;
        const seatSeed = sure ? bracket.teams.find((t) => t.rosterId === sure.rosterId)?.seed ?? null : null;
        return {
          from: sl.from || null, reseed: sl.reseed || null, seed: seatSeed,
          rosterId: sure ? sure.rosterId : null, name: sure ? sure.name : null,
          candidates: sure ? [] : cand,
        };
      });
      const advancePct = Object.fromEntries(Object.entries(info.advance));
      return {
        id: g.id, round: g.round, m: g.m,
        slots,
        locked: info.forced === 'lock', picked: info.forced === 'pick',
        forcedTo: info.forcedTo,
        // Chance each team in the game advances, overall (not conditional on getting there).
        advance: advancePct,
      };
    }),
  }));
  const champion = Object.entries(odds.titleOdds).map(([rosterId, p]) => ({ ...teamRef(rosterId), p }))
    .sort((a, b) => b.p - a.p);
  return {
    n: bracket.n, size: bracket.size, reseed: bracket.reseed, advance: bracket.advance,
    byes: bracket.byes.map((t) => ({ seed: t.seed, ...teamRef(t.rosterId) })),
    seeds: bracket.teams.map((t) => ({ seed: t.seed, ...teamRef(t.rosterId) })),
    rounds, champion,
    finalWeeks: final ? final.weeks : [],
    reach: odds.reach,
    runnerUp: odds.runnerUp,
    total: odds.total,
  };
}

/**
 * Build the winners and losers brackets for a league.
 *
 * @param {Object} o
 * @param {Array}  o.teams        season-report rows {rosterId, name, wins, losses, ties, pointsFor, weeklyMean, weeklySd, seedOdds}
 * @param {Object} o.settings     playoffSettings(...) {teams, startWeek, roundType, reseed}
 * @param {Array}  [o.winnersRaw] Sleeper's winners_bracket
 * @param {Array}  [o.losersRaw]  Sleeper's losers_bracket
 * @param {Array}  [o.picks]      [{game, rosterId}]
 * @param {string} [o.losersStyle] sleeper | toilet | consolation
 * @param {string|null} [o.leagueAdvance] 'loser' | 'winner' | null from the league's settings
 * @param {number} [o.upset]
 */
export function leagueBracket(o) {
  const upset = validateUpset(o.upset);
  const style = validateLosersStyle(o.losersStyle);
  const rows = o.teams;
  const nameById = new Map(rows.map((t) => [String(t.rosterId), t.name]));
  const nameOf = (id) => nameById.get(String(id)) || `Roster ${id}`;
  const strength = {};
  for (const t of rows) strength[String(t.rosterId)] = { mean: t.weeklyMean, sd: t.weeklySd };

  const settings = o.settings;
  const sleeperIds = sleeperTeams(o.winnersRaw);
  const known = new Set(rows.map((t) => String(t.rosterId)));
  const fromSleeper = sleeperIds.length >= 2 && sleeperIds.every((id) => known.has(id));

  let winnersSeeds;
  if (fromSleeper) {
    const set = new Set(sleeperIds);
    winnersSeeds = rows.filter((t) => set.has(String(t.rosterId))).sort(byStanding).map((t) => String(t.rosterId));
  } else {
    winnersSeeds = projectedSeeds(rows, Math.min(settings.teams, rows.length));
  }
  const inField = new Set(winnersSeeds);

  let loserSeeds;
  if (fromSleeper) {
    loserSeeds = rows.filter((t) => !inField.has(String(t.rosterId))).sort(byStanding).map((t) => String(t.rosterId));
  } else {
    loserSeeds = projectedSeeds(rows).filter((id) => !inField.has(id));
  }

  const advance = style === 'toilet' ? 'loser'
    : style === 'consolation' ? 'winner'
      : (inferLosersAdvance(o.losersRaw) || o.leagueAdvance || 'loser');

  const picksFor = (field) => {
    const map = {};
    for (const p of o.picks || []) if (field.has(String(p.rosterId))) map[p.game] = String(p.rosterId);
    return map;
  };

  const make = (seeds, adv, raw, useSleeper) => {
    if (seeds.length < 2) return null;
    const rounds = Math.log2(bracketSize(seeds.length));
    let b = buildBracket(seeds, {
      reseed: settings.reseed, advance: adv,
      weeks: roundWeeks(rounds, settings.roundType, settings.startWeek),
    });
    if (useSleeper) b = lockSleeperResults(b, raw);
    const picks = picksFor(new Set(seeds));
    const odds = exactTitleOdds(b, strength, { upset, picks });
    return { bracket: b, odds, view: describe(b, odds, nameOf) };
  };

  const w = make(winnersSeeds, 'winner', o.winnersRaw, fromSleeper);
  const losersFromSleeper = fromSleeper && sleeperTeams(o.losersRaw).length >= 2;
  const l = make(loserSeeds, advance, o.losersRaw, losersFromSleeper);

  const winners = w ? { ...w.view, kind: 'winners', locksMatch: fromSleeper ? matchesSleeper(w.bracket, o.winnersRaw) : null } : null;
  const losers = l ? { ...l.view, kind: 'losers', style: advance === 'loser' ? 'toilet' : 'consolation' } : null;
  const titleOdds = w ? Object.fromEntries(Object.entries(w.odds.titleOdds)) : {};
  const worstOdds = l && advance === 'loser' ? Object.fromEntries(Object.entries(l.odds.titleOdds)) : {};
  return {
    winners, losers,
    source: fromSleeper ? 'sleeper' : 'projected',
    titleOdds, worstOdds,
    losersStyle: style, losersAdvance: advance,
    upset,
  };
}
