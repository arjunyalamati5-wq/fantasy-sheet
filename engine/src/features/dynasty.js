// Dynasty and keeper leagues: who holds which future picks, what a pick is
// worth, whether each team is a contender or a rebuilder, and how a trade
// reads when this season and the future are weighed by that label.
// Redraft leagues get a plain explanation instead.

import { solveLineup } from '../lineup.js';
import { round2 } from '../scoring.js';
import { teamStrength } from '../context.js';
import { getTradedPicks } from '../sleeper.js';
import { dynastyMarketForContext, roundName } from '../fantasycalc.js';
import { leagueOddsFor } from './oddsim.js';

export const REDRAFT_EXPLAIN = 'This league is redraft: every roster starts over each season, so there are no future picks to hold and no dynasty values to weigh. Trades are graded on this season alone.';
export const PICK_SEASONS = 3;
const DEFAULT_ROUNDS = 4;

/** 'dynasty' (Sleeper type 2), 'keeper' (type 1) or 'redraft'. */
export function leagueKind(league) {
  const t = Number(league?.settings?.type);
  return t === 2 ? 'dynasty' : t === 1 ? 'keeper' : 'redraft';
}

/** Age in years (one decimal) from a birth date, else Sleeper's own age field. */
export function ageOf(player, now = new Date()) {
  if (!player) return null;
  if (player.birth_date) {
    const born = Date.parse(player.birth_date);
    if (Number.isFinite(born)) {
      const years = (now.getTime() - born) / (365.25 * 86_400_000);
      if (years > 15 && years < 55) return Math.round(years * 10) / 10;
    }
  }
  const a = Number(player.age);
  return Number.isFinite(a) && a > 15 && a < 55 ? a : null;
}

// ---------------------------------------------------------------- picks

/**
 * The next draft seasons. Before the league's draft happens that is this
 * season; once it has, the first pick still to be made is next season's.
 */
export function pickSeasons(league, season, count = PICK_SEASONS) {
  const drafted = !['pre_draft', 'drafting'].includes(String(league?.status || ''));
  const first = Number(season || league?.season) + (drafted ? 1 : 0);
  return Array.from({ length: count }, (_, i) => String(first + i));
}

export function pickRounds(league) {
  const r = Number(league?.settings?.draft_rounds);
  return Number.isInteger(r) && r >= 1 && r <= 12 ? r : DEFAULT_ROUNDS;
}

export const pickKey = (season, round, originalRosterId) => `${season}-${round}-${originalRosterId}`;

/**
 * Who holds every pick: each team starts with its own picks, then Sleeper's
 * traded-picks list moves them. Returns Map pickKey -> holder rosterId.
 * @param {Array} traded  [{season, round, roster_id (original), owner_id}]
 */
export function pickOwnership({ seasons, rounds, rosterIds, traded = [] }) {
  const owner = new Map();
  for (const s of seasons) {
    for (let r = 1; r <= rounds; r++) for (const id of rosterIds) owner.set(pickKey(s, r, id), Number(id));
  }
  const ids = new Set(rosterIds.map(String));
  for (const t of Array.isArray(traded) ? traded : []) {
    const key = pickKey(String(t.season), Number(t.round), t.roster_id);
    if (!owner.has(key) || !ids.has(String(t.owner_id))) continue; // outside the window, or a stranger
    owner.set(key, Number(t.owner_id));
  }
  return owner;
}

/** Value of a pick (FantasyCalc dynasty), or null when the source has none. */
export function pickValue(picks, season, round) {
  if (!picks) return null;
  const v = picks.get(`${season}|${round}`);
  return v === undefined ? null : v;
}

export function pickLabel(season, round) { return `${season} ${roundName(round)}`; }

/**
 * Future picks by team. `moved` is how many picks sit with someone other than
 * their original owner; when it is zero the report says no picks have changed hands.
 */
export function futurePicks(ctx, { tradedPicks = [], picks = null } = {}) {
  const seasons = pickSeasons(ctx.league, ctx.season);
  const rounds = pickRounds(ctx.league);
  const ids = ctx.rosters.map((r) => r.roster_id);
  const owner = pickOwnership({ seasons, rounds, rosterIds: ids, traded: tradedPicks });
  const nameOf = (id) => { const r = ctx.rosterOf(id); return r ? ctx.teamName(r) : `Roster ${id}`; };

  const byTeam = new Map(ids.map((id) => [String(id), []]));
  let moved = 0;
  for (const [key, holder] of owner) {
    const [season, round, original] = key.split('-');
    const isOwn = String(holder) === String(original);
    if (!isOwn) moved++;
    byTeam.get(String(holder))?.push({
      key, season, round: Number(round), label: pickLabel(season, Number(round)), originalRosterId: Number(original),
      from: nameOf(original), own: isOwn, value: pickValue(picks, season, Number(round)),
    });
  }
  const teams = ids.map((id) => {
    const list = byTeam.get(String(id)).sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
    return {
      rosterId: id, teamName: nameOf(id), isMine: String(id) === String(ctx.myRoster?.roster_id),
      picks: list, count: list.length,
      value: picks ? list.reduce((s, p) => s + (p.value || 0), 0) : null,
    };
  });
  const first = seasons[0];
  const holders = [];
  for (let r = 1; r <= Math.min(rounds, 2); r++) {
    for (const id of ids) {
      const holder = owner.get(pickKey(first, r, id));
      holders.push({ season: first, round: r, label: pickLabel(first, r), originalRosterId: id, original: nameOf(id), holderId: holder, holder: nameOf(holder), traded: String(holder) !== String(id) });
    }
  }
  return {
    seasons, rounds, teams, holders, moved,
    noneMoved: moved === 0,
    movedMessage: moved === 0 ? 'No picks have changed hands in this league.' : `${moved} pick${moved === 1 ? ' has' : 's have'} changed hands.`,
    ownerOf: owner,
  };
}

/** Just who holds which picks (no team labels, no simulation): what the trade builder lists. */
export async function pickHoldings(ctx, { dynasty, tradedPicks } = {}) {
  if (leagueKind(ctx.league) === 'redraft') return null;
  const market = dynasty !== undefined ? dynasty : await dynastyMarketForContext(ctx);
  const traded = tradedPicks !== undefined ? tradedPicks : await getTradedPicks(ctx.league.league_id);
  const { ownerOf, ...info } = futurePicks(ctx, { tradedPicks: traded || [], picks: market?.picks || null });
  return info;
}

// ---------------------------------------------------------------- contender or rebuilder

/** Share of the other teams this value beats (ties count half), so 0..1 and ~0.5 for the middle. */
export function percentRanks(values) {
  const n = values.length;
  return values.map((v) => {
    let below = 0; let same = 0;
    for (const w of values) { if (w < v) below++; else if (w === v) same++; }
    return n ? (below + (same - 1) / 2 + 0.5) / n : 0.5;
  });
}

const QUADRANTS = {
  'strong-strong': 'strong now and strong later',
  'strong-thin': 'strong now, thin later',
  'weak-strong': 'weak now, strong later',
  'weak-thin': 'weak now and thin later',
};

export const WEIGHTS = {
  contender: { now: 0.7, future: 0.3 },
  rebuilder: { now: 0.25, future: 0.75 },
  undecided: { now: 0.5, future: 0.5 },
};

/**
 * Contender or rebuilder from two 0..1 strengths. `now` is win-now strength
 * (playoff odds plus expected points), `future` is dynasty value plus youth.
 */
export function classifyTeam({ now, future }) {
  const strongNow = now >= 0.5;
  const strongLater = future >= 0.5;
  const quadrant = `${strongNow ? 'strong' : 'weak'}-${strongLater ? 'strong' : 'thin'}`;
  const quadrantText = QUADRANTS[quadrant];
  const middling = Math.abs(now - future) < 0.1 && Math.abs(now - 0.5) < 0.2;
  let label;
  if (middling) label = 'undecided';
  else label = strongNow ? 'contender' : 'rebuilder';
  const word = { contender: 'Contender', rebuilder: 'Rebuilder', undecided: 'Undecided' }[label];
  const sentence = {
    contender: strongLater
      ? `You are ${quadrantText}: keep pushing this season without selling the future.`
      : `You are ${quadrantText}: the window is open now, so use picks and young depth to win this year.`,
    rebuilder: strongLater
      ? `You are ${quadrantText}: be patient, collect picks and youth, and let this year go if it has to.`
      : `You are ${quadrantText}: build the base first, with picks and young players over veterans.`,
    undecided: `You are ${quadrantText}, and no side stands out yet: a good trade can push you either way.`,
  }[label];
  return { label, word, quadrant, quadrantText, now: round2(now), future: round2(future), weights: WEIGHTS[label], sentence };
}

const youthFactor = (age) => (age == null ? 1 : Math.max(0.55, Math.min(1.3, 1 + (26.5 - age) * 0.04)));

/**
 * Value of a player for the future: FantasyCalc dynasty value when the feed is
 * up, otherwise this season's value stretched by how young he is.
 */
export function futureValueOf(ctx, player, dynasty) {
  const m = dynasty?.values?.get(String(player.player_id));
  if (m) return m.value;
  return ctx.valueOf(player.player_id) * 60 * youthFactor(ageOf(player));
}

/** Value-weighted average age of a roster's best players, or null. */
export function rosterAge(ctx, players, weight = (p) => ctx.valueOf(p.player_id)) {
  let num = 0; let den = 0;
  for (const p of players) {
    const a = ageOf(p); const w = Math.max(0.01, weight(p));
    if (a == null) continue;
    num += a * w; den += w;
  }
  return den ? Math.round((num / den) * 10) / 10 : null;
}

/**
 * Win-now and future strength for every team, each as a 0..1 rank in the league,
 * plus the contender/rebuilder label.
 * @param {Object|null} odds  rosterId -> playoff odds (0..1), if a simulation ran
 */
export function teamProfiles(ctx, { dynasty = null, picksHeld = null, odds = null } = {}) {
  const rows = ctx.rosters.map((r) => {
    const id = r.roster_id;
    const players = ctx.playersOn(id);
    const strength = teamStrength(ctx, id);
    const lineup = solveLineup(ctx.slots, players, (p) => ctx.valueOf(p.player_id));
    const top = [...players].sort((a, b) => futureValueOf(ctx, b, dynasty) - futureValueOf(ctx, a, dynasty)).slice(0, 24);
    const assets = top.reduce((s, p) => s + futureValueOf(ctx, p, dynasty), 0)
      + (picksHeld?.get(String(id)) || 0);
    const age = rosterAge(ctx, lineup.assignments.filter((a) => a.player).map((a) => a.player)
      .concat(top.slice(0, 12)).filter((p, i, arr) => arr.indexOf(p) === i), (p) => futureValueOf(ctx, p, dynasty));
    return { rosterId: id, teamName: ctx.teamName(r), isMine: String(id) === String(ctx.myRoster?.roster_id), mean: strength.mean, odds: odds ? (odds[String(id)] ?? 0) : null, assets, age };
  });
  const rank = (get) => percentRanks(rows.map(get));
  const meanR = rank((r) => r.mean);
  const oddsR = odds ? rank((r) => r.odds) : null;
  const assetR = rank((r) => r.assets);
  const youthR = rank((r) => -(r.age ?? 26));
  return rows.map((r, i) => {
    const now = oddsR ? (meanR[i] + oddsR[i]) / 2 : meanR[i];
    const future = (assetR[i] + youthR[i]) / 2;
    return { ...r, mean: round2(r.mean), assets: Math.round(r.assets), ...classifyTeam({ now, future }) };
  });
}

// ---------------------------------------------------------------- the report

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Everything the dynasty page shows. Redraft leagues get the explanation. */
export async function dynastyReport(ctx, { dynasty, tradedPicks, odds, withMarket = true } = {}) {
  const kind = leagueKind(ctx.league);
  if (kind === 'redraft') return { enabled: false, kind, message: REDRAFT_EXPLAIN };
  const market = dynasty !== undefined ? dynasty : (withMarket ? await dynastyMarketForContext(ctx) : null);
  const traded = tradedPicks !== undefined ? tradedPicks : await getTradedPicks(ctx.league.league_id);
  const held = futurePicks(ctx, { tradedPicks: traded || [], picks: market?.picks || null });
  const oddsNow = odds !== undefined ? odds : await leagueOddsFor(ctx);
  const picksHeld = market ? new Map(held.teams.map((t) => [String(t.rosterId), t.value || 0])) : null;
  const profiles = teamProfiles(ctx, { dynasty: market, picksHeld, odds: oddsNow });
  const { ownerOf, ...pickInfo } = held;
  return {
    enabled: true, kind,
    marketAvailable: Boolean(market),
    tradedPicksAvailable: Array.isArray(traded),
    picks: pickInfo,
    profiles,
    mine: profiles.find((p) => p.isMine) || null,
    note: market ? 'Pick and player values: FantasyCalc dynasty.' : 'Dynasty values are unavailable right now, so future strength uses this season\'s values and age.',
  };
}

/** A pick named in a trade ("2027-1-3") -> { key, label, value, ... } if it is real and the giver holds it. */
export function resolvePick(key, { held, picks }) {
  const m = /^(20\d\d)-(\d{1,2})-(\d{1,3})$/.exec(String(key));
  if (!m) return null;
  const season = m[1]; const round = Number(m[2]); const original = Number(m[3]);
  const holder = held.ownerOf.get(pickKey(season, round, original));
  if (holder === undefined) return null;
  return { key, season, round, originalRosterId: original, holderId: holder, label: pickLabel(season, round), value: pickValue(picks, season, round) };
}

export function letterFor(score) {
  if (score >= 0.55) return { letter: 'A', label: 'Clear win' };
  if (score >= 0.3) return { letter: 'B', label: 'Good for you' };
  if (score >= 0.1) return { letter: 'C+', label: 'Slight edge to you' };
  if (score > -0.1) return { letter: 'C', label: 'Roughly even' };
  if (score > -0.3) return { letter: 'D', label: 'Slightly against you' };
  return { letter: 'F', label: 'Bad for you' };
}

/**
 * How a trade reads when this season and the future are weighed by the team's
 * label. Pure given its inputs (see dynastyTradeRead for the loader).
 * @param {{nowScore:number, gapPct:number|null, ageShift:number|null, label:string}} x
 */
export function weighTrade({ myDelta, gapPct, ageShift, label }) {
  const weights = WEIGHTS[label] || WEIGHTS.undecided;
  const nowScore = clamp(myDelta / 4, -1, 1);
  const futureScore = gapPct == null ? null : clamp(gapPct / 25, -1, 1);
  const combined = futureScore == null ? nowScore : weights.now * nowScore + weights.future * futureScore;
  const sentences = [{
    contender: 'A contender weighs this season first and future value second.',
    rebuilder: 'A retooling team weighs future value first and this season second.',
    undecided: 'No contender or rebuilder read yet, so this season and future value count about evenly.',
  }[label] || 'No contender or rebuilder read yet, so this season and future value count about evenly.'];
  if (futureScore == null) sentences.push('Future values are unavailable right now, so only this season counts.');
  else if (gapPct > 3 && ageShift != null && ageShift >= 1.5) sentences.push('This brings value but not youth: what comes in is older than what goes out.');
  else if (gapPct > 3) sentences.push(ageShift != null && ageShift <= -1.5 ? 'This brings value and youth.' : 'This brings future value.');
  else if (gapPct < -3) sentences.push('This costs future value.');
  else sentences.push('Future value is about even.');
  return { weights, nowScore: round2(nowScore), futureScore: futureScore == null ? null : round2(futureScore), combined: round2(combined), grade: letterFor(combined), sentences };
}

/** The dynasty read on one proposed trade. */
export async function dynastyTradeRead(ctx, input, { dynastyMarket, tradedPicks, odds } = {}) {
  const kind = leagueKind(ctx.league);
  if (kind === 'redraft') return { available: false, kind, reason: REDRAFT_EXPLAIN };
  const dynasty = dynastyMarket !== undefined ? dynastyMarket : await dynastyMarketForContext(ctx);
  const traded = tradedPicks !== undefined ? tradedPicks : await getTradedPicks(ctx.league.league_id);
  const held = futurePicks(ctx, { tradedPicks: traded || [], picks: dynasty?.picks || null });
  const oddsNow = odds !== undefined && odds !== null ? odds : await leagueOddsFor(ctx);
  const picksHeld = dynasty ? new Map(held.teams.map((t) => [String(t.rosterId), t.value || 0])) : null;
  const profiles = teamProfiles(ctx, { dynasty, picksHeld, odds: oddsNow });
  const mine = profiles.find((p) => String(p.rosterId) === String(input.rosterId));
  const theirs = profiles.find((p) => String(p.rosterId) === String(input.partnerId));

  const pickInfo = (keys, holderId) => keys.map((k) => resolvePick(k, { held, picks: dynasty?.picks }))
    .filter((p) => p && String(p.holderId) === String(holderId));
  const givePicks = pickInfo(input.givePicks || [], input.rosterId);
  const getPicks = pickInfo(input.getPicks || [], input.partnerId);
  const players = (ids) => ids.map((id) => ctx.playerOf(id)).filter(Boolean);
  const giveP = players(input.give); const getP = players(input.get);
  const total = (list, picks) => list.reduce((s, p) => s + futureValueOf(ctx, p, dynasty), 0)
    + picks.reduce((s, p) => s + (p.value || 0), 0);
  const giveTotal = total(giveP, givePicks); const getTotal = total(getP, getPicks);
  const hasValues = Boolean(dynasty) && giveTotal + getTotal > 0;
  const gapPct = hasValues && giveTotal > 0 ? ((getTotal - giveTotal) / giveTotal) * 100 : (hasValues && getTotal > 0 ? 100 : null);
  const ageIn = rosterAge(ctx, getP, (p) => futureValueOf(ctx, p, dynasty));
  const ageOut = rosterAge(ctx, giveP, (p) => futureValueOf(ctx, p, dynasty));
  const ageShift = ageIn != null && ageOut != null ? round2(ageIn - ageOut) : null;
  const label = mine?.label || 'undecided';
  const w = weighTrade({ myDelta: input.myDelta, gapPct, ageShift, label });
  return {
    available: true, kind,
    myLabel: mine ? { label: mine.label, word: mine.word, quadrantText: mine.quadrantText } : null,
    theirLabel: theirs ? { label: theirs.label, word: theirs.word, quadrantText: theirs.quadrantText } : null,
    ...w,
    values: dynasty ? { giveTotal: Math.round(giveTotal), getTotal: Math.round(getTotal), gapPct: gapPct == null ? null : Math.round(gapPct * 10) / 10 } : null,
    picks: { give: givePicks, get: getPicks },
    ageShift, source: dynasty ? 'FantasyCalc dynasty' : null,
  };
}
