// Small shared pieces for the lineup, waiver and playoff views: a row of
// toggle buttons, a colour block with a title, and the soft/tough matchup tag.

import { el } from './ui.js';

/**
 * A row of buttons where exactly one is pressed (aria-pressed), for choosing
 * a horizon, a week, or a list. `onChange(id)` fires on a real change only.
 */
export function segmented({ label, options, value, onChange, className = '' }) {
  const wrap = el('div', { class: `seg ${className}`.trim(), role: 'group', 'aria-label': label });
  let current = value;
  const buttons = options.map((o) => el('button', {
    type: 'button', class: 'seg-btn', 'data-id': String(o.id),
    'aria-pressed': String(o.id === current),
    onclick: () => {
      if (o.id === current) return;
      current = o.id;
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.id === String(current)));
      onChange(current);
    },
  }, [o.label]));
  wrap.append(...buttons);
  return wrap;
}

/** A colour block (the studio's section): a title, an optional line under it, then the content. */
export function block({ band = 'team', id, title, note = null, className = '' }, children = []) {
  return el('section', { class: `stack-block sp-block ${className}`.trim(), 'data-band': band, 'aria-labelledby': id }, [
    el('h3', { id, class: 'sp-title', text: title }),
    note ? el('p', { class: 'sp-note', text: note }) : null,
    ...[].concat(children),
  ]);
}

const GRADE_WORD = { soft: 'Soft', avg: 'Average', tough: 'Tough' };
const GRADE_CLASS = { soft: 'pine', tough: 'brick', avg: '' };

/** Matchup grade as a tag. The word carries the meaning; colour only backs it up. */
export function gradeTag(grade) {
  if (!grade) return null;
  return el('span', {
    class: `tag grade ${GRADE_CLASS[grade]}`.trim(),
    title: 'Points the defence allows to his position, against the league average',
    text: GRADE_WORD[grade],
  });
}

/** "vs DAL" plus its grade, or a dash when there is no game. */
export function matchupCell(m) {
  if (!m) return el('span', { class: 'dim', text: '—' });
  return el('span', { class: 'matchup' }, [m.opponent, ' ', gradeTag(m.grade)]);
}

export const range = (lo, hi) => (lo == null || hi == null ? '' : `${lo.toFixed(1)}–${hi.toFixed(1)}`);
export const liftText = (v) => (v > 0.05 ? `+${v.toFixed(1)}` : '0.0');
