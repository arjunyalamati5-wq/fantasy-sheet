// How soft or tough an opponent is for a position: the points a defence has
// given up to that position per game, against the league average.

import { displayTeam } from '../teams.js';

export const SOFT_AT = 1.15;
export const TOUGH_AT = 0.87;
const MIN_GAMES = 2;
const GRADED = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

export function gradeOf(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  if (ratio >= SOFT_AT) return 'soft';
  if (ratio <= TOUGH_AT) return 'tough';
  return 'avg';
}

/**
 * Per-game points each defence allowed to each position, over the league mean.
 * A game's figure is the sum of every player at that position on the other
 * side, from the weeks already played.
 * @returns {Map<string,{ratio:number,games:number}>} key `${defTeam}|${pos}`
 */
export function buildAllowance(ctx) {
  const perGame = new Map(); // `${def}|${pos}|${week}` -> points
  for (const [id, games] of ctx.resultsByPlayer || []) {
    const p = ctx.playerOf(id);
    if (!p?.team || !GRADED.has(p.position)) continue;
    for (const g of games) {
      if (!g.played || g.onBye) continue;
      const game = ctx.schedule?.gameFor?.(p.team, g.week);
      if (!game?.opponent) continue;
      const key = `${game.opponent}|${p.position}|${g.week}`;
      perGame.set(key, (perGame.get(key) || 0) + (Number(g.points) || 0));
    }
  }
  const byTeamPos = new Map(); // `${def}|${pos}` -> [game totals]
  for (const [key, pts] of perGame) {
    const [def, pos] = key.split('|');
    const k = `${def}|${pos}`;
    if (!byTeamPos.has(k)) byTeamPos.set(k, []);
    byTeamPos.get(k).push(pts);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const leagueMean = {};
  for (const pos of GRADED) {
    const all = [...perGame].filter(([k]) => k.split('|')[1] === pos).map(([, v]) => v);
    leagueMean[pos] = all.length ? mean(all) : 0;
  }
  const out = new Map();
  for (const [k, list] of byTeamPos) {
    const pos = k.split('|')[1];
    if (list.length < MIN_GAMES || !(leagueMean[pos] > 0)) continue;
    out.set(k, { ratio: mean(list) / leagueMean[pos], games: list.length });
  }
  return out;
}

const cache = new WeakMap();
export function allowanceFor(ctx) {
  if (!cache.has(ctx)) cache.set(ctx, buildAllowance(ctx));
  return cache.get(ctx);
}

/** The grade of one specific game for one player; null when it cannot be graded. */
export function gradeGame(ctx, player, week) {
  const game = player?.team ? ctx.schedule?.gameFor?.(player.team, week) : null;
  if (!game) return null;
  const a = allowanceFor(ctx).get(`${game.opponent}|${player.position}`);
  return {
    week: Number(week),
    opponent: `${game.isHome ? 'vs' : 'at'} ${displayTeam(game.opponent)}`,
    grade: a ? gradeOf(a.ratio) : null,
    ratio: a ? Math.round(a.ratio * 100) / 100 : null,
  };
}

/** The first game from `fromWeek` on (so a bye is skipped), graded. */
export function nextMatchup(ctx, player, fromWeek = ctx.week) {
  const last = Math.min(ctx.schedule?.maxWeek || 18, 18);
  for (let w = Number(fromWeek); w <= last; w++) {
    const g = gradeGame(ctx, player, w);
    if (g) return g;
  }
  return null;
}
