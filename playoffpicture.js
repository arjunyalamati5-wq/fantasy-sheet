// The playoff picture: who gets in and how, the standings with all-play and
// luck, clinch marks from strict math, the chance of each seed, and the magic
// number for your own team.

import { el, frag, n1, pct0, signed, callout, bar, figures, announce, loading } from './ui.js';
import { block } from './seg.js';
import { load } from './store.js';

const MARK_TEXT = {
  y: 'Clinched the division title',
  x: 'Clinched a playoff spot',
  d: 'Out of the division race',
  e: 'Eliminated from the playoffs',
};
const STATUS_CLASS = { lock: 'pine', likely: 'pine', bubble: 'amber', 'long shot': '', eliminated: 'brick' };
const STATUS_TEXT = { lock: 'Lock', likely: 'Likely', bubble: 'Bubble', 'long shot': 'Long shot', eliminated: 'Eliminated' };

const recordOf = (t) => `${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ''}`;
const range = (lo, hi) => `${lo}–${hi}`;
const wins1 = (v) => Number(v).toFixed(1);

/** A percentage that never reads as zero when it is merely small. */
function pctSmall(v) {
  if (v === null || v === undefined) return '—';
  if (v > 0 && v < 0.005) return '<1%';
  return pct0(v);
}

export function mark(m) {
  if (!m) return null;
  return el('span', { class: 'mark' }, [
    el('span', { 'aria-hidden': 'true', title: MARK_TEXT[m], text: m }),
    el('span', { class: 'visually-hidden', text: ` (${MARK_TEXT[m].toLowerCase()})` }),
  ]);
}

/** The magic number as a sentence a manager can act on. */
export function magicSentence(magic) {
  if (!magic) return null;
  const p = magic.playoff;
  const games = (n) => `${n} remaining game${n === 1 ? '' : 's'}`;
  const out = { headline: '', detail: '', tone: '' };
  if (p.state === 'clinched') {
    out.headline = 'In';
    out.detail = 'You have clinched a playoff spot.';
    out.tone = 'good';
  } else if (p.state === 'out') {
    out.headline = 'Out';
    out.detail = 'You cannot make the playoffs any more.';
    out.tone = 'warn';
  } else if (p.state === 'wins') {
    out.headline = String(p.wins);
    out.detail = `Win ${p.wins} of your ${games(p.of)} and you are in, whatever anyone else does.`;
  } else if (p.of === 0) {
    out.headline = 'Decided by tiebreak';
    out.detail = 'No games are left, and the points-for tiebreak decides whether you are in.';
  } else {
    out.headline = 'None yet';
    out.detail = `Even ${p.of === 1 ? 'winning your last game' : `winning all ${p.of} games`} would not clinch a spot on its own. You need help from other results.`;
  }
  if (magic.division && magic.division.state === 'wins' && p.state !== 'clinched') {
    out.detail += ` To lock up the division, win ${magic.division.wins} of ${p.of}.`;
  } else if (magic.division?.state === 'clinched') {
    out.detail += ' You have won your division.';
  }
  return out;
}

function standingsTable(r, hasDiv) {
  const t = el('table', { class: 'sheet standings-plus' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: 'League standings with all-play record, luck, playoff, title and division odds, expected wins and status. Select a team for its details.' }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Team' }),
    hasDiv ? el('th', { class: 'l wide', scope: 'col', text: 'Division' }) : null,
    el('th', { scope: 'col', text: 'W–L' }),
    el('th', { class: 'wide', scope: 'col', text: 'Points for' }),
    el('th', { class: 'wide', scope: 'col', text: 'All-play' }),
    el('th', { class: 'wide', scope: 'col', text: 'Luck' }),
    el('th', { scope: 'col', text: 'Playoffs' }),
    el('th', { scope: 'col', text: 'Title' }),
    hasDiv ? el('th', { class: 'wide', scope: 'col', text: 'Division' }) : null,
    el('th', { class: 'wide', scope: 'col', text: 'Expected wins' }),
    el('th', { class: 'l', scope: 'col', text: 'Status' }),
  ])]));

  const cols = hasDiv ? 11 : 9;
  const tb = el('tbody');
  r.teams.forEach((team, i) => {
    const detailId = `sched-${team.rosterId}`;
    const toggle = el('button', {
      type: 'button', class: 'row-toggle', 'aria-expanded': 'false', 'aria-controls': detailId,
    }, [
      el('span', { class: 'rank-badge', 'aria-hidden': 'true', text: String(i + 1) }),
      el('span', { class: 'tname', text: team.name }),
      mark(team.mark),
      el('span', { class: 'chev', 'aria-hidden': 'true', text: '+' }),
    ]);
    const detail = el('tr', { id: detailId, class: 'detail-row', hidden: true }, [
      el('td', { colspan: cols }, [teamPanel(team, r)]),
    ]);
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.chev').textContent = open ? '−' : '+';
      detail.hidden = !open;
    };
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));

    const lucky = team.luck;
    const summary = [
      hasDiv && team.divisionName ? team.divisionName : null,
      team.allPlayText ? `all-play ${team.allPlayText}` : null,
      lucky != null ? `luck ${signed(lucky)}` : null,
      team.titleOdds != null ? `${pctSmall(team.titleOdds)} to win the title` : null,
      `${wins1(team.projectedWins)} expected wins (${range(team.winsLow, team.winsHigh)})`,
      team.mark ? MARK_TEXT[team.mark].toLowerCase() : null,
    ].filter(Boolean).join(', ');

    const rowEl = el('tr', { class: `team-row${team.isMine ? ' mine' : ''}` }, [
      el('th', { class: 'l', scope: 'row' }, [toggle, el('span', { class: 'sub narrow-only', text: summary })]),
      hasDiv ? el('td', { class: 'l wide', text: team.divisionName || '' }) : null,
      el('td', { class: 'num', text: recordOf(team) }),
      el('td', { class: 'num wide', text: n1(team.pointsFor) }),
      el('td', { class: 'num wide', text: team.allPlayText || '—' }),
      el('td', { class: `num wide ${lucky > 0.05 ? 'pos' : lucky < -0.05 ? 'neg' : ''}`, text: lucky == null ? '—' : signed(lucky) }),
      el('td', {}, [
        el('div', { class: 'num', text: pctSmall(team.playoffOdds) }),
        el('div', { style: 'margin-top:4px' }, [bar(team.playoffOdds)]),
      ]),
      el('td', { class: 'num title-odds', text: team.titleOdds == null ? '—' : pctSmall(team.titleOdds) }),
      hasDiv ? el('td', { class: 'num wide', text: pctSmall(team.divisionOdds) }) : null,
      el('td', { class: 'num wide' }, [
        wins1(team.projectedWins),
        el('span', { class: 'sub', text: range(team.winsLow, team.winsHigh) }),
      ]),
      el('td', { class: 'l' }, [el('span', { class: `tag ${STATUS_CLASS[team.status] || ''}`, text: STATUS_TEXT[team.status] || team.status })]),
    ]);
    // The whole row is a click target for the mouse; the button inside is the keyboard's way in.
    rowEl.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select')) return;
      setOpen(detail.hidden);
    });
    tb.appendChild(rowEl);
    tb.appendChild(detail);
  });
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

function seedGrid(r) {
  const P = r.playoffTeams;
  const t = el('table', { class: 'sheet seed-grid' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: `Chance of finishing in each playoff seed, 1 to ${P}, or missing the playoffs` }));
  const head = [el('th', { class: 'l', scope: 'col', text: 'Team' })];
  for (let s = 1; s <= P; s++) head.push(el('th', { scope: 'col', 'aria-label': `Seed ${s}`, text: String(s) }));
  head.push(el('th', { scope: 'col', text: 'Out' }));
  t.appendChild(el('thead', {}, [el('tr', {}, head)]));
  const tb = el('tbody');
  for (const team of r.teams) {
    const seeds = team.seedOdds.slice(0, P);
    const out = Math.max(0, 1 - seeds.reduce((a, b) => a + b, 0));
    const cell = (v, label) => el('td', {
      class: `num cell-p${v < 0.0005 ? ' zero' : ''}`,
      style: `--p:${Math.min(1, v).toFixed(3)}`,
      'aria-label': `${label}: ${Math.round(v * 100)}%`,
      text: v < 0.0005 ? '0' : pctSmall(v).replace('%', ''),
    });
    tb.appendChild(el('tr', { class: team.isMine ? 'mine' : '' }, [
      el('th', { class: 'l', scope: 'row', text: team.name }),
      ...seeds.map((v, i) => cell(v, `Seed ${i + 1}`)),
      cell(out, 'Out'),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

// ---------------------------------------------------------------- upset factor

const UPSET_KEY = 'ff.upset';
const upsetText = (v) => `${Number(v).toFixed(2)}×`;

/** The remembered upset factor, 0.5 to 2.0, or 1. */
export function readUpset() {
  try {
    const v = Number(localStorage.getItem(UPSET_KEY));
    return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : 1;
  } catch { return 1; }
}
export function saveUpset(v) {
  try { localStorage.setItem(UPSET_KEY, String(v)); } catch { /* not remembered */ }
}

/** A labelled slider for the upset factor. onChange fires when the thumb is released. */
export function upsetControl({ value = 1, onChange, id = 'upset' }) {
  const out = el('output', { for: id, class: 'upset-value', text: upsetText(value) });
  const input = el('input', {
    type: 'range', id, min: '0.5', max: '2', step: '0.05', value: String(value),
    'aria-describedby': `${id}-help`, 'aria-valuetext': upsetText(value),
  });
  input.addEventListener('input', () => {
    out.textContent = upsetText(input.value);
    input.setAttribute('aria-valuetext', upsetText(input.value));
  });
  input.addEventListener('change', () => onChange(Number(input.value)));
  return el('div', { class: 'field upset-field' }, [
    el('label', { for: id }, ['Upset factor ', out]),
    input,
    el('p', { id: `${id}-help`, class: 'upset-help', text: '1.00× is the spread of real results around projections. Higher means more upsets.' }),
  ]);
}

// ---------------------------------------------------------------- team details

const favour = (p) => (p >= 0.6 ? 'Favoured' : p <= 0.4 ? 'Underdog' : 'Toss-up');
const FAVOUR_CLASS = { Favoured: 'pine', Underdog: 'brick', 'Toss-up': 'amber' };

/** What a click on a team opens: its remaining games with win chance, seed odds and path. */
function teamPanel(team, r) {
  const P = r.playoffTeams;
  const sched = team.remaining.length
    ? el('ul', { class: 'sched-list sched-odds', 'aria-label': `${team.name} remaining schedule` }, team.remaining.map((g) =>
      el('li', {}, [
        el('span', { class: 'wk', text: `Week ${g.week}` }), ` against ${g.opponentName}`,
        g.winChance != null
          ? el('span', { class: 'game-p' }, [
            ` ${pctSmall(g.winChance)} to win `,
            el('span', { class: `tag ${FAVOUR_CLASS[favour(g.winChance)]}`, text: favour(g.winChance) }),
          ])
          : null,
      ])))
    : el('p', { class: 'dim', text: 'No regular-season games left.' });

  const seeds = (team.seedOdds || []).slice(0, P)
    .map((p, i) => ({ seed: i + 1, p })).filter((x) => x.p >= 0.005).sort((a, b) => b.p - a.p).slice(0, 4);
  const path = [
    ['Makes the playoffs', team.playoffOdds],
    r.byes ? [`Earns a first-round bye (top ${r.byes} seed${r.byes === 1 ? '' : 's'})`, team.byeOdds] : null,
    ['Reaches the final', team.finalOdds],
    ['Wins the title', team.titleOdds],
  ].filter(Boolean).filter(([, p]) => p != null);

  return el('div', { class: 'team-panel' }, [
    el('div', {}, [
      el('h4', { class: 'tp-h', text: 'Remaining schedule' }),
      sched,
    ]),
    el('div', {}, [
      el('h4', { class: 'tp-h', text: 'Seed odds' }),
      seeds.length
        ? el('ul', { class: 'tp-list' }, seeds.map((x) => el('li', {}, [el('strong', { text: `Seed ${x.seed}` }), ` ${pctSmall(x.p)}`])))
        : el('p', { class: 'dim', text: 'Unlikely to finish in a playoff seed.' }),
      el('p', { class: 'tp-note', text: `Finishes with ${wins1(team.projectedWins)} wins on average (${range(team.winsLow, team.winsHigh)} in the middle 80% of seasons).` }),
    ]),
    el('div', {}, [
      el('h4', { class: 'tp-h', text: 'Path to the title' }),
      el('ol', { class: 'tp-path' }, path.map(([label, p]) => el('li', {}, [
        el('span', { text: label }), el('strong', { text: pctSmall(p) }),
      ]))),
    ]),
  ]);
}

// ---------------------------------------------------------------- win-total chart

/** Small multiples of each team's final wins, one shared scale, plus the same numbers as a table. */
function winChart(r) {
  const all = r.teams.flatMap((t) => (t.winsDist || []).map((d) => d.wins));
  if (!all.length) return null;
  const lo = Math.floor(Math.min(...all));
  const hi = Math.ceil(Math.max(...all));
  const steps = [];
  for (let w = lo; w <= hi; w += 0.5) steps.push(w);
  const top = Math.max(0.01, ...r.teams.flatMap((t) => (t.winsDist || []).map((d) => d.p)));
  const W = 144;
  const H = 52;
  const bw = W / steps.length;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  const grid = el('div', { class: 'win-grid' });
  for (const t of r.teams) {
    const byWins = new Map((t.winsDist || []).map((d) => [d.wins, d.p]));
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H + 12}`, class: 'win-svg', role: 'img', 'aria-label': `${t.name}: most likely ${mode(t.winsDist)} wins, expected ${wins1(t.projectedWins)}, middle 80% ${range(t.winsLow, t.winsHigh)}` });
    steps.forEach((w, i) => {
      const p = byWins.get(w) || 0;
      const h = p / top * H;
      const inRange = w >= t.winsLow && w <= t.winsHigh;
      svg.appendChild(svgEl('rect', {
        x: (i * bw + 0.5).toFixed(2), y: (H - h).toFixed(2), width: Math.max(1, bw - 1).toFixed(2), height: h.toFixed(2),
        class: inRange ? 'win-bar in' : 'win-bar',
      }));
    });
    svg.appendChild(svgEl('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'win-axis' }));
    const label = (w, anchor, x) => {
      const tx = svgEl('text', { x, y: H + 10, class: 'win-tick', 'text-anchor': anchor });
      tx.textContent = String(w);
      svg.appendChild(tx);
    };
    label(lo, 'start', 0);
    label(hi, 'end', W);
    grid.appendChild(el('figure', { class: `win-fig${t.isMine ? ' mine' : ''}` }, [
      svg,
      el('figcaption', {}, [
        el('strong', { text: t.name }),
        el('span', { class: 'sub', text: `${wins1(t.projectedWins)} expected, ${range(t.winsLow, t.winsHigh)}` }),
      ]),
    ]));
  }

  const table = el('table');
  table.appendChild(el('caption', { text: 'Chance of each final win total, by team, from the season simulation' }));
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { scope: 'col', text: 'Team' }),
    ...steps.map((w) => el('th', { scope: 'col', text: `${w} wins` })),
  ])]));
  table.appendChild(el('tbody', {}, r.teams.map((t) => {
    const byWins = new Map((t.winsDist || []).map((d) => [d.wins, d.p]));
    return el('tr', {}, [
      el('th', { scope: 'row', text: t.name }),
      ...steps.map((w) => el('td', { text: `${Math.round((byWins.get(w) || 0) * 100)}%` })),
    ]);
  })));
  return el('div', { class: 'win-chart' }, [grid, el('div', { class: 'visually-hidden' }, [table])]);
}

function mode(dist = []) {
  let best = null;
  for (const d of dist) if (!best || d.p > best.p) best = d;
  return best ? best.wins : '—';
}

// ---------------------------------------------------------------- the picture

/**
 * The playoff picture. It owns the upset slider: moving it asks the server for
 * the same report at the new spread and redraws in place.
 */
export function playoffPicture(r) {
  const host = el('div', { class: 'pp-host' });
  const redraw = (report) => {
    host.textContent = '';
    host.appendChild(picture(report, async (v) => {
      saveUpset(v);
      host.setAttribute('aria-busy', 'true');
      try {
        const data = await load('season', { upset: v });
        redraw(data.report);
        announce(`Upset factor ${upsetText(v)}. The odds are recalculated.`);
        host.querySelector('#pp-upset')?.focus({ preventScroll: true });
      } catch (err) {
        host.removeAttribute('aria-busy');
        host.prepend(callout(`The odds did not update: ${err.message}`, 'amber'));
        announce(`The odds did not update. ${err.message}`, { assertive: true });
      }
    }));
  };
  redraw(r);
  // Come back to the spread the manager chose last time.
  const saved = readUpset();
  if (Math.abs(saved - (r.upset ?? 1)) > 1e-9) {
    host.appendChild(loading('Applying your upset factor…'));
    load('season', { upset: saved }).then((d) => redraw(d.report), () => redraw(r));
  }
  return host;
}

function picture(r, onUpset) {
  const hasDiv = r.format.divisions >= 2;
  const out = frag([]);
  const sections = [];

  const lead = [r.format.text];
  if (!r.emptyMessage) lead.push(r.note);
  sections.push(el('p', { class: 'sp-lede', text: lead.join(' ') }));

  if (!r.sanity.playoffOk || !r.sanity.titleOk) {
    sections.push(callout(`Sanity check failed: playoff odds summed to ${Number(r.sanity.playoffSum).toFixed(2)} (expected ${r.sanity.playoffExpected}) and title odds to ${Number(r.sanity.titleSum).toFixed(2)} (expected 1).`, 'warn'));
  }

  const m = magicSentence(r.magic);
  if (m && !r.emptyMessage) {
    sections.push(el('div', { class: 'magic' }, [
      figures([{ value: m.headline, label: 'Your magic number', sublabel: r.magic.name, tone: m.tone }]),
      el('p', { class: 'magic-detail', text: m.detail }),
    ]));
  }

  sections.push(upsetControl({ value: r.upset ?? 1, onChange: onUpset, id: 'pp-upset' }));
  sections.push(el('p', { class: 'sp-hint', text: 'Click a team for its details.' }));
  sections.push(standingsTable(r, hasDiv));
  const legend = el('p', { class: 'sp-legend' }, [
    el('strong', { text: 'Marks: ' }),
    ...['y', 'x', 'd', 'e'].flatMap((k, i) => [
      i ? '  ' : null,
      el('span', { class: 'mark', text: k }), ` ${MARK_TEXT[k].toLowerCase()}.`,
    ]),
    ' They come from the remaining schedule alone, with every tie in wins counted against you, so a mark can arrive late but is never wrong. ',
    el('strong', { text: 'All-play ' }), 'is each week’s score against every other team’s that week. ',
    el('strong', { text: 'Luck ' }), 'is your wins minus the wins those scores would have earned. ',
    el('strong', { text: 'Expected wins ' }), 'show the average and the middle 80% of simulated seasons. ',
    el('strong', { text: 'Title ' }), 'is how often a team wins the whole thing: after every simulated regular season is seeded, its playoffs are played too, drawn after the regular season so no regular-season number moves.',
  ]);
  sections.push(legend);

  out.appendChild(block({ band: 'league', id: 'pp-standings', title: 'Standings and playoff odds' }, sections));

  out.appendChild(block({
    band: 'week', id: 'pp-seeds', title: 'Chance of each seed',
    note: hasDiv
      ? 'Division winners take the top seeds, then wildcards by record. Each row adds to 100%.'
      : 'Seeds go by record, then points for. Each row adds to 100%.',
  }, [seedGrid(r), el('p', { class: 'section-note', text: `Checks: playoff percentages add to ${Math.round(r.sanity.playoffSum * 100)}% across ${r.sanity.playoffExpected} spots, title percentages to ${Math.round(r.sanity.titleSum * 100)}%.` })]));

  const chart = winChart(r);
  if (chart) {
    out.appendChild(block({
      band: 'waivers', id: 'pp-wins', title: 'Win-total chart',
      note: 'How many games each team wins by the end of the regular season, across the simulated seasons. Taller bars are likelier; the solid bars are the middle 80%.',
    }, [chart]));
  }
  out.appendChild(el('p', { class: 'sp-hint' }, [el('a', { class: 'bk-link', href: '#bracket', text: 'See the playoff bracket' }), ' for the drawn bracket, with exact title odds.']));
  return out;
}
