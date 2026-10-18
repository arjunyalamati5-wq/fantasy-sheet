// Streaming: which kicker or defence to pick up for each of the next three
// weeks, and the best path through all three. Free agents and your own only.

import { load } from './store.js';
import { el, n1, renderAsync, emptyState } from './ui.js';
import { segmented, block } from './seg.js';
import { riseWords } from './motion.js';

const POS = { DEF: { label: 'Defences', one: 'defence', title: 'Defence' }, K: { label: 'Kickers', one: 'kicker', title: 'Kicker' } };
const range = (a, b) => (a === b ? `week ${a}` : `weeks ${a}–${b}`);

/** The pick-up plan: one line per step, then how it compares with holding one option. */
function pathBlock(pos, group) {
  const p = group.path;
  if (!p.steps.length) {
    return block({ band: 'waivers', id: `path-${pos}`, title: 'Best 3-week path' }, [
      emptyState('Nothing to plan', `No ${POS[pos].one} has a game in these weeks.`),
    ]);
  }
  const compare = p.hold
    ? (p.gain > 0.05
      ? `Streaming scores ${n1(p.total)} over the stretch against ${n1(p.hold.total)} for holding ${p.hold.name} all the way: ${n1(p.gain)} better.`
      : `Holding ${p.hold.name} all the way scores ${n1(p.hold.total)}, about the same as streaming (${n1(p.total)}), so there is no need to churn the roster.`)
    : null;
  return block({ band: 'waivers', id: `path-${pos}`, title: 'Best 3-week path', note: 'The top option in each week; the same player in back-to-back weeks is one pick-up.' }, [
    el('ol', { class: 'stream-steps' }, p.steps.map((s) => el('li', {}, [
      el('strong', { text: `${s.name} ` }),
      el('span', { text: `${range(s.fromWeek, s.toWeek)}, ${s.where}` }),
      el('span', { class: 'stream-owned', text: s.owned }),
    ]))),
    compare ? el('p', { class: 'stream-compare', text: compare }) : null,
  ]);
}

function weekTable(pos, wk, group) {
  const t = el('table', { class: 'sheet stream-sheet' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: `${POS[pos].title} options for week ${wk.week}, best first` }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: '#' }),
    el('th', { class: 'l', scope: 'col', text: POS[pos].title }),
    el('th', { class: 'l wide', scope: 'col', text: 'Game' }),
    el('th', { class: 'wide', scope: 'col', text: 'Vegas total' }),
    el('th', { scope: 'col', text: 'Score' }),
  ])]));
  t.appendChild(el('tbody', {}, wk.rows.map((r) => el('tr', { class: r.rank === 1 ? 'is-move' : '' }, [
    el('td', { class: 'num', text: String(r.rank) }),
    el('th', { class: 'l player', scope: 'row' }, [
      el('span', { class: 'pname', text: `${r.name}` }),
      el('span', { class: 'tag stream-own', text: r.owned }),
      el('span', { class: 'psub', text: r.reason }),
    ]),
    el('td', { class: 'l wide', text: `${r.home ? 'vs' : 'at'} ${r.opp}` }),
    el('td', { class: 'num wide', text: r.total == null ? '—' : n1(r.total) }),
    el('td', { class: 'num big', text: n1(r.score) }),
  ]))));
  return wk.rows.length
    ? el('div', { class: 'table-scroll' }, [t])
    : emptyState('No options', `Nobody here has a game in week ${wk.week}, or every ${POS[pos].one} is on another team.`);
}

function weeksBlocks(pos, group, plan) {
  return group.weeks.map((wk) => block({
    band: 'week', id: `stream-${pos}-${wk.week}`, title: `Week ${wk.week}${wk.week === plan.week ? ' (this week)' : ''}`,
  }, [weekTable(pos, wk, group)]));
}

export function streamView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Streaming' })));
  const body = el('div');
  root.appendChild(body);
  renderAsync(body, load('streaming'), (data) => {
    const plan = data.plan;
    if (!plan || !plan.weeks.length) return emptyState('Nothing to stream', 'There are no games left in the schedule.');
    let pos = 'DEF';
    const holder = el('div', { class: 'stream-body' });
    const note = el('p', { class: 'sp-note', 'aria-live': 'polite' });
    const caveat = el('p', { class: 'sp-note' });
    const draw = () => {
      note.textContent = plan.notes[pos];
      const gaps = [];
      if (!plan.sources.vegas) gaps.push('Vegas lines are not published yet, so those terms are left out.');
      if (pos === 'DEF' && !plan.sources.sacks) gaps.push('Sack rates need the nflverse usage data, which has not loaded.');
      caveat.textContent = gaps.join(' ');
      caveat.hidden = !gaps.length;
      holder.replaceChildren(pathBlock(pos, plan[pos]), ...weeksBlocks(pos, plan[pos], plan));
    };
    const tabs = segmented({
      label: 'Position', value: pos,
      options: Object.entries(POS).map(([id, v]) => ({ id, label: v.label })),
      onChange: (id) => { pos = id; draw(); },
    });
    draw();
    return el('div', {}, [
      el('p', { class: 'hero-sub', text: `Weeks ${plan.weeks[0]} to ${plan.weeks[plan.weeks.length - 1]}: free agents and your own defences and kickers, best first.` }),
      tabs, note,
      caveat,
      holder,
    ]);
  });
}
