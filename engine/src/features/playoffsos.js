// Fantasy-playoff schedule strength: who a player's team faces in the weeks
// the league's playoffs are played, graded with the same matchup machinery the
// rest of the app uses (points allowed to his position against the league
// average, soft at 1.15 and over, tough at 0.87 and under).

import { displayTeam } from '../teams.js';
import { allowanceFor, gradeOf } from './oppgrade.js';

/** Playoff rounds a league plays when Sleeper does not say (week 15, 16, 17). */
export const DEFAULT_PLAYOFF_WEEKS = 3;
const LAST_WEEK = 18;

/**
 * The weeks the league's playoffs are played: from its playoff_week_start,
 * as many rounds as its bracket needs (6 teams: 3, 4 teams: 2, 8+: 3), never
 * past the NFL's last regular week.
 */
export function playoffWeeks(ctx) {
  const start = Number(ctx.playoffWeekStart) || 15;
  const teams = Number(ctx.playoffTeams) || 6;
  const rounds = teams <= 4 ? 2 : DEFAULT_PLAYOFF_WEEKS;
  const last = Math.min(LAST_WEEK, Number(ctx.schedule?.maxWeek) || LAST_WEEK);
  const weeks = [];
  for (let w = start; w < start + rounds && w <= last; w++) weeks.push(w);
  return weeks;
}

/** Ratio source from the league's own scored results (oppgrade). */
export function leagueRatio(ctx) {
  const allow = allowanceFor(ctx);
  return (pos, opp) => allow.get(`${opp}|${pos}`)?.ratio ?? null;
}

/**
 * @param {object} ctx
 * @param {{team:string, position:string}} player
 * @param {(pos:string, opp:string)=>number|null} [ratioOf] defaults to the league's allowance table
 * @returns {{weeks:Array, score:number|null, label:'soft'|'avg'|'tough'|null, range:string, summary:string}|null}
 */
export function playoffSos(ctx, player, ratioOf = leagueRatio(ctx)) {
  const weeks = playoffWeeks(ctx);
  if (!player?.team || !weeks.length) return null;
  const rows = weeks.map((week) => {
    const game = ctx.schedule?.gameFor?.(player.team, week);
    if (!game) {
      const bye = ctx.schedule?.isOnBye?.(player.team, week);
      return { week, opp: null, home: null, grade: bye ? 'bye' : null, ratio: null };
    }
    const ratio = ratioOf(player.position, game.opponent);
    const r = ratio == null ? null : Math.round(ratio * 100) / 100;
    return { week, opp: displayTeam(game.opponent), home: game.isHome, grade: gradeOf(r), ratio: r };
  });
  const graded = rows.filter((r) => r.ratio != null);
  const score = graded.length ? Math.round((graded.reduce((s, r) => s + r.ratio, 0) / graded.length) * 100) / 100 : null;
  const label = gradeOf(score);
  const range = weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks[0]}–${weeks[weeks.length - 1]}`;
  const parts = rows.map((r) => {
    if (r.grade === 'bye') return `bye in week ${r.week}`;
    if (!r.opp) return `no game in week ${r.week}`;
    return `${r.home ? 'vs' : 'at'} ${r.opp}${r.grade ? ` ${r.grade === 'avg' ? 'average' : r.grade}` : ''}`;
  });
  return { weeks: rows, score, label, range, summary: `Fantasy playoffs (${range}): ${parts.join(', ')}.` };
}
