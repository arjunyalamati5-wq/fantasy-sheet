// Standings arithmetic that does not depend on the simulation: all-play
// records, luck, and strict clinch/elimination marks from the remaining
// schedule. "Strict" means a mark is only given when it is certain whatever
// happens in every other game, and any tie in wins is assumed to go against
// the team being marked for a clinch and for it for an elimination (points for
// is not known in advance). Results that depend on two teams who play each
// other not both winning are NOT used, so these marks can be late, never wrong.

const half = (x) => Math.round(x * 2) / 2;

/**
 * Each week's score against every other team's score that week.
 * @param {{week:number, scores:{rosterId, points:number}[]}[]} weeks
 * @returns {Map<string,{w:number,l:number,t:number,games:number,expectedWins:number}>}
 *   expectedWins is the wins a team would have had in an average schedule:
 *   each week's all-play share (wins plus half ties over opponents) added up.
 */
export function allPlayRecords(weeks) {
  const out = new Map();
  const rec = (id) => {
    const k = String(id);
    if (!out.has(k)) out.set(k, { w: 0, l: 0, t: 0, games: 0, expectedWins: 0 });
    return out.get(k);
  };
  for (const { scores } of weeks) {
    const live = (scores || []).filter((s) => s.points !== null && s.points !== undefined && Number.isFinite(Number(s.points)));
    // A week with every score at zero has not been played.
    if (live.length < 2 || live.every((s) => Number(s.points) === 0)) continue;
    for (const a of live) {
      const r = rec(a.rosterId);
      let w = 0, l = 0, t = 0;
      for (const b of live) {
        if (b === a) continue;
        const d = Number(a.points) - Number(b.points);
        if (d > 0) w++; else if (d < 0) l++; else t++;
      }
      r.w += w; r.l += l; r.t += t; r.games += 1;
      r.expectedWins += (w + 0.5 * t) / (live.length - 1);
    }
  }
  for (const r of out.values()) r.expectedWins = Math.round(r.expectedWins * 100) / 100;
  return out;
}

/** Wins above (positive) or below what the scores earned. */
export function luck(actualWins, expectedWins) {
  return Math.round((Number(actualWins) - Number(expectedWins)) * 100) / 100;
}

/** "31-24" or "31-24-1". */
export function recordText(r) {
  return r ? `${r.w}–${r.l}${r.t ? `–${r.t}` : ''}` : '';
}

/**
 * Most games each team could still play: its scheduled ones plus one for every
 * week whose pairings are unknown (so a missing schedule never hides a threat).
 */
export function gamesLeft(teamIds, remainingWeeks, unknownWeeks = 0) {
  const n = new Map(teamIds.map((id) => [String(id), unknownWeeks]));
  for (const wk of remainingWeeks) {
    for (const pair of wk.pairs) {
      for (const id of pair) {
        const k = String(id);
        if (n.has(k)) n.set(k, n.get(k) + 1);
      }
    }
  }
  return n;
}

/**
 * Clinch and elimination marks.
 * @param {Object} cfg
 * @param {{rosterId, wins:number, division?:*}[]} cfg.teams  wins count a tie as half
 * @param {{pairs:number[][]}[]} cfg.remainingWeeks
 * @param {number} [cfg.unknownWeeks]  weeks left whose pairings are not known
 * @param {number} cfg.playoffTeams
 * @returns {Map<string,{clinchedPlayoff,clinchedDivision,outOfDivision,eliminated,mark,gamesLeft,magic}>}
 */
export function clinchMarks({ teams, remainingWeeks = [], unknownWeeks = 0, playoffTeams }) {
  const ids = teams.map((t) => t.rosterId);
  const left = gamesLeft(ids, remainingWeeks, unknownWeeks);
  const divisions = new Set(teams.map((t) => t.division).filter((d) => d !== null && d !== undefined));
  const hasDiv = divisions.size >= 2;
  const D = hasDiv ? divisions.size : 0;
  const P = playoffTeams;
  const n = teams.length;
  const info = teams.map((t) => ({
    id: String(t.rosterId),
    div: t.division ?? null,
    wins: Number(t.wins) || 0,
    max: (Number(t.wins) || 0) + left.get(String(t.rosterId)),
    games: left.get(String(t.rosterId)),
  }));

  const test = (me, wins) => {
    const others = info.filter((j) => j !== me);
    const mates = hasDiv ? others.filter((j) => j.div === me.div) : [];
    const clinchedDivision = hasDiv && mates.every((j) => j.max < wins);
    const outOfDivision = hasDiv && mates.some((j) => j.wins > me.max);
    const threats = others.filter((j) => j.max >= wins).length;
    const clinchedPlayoff = P >= n || clinchedDivision || threats < (hasDiv ? P - D : P);
    return { clinchedDivision, outOfDivision, clinchedPlayoff };
  };

  const out = new Map();
  for (const me of info) {
    const base = test(me, me.wins);
    const ahead = info.filter((j) => j !== me && j.wins > me.max).length;
    // P teams already beyond reach: a division title is the only way back in.
    const eliminated = !base.clinchedPlayoff && P < n && ahead >= P && (!hasDiv || base.outOfDivision);

    const magicFor = (key) => {
      for (let k = 0; k <= me.games; k++) {
        if (test(me, me.wins + k)[key]) return k;
      }
      return null;
    };
    const mp = magicFor('clinchedPlayoff');
    const md = hasDiv ? magicFor('clinchedDivision') : null;

    let mark = '';
    if (base.clinchedDivision) mark = 'y';
    else if (base.clinchedPlayoff) mark = 'x';
    else if (eliminated) mark = 'e';
    else if (base.outOfDivision) mark = 'd';

    out.set(me.id, {
      clinchedPlayoff: base.clinchedPlayoff,
      clinchedDivision: base.clinchedDivision,
      outOfDivision: base.outOfDivision,
      eliminated,
      mark,
      gamesLeft: me.games,
      magic: {
        playoff: magicState(mp, me.games, base.clinchedPlayoff, eliminated),
        division: hasDiv ? magicState(md, me.games, base.clinchedDivision, base.outOfDivision) : null,
      },
    });
  }
  return out;
}

function magicState(k, games, clinched, out) {
  if (clinched) return { state: 'clinched', wins: 0, of: games };
  if (out) return { state: 'out', wins: null, of: games };
  if (k === null) return { state: 'none', wins: null, of: games };
  return { state: 'wins', wins: k, of: games };
}

/** One plain word for where a team stands. */
export function statusWord({ playoffOdds = 0, clinchedPlayoff = false, eliminated = false }) {
  if (eliminated) return 'eliminated';
  if (clinchedPlayoff || playoffOdds >= 0.99) return 'lock';
  if (playoffOdds >= 0.7) return 'likely';
  if (playoffOdds >= 0.25) return 'bubble';
  return 'long shot';
}

/** The playoff format in a sentence, from the league's settings. */
export function formatSentence({ playoffTeams, divisionCount }) {
  const P = playoffTeams;
  if (divisionCount >= 2) {
    const wild = Math.max(0, P - divisionCount);
    const winners = divisionCount > P ? `${P} of the ${divisionCount} division winners` : `${divisionCount} division winners`;
    return `${P} teams make it: ${winners}${wild ? `, then ${wild} wildcard${wild === 1 ? '' : 's'} by record` : ''}, points for breaking ties.`;
  }
  return `${P} teams make it: the best ${P} records, points for breaking ties. This league has no divisions.`;
}

/** Round to the nearest half win, for the wins histogram. */
export const toHalf = half;
