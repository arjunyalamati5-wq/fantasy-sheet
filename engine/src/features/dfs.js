import { parseSalaries, optimizeLineup, contestById, CONTEST_TYPES } from '../dfs.js';
import { scoreStats, round2 } from '../scoring.js';
import { normTeam, displayTeam } from '../teams.js';

/**
 * Daily-fantasy optimiser. Salaries come from the CSV the site exports; the
 * projections are ours, re-scored — though DFS sites use their own scoring, so
 * we score against a site ruleset rather than the home league's.
 */
export function dfsReport(ctx, { salaryCsv, contestId = 'dk_classic', locked = [], excluded = [] } = {}) {
  const contest = contestById(contestId);
  if (!salaryCsv || !String(salaryCsv).trim()) {
    return {
      needsSalaries: true,
      contests: CONTEST_TYPES.map((c) => ({ id: c.id, name: c.name, cap: c.cap, size: c.size })),
      emptyMessage: 'Paste the salary file your DFS site gives you and this will build the best lineup that fits under the cap. Daily-fantasy salaries are not published anywhere free, so the file has to come from the site itself — on DraftKings it is the "Export to CSV" link on the contest\'s draft screen.',
    };
  }

  const parsed = parseSalaries(salaryCsv);
  if (parsed.error) return { needsSalaries: true, error: parsed.error, contests: CONTEST_TYPES };

  // Match each salaried player to our own projection.
  const byName = new Map();
  for (const id of ctx.candidateIds) {
    const p = ctx.playerOf(id);
    if (!p) continue;
    byName.set(matchKey(p.name, p.team), id);
    if (!byName.has(looseKey(p.name))) byName.set(looseKey(p.name), id);
  }

  const players = [];
  let matched = 0;
  for (const row of parsed.rows) {
    const id = byName.get(matchKey(row.name, row.team)) || byName.get(looseKey(row.name)) || null;
    const proj = id ? ctx.projections[id] : null;

    // DFS sites score their own way. Use the site ruleset, not the home league's.
    const ourPoints = proj ? round2(scoreStats(proj.stats, DFS_SCORING)) : null;
    const points = ourPoints ?? (row.sitePoints ?? 0);
    if (ourPoints !== null) matched++;

    players.push({
      key: `${row.name}|${row.position}|${row.salary}`,
      player_id: id,
      name: row.name,
      position: row.position,
      team: displayTeam(row.team),
      salary: row.salary,
      points,
      source: ourPoints !== null ? 'projection' : (row.sitePoints != null ? 'site average' : 'none'),
      value: row.salary > 0 ? round2((points / row.salary) * 1000) : 0,
      game: row.game,
    });
  }

  const result = optimizeLineup(players, contest, { locked, excluded });

  return {
    needsSalaries: false,
    contest: { id: contest.id, name: contest.name, cap: contest.cap, size: contest.size },
    contests: CONTEST_TYPES.map((c) => ({ id: c.id, name: c.name, cap: c.cap, size: c.size })),
    result,
    pool: players.sort((a, b) => b.value - a.value).slice(0, 200),
    matched,
    totalRows: parsed.rows.length,
    matchNote: matched === 0
      ? 'None of the names in that file matched a player we hold projections for, so the lineup uses the site\'s own average points instead.'
      : `${matched} of ${parsed.rows.length} salaried players matched a projection. The rest fall back to the site's average points.`,
    scoringNote: 'Scored with standard DFS rules (full PPR, 4-point passing touchdowns, 100-yard bonuses), not your home league\'s settings — the contest uses the site\'s scoring, not yours.',
  };
}

/** Standard DraftKings-style scoring, which is what these contests actually use. */
const DFS_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2, bonus_pass_yd_300: 3,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2, bonus_rush_yd_100: 3,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2, bonus_rec_yd_100: 3,
  fum_lost: -1,
  def_td: 6, st_td: 6, sack: 1, int: 2, ff: 1, fum_rec: 2, safe: 2, blk_kick: 2,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

const strip = (s) => String(s || '').toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
  .replace(/[^a-z ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const matchKey = (name, team) => `${strip(name)}|${normTeam(team) || ''}`;
const looseKey = (name) => strip(name);
