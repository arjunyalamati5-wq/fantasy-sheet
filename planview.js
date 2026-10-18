// The game plan: the week as four steps in the order they have to happen,
// each a colour block that slides over the one before as you scroll.

import { load } from './store.js';
import { el, n1, renderAsync, emptyState } from './ui.js';
import { riseWords, goArrow } from './motion.js';

// Each phase borrows the colour of the part of the app where it is done.
const PHASE_BAND = { fix: 'plan', claim: 'waivers', kickoff: 'week', longer: 'league' };
const EMPTY = {
  fix: 'Nothing to fix. You are starting your best legal lineup.',
  claim: 'No free agent would start for you this week. Keep your budget for the next breakout.',
  kickoff: 'Nothing to check yet.',
  longer: 'No moves worth making beyond this week.',
};
const pct = (p) => `${Math.round(p * 100)}%`;

function stepRow(s) {
  const badge = s.tone === 'urgent'
    ? el('span', { class: 'step-tag urgent', text: 'Do this' })
    : s.gain ? el('span', { class: 'step-tag gain', text: `+${n1(s.gain)} pts` }) : null;
  return el('li', {}, [
    el('a', { class: 'step', href: s.href || '#plan' }, [
      el('span', { class: 'step-text' }, [
        el('span', { class: 'step-title' }, [s.title, badge ? ' ' : null, badge]),
        s.detail ? el('span', { class: 'step-detail', text: s.detail }) : null,
      ]),
      goArrow(),
    ]),
  ]);
}

function phaseBlock(phase, i) {
  return el('section', { class: 'plan-phase stack-block', 'data-band': PHASE_BAND[phase.id] || 'feeds', 'aria-labelledby': `phase-${phase.id}` }, [
    el('div', { class: 'phase-head' }, [
      el('span', { class: 'phase-num', 'aria-hidden': 'true', text: String(i + 1) }),
      el('h3', { id: `phase-${phase.id}`, class: 'phase-title', text: phase.title }),
      el('p', { class: 'phase-when', text: phase.when }),
    ]),
    phase.steps.length
      ? el('ol', { class: 'steps' }, phase.steps.map(stepRow))
      : el('p', { class: 'phase-empty', text: EMPTY[phase.id] }),
  ]);
}

/** One sentence that says how the week stands. */
function summary(r) {
  const bits = [];
  bits.push(r.todo ? `${r.todo} ${r.todo === 1 ? 'thing' : 'things'} to do` : 'Nothing urgent to do');
  if (r.winProbability != null) bits.push(`${pct(r.winProbability)} to beat ${r.opponent || 'your opponent'}`);
  if (r.playoffOdds != null) bits.push(`${pct(r.playoffOdds)} playoff odds`);
  return `${bits.join(', ')}.`;
}

export function planView(root) {
  root.textContent = '';
  const title = riseWords(el('h2', { class: 'hero-title', text: 'Your game plan' }));
  root.appendChild(title);
  const body = el('div');
  root.appendChild(body);
  renderAsync(body, load('gameplan'), (data) => {
    const r = data.report;
    return el('div', {}, [
      el('p', { class: 'hero-sub', text: `Week ${r.week}. ${summary(r)}` }),
      ...r.phases.map(phaseBlock),
    ]);
  });
}

/** Home's slice of the plan: the steps that need doing, then a way in. */
export function planPreview() {
  const box = el('section', { class: 'plan-preview stack-block', 'data-band': 'plan', 'aria-labelledby': 'plan-preview-title' }, [
    el('div', { class: 'phase-head' }, [
      el('h2', { id: 'plan-preview-title', class: 'phase-title', text: 'Your game plan' }),
    ]),
  ]);
  const list = el('div', { class: 'preview-body' }, [el('p', { class: 'phase-empty', text: 'Reading every report for this week…' })]);
  box.appendChild(list);
  load('gameplan').then(({ report: r }) => {
    const steps = r.phases.flatMap((p) => p.steps.map((s) => ({ ...s, phase: p.id })))
      .filter((s) => s.tone !== 'info').slice(0, 4);
    const fallback = r.phases.flatMap((p) => p.steps).slice(0, 3);
    list.replaceChildren(
      el('p', { class: 'phase-when', text: summary(r) }),
      el('ol', { class: 'steps' }, (steps.length ? steps : fallback).map(stepRow)),
      el('a', { class: 'cta', href: '#plan' }, [el('span', { class: 'cta-label', text: 'See the whole plan' }), goArrow()]),
    );
  }).catch((err) => {
    list.replaceChildren(emptyState('The game plan did not load', err.message));
  });
  return box;
}
