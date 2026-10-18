import { scoreStats, statLabel, round2 } from '../scoring.js';
import { describe } from './lineup.js';

// Sleeper's projections are RAW STAT LINES, so we can show what a player is
// projected to do stat by stat — passing yards, carries, receptions — not just
// a fantasy total. That is the same shape as a sportsbook's player props board.
//
// These are PROJECTIONS, not betting lines. Real props need a sportsbook odds
// feed, which requires an API key this app deliberately does not use.

const LINES_BY_POSITION = {
  QB: ['pass_yd', 'pass_td', 'pass_att', 'pass_cmp', 'pass_int', 'rush_yd', 'rush_att'],
  RB: ['rush_yd', 'rush_att', 'rush_td', 'rec', 'rec_yd', 'rec_td'],
  WR: ['rec', 'rec_yd', 'rec_td', 'rec_tgt', 'rush_yd'],
  TE: ['rec', 'rec_yd', 'rec_td', 'rec_tgt'],
  K: ['fgm', 'fga', 'xpm'],
  DEF: ['sack', 'int', 'ff', 'fum_rec', 'def_td', 'pts_allow'],
};

export function propsReport(ctx, { rosterId = ctx.myRoster?.roster_id, scope = 'mine', position = null, limit = 40 } = {}) {
  const mine = new Set((ctx.rosterOf(rosterId)?.players) || []);

  let ids;
  if (scope === 'mine') ids = [...mine];
  else if (scope === 'free') ids = [...ctx.candidateIds].filter((id) => !ctx.ownerOf.has(id));
  else ids = [...ctx.candidateIds];

  const rows = [];
  for (const id of ids) {
    const p = ctx.playerOf(id);
    if (!p) continue;
    if (position && p.position !== position) continue;
    const proj = ctx.projections[id];
    if (!proj?.stats) continue;

    const keys = LINES_BY_POSITION[p.position] || [];
    const lines = keys
      .map((k) => ({ key: k, label: statLabel(k), projected: numOrNull(proj.stats[k]) }))
      .filter((l) => l.projected !== null && l.projected !== 0);
    if (lines.length === 0) continue;

    rows.push({
      ...describe(ctx, p),
      isMine: mine.has(id),
      fantasyPoints: round2(scoreStats(proj.stats, ctx.scoring)),
      lines,
    });
  }

  rows.sort((a, b) => b.fantasyPoints - a.fantasyPoints);

  return {
    week: ctx.week,
    scope,
    rows: rows.slice(0, limit),
    available: ctx.projectionsAvailable,
    disclaimer: 'These are projected stat lines, not betting odds. Sportsbook player props need a paid odds feed; this app uses only free sources, so what you see is what Sleeper projects each player to actually do, scored in your league\'s settings.',
    emptyMessage: rows.length === 0
      ? (ctx.projectionsAvailable
        ? 'No projected stat lines for this selection yet.'
        : 'Projections are unavailable right now, so there are no stat lines to show. Try again later.')
      : null,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? round2(v) : null;
}
