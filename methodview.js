// Under the hood: where every number comes from, and how far to trust it.
// Projections are Sleeper's, scored in this league's settings; this page says
// so plainly, shows the floor and ceiling calibration, and gives each kind of
// hot take its own track record, good or bad.

import { load } from './store.js';
import { el, renderAsync } from './ui.js';
import { riseWords } from './motion.js';

const pct = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);
const POS = { QB: 'Quarterback', RB: 'Running back', WR: 'Wide receiver', TE: 'Tight end', K: 'Kicker', DEF: 'Defence' };

function block(band, title, children) {
  return el('section', { class: 'stack-block method-block', 'data-band': band, 'aria-label': title }, [
    el('h3', { class: 'phase-title', text: title }),
    ...children,
  ]);
}

const n1 = (v) => (v == null ? '—' : Number(v).toFixed(1));
const n2 = (v) => (v == null ? '—' : Number(v).toFixed(2));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v) => (v == null ? '—' : Number(v).toLocaleString());
const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`);

const p = (text) => el('p', { class: 'method-p', text });
const note = (text) => el('p', { class: 'phase-when', text });

/** A part that could not be worked out says so, in words. */
const missing = (r, what) => note(r?.reason || `${what} could not be loaded right now.`);

function table(caption, heads, rows, leftCols = [0]) {
  return el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet' }, [
    el('caption', { class: 'visually-hidden', text: caption }),
    el('thead', {}, [el('tr', {}, heads.map((h, i) => el('th', { scope: 'col', class: leftCols.includes(i) ? 'l' : '', text: h })))]),
    el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c, i) => (i === 0
      ? el('th', { scope: 'row', class: 'l', text: c })
      : el('td', { class: leftCols.includes(i) ? 'l' : 'num', text: c })))))),
  ])]);
}

function rulesBlock(r) {
  const a = r.rules;
  const kids = [];
  if (!a?.available) kids.push(missing(a, 'The league rules'));
  else {
    const s = a.scoring;
    const rule = (label, v, unit = 'points') => (v == null ? null : [label, `${v} ${unit}`]);
    const rows = [
      rule('Reception', s.reception), rule('Passing touchdown', s.passTd), rule('Passing yard', s.passYd),
      rule('Rushing yard', s.rushYd), rule('Rushing touchdown', s.rushTd), rule('Receiving yard', s.recYd),
      rule('Receiving touchdown', s.recTd), rule('Interception thrown', s.interception),
      rule('Tight end reception bonus', s.teBonus), rule('300-yard passing bonus', s.passYd300Bonus),
      rule('100-yard rushing bonus', s.rushYd100Bonus), rule('100-yard receiving bonus', s.recYd100Bonus),
    ].filter(Boolean);
    kids.push(p(`Every number is scored with ${a.name || 'your league'}'s own settings, read from Sleeper (${plural(a.scoringRules, 'scoring rule')} in all), not the generic PPR figure Sleeper prints. Sleeper's projection is a list of expected stats, and we score that list with these rules.`));
    if (rows.length) kids.push(table('Scoring rules read from the league', ['Rule', 'Worth'], rows, [0, 1]));
    kids.push(p(`${plural(a.teams, 'team')} start ${plural(a.starters, 'player')} each: ${a.slots.filter((x) => x.slot !== 'BN' && x.slot !== 'IR' && x.slot !== 'TAXI').map((x) => `${x.count} ${x.slot}`).join(', ')}; ${a.bench} on the bench. Waivers use ${a.waiverType}${a.faab ? `, with a budget of $${a.faab.budget ?? '?'} per team` : ''}.`));
  }
  kids.push(el('ul', { class: 'method-list' }, [
    ['Sleeper', 'league, rosters, matchups, live scores, weekly stats and projections, trending adds and drops'],
    ['nflverse', 'schedule with betting lines, injury and practice reports, snap counts, play-by-play'],
    ['ESPN, Reddit, Open-Meteo', 'news and the game clock, fan talk, kickoff weather'],
  ].map(([n, w]) => el('li', {}, [el('strong', { text: n }), ` — ${w}.`]))));
  kids.push(note('Not included: TikTok and X have no open API, so they cannot be read without an approved key.'));
  return block('feeds', 'Where the data comes from', kids);
}

function checkBlock(r) {
  const c = r.projectionCheck;
  const kids = [];
  if (!c?.available) kids.push(missing(c, 'The projection check'));
  else {
    const dir = c.bias > 0.05 ? 'ran high' : c.bias < -0.05 ? 'ran low' : 'had no lean either way';
    kids.push(p(`In this league, Sleeper's projection missed by ${n1(c.mae)} points per player on average over weeks ${c.firstWeek} to ${c.lastWeek}, scored with your league's settings. It ${dir} (bias ${signed(c.bias)} points, projection minus actual). That is ${num(c.n)} player-weeks of players on a roster today who were projected to play and did.`));
    kids.push(table('Sleeper projection error by position, scored with this league settings', ['Position', 'Player-weeks', 'Average miss', 'Bias'],
      c.byPos.map((x) => [POS[x.pos] || x.pos, num(x.n), `${n1(x.mae)} pts`, `${signed(x.bias)} pts`])));
  }
  kids.push(note('Bias above zero means the projection was higher than what happened. Players with no stat line that week are left out, so the check describes "when he plays".'));
  return block('week', 'Projection check', kids);
}

function bakeBlock(r) {
  const b = r.bakeOff;
  const kids = [];
  if (!b?.available) kids.push(missing(b, 'The model comparison'));
  else {
    kids.push(p(`A private model was trained offline to beat Sleeper's projection. ${b.note} The projection already knows everything public, so it is the number we show, and the modelling goes where it holds up: ranges, matchup grades, hot takes and the season simulation.`));
    if (b.kind === 'practice') {
      kids.push(p(`Live check: over ${plural(b.graded, 'graded snapshot')} (${num(b.n)} player-weeks) the model missed by ${n2(b.modelMae)} points against ${n2(b.sleeperMae)} for Sleeper.`));
    } else kids.push(note('No live snapshots have been graded for this league yet, so there is no live figure to show.'));
  }
  return block('team', 'Offline bake-off', kids);
}

function bandsBlock(r) {
  const b = r.bands;
  const kids = [];
  if (!b?.available) kids.push(missing(b, 'The floors and ceilings'));
  else {
    kids.push(p(`A floor is the ${Math.round(b.low * 100)}th percentile of what players actually scored against their projection, a ceiling the ${Math.round(b.high * 100)}th, by position, from the last ${plural(b.weeks, 'finished week')}. About ${Math.round(b.target * 100)} games in 100 should land between them.`));
    const h = b.heldOut;
    if (h?.available) {
      kids.push(p(`Held out on the latest week (${h.season} week ${h.week}), with the bands set from the weeks before it, they caught ${pct(h.coverage)} of ${num(h.n)} outcomes against a ${pct(h.target)} target.`));
      kids.push(table('Held-out coverage by position', ['Position', 'Outcomes', 'Caught'], h.byPos.map((x) => [POS[x.pos] || x.pos, num(x.n), pct(x.coverage)])));
    } else kids.push(missing(h, 'The held-out test'));
    kids.push(table('Floor and ceiling multipliers and spread by position', ['Position', 'Floor ×', 'Ceiling ×', 'Spread (SD, pts)', 'Games measured'],
      b.table.map((c) => [POS[c.pos] || c.pos, n2(c.floor), n2(c.ceiling), n1(c.sd), `${num(c.samples)}${c.fallback ? ' (too few, fixed values used)' : ''}`])));
    kids.push(note('Spread is the standard deviation of actual minus projected, in standard PPR points as Sleeper published both.'));
  }
  return block('team', 'Floors and ceilings', kids);
}

function simBlock(r) {
  const s = r.simulation;
  const bk = r.bracket;
  const kids = [];
  if (!s?.available) kids.push(missing(s, 'The season simulation'));
  else {
    kids.push(p(`Each team's weekly score is its best lineup's expected points plus noise of about ${n1(s.sdMean)} points (${n1(s.sdMin)} to ${n1(s.sdMax)} across teams), drawn from a lopsided distribution. The remaining ${plural(s.weeksSimulated, 'week')} are played ${num(s.runs)} times from the league's real schedule. ${s.divisions >= 2 ? `Division winners are seeded first, then wildcards by record, with points for breaking ties.` : 'Teams are seeded by record, with points for breaking ties.'}`));
  }
  if (!bk?.available) kids.push(missing(bk, 'The bracket'));
  else {
    kids.push(p(`Brackets and title odds are exact, not simulated: every possible result of the ${bk.teams}-team bracket is enumerated. ${bk.byes ? `The top ${plural(bk.byes, 'seed')} get a first-round bye.` : 'There are no byes.'} ${bk.reseed ? 'Teams are reseeded each round.' : 'The bracket is fixed after seeding.'} Playoffs start in week ${bk.startWeek}${bk.twoWeekFinal ? ', with some rounds played over two weeks' : ''}. Teams outside the bracket play a toilet bowl or consolation bracket, as the league is set up.`));
  }
  kids.push(p(`Clinch and elimination marks are strict arithmetic on the remaining games${bk?.available ? ` (${plural(bk.regularWeeksLeft, 'regular-season week')} left)` : ''}, never the simulation: a team is marked only when every possible outcome agrees.`));
  return block('league', 'Season simulation, brackets and clinch marks', kids);
}

function assumptionsBlock(r) {
  const a = r.assumptions;
  const kids = [];
  if (!a?.available) kids.push(missing(a, 'The assumptions'));
  else {
    kids.push(el('ul', { class: 'method-list' }, [
      `This week, a questionable player keeps ${pct(a.questionableShare)} of his projection, a doubtful player ${pct(a.doubtfulShare)}, and a player ruled out ${pct(a.outShare)}.`,
      `A player on injured reserve counts again ${plural(a.irDefaultWeeks, 'week')} out, unless you set a return week.`,
      'Trades take effect next week.',
      'Other managers set their best lineup from next week on.',
      'The lineup optimizer fills the fixed slots first, then the flex slots.',
    ].map((t) => el('li', { text: t }))));
  }
  return block('plan', 'Assumptions', kids);
}

function extraBlock() {
  return block('waivers', 'What we do that the projection does not', [
    p("Sleeper's projection says what one player might score. We add what it leaves out: how your whole lineup fits together, a floor and a ceiling for each player, how the opponent's defence has fared against his position, injury and practice status through the week, and what a move does to your playoff and title odds."),
  ]);
}

function usageBlock(r) {
  const u = r.usage;
  const kids = [];
  if (!u?.available) kids.push(missing(u, 'The usage data'));
  else {
    const when = u.generatedAt ? new Date(u.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
    kids.push(p(`Usage data was last built ${when}, through week ${u.throughWeek ?? '?'} of ${u.season}. It matched ${num(u.matched)} players to Sleeper, leaving ${num(u.unmatched)} unmatched. Charting joined to ${pct(u.ftnJoinRate)} of plays.`));
    if (u.matchMethods.length) kids.push(table('How players were matched', ['Method', 'Players'], u.matchMethods.map((m) => [m.method, num(m.count)]), [0]));
    if (u.xtd) kids.push(p(`The expected-touchdown model was fitted on ${u.xtd.fitSeason}: ${num(u.xtd.targets)} targets and ${num(u.xtd.carries)} carries.`));
    kids.push(p(`Route and coverage data is from ${u.participationSeason}${u.participationIsCurrent ? ', the current season' : '; this season\'s is not published yet'}.`));
  }
  return block('feeds', 'Usage data build', kids);
}

function creditsBlock(r) {
  return block('feeds', 'Credits', [
    el('ul', { class: 'method-list' }, (r.credits || []).map((c) => el('li', {}, [
      el('strong', { text: c.name }), ` — ${c.what}${c.licence ? ` (${c.licence})` : ''}.`,
    ]))),
  ]);
}

function verdictOf(d) {
  const b = d.backtest;
  const beat = (b.hitRate ?? 0) - (b.baseline ?? 0);
  const top = (b.topRate ?? 0) - (b.baseTop ?? 0);
  const bust = (b.bustRate ?? 0) - (b.baseBust ?? 0);
  if (d.tone === 'good') {
    if (beat >= 0.02) return 'Beats the projection';
    if (top >= 0.08 && bust <= 0) return 'Reliable starter; the projection already counts it';
    return 'No better than chance';
  }
  if (d.tone === 'bad') {
    if (beat <= -0.02) return 'Holds up: they fall short';
    if (bust >= 0.03) return 'Riskier, but the projection counts it';
    return 'No better than chance';
  }
  if (beat >= 0.02 && bust >= 0.03) return 'Swingy: beat the projection more often, busted more too';
  if (beat >= 0.02) return 'Beat the projection more often';
  if (beat <= -0.02) return 'They cooled off';
  return 'No better than chance';
}

function takesBlock(r) {
  const rows = (r.detectors || []).filter((d) => d.backtest);
  const vs = (x, base, f = pct) => (x == null ? '—' : `${f(x)} vs ${f(base)}`);
  const pts = (x) => x.toFixed(1);
  return block('takes', 'How the hot takes have done', [
    el('p', { class: 'method-p', text: 'Each kind of take was replayed over the 2025 season, using only what was known before each week, and compared with other active players at the same positions. Two questions: did these players score (points, starter weeks, busts), and did they beat their projection? A take can be a real sign of a good player without beating a projection that already knew it, as target hogs show.' }),
    rows.length ? el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet' }, [
      el('caption', { class: 'visually-hidden', text: 'Hot take track record, 2025, each against other active players' }),
      el('thead', {}, [el('tr', {}, ['Take', 'Points a game', 'Starter weeks', 'Busts', 'Beat projection', 'Takes', 'Verdict'].map((h, i) => el('th', { scope: 'col', class: i === 0 || i === 6 ? 'l' : '', text: h })))]),
      el('tbody', {}, rows.map((d) => {
        const b = d.backtest;
        return el('tr', {}, [
          el('th', { scope: 'row', class: 'l', text: d.label }),
          el('td', { class: 'num', text: b.pts == null ? '—' : vs(b.pts, b.basePts, pts) }),
          el('td', { class: 'num', text: vs(b.topRate, b.baseTop) }),
          el('td', { class: 'num', text: vs(b.bustRate, b.baseBust) }),
          el('td', { class: 'num', text: vs(b.hitRate, b.baseline) }),
          el('td', { class: 'num', text: String(b.n ?? '—') }),
          el('td', { class: 'l', text: verdictOf(d) }),
        ]);
      })),
    ])]) : el('p', { class: 'phase-when', text: 'The backtest has not been computed yet.' }),
    el('p', { class: 'phase-when', text: 'A starter week is top 12 at QB and TE, top 24 at RB and WR. A bust is under half the projection.' }),
  ]);
}

export function methodView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Under the hood' })));
  const body = el('div');
  root.appendChild(body);
  renderAsync(body, load('method'), (data) => {
    const r = data.report || {};
    return el('div', {}, [
      el('p', { class: 'hero-sub', text: 'Where every number comes from, and how far to trust it.' }),
      rulesBlock(r),
      checkBlock(r),
      bakeBlock(r),
      extraBlock(),
      bandsBlock(r),
      simBlock(r),
      assumptionsBlock(r),
      takesBlock(r),
      usageBlock(r),
      creditsBlock(r),
    ]);
  });
}
