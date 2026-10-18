import { round2 } from '../scoring.js';
import { displayTeam } from '../teams.js';
import { describe } from './lineup.js';

// Best free DEF / K / QB / TE for this week, with the Vegas game total as
// context. A defence facing a low-total offence is the whole streaming idea; a
// kicker in a high-total game gets more chances.
const STREAM_POSITIONS = ['DEF', 'K', 'QB', 'TE'];

export function streamingReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const free = ctx.freeAgents();
  const mine = new Set((ctx.rosterOf(rosterId)?.players) || []);

  const groups = {};
  for (const pos of STREAM_POSITIONS) {
    const rows = free
      .filter((p) => p.position === pos && !mine.has(p.player_id))
      .filter((p) => !ctx.onByeThisWeek(p.player_id))
      .map((p) => {
        const d = describe(ctx, p);
        const game = ctx.schedule.gameFor(p.team, ctx.week);
        return {
          ...d,
          game: game ? {
            opponent: displayTeam(game.opponent),
            isHome: game.isHome,
            total: game.totalLine,
            spread: game.spreadLine == null ? null
              : round2(game.isHome ? game.spreadLine : -game.spreadLine),
            kickoff: game.gameday,
          } : null,
          context: contextFor(pos, game),
        };
      })
      .sort((a, b) => b.projected - a.projected || b.value - a.value)
      .slice(0, 8);

    groups[pos] = {
      position: pos,
      label: LABELS[pos],
      rows,
      emptyMessage: rows.length === 0
        ? `Every ${LABELS[pos]} in the league is rostered. Look at who is droppable on your bench instead.`
        : null,
    };
  }

  const vegasAvailable = ctx.schedule.available
    && ctx.schedule.games.some((g) => g.totalLine != null);

  return {
    week: ctx.week,
    groups,
    vegasAvailable,
    note: vegasAvailable
      ? 'Game total is the number Vegas expects both teams to score combined. Low totals favour defences; high totals favour kickers and quarterbacks.'
      : 'Vegas totals are not published for this week yet, so the ranking uses projections alone.',
  };
}

const LABELS = { DEF: 'defence', K: 'kicker', QB: 'quarterback', TE: 'tight end' };

function contextFor(pos, game) {
  if (!game || game.totalLine == null) return null;
  const total = game.totalLine;
  const spread = game.isHome ? game.spreadLine : -game.spreadLine;

  if (pos === 'DEF') {
    if (total <= 41 && spread != null && spread <= -3) {
      return `Low-scoring game (${total} total) and favoured by ${Math.abs(spread)}. That is the profile you want.`;
    }
    if (total <= 41) return `Vegas expects a low-scoring game (${total} points total).`;
    if (total >= 49) return `Vegas expects a shootout (${total} points total). Risky start for a defence.`;
    return `Middling game total of ${total}.`;
  }
  if (pos === 'K') {
    if (total >= 48) return `High total (${total}) means more drives and more kicks.`;
    if (total <= 40) return `Low total (${total}) means fewer scoring chances.`;
    return `Game total of ${total}.`;
  }
  if (total >= 48) return `High total (${total}) — plenty of scoring expected.`;
  if (total <= 40) return `Low total (${total}) — a grind is expected.`;
  return `Game total of ${total}.`;
}

// ---------------------------------------------------------------- 3-week plan
//
// Kickers and defences ranked for the next three weeks, free agents and your
// own, from the Vegas lines and (for defences) how often the opponent's
// offence gets sacked. The score is a streaming score on a points-like scale,
// not a projection: it ranks one option against another, nothing more.

export const PLAN_WEEKS = 3;
const LEAGUE_SACK_FALLBACK = null;
// Weights of the streaming score (points per point of implied total, per point of sack rate).
const DEF_BASE = 6;
const DEF_PER_OPP_POINT = 0.45;
const DEF_PER_SACK_PT = 0.35;   // per percentage point of dropbacks the opponent is sacked above average
const DEF_HOME = 0.3;
const K_BASE = 7;
const K_PER_OWN_POINT = 0.25;
const K_DOME = 0.4;
const K_WIND = 1;
const MIN_OPP_DROPBACKS = 60;

/** Each side's implied points from the total and the spread (spread is positive when the home team is favoured). */
export function impliedTotals(total, spread) {
  if (total == null || spread == null) return null;
  return { home: round2(total / 2 + spread / 2), away: round2(total / 2 - spread / 2) };
}

/** Points the game expects `team` and its opponent to score. */
export function impliedFor(game) {
  const t = game && impliedTotals(game.totalLine, game.spreadLine);
  if (!t) return null;
  return game.isHome ? { own: t.home, opp: t.away } : { own: t.away, opp: t.home };
}

/** Sack rate by offence (sacks taken / dropbacks) from the usage team table, and the league's. */
export function sackRates(usage) {
  const acc = new Map();
  let sacks = 0; let db = 0;
  for (const t of usage?.teams || []) {
    const a = acc.get(t.team) || { sacks: 0, db: 0 };
    a.sacks += t.sacks || 0; a.db += t.dropbacks || 0;
    acc.set(t.team, a);
    sacks += t.sacks || 0; db += t.dropbacks || 0;
  }
  const byTeam = new Map();
  for (const [team, a] of acc) if (a.db >= MIN_OPP_DROPBACKS) byTeam.set(team, { rate: a.sacks / a.db, sacks: a.sacks, db: a.db });
  return { byTeam, league: db > 0 ? sacks / db : LEAGUE_SACK_FALLBACK };
}

const pct1 = (x) => `${(x * 100).toFixed(1)}%`;

/** Score and one-line reason for a defence in one game. */
export function scoreDefence(game, sack) {
  const imp = impliedFor(game);
  const parts = {};
  let score = DEF_BASE;
  const bits = [];
  const where = `${game.isHome ? 'vs' : 'at'} ${displayTeam(game.opponent)}`;
  if (imp) {
    parts.oppImplied = imp.opp;
    score += (22.5 - imp.opp) * DEF_PER_OPP_POINT;
    bits.push(`${displayTeam(game.opponent)} are expected to score ${imp.opp.toFixed(1)}`);
  } else bits.push('no Vegas line yet');
  if (sack && sack.league != null) {
    parts.oppSackRate = round2(sack.rate * 100);
    score += (sack.rate - sack.league) * 100 * DEF_PER_SACK_PT;
    bits.push(`they are sacked on ${pct1(sack.rate)} of dropbacks (league ${pct1(sack.league)})`);
  }
  if (game.isHome) score += DEF_HOME;
  return { score: round2(score), parts, where, reason: `${where}: ${bits.join('; ')}.` };
}

/** Score and one-line reason for a kicker in one game; `weather` is the forecast summary for this week only. */
export function scoreKicker(game, weather = null) {
  const imp = impliedFor(game);
  const parts = {};
  let score = K_BASE;
  const bits = [];
  const where = `${game.isHome ? 'vs' : 'at'} ${displayTeam(game.opponent)}`;
  if (imp) {
    parts.ownImplied = imp.own;
    score += (imp.own - 22) * K_PER_OWN_POINT;
    bits.push(`his team is expected to score ${imp.own.toFixed(1)}`);
  } else bits.push('no Vegas line yet');
  const indoors = game.roof === 'dome' || game.roof === 'closed';
  if (indoors) { score += K_DOME; parts.indoors = true; bits.push('indoors, so no weather'); }
  const bad = weather?.flags?.length ? weather.flags : null;
  if (bad) { score -= K_WIND; parts.weather = bad; bits.push(`${bad.join(', ').toLowerCase()} in the forecast`); }
  return { score: round2(score), parts, where, reason: `${where}: ${bits.join('; ')}.` };
}

/** Who holds him, for the table: only free agents and your own are ranked. */
function ownedText(ctx, id, mineSet) {
  if (mineSet.has(id)) return 'On your roster';
  return ctx.ownerOf?.has(id) ? null : 'Free agent';
}

/**
 * The best 3-week path: pick the top option each week (a stream), and compare
 * it with holding the one option that scores most over all three weeks.
 */
export function bestPath(weeksOut) {
  const picks = weeksOut.map((w) => {
    const top = w.rows[0];
    return top ? { week: w.week, id: top.id, name: top.name, team: top.team, where: top.where, score: top.score, owned: top.owned } : null;
  }).filter(Boolean);
  const total = round2(picks.reduce((s, p) => s + p.score, 0));
  // Hold: the one player present in every week with the highest summed score.
  const sums = new Map();
  for (const w of weeksOut) for (const r of w.rows) {
    const e = sums.get(r.id) || { id: r.id, name: r.name, team: r.team, total: 0, weeks: 0 };
    e.total += r.score; e.weeks++;
    sums.set(r.id, e);
  }
  const holds = [...sums.values()].filter((e) => e.weeks === weeksOut.length).sort((a, b) => b.total - a.total);
  const hold = holds[0] ? { ...holds[0], total: round2(holds[0].total) } : null;
  // Merge a player picked in consecutive weeks into one pick-up.
  const steps = [];
  for (const p of picks) {
    const last = steps[steps.length - 1];
    if (last && last.id === p.id) { last.toWeek = p.week; last.score = round2(last.score + p.score); } else steps.push({ ...p, fromWeek: p.week, toWeek: p.week });
  }
  const plan = steps.map((s, i) => `${i === 0 ? 'Add' : 'Then add'} ${s.name} ${s.owned === 'On your roster' ? '(already yours) ' : ''}for ${s.fromWeek === s.toWeek ? `week ${s.fromWeek}` : `weeks ${s.fromWeek}–${s.toWeek}`} (${s.where}).`);
  return { picks, steps, total, hold, gain: hold ? round2(total - hold.total) : null, plan };
}

/**
 * Ranked kickers and defences for the next three weeks.
 * @param {object} ctx
 * @param {string|number} [rosterId] whose roster counts as "yours"
 * @param {{usage?:object, weather?:Function}} [opts] usage = loadUsage() result (sack rates); weather(team) for the current week
 */
export function streamingPlan(ctx, rosterId = ctx.myRoster?.roster_id, { usage = null } = {}) {
  const mine = new Set((ctx.rosterOf(rosterId)?.players) || []);
  const sack = sackRates(usage);
  const pool = new Map();
  for (const p of [...ctx.freeAgents(), ...ctx.playersOn(rosterId)]) {
    if ((p.position === 'DEF' || p.position === 'K') && p.team) pool.set(p.player_id, p);
  }
  const weeks = [];
  const last = Math.min(18, ctx.schedule?.maxWeek || 18);
  for (let w = ctx.week; w < ctx.week + PLAN_WEEKS && w <= last; w++) weeks.push(w);

  const out = { DEF: [], K: [] };
  for (const w of weeks) {
    const byPos = { DEF: [], K: [] };
    for (const p of pool.values()) {
      const owned = ownedText(ctx, p.player_id, mine);
      if (!owned) continue;
      const game = ctx.schedule.gameFor(p.team, w);
      if (!game) continue; // bye
      const s = p.position === 'DEF'
        ? scoreDefence(game, sack.league == null ? null : sack.byTeam.get(game.opponent) ? { ...sack.byTeam.get(game.opponent), league: sack.league } : null)
        : scoreKicker(game, w === ctx.week ? ctx.weatherFor?.(p.team) : null);
      byPos[p.position].push({
        id: p.player_id, name: p.name, team: displayTeam(p.team), position: p.position, owned,
        opp: displayTeam(game.opponent), home: game.isHome,
        total: game.totalLine ?? null, spread: game.spreadLine == null ? null : round2(game.isHome ? game.spreadLine : -game.spreadLine),
        ...s,
      });
    }
    for (const pos of ['DEF', 'K']) {
      byPos[pos].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      out[pos].push({ week: w, rows: byPos[pos].slice(0, 8).map((r, i) => ({ ...r, rank: i + 1 })) });
    }
  }
  const vegas = ctx.schedule?.available && ctx.schedule.games.some((g) => g.totalLine != null);
  return {
    week: ctx.week, weeks,
    DEF: { weeks: out.DEF, path: bestPath(out.DEF) },
    K: { weeks: out.K, path: bestPath(out.K) },
    sources: { vegas: Boolean(vegas), sacks: sack.league != null },
    notes: {
      DEF: 'Defences rank higher when the opponent is expected to score little and gets sacked often. Turnover rates are not in the usage tables, so sacks stand in. The score is for ordering options, not a projection.',
      K: 'Kickers rank higher when their own team is expected to score more (more drives, more field goal tries), indoors, and with no wind, rain, snow or cold in the forecast (forecasts reach only this week).',
    },
  };
}
