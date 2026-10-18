import { solveLineup, scoreSetLineup } from '../lineup.js';
import { round2 } from '../scoring.js';
import { simulateSeason, checkOdds } from '../season.js';
import { teamStrength } from '../context.js';
import { scenarioStrength, forcedResults } from './whatif.js';
import { getMatchups } from '../sleeper.js';
import { playoffSettings, bracketSize, normalCdf, validateUpset } from './bracket.js';
import { allPlayRecords, luck, recordText, clinchMarks, statusWord, formatSentence } from './playoffmath.js';

/**
 * Playoff and title odds, simulating every remaining week from the league's
 * real pairings rather than an invented schedule.
 */
export async function seasonReport(ctx, opts = {}) {
  const upset = validateUpset(opts.upset);
  const po = playoffSettings(ctx.league?.settings, ctx.playoffTeams);
  const lastRegularWeek = (ctx.playoffWeekStart || 15) - 1;
  const weeks = [];
  for (let w = ctx.week; w <= lastRegularWeek; w++) weeks.push(w);

  const remainingWeeks = [];
  for (const w of weeks) {
    const entries = w === ctx.week ? ctx.currentMatchups : await getMatchups(ctx.league.league_id, w);
    const pairs = pairsFrom(entries);
    if (pairs.length) remainingWeeks.push({ week: w, pairs });
  }

  // Divisions: the league's own setting, read from each roster. Fewer than two
  // distinct divisions means the league has none worth speaking of.
  const divisionOf = (r) => {
    const d = Number(r.settings?.division);
    return Number.isFinite(d) && d > 0 ? d : null;
  };
  const divisionIds = [...new Set(ctx.rosters.map(divisionOf).filter((d) => d !== null))];
  const hasDivisions = divisionIds.length >= 2;
  const divisionName = (d) => {
    const meta = ctx.league?.metadata || {};
    return d == null ? null : (meta[`division_${d}`] || `Division ${d}`);
  };

  const teams = ctx.rosters.map((r) => {
    const s = r.settings || {};
    // Under a what-if, traded rosters change from next week (see whatif.js).
    const strength = ctx.scenario ? scenarioStrength(ctx, r.roster_id) : teamStrength(ctx, r.roster_id);
    return {
      rosterId: r.roster_id,
      name: ctx.teamName(r),
      wins: s.wins || 0,
      losses: s.losses || 0,
      ties: s.ties || 0,
      pointsFor: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      mean: strength.mean,
      sd: strength.sd,
    };
  });

  const { forced, ignored: ignoredPicks } = forcedResults(ctx.scenario, remainingWeeks);
  const result = simulateSeason({
    forced,
    teams,
    remainingWeeks,
    playoffTeams: ctx.playoffTeams,
    runs: opts.runs || 10_000,
    divisions: hasDivisions ? ctx.rosters.map(divisionOf) : undefined,
    upsetFactor: upset,
    playoff: { reseed: po.reseed, roundType: po.roundType, startWeek: ctx.playoffWeekStart || po.startWeek },
  });
  const sanity = checkOdds(result);

  // --- Everything below is arithmetic on the real record and schedule, not the simulation.
  const playedWeeks = (ctx.completedWeeks || []).filter((w) => w <= lastRegularWeek);
  const allPlay = allPlayRecords(playedWeeks.map((w) => ({
    week: w,
    scores: (ctx.pastMatchups?.[w] || []).map((e) => ({ rosterId: e.roster_id, points: e.points })),
  })));
  const unknownWeeks = weeks.length - remainingWeeks.length;
  // Picked results count as played for the strict arithmetic: the winner
  // banks the win and the game leaves the remaining schedule.
  const pickedWins = new Map();
  const openWeeks = remainingWeeks.map((wk) => ({
    ...wk,
    pairs: wk.pairs.filter(([a, b]) => {
      const [x, y] = [String(a), String(b)].sort();
      const w = forced.get(`${wk.week}|${x}|${y}`);
      if (w) pickedWins.set(w, (pickedWins.get(w) || 0) + 1);
      return !w;
    }),
  }));
  const marks = clinchMarks({
    teams: ctx.rosters.map((r) => ({
      rosterId: r.roster_id,
      wins: (r.settings?.wins || 0) + 0.5 * (r.settings?.ties || 0) + (pickedWins.get(String(r.roster_id)) || 0),
      division: hasDivisions ? divisionOf(r) : null,
    })),
    remainingWeeks: openWeeks, unknownWeeks, playoffTeams: result.playoffTeams,
  });
  const rosterById = new Map(ctx.rosters.map((r) => [String(r.roster_id), r]));
  const nameOf = (id) => {
    const r = rosterById.get(String(id));
    return r ? ctx.teamName(r) : `Roster ${id}`;
  };
  // The same weekly spread the simulation uses, scaled by the upset factor.
  const strengthOf = new Map(result.teams.map((t) => [String(t.rosterId), t]));
  const winChance = (a, b) => {
    const x = strengthOf.get(String(a));
    const y = strengthOf.get(String(b));
    if (!x || !y) return null;
    const sd = Math.hypot(x.weeklySd * upset, y.weeklySd * upset);
    return sd > 0 ? normalCdf((x.weeklyMean - y.weeklyMean) / sd) : 0.5;
  };
  const byeCount = result.playoffTeams >= 2 ? bracketSize(result.playoffTeams) - result.playoffTeams : 0;
  const scheduleOf = (id) => {
    const out = [];
    for (const wk of remainingWeeks) {
      const pair = wk.pairs.find((p) => p.map(String).includes(String(id)));
      if (!pair) continue;
      const opp = pair.find((x) => String(x) !== String(id));
      out.push({ week: wk.week, opponentId: opp, opponentName: nameOf(opp), winChance: winChance(id, opp) });
    }
    return out;
  };
  const myId = ctx.myRoster?.roster_id;

  const rows = result.teams.map((t) => {
    const r = rosterById.get(String(t.rosterId));
    const ap = allPlay.get(String(t.rosterId));
    const m = marks.get(String(t.rosterId));
    const winsNow = t.wins + 0.5 * t.ties;
    return {
      ...t,
      isMine: String(t.rosterId) === String(myId),
      division: hasDivisions ? divisionOf(r) : null,
      divisionName: hasDivisions ? divisionName(divisionOf(r)) : null,
      allPlay: ap ? { w: ap.w, l: ap.l, t: ap.t } : null,
      allPlayText: ap ? recordText(ap) : null,
      luck: ap ? luck(winsNow, ap.expectedWins) : null,
      expectedWinsSoFar: ap ? ap.expectedWins : null,
      mark: m.mark,
      clinchedPlayoff: m.clinchedPlayoff,
      clinchedDivision: m.clinchedDivision,
      outOfDivision: m.outOfDivision,
      eliminated: m.eliminated,
      gamesLeft: m.gamesLeft,
      status: statusWord({ playoffOdds: t.playoffOdds, clinchedPlayoff: m.clinchedPlayoff, eliminated: m.eliminated }),
      remaining: scheduleOf(t.rosterId),
      byeOdds: byeCount ? t.seedOdds.slice(0, byeCount).reduce((a, b) => a + b, 0) : 0,
    };
  });

  const mine = rows.find((t) => t.isMine);
  return {
    ...result,
    teams: rows,
    weeksRemaining: remainingWeeks.length,
    lastRegularWeek,
    format: {
      playoffTeams: result.playoffTeams,
      divisions: hasDivisions ? divisionIds.length : 0,
      text: formatSentence({ playoffTeams: result.playoffTeams, divisionCount: hasDivisions ? divisionIds.length : 0 }),
    },
    upset,
    // The playoff machine: every game left, with its win chance and any pick.
    machine: remainingWeeks.map((wk) => ({
      week: wk.week,
      games: wk.pairs.map(([a, b]) => {
        const [x, y] = [String(a), String(b)].sort();
        return { a, b, aName: nameOf(a), bName: nameOf(b), aWinChance: winChance(a, b), picked: forced.get(`${wk.week}|${x}|${y}`) || null };
      }),
    })),
    whatIf: ctx.scenario ? { key: ctx.scenario.key, changes: ctx.scenario.changes, ignoredPicks } : null,
    byes: byeCount,
    allPlayWeeks: playedWeeks.length,
    magic: mine ? { rosterId: mine.rosterId, name: mine.name, gamesLeft: mine.gamesLeft, ...marks.get(String(mine.rosterId)).magic } : null,
    sanity,
    emptyMessage: remainingWeeks.length === 0
      ? 'The regular season is over, so there is nothing left to simulate.'
      : null,
    note: `Simulated ${result.runs.toLocaleString()} versions of the rest of the season using your league's real schedule.`,
  };
}

/** Group a week's matchup entries into [rosterA, rosterB] pairs. */
function pairsFrom(entries = []) {
  const byMatchup = new Map();
  for (const e of entries) {
    if (e.matchup_id == null) continue;
    if (!byMatchup.has(e.matchup_id)) byMatchup.set(e.matchup_id, []);
    byMatchup.get(e.matchup_id).push(e.roster_id);
  }
  const pairs = [];
  for (const ids of byMatchup.values()) {
    if (ids.length === 2) pairs.push([ids[0], ids[1]]);
  }
  return pairs;
}

/**
 * Points left on the bench, per manager, from what they actually started.
 * Uses the historical `starters` array zipped against roster_positions, and the
 * `players_points` map from the same week.
 */
export function efficiencyReport(ctx) {
  const rows = new Map();

  for (const week of ctx.completedWeeks) {
    const entries = ctx.pastMatchups[week] || [];
    for (const entry of entries) {
      const pts = entry.players_points || {};
      if (Object.keys(pts).length === 0) continue;

      const pointsOf = (p) => Number(pts[p.player_id]) || 0;
      const rosterPlayers = (entry.players || [])
        .map((id) => ctx.playerOf(id) || { player_id: id, position: null, fantasy_positions: [] })
        .filter(Boolean);

      // Zip starters positionally against roster_positions. Summing the set
      // instead can report a total that beats the true optimum.
      const set = scoreSetLineup(ctx.slots, entry.starters || [], pointsOf, (id) => ctx.playerOf(id) || { player_id: id });
      const optimal = solveLineup(ctx.slots, rosterPlayers, pointsOf);

      const actual = set.total;
      // Sleeper's own points for the week, when present, is the authority.
      const reported = entry.points != null ? round2(Number(entry.points)) : actual;
      const best = Math.max(optimal.total, reported);

      const key = String(entry.roster_id);
      if (!rows.has(key)) rows.set(key, { rosterId: entry.roster_id, actual: 0, optimal: 0, weeks: [] });
      const row = rows.get(key);
      row.actual += reported;
      row.optimal += best;
      row.weeks.push({
        week,
        actual: reported,
        optimal: round2(best),
        leftOnBench: round2(Math.max(0, best - reported)),
      });
    }
  }

  const out = [...rows.values()].map((r) => {
    const roster = ctx.rosterOf(r.rosterId);
    // Cap at 100%: you cannot start a better lineup than the best one available.
    const efficiency = r.optimal > 0 ? Math.min(1, r.actual / r.optimal) : null;
    return {
      rosterId: r.rosterId,
      teamName: roster ? ctx.teamName(roster) : `Roster ${r.rosterId}`,
      isMine: String(r.rosterId) === String(ctx.myRoster?.roster_id),
      actual: round2(r.actual),
      optimal: round2(r.optimal),
      pointsLeftOnBench: round2(Math.max(0, r.optimal - r.actual)),
      perWeekLeftOnBench: r.weeks.length ? round2(Math.max(0, r.optimal - r.actual) / r.weeks.length) : 0,
      efficiency,
      weeks: r.weeks,
    };
  });

  out.sort((a, b) => (b.efficiency ?? 0) - (a.efficiency ?? 0));
  return {
    rows: out,
    weeksCounted: ctx.completedWeeks.length,
    emptyMessage: out.length === 0
      ? 'No completed weeks yet this season. This view fills in once week 1 is in the books.'
      : null,
  };
}

/** Power rankings: total value over replacement across each team's best legal lineup. */
export function powerRankings(ctx) {
  const rows = ctx.rosters.map((r) => {
    const players = ctx.playersOn(r.roster_id);
    const lineup = solveLineup(ctx.slots, players, (p) => ctx.valueOf(p.player_id));
    const starters = lineup.assignments.filter((a) => a.player);
    const vorTotal = starters.reduce((s, a) => s + ctx.vorOf(a.player.player_id), 0);
    const s = r.settings || {};

    return {
      rosterId: r.roster_id,
      teamName: ctx.teamName(r),
      isMine: String(r.roster_id) === String(ctx.myRoster?.roster_id),
      record: `${s.wins || 0}-${s.losses || 0}${s.ties ? `-${s.ties}` : ''}`,
      wins: s.wins || 0,
      pointsFor: round2((s.fpts || 0) + (s.fpts_decimal || 0) / 100),
      lineupValue: lineup.total,
      vor: round2(vorTotal),
      best: starters
        .map((a) => ({ name: a.player.name, position: a.player.position, vor: ctx.vorOf(a.player.player_id) }))
        .sort((a, b) => b.vor - a.vor)
        .slice(0, 3),
    };
  });

  rows.sort((a, b) => b.vor - a.vor);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return {
    rows,
    note: 'Value over replacement is how many points a starter is worth compared with the best player you could pick up free at that position. Adding it up across a starting lineup is a fairer read on roster strength than the standings, which reward luck.',
  };
}
