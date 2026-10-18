// Bye and injury planner: a calendar of every week left, where the lineup has
// holes (byes, IR), and the best waiver pickup to fill each one.

import { load } from './store.js';
import { el, renderAsync, emptyState, signed, n1 } from './ui.js';
import { riseWords, goArrow } from './motion.js';
import { whatIfButton } from './whatifview.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pts = (v) => `${n1(Math.abs(v))} points`;

/** The week's change in words, never colour alone. */
export function deltaWords(w) {
  if (!w.holes.length && Math.abs(w.delta) < 0.05) return 'normal week';
  if (w.delta < -0.05) return `${pts(w.delta)} below normal`;
  if (w.delta > 0.05) return `${pts(w.delta)} above normal`;
  return 'normal week';
}

function strip(report) {
  const items = report.weeks.map((w) => {
    const has = w.holes.length > 0;
    const label = `Week ${w.week}${w.playoff ? ', playoffs' : ''}: ${has ? plural(w.holes.length, 'hole', 'holes') : 'no holes'}, ${deltaWords(w)}`;
    const body = [
      el('span', { class: 'pl-wk', text: `Wk ${w.week}` }),
      w.playoff ? el('span', { class: 'pl-tag', text: 'Playoffs' }) : null,
      el('span', { class: 'pl-holes', text: has ? plural(w.holes.length, 'hole', 'holes') : 'No holes' }),
      el('span', { class: 'pl-delta', text: deltaWords(w) }),
    ];
    const attrs = { class: `pl-cell${has ? ' has-holes' : ''}${w.playoff ? ' is-playoff' : ''}` };
    if (!has) return el('li', attrs, [el('div', { class: 'pl-cell-in', 'aria-label': label }, body)]);
    return el('li', attrs, [el('button', {
      type: 'button', class: 'pl-cell-in', 'aria-label': `${label}. Jump to the week.`,
      onclick: () => {
        const t = document.getElementById(`pl-week-${w.week}`);
        if (t) { t.scrollIntoView({ block: 'start', behavior: 'smooth' }); t.focus({ preventScroll: true }); }
      },
    }, body)]);
  });
  return el('nav', { class: 'pl-strip-wrap', 'aria-label': 'Weeks left' }, [el('ol', { class: 'pl-strip' }, items)]);
}

function summary(report) {
  const s = report.summary;
  const lines = [];
  if (s.worst.length) {
    lines.push(el('p', { class: 'pl-sum' }, [
      el('strong', { text: 'Roughest weeks: ' }),
      s.worst.map((x) => `week ${x.week}${x.playoff ? ' (playoffs)' : ''}, ${n1(x.loss)} points down`).join('; ') + '.',
    ]));
    lines.push(el('p', { class: 'pl-sum' }, [
      el('strong', { text: 'Points at risk: ' }),
      `${n1(s.pointsAtRisk)} across ${plural(s.weeksWithHoles, 'week', 'weeks')} (a normal week is ${n1(s.usualTotal)}).`,
    ]));
  }
  const ahead = s.planAhead.length ? el('div', { class: 'pl-ahead' }, [
    el('h3', { class: 'sub-title', text: 'Plan ahead' }),
    el('ul', { class: 'pl-ahead-list' }, s.planAhead.map((t) => el('li', { text: t }))),
  ]) : null;
  return el('section', { class: 'stack-block pl-summary', 'aria-label': 'Season summary' }, [...lines, ahead]);
}

function holeRow(h) {
  const m = h.missing;
  const f = h.fill;
  const head = el('p', { class: 'pl-missing' }, [
    el('strong', { text: `${h.slotLabel}: ` }),
    m ? `${m.name} (${m.position}${m.team ? `, ${m.team}` : ''}) is out, ${m.reason}.` : 'Nobody on your roster fits this slot.',
    ` Slot scores ${n1(h.points)} instead of ${n1(h.usualPoints)}.`,
  ]);
  if (!f) {
    return el('li', { class: 'pl-hole' }, [head, el('p', { class: 'pl-fill none', text: 'No free agent beats what you have in this slot.' })]);
  }
  const covers = f.covers.length > 1 ? `covers weeks ${f.coversText}` : `fills week ${f.covers[0]}`;
  const text = `Add ${f.name} (${f.position}${f.team ? `, ${f.team}` : ''})${f.drop ? `, drop ${f.drop.name}` : ''} — ${covers}, about ${n1(f.gain)} points better.`;
  return el('li', { class: 'pl-hole' }, [
    head,
    el('p', { class: 'pl-fill', text }),
    f.bid?.text ? el('p', { class: 'pl-bid', text: f.bid.text }) : null,
    el('div', { class: 'pl-actions' }, [
      whatIfButton(f.whatIf, 'Try it in the what-if lab', { ariaLabel: `Try adding ${f.name} in the what-if lab` }),
      el('a', { class: 'pill-btn pl-link', href: '#waivers', 'aria-label': `Open waivers for ${f.name}` }, [el('span', { text: 'Waivers' }), goArrow()]),
    ]),
  ]);
}

function sheet(w) {
  const rows = w.lineup.map((l) => el('tr', {}, [
    el('th', { scope: 'row', text: l.slotLabel }),
    el('td', { text: l.player ? `${l.player.name} (${l.player.position}${l.player.team ? `, ${l.player.team}` : ''})` : 'Empty' }),
    el('td', { class: 'num', text: n1(l.points) }),
  ]));
  const off = w.off.filter((x) => x.usual);
  return el('section', {
    class: 'stack-block pl-week', id: `pl-week-${w.week}`, tabindex: '-1', 'aria-labelledby': `pl-week-h-${w.week}`,
  }, [
    el('h3', { id: `pl-week-h-${w.week}`, class: 'sub-title', text: `Week ${w.week}${w.playoff ? ' · playoffs' : ''}` }),
    el('p', { class: 'pl-sum', text: `${plural(w.holes.length, 'hole', 'holes')}. You project ${n1(w.total)} points against a normal ${n1(w.usualTotal)}, ${deltaWords(w)}.` }),
    el('ul', { class: 'pl-holes-list' }, w.holes.map(holeRow)),
    off.length ? el('p', { class: 'pl-off', text: `Off this week: ${off.map((x) => `${x.name} (${x.reason})`).join('; ')}.` }) : null,
    el('details', { class: 'pl-lineup' }, [
      el('summary', { text: `Your lineup in week ${w.week}` }),
      el('table', { class: 'sheet' }, [
        el('caption', { class: 'sr-only', text: `Best lineup for week ${w.week} without the players who are off` }),
        el('thead', {}, [el('tr', {}, [
          el('th', { scope: 'col', text: 'Slot' }), el('th', { scope: 'col', text: 'Player' }), el('th', { scope: 'col', class: 'num', text: 'Points' }),
        ])]),
        el('tbody', {}, rows),
      ]),
    ]),
  ]);
}

function render(data) {
  const r = data.report;
  const withHoles = r.weeks.filter((w) => w.holes.length);
  const clear = r.weeks.filter((w) => !w.holes.length).map((w) => w.week);
  const wrap = el('div', { class: 'planner' });
  wrap.appendChild(el('p', {
    class: 'hero-sub',
    text: withHoles.length
      ? `${plural(withHoles.length, 'week', 'weeks')} of the ${r.weeks.length} left ${withHoles.length === 1 ? 'has' : 'have'} holes in your lineup.`
      : `${r.weeks.length} weeks checked, from week ${r.weeks[0]?.week} through the playoffs.`,
  }));
  if (!withHoles.length) {
    wrap.appendChild(emptyState('No holes in any week left.', 'Byes and injuries leave every starting slot filled. This updates when a player is hurt or you set a return week on the Locker room.'));
    return wrap;
  }
  wrap.append(strip(r), summary(r), ...withHoles.map(sheet));
  if (clear.length) {
    wrap.appendChild(el('p', { class: 'pl-clear', text: `No holes in week${clear.length === 1 ? '' : 's'} ${clear.join(', ')}.` }));
  }
  return wrap;
}

export function plannerView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Bye and injury planner' })));
  const body = el('div');
  root.appendChild(body);
  renderAsync(body, load('planner'), render);
}
