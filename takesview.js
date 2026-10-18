// Hot takes: a feed of short, rule-based observations about players, each with
// the numbers behind it and how often that kind of take was right last season.

import { load } from './store.js';
import { el, renderAsync, emptyState, announce, field } from './ui.js';
import { riseWords, goArrow } from './motion.js';

const SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'My players' },
  { key: 'waiver', label: 'Waiver wire' },
  { key: 'league', label: 'League-wide' },
];
const TONE = {
  good: { label: 'Good news', band: 'waivers' },
  watch: { label: 'Watch', band: 'team' },
  bad: { label: 'Bad news', band: 'week' },
};
const EMPTY = {
  all: ['No takes yet', 'Nothing in the numbers clears the bar this week. Check back after the next games.'],
  mine: ['Nothing on your players', 'None of your players trip a detector right now. That is quiet, not bad.'],
  waiver: ['Nobody worth a claim', 'No free agent shows a rising role this week.'],
  league: ['Nothing league-wide', 'No player on another team trips a detector right now.'],
};
// Plain names for the metric key a take carries (the player page defines each one).
const METRIC_NAMES = {
  wopr: 'Weighted opportunity rating', td_gap: 'Touchdowns minus expected', i10_car_share: 'Inside-10 carry share',
  i10_tgt_share: 'Inside-10 target share', adot: 'Average depth of target', ez_tgt: 'End-zone targets',
  tgt_share: 'Target share', snap_pct: 'Snap share', rz_share: 'Inside-20 share',
};
const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * Two honest measures from the last-season replay: how these players did in
 * absolute terms (points, starter weeks, busts) and whether they beat the
 * projection, which already prices most of what a take sees.
 */
export function backtestLine(bt) {
  if (!bt || bt.hitRate == null) return 'Not backtested yet.';
  const season = bt.season || 2025;
  const gap = Math.round((bt.hitRate - bt.baseline) * 100);
  const vsProj = Math.abs(gap) <= 1
    ? `They beat their projection ${pct(bt.hitRate)} of the time, level with everyone (${pct(bt.baseline)}): the projection already counts it.`
    : `They beat their projection ${pct(bt.hitRate)} of the time, against ${pct(bt.baseline)} for everyone, ${Math.abs(gap)} points ${gap > 0 ? 'ahead' : 'behind'}.`;
  const small = bt.small ? ' Small sample, so treat it loosely.' : '';
  if (bt.pts == null) return `${season} backtest (${bt.n} takes): ${vsProj}${small}`;
  return `${season} backtest (${bt.n} takes): these players averaged ${bt.pts.toFixed(1)} points, had a starter week ${pct(bt.topRate)} of the time and busted ${pct(bt.bustRate)}, against ${bt.basePts.toFixed(1)}, ${pct(bt.baseTop)} and ${pct(bt.baseBust)} for other active players. ${vsProj}${small}`;
}

function takeCard(t) {
  const tone = TONE[t.tone] || TONE.watch;
  return el('article', { class: 'take stack-block', 'data-band': tone.band, 'aria-labelledby': `take-${t.id}` }, [
    el('div', { class: 'take-meta' }, [
      el('span', { class: 'step-tag take-tone', text: tone.label }),
      el('span', { class: 'take-who', text: `${t.name}, ${t.pos} ${t.team}` }),
    ]),
    el('h3', { id: `take-${t.id}`, class: 'take-headline', text: t.headline }),
    el('p', { class: 'take-evidence', text: t.evidence }),
    el('p', { class: 'take-backtest', text: backtestLine(t.backtest) }),
    el('p', { class: 'take-why' }, [el('strong', { text: 'Why it matters for you: ' }), t.whyItMatters]),
    el('div', { class: 'take-foot' }, [
      el('span', { class: 'take-sample', text: `Sample: ${t.sample}` }),
      el('span', { class: 'take-sources', text: `Sources: ${(t.sources || []).join(', ')}` }),
      t.metric ? el('a', {
        class: 'take-origin', href: `#player/${encodeURIComponent(t.playerId)}`,
        title: `${METRIC_NAMES[t.metric] || t.metric}: ${t.source || ''}`,
        'aria-label': `Where this number comes from: ${METRIC_NAMES[t.metric] || t.metric} for ${t.name}`,
      }, [el('span', { text: 'Where this number comes from' })]) : null,
      el('a', { class: 'take-link', href: `#player/${encodeURIComponent(t.playerId)}`, 'aria-label': `More on ${t.name}` }, [
        el('span', { text: `More on ${t.name}` }), goArrow(),
      ]),
    ]),
  ]);
}

function feed(report) {
  const f = { scope: 'all', detector: 'all' };
  const wrap = el('div', { class: 'takes' });
  const bar = el('div', { class: 'takes-controls' });
  const list = el('div', { class: 'takes-feed' });
  wrap.append(bar, list);

  const matches = (t, scope, detector) => (scope === 'all' || t.scope === scope) && (detector === 'all' || t.detector === detector);
  const count = (scope, detector) => report.takes.filter((t) => matches(t, scope, detector)).length;

  function draw({ speak = false } = {}) {
    // The controls are rebuilt with fresh counts; keep keyboard focus on the same one.
    const focusKey = bar.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
    const chips = el('div', { class: 'take-chips', role: 'group', 'aria-label': 'Whose takes' }, SCOPES.map((s) => {
      const on = f.scope === s.key;
      return el('button', {
        type: 'button', class: 'take-chip', 'data-fk': s.key, 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { f.scope = s.key; draw({ speak: true }); },
      }, [s.label, el('span', { class: 'take-count', text: ` ${count(s.key, f.detector)}` })]);
    }));
    const select = el('select', {
      'data-fk': 'detector',
      onchange: (e) => { f.detector = e.target.value; draw({ speak: true }); },
    }, [
      el('option', { value: 'all', text: `All detectors (${count(f.scope, 'all')})`, selected: f.detector === 'all' }),
      ...report.detectors.map((d) => el('option', {
        value: d.key, selected: f.detector === d.key,
        text: `${d.label} (${count(f.scope, d.key)})${d.unavailable ? ', data unavailable' : ''}`,
      })),
    ]);
    bar.replaceChildren(chips, field('Detector', select, { class: 'field take-detector' }));
    if (focusKey) bar.querySelector(`[data-fk="${focusKey}"]`)?.focus();

    const shown = report.takes.filter((t) => matches(t, f.scope, f.detector));
    if (!shown.length) {
      const [title, body] = EMPTY[f.scope];
      const down = report.detectors.find((d) => d.key === f.detector && d.unavailable);
      if (down) list.replaceChildren(emptyState(down.note || 'Charting data unavailable right now', 'This detector needs charting data that could not be loaded. The other detectors are unaffected.'));
      else list.replaceChildren(emptyState(f.detector === 'all' ? title : 'No takes from this detector', f.detector === 'all' ? body : 'Try another detector or widen the filter.'));
    } else {
      list.replaceChildren(...shown.map(takeCard));
    }
    if (speak) announce(`${shown.length} ${shown.length === 1 ? 'take' : 'takes'} shown.`);
  }

  draw();
  return wrap;
}

/** Each detector's own record, shown whatever it is. */
function scorecard(report) {
  const rows = report.detectors.filter((d) => d.backtest);
  const down = report.detectors.filter((d) => d.unavailable);
  if (!rows.length && !down.length) return null;
  return el('details', { class: 'take-scorecard' }, [
    el('summary', { text: `How each detector did in ${report.backtestSeason}` }),
    el('ul', {}, [
      ...rows.map((d) => el('li', {}, [el('strong', { text: `${d.label}: ` }), backtestLine(d.backtest)])),
      ...down.filter((d) => !d.backtest).map((d) => el('li', {}, [el('strong', { text: `${d.label}: ` }), d.note || 'Charting data unavailable right now.'])),
    ]),
  ]);
}

export function takesView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Hot takes' })));
  const body = el('div');
  root.appendChild(body);
  renderAsync(body, load('takes'), (data) => {
    const r = data.report;
    const n = r.takes.length;
    return el('div', {}, [
      el('p', {
        class: 'hero-sub',
        text: `${n} ${n === 1 ? 'take' : 'takes'} from real numbers${r.dataThrough ? `, data through week ${r.dataThrough}` : ''}.`
          + (r.backtestAvailable ? '' : ' The last-season backtest is not available right now.'),
      }),
      feed(r),
      scorecard(r),
    ]);
  });
}

/** Home's slice: the strongest takes on your own players, then a way in. */
export function takesPreview(limit = 3) {
  const box = el('section', { class: 'takes-preview stack-block', 'data-band': 'waivers', 'aria-labelledby': 'takes-preview-title' }, [
    el('div', { class: 'phase-head' }, [el('h2', { id: 'takes-preview-title', class: 'phase-title', text: 'Hot takes' })]),
  ]);
  const body = el('div', { class: 'preview-body' }, [el('p', { class: 'phase-empty', text: 'Reading the numbers…' })]);
  box.appendChild(body);
  load('takes').then(({ report }) => {
    const mine = report.takes.filter((t) => t.scope === 'mine').slice(0, limit);
    body.replaceChildren(
      mine.length
        ? el('ol', { class: 'steps' }, mine.map((t) => el('li', {}, [
          el('a', { class: 'step', href: '#takes' }, [
            el('span', { class: 'step-text' }, [
              el('span', { class: 'step-title' }, [t.headline, ' ', el('span', { class: 'step-tag', text: (TONE[t.tone] || TONE.watch).label })]),
              el('span', { class: 'step-detail', text: t.evidence }),
            ]),
            goArrow(),
          ]),
        ])))
        : el('p', { class: 'phase-empty', text: 'Nothing is standing out on your players right now.' }),
      el('a', { class: 'cta', href: '#takes' }, [el('span', { class: 'cta-label', text: 'All hot takes' }), goArrow()]),
    );
  }).catch((err) => {
    body.replaceChildren(emptyState('Hot takes did not load', err.message));
  });
  return box;
}
