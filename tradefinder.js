// Trade finder: every one- and two-for-one trade in the league, ranked by what
// it does for you week by week. Pick a goal; the server does the searching
// (src/features/tradefinder.js). Nothing is sent to Sleeper.

import { load } from './store.js';
import { whatIfButton } from './whatifview.js';
import { segmented } from './seg.js';
import { riseWords } from './motion.js';
import { el, field, emptyState, renderAsync, announce } from './ui.js';

const GOALS = [
  { id: 'odds', label: 'Best for my odds' },
  { id: 'week', label: 'Fix a week' },
  { id: 'position', label: 'Upgrade a position' },
  { id: 'fair', label: 'Fair for both' },
];
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const GOAL_NOTE = {
  odds: 'The deals that raise your playoff and title odds the most, as simulated with the real schedule.',
  week: 'The deals that add the most to your lineup in one week, such as a bye week with an empty slot.',
  position: 'The deals that give you a better starter at one position.',
  fair: 'Deals where both lineups get better, so the other manager has a reason to say yes.',
};
const ACCEPT = {
  likely: 'Likely to accept',
  maybe: 'Could go either way',
  unlikely: 'Unlikely to accept',
};

// Kept between visits to the page in this tab.
const choice = { goal: 'odds', wk: null, pos: 'TE' };

const signed = (v, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
const pct = (v) => {
  if (v == null) return '—';
  const x = v * 100;
  return `${x > 0 && x < 10 ? x.toFixed(1) : Math.round(x)}%`;
};
const names = (list) => list.map((p) => p.name).join(' and ');

/** "Send X for Y (Team)". */
export const headline = (r) => `Send ${names(r.give)} for ${names(r.get)} (${r.partner.teamName})`;

/** "Playoff odds 92% → 97%, title 9% → 14%", or a lineup line when odds are unavailable. */
export function oddsLine(r) {
  const o = r.odds;
  if (!o) return `Your lineup ${signed(r.yourPerWeek)} points a week (odds not shown for this one).`;
  return `Playoff odds ${pct(o.playoffBefore)} → ${pct(o.playoffAfter)}, title ${pct(o.titleBefore)} → ${pct(o.titleAfter)}`;
}

function weekBars(weeks, targetWeek) {
  const max = Math.max(1, ...weeks.map((w) => Math.abs(w.you)));
  return el('ol', { class: 'wi-bars tf-bars', 'aria-hidden': 'true' }, weeks.map((w) => {
    const share = Math.min(1, Math.abs(w.you) / max);
    return el('li', { class: `wi-bar ${w.you >= 0 ? 'is-up' : 'is-down'}${w.phase === 'playoffs' ? ' is-playoff' : ''}${w.week === targetWeek ? ' is-target' : ''}` }, [
      el('span', { class: 'wi-bar-week', text: `W${w.week}` }),
      el('span', { class: 'wi-bar-track' }, [el('span', { class: 'wi-bar-fill', style: `--share:${share}` })]),
      el('span', { class: 'wi-bar-val', text: signed(w.you) }),
    ]);
  }));
}

function weekTable(weeks) {
  const holes = (h) => (h.length ? h.join(', ') : 'none');
  return el('table', { class: 'sheet tf-weeks' }, [
    el('caption', { class: 'visually-hidden', text: 'Week by week: points added to your lineup and to theirs, and empty starting slots before and after' }),
    el('thead', {}, [el('tr', {}, ['Week', 'You', 'Them', 'Empty slots now', 'After'].map((h) => el('th', { scope: 'col', text: h })))]),
    el('tbody', {}, weeks.map((w) => el('tr', {}, [
      el('th', { scope: 'row', text: `${w.week}${w.phase === 'playoffs' ? ' (playoffs)' : ''}` }),
      el('td', { class: 'num', text: signed(w.you) }),
      el('td', { class: 'num', text: signed(w.them) }),
      el('td', { text: holes(w.holesBefore) }),
      el('td', { text: holes(w.holesAfter) }),
    ]))),
  ]);
}

function playerLine(p) {
  return el('li', {}, [
    el('span', { class: 'tf-pname', text: p.name }),
    el('span', { class: 'tf-pmeta', text: ` ${p.position}${p.team ? ` · ${p.team}` : ''} · ${p.valuePerGame.toFixed(1)} per game` }),
  ]);
}

export function resultCard(r, rank, rpt) {
  const target = r.week;
  const sr = r.weeks.map((w) => `week ${w.week} ${signed(w.you)}`).join(', ');
  return el('section', { class: 'stack-block tf-card', 'data-band': 'team', 'aria-labelledby': `tf-h-${rank}` }, [
    el('div', { class: 'tf-head' }, [
      el('h3', { id: `tf-h-${rank}`, class: 'tf-title', text: headline(r) }),
      el('span', { class: `tag tf-accept is-${r.acceptance}`, text: ACCEPT[r.acceptance] }),
    ]),
    el('p', { class: 'tf-odds', text: oddsLine(r) }),
    rpt.goal === 'week' && r.weekGain != null
      ? el('p', { class: 'tf-line', text: `Week ${target}: your lineup ${signed(r.weekGain)} points.` })
      : null,
    el('p', { class: 'tf-line', text: `Your lineup ${signed(r.yourPerWeek)} a week (${signed(r.restOfSeason)} over the rest of the regular season); theirs ${signed(r.theirPerWeek)} a week.` }),
    el('p', { class: 'tf-why', text: r.why }),
    el('div', { class: 'tf-sides' }, [
      el('div', {}, [el('h4', { class: 'tf-side-title', text: 'You send' }), el('ul', { class: 'tf-players' }, r.give.map(playerLine))]),
      el('div', {}, [el('h4', { class: 'tf-side-title', text: 'You get' }), el('ul', { class: 'tf-players' }, r.get.map(playerLine))]),
    ]),
    el('p', { class: 'visually-hidden', text: `Points added to your lineup by week: ${sr}.` }),
    weekBars(r.weeks, target),
    el('details', { class: 'tf-more' }, [el('summary', { text: 'Week by week, with empty slots' }), weekTable(r.weeks)]),
    el('div', { class: 'tf-actions' }, [
      whatIfButton([r.item], 'Try it in the what-if lab', { ariaLabel: `Try in the what-if lab: ${headline(r)}` }),
      el('a', { class: 'tf-link', href: '#trades', text: 'Load into the trade builder' }),
    ]),
  ]);
}

export function tradeFinderView(root) {
  root.textContent = '';
  root.append(riseWords(el('h2', { class: 'hero-title', text: 'Trade finder' })));
  root.append(el('p', { class: 'hero-sub', text: 'Every one-for-one and two-for-one trade in your league, ranked by what it does for you, week by week.' }));

  let outlook = [];
  const weekSel = el('select', { onchange: () => { choice.wk = Number(weekSel.value); run(); } });
  const posSel = el('select', { onchange: () => { choice.pos = posSel.value; run(); } }, POSITIONS.map((p) => el('option', { value: p, selected: p === choice.pos }, [p])));
  const weekField = field('Week to fix', weekSel, { class: 'field tf-field' });
  const posField = field('Position to upgrade', posSel, { class: 'field tf-field' });
  const note = el('p', { class: 'section-note tf-note', text: GOAL_NOTE[choice.goal] });
  const goalSeg = segmented({
    label: 'What to optimise', options: GOALS, value: choice.goal, className: 'tf-goals',
    onChange: (id) => { choice.goal = id; run(); },
  });
  const body = el('div', { class: 'tf-body', 'aria-live': 'polite' });

  function fillWeeks(list, picked) {
    outlook = list;
    weekSel.textContent = '';
    for (const o of list) {
      const label = `Week ${o.week}${o.phase === 'playoffs' ? ' (playoffs)' : ''}${o.holes.length ? ` — empty ${o.holes.join(', ')}` : ''}`;
      weekSel.append(el('option', { value: o.week, selected: o.week === picked }, [label]));
    }
  }
  const sync = () => {
    weekField.hidden = choice.goal !== 'week';
    posField.hidden = choice.goal !== 'position';
    note.textContent = GOAL_NOTE[choice.goal];
  };

  let token = 0;
  function run() {
    sync();
    const mine = ++token;
    const params = { goal: choice.goal };
    if (choice.goal === 'week' && choice.wk) params.wk = choice.wk;
    if (choice.goal === 'position') params.pos = choice.pos;
    renderAsync(body, load('tradefinder', params), (d) => {
      if (mine !== token) return null;
      const rpt = d.report;
      if (rpt.weekOutlook?.length) {
        if (choice.goal === 'week' && rpt.week) choice.wk = rpt.week;
        fillWeeks(rpt.weekOutlook, choice.goal === 'week' ? rpt.week : choice.wk);
      }
      announce(rpt.results.length ? `${rpt.results.length} trades found.` : 'No trades found.');
      if (!rpt.results.length) {
        return el('div', {}, [
          emptyState('No trades found', rpt.weeksLeft === 0
            ? rpt.note
            : choice.goal === 'fair'
              ? 'No swap makes both lineups better right now. Try Best for my odds, where the other manager may lose a little.'
              : 'Nothing in the league improves that for you without costing you more somewhere else. Try another goal, week or position.'),
        ]);
      }
      return el('div', {}, [
        el('p', { class: 'section-note tf-note', text: rpt.note }),
        ...rpt.results.map((r, i) => resultCard(r, i, rpt)),
        el('p', { class: 'tf-foot', text: `Searched ${rpt.scanned.candidates.toLocaleString('en-US')} swaps across ${rpt.scanned.partners} other teams. Lineups use value per game played, with byes and injuries counted week by week.` }),
      ]);
    });
  }

  root.append(
    goalSeg,
    el('div', { class: 'tf-controls' }, [weekField, posField]),
    note,
    body,
  );
  sync();
  run();
}
