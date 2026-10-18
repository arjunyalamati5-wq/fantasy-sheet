// Scouting reports: a search over every player, and one page per player with
// the facts, the outlook (with a likely range), the next opponents and the
// weekly game log.

import { load } from './store.js';
import { el, frag, n1, field, emptyState, announce, renderAsync, headshot, figures } from './ui.js';
import { lineChart, barRange } from './charts.js';
import { riseWords, goArrow } from './motion.js';

const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const WATCH_KEY = 'ff.watchlist';

export function readWatchlist() {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}
function writeWatchlist(list) {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(list)); } catch { /* private window: the button just does not stick */ }
}

const ownerText = (o) => (o === 'mine' ? 'On your team' : o === 'free agent' ? 'Free agent' : o);

// ---------------------------------------------------------------- search

export function playersView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Scouting report' })));
  root.appendChild(el('p', { class: 'section-note', text: 'Every player, every split. Search by name, narrow by position, and open a player for his outlook and game log.' }));

  let pos = null;
  const input = el('input', { type: 'search', placeholder: 'a name or a team (KC)', autocapitalize: 'none', autocomplete: 'off' });
  const scope = el('select', {}, [
    ['all', 'All players'], ['mine', 'My team'], ['rostered', 'Rostered'], ['free', 'Free agents'], ['watch', 'Watchlist'],
  ].map(([v, t]) => el('option', { value: v, text: t })));
  const chips = el('div', { class: 'pv-chips', role: 'group', 'aria-label': 'Position' });
  const results = el('div', { class: 'pv-results', 'aria-live': 'polite' });

  const drawChips = () => {
    chips.textContent = '';
    for (const p of [null, ...POS]) {
      chips.appendChild(el('button', {
        type: 'button', class: 'pv-chip', 'aria-pressed': String(pos === p),
        onclick: () => { pos = p; drawChips(); run(); },
      }, [p || 'All']));
    }
  };

  const run = () => {
    const q = input.value.trim();
    const params = { q, pos, scope: scope.value };
    if (scope.value === 'watch') {
      const ids = readWatchlist();
      if (!ids.length) {
        results.textContent = '';
        results.appendChild(emptyState('Your watchlist is empty', 'Open a player and choose Add to watchlist.'));
        return;
      }
      params.scope = 'ids';
      params.ids = ids.join(',');
    }
    renderAsync(results, load('players', params), (data) => {
      const r = data.report;
      if (!r.rows.length) {
        announce('No players match.');
        return emptyState('Nobody matches', 'Try a surname, another position, or a wider scope.');
      }
      announce(`${r.total} player${r.total === 1 ? '' : 's'}.`);
      return frag([
        el('p', { class: 'section-note', text: `${r.total} player${r.total === 1 ? '' : 's'}${r.total > r.rows.length ? `, showing the top ${r.rows.length}` : ''}.` }),
        el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet pv-table' }, [
          el('caption', { class: 'visually-hidden', text: 'Players' }),
          el('thead', {}, [el('tr', {}, [
            el('th', { class: 'l', scope: 'col', text: 'Player' }),
            el('th', { class: 'l', scope: 'col', text: 'Pos' }),
            el('th', { class: 'l', scope: 'col', text: 'Team' }),
            el('th', { class: 'l', scope: 'col', text: 'In your league' }),
            el('th', { scope: 'col', text: 'Projected' }),
          ])]),
          el('tbody', {}, r.rows.map((p) => el('tr', { class: p.owner === 'mine' ? 'mine' : null }, [
            el('th', { class: 'l player', scope: 'row' }, [
              el('a', { class: 'pv-link', href: `#player/${encodeURIComponent(p.id)}` }, [
                headshot({ player_id: p.id, position: p.pos, team: p.team }, { size: 28 }),
                el('span', { class: 'pname', text: p.name }),
              ]),
            ]),
            el('td', { class: 'l', text: p.pos }),
            el('td', { class: 'l', text: p.team || '—' }),
            el('td', { class: 'l', text: ownerText(p.owner) }),
            el('td', { class: 'big', text: p.proj == null ? '—' : n1(p.proj) }),
          ]))),
        ])]),
      ]);
    });
  };

  let timer = null;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  scope.addEventListener('change', run);
  drawChips();
  root.appendChild(el('div', { class: 'pv-controls' }, [
    field('Search players', input, { class: 'field pv-search' }),
    field('Show', scope),
  ]));
  root.appendChild(chips);
  root.appendChild(results);
  run();
}

// ---------------------------------------------------------------- one player

const GRADE_WORD = { soft: 'Soft matchup', avg: 'Average matchup', tough: 'Tough matchup', bye: 'Bye week' };
const GRADE_TAG = { soft: 'pine', tough: 'brick', avg: '', bye: 'amber' };

export function playerView(root, id) {
  root.textContent = '';
  const body = el('div', { class: 'pv-page' });
  root.appendChild(el('p', {}, [el('a', { class: 'pv-back', href: '#players', text: 'All players' })]));
  root.appendChild(body);
  renderAsync(body, load('player', { id }), (data) => render(data.report, id));
}

function watchButton(id) {
  const btn = el('button', { type: 'button', class: 'btn ghost pv-watch' });
  const draw = () => {
    const on = readWatchlist().includes(id);
    btn.textContent = on ? 'On your watchlist' : 'Add to watchlist';
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.addEventListener('click', () => {
    const list = readWatchlist();
    writeWatchlist(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
    draw();
  });
  draw();
  return btn;
}

function render(r, id) {
  const f = r.facts;
  const o = r.outlook;
  const out = frag([]);

  out.appendChild(el('header', { class: 'pv-hero' }, [
    headshot({ player_id: id, position: f.pos, team: f.team }, { size: 84 }),
    el('div', { class: 'pv-hero-text' }, [
      riseWords(el('h2', { class: 'hero-title pv-name', text: f.name })),
      el('p', { class: 'pv-sub', text: `${f.pos}${f.team ? ` · ${f.team}` : ''} · ${ownerText(f.owner)}` }),
      el('div', { class: 'pv-actions' }, [
        watchButton(id),
        el('a', { class: 'pv-takes', href: '#takes' }, ['Hot takes', goArrow()]),
      ]),
    ]),
  ]));

  // The facts
  const facts = [
    ['Age', f.age], ['Experience', f.experience == null ? null : f.experience === 0 ? 'Rookie' : `${f.experience} yr`],
    ['Injury', f.injury || 'None listed'], ['Depth chart', f.depthChart], ['Height', f.height], ['Weight', f.weight],
    ['College', f.college], ['In your league', ownerText(f.owner)],
    ['Trade value', f.tradeValue ? tradeValueText(f.tradeValue) : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  out.appendChild(el('section', { class: 'stack-block pv-block', 'data-band': 'team', 'aria-labelledby': 'pv-facts' }, [
    el('h3', { id: 'pv-facts', class: 'pv-h', text: 'The facts' }),
    el('dl', { class: 'pv-facts' }, facts.map(([k, v]) => el('div', { class: 'pv-fact' }, [el('dt', { text: k }), el('dd', { text: String(v) })]))),
  ]));

  // The outlook
  out.appendChild(el('section', { class: 'stack-block pv-block', 'data-band': 'week', 'aria-labelledby': 'pv-outlook' }, [
    el('h3', { id: 'pv-outlook', class: 'pv-h', text: 'Outlook' }),
    el('div', { class: 'pv-figures' }, [
      el('div', { class: 'pv-fig' }, [
        el('div', { class: 'pv-big', text: n1(o.proj) }),
        el('div', { class: 'pv-cap', text: `Week ${o.week} projection` }),
        el('div', { class: 'pv-range', text: `floor ${n1(o.floor)} · ceiling ${n1(o.ceiling)}` }),
      ]),
      el('div', { class: 'pv-fig' }, [
        el('div', { class: 'pv-big', text: n1(o.ros) }),
        el('div', { class: 'pv-cap', text: 'Rest of season' }),
        el('div', { class: 'pv-range', text: o.rosRank ? `${f.pos}${o.rosRank} of ${o.rosPoolSize} in the pool` : 'Not ranked' }),
      ]),
    ]),
    outlookChart(o),
    el('h4', { class: 'pv-h2', text: 'Next opponents' }),
    el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet pv-table' }, [
      el('caption', { class: 'visually-hidden', text: 'Next opponents with matchup grade and projection' }),
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'l', scope: 'col', text: 'Week' }),
        el('th', { class: 'l', scope: 'col', text: 'Opponent' }),
        el('th', { class: 'l', scope: 'col', text: 'Matchup' }),
        el('th', { scope: 'col', text: 'Projected' }),
        el('th', { scope: 'col', text: 'Floor–ceiling' }),
      ])]),
      el('tbody', {}, o.next.map((g) => el('tr', {}, [
        el('th', { class: 'l', scope: 'row', text: String(g.week) }),
        el('td', { class: 'l', text: g.grade === 'bye' ? '—' : g.opp ? `${g.home ? 'vs' : 'at'} ${g.opp}` : 'TBD' }),
        el('td', { class: 'l' }, [
          el('span', { class: `tag ${GRADE_TAG[g.grade]}`, text: GRADE_WORD[g.grade] }),
          g.ratio != null && g.grade !== 'bye' ? el('span', { class: 'sub', text: ` ${g.ratio.toFixed(2)}× average` }) : null,
        ]),
        el('td', { class: 'big', text: g.grade === 'bye' ? '—' : n1(g.proj) }),
        el('td', { text: g.grade === 'bye' ? '—' : `${n1(g.floor)}–${n1(g.ceiling)}` }),
      ]))),
    ])]),
    playoffLine(o.playoffs),
    el('p', { class: 'section-note', text: 'A matchup is soft when that defence has allowed 15% more points than average to his position this season, and tough at 13% fewer. Floor and ceiling are the 20th and 80th percentile of past results against projections, for games he plays.' }),
  ]));

  for (const sec of usageSections(r, f)) out.appendChild(sec);

  // The game log
  out.appendChild(el('section', { class: 'stack-block pv-block', 'data-band': 'league', 'aria-labelledby': 'pv-log' }, [
    el('h3', { id: 'pv-log', class: 'pv-h', text: 'Game log' }),
    r.gameLog.length
      ? el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet pv-table' }, [
        el('caption', { class: 'visually-hidden', text: 'Weekly results this season' }),
        el('thead', {}, [el('tr', {}, [
          el('th', { class: 'l', scope: 'col', text: 'Week' }),
          el('th', { class: 'l', scope: 'col', text: 'Opponent' }),
          el('th', { scope: 'col', text: 'Points' }),
          el('th', { class: 'l', scope: 'col', text: 'Line' }),
        ])]),
        el('tbody', {}, r.gameLog.map((g) => el('tr', {}, [
          el('th', { class: 'l', scope: 'row', text: String(g.week) }),
          el('td', { class: 'l', text: g.opp || '—' }),
          el('td', { class: 'big', text: g.points == null ? '—' : n1(g.points) }),
          el('td', { class: 'l', text: g.line }),
        ]))),
      ])])
      : emptyState('No games yet', 'Nothing has been recorded for him this season.'),
  ]));
  return out;
}

/** "7,450 (TE3), up 6% in 30 days" from a FantasyCalc value. */
function tradeValueText(t) {
  const base = t.value - t.trend30;
  const trend = base > 0 && Math.abs(t.trend30) >= 1
    ? `, ${t.trend30 > 0 ? 'up' : 'down'} ${Math.abs(Math.round((t.trend30 / base) * 100))}% in 30 days` : '';
  return `${t.value.toLocaleString('en-US')}${t.posRank ? ` (${t.pos}${t.posRank})` : ''}${trend}. ${t.source}`;
}

// ---------------------------------------------------------------- usage

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const d1 = (v) => (v == null ? '—' : v.toFixed(1));
const d2 = (v) => (v == null ? '—' : v.toFixed(2));

/** Every metric the page shows: how to print it and where it comes from. */
const METRICS = {
  snap_pct: { label: 'Snap share', fmt: pct, help: 'Offensive snaps he played divided by his team’s offensive snaps.' },
  tgt_share: { label: 'Target share', fmt: pct, help: 'His targets divided by his team’s pass attempts (sacks excluded).' },
  ay_share: { label: 'Air-yards share', fmt: pct, help: 'The yards the ball travelled in the air on his targets, as a share of the team’s total.' },
  wopr: { label: 'WOPR', fmt: d2, help: 'Weighted opportunity rating: 1.5 × target share + 0.7 × air-yards share. Above about 0.7 is a true number one.' },
  rush_share: { label: 'Rush share', fmt: pct, help: 'His carries divided by his team’s carries.' },
  rz_tgt_share: { label: 'Red-zone target share', fmt: pct, help: 'Targets inside the opponent’s 20 as a share of the team’s.' },
  i10_tgt_share: { label: 'Inside-10 target share', fmt: pct, help: 'Targets inside the opponent’s 10 as a share of the team’s.' },
  rz_car_share: { label: 'Red-zone carry share', fmt: pct, help: 'Carries inside the opponent’s 20 as a share of the team’s.' },
  i10_car_share: { label: 'Inside-10 carry share', fmt: pct, help: 'Carries inside the opponent’s 10 as a share of the team’s.' },
  tgt_per_snap: { label: 'Targets per offensive snap', fmt: d2, help: 'Targets divided by offensive snaps played.' },
};
const TREND_ORDER = ['snap_pct', 'tgt_share', 'ay_share', 'wopr', 'rush_share', 'rz_tgt_share', 'i10_tgt_share', 'rz_car_share', 'i10_car_share', 'tgt_per_snap'];
const DEFAULT_METRIC = { QB: 'rush_share', RB: 'rush_share', WR: 'tgt_share', TE: 'tgt_share' };

function explain(text) {
  return el('details', { class: 'pv-explain' }, [
    el('summary', { text: 'Where this number comes from' }),
    el('p', { text }),
  ]);
}

function usageBlock(id, title, band, children) {
  return el('section', { class: 'stack-block pv-block', 'data-band': band, 'aria-labelledby': id }, [
    el('h3', { id, class: 'pv-h', text: title }), ...children,
  ]);
}

function usageEmpty(u) {
  return [usageBlock('pv-usage', 'Usage trends', 'team', [
    emptyState('No usage yet', u && u.reason && /^no nflverse/.test(u.reason)
      ? 'No nflverse usage on file for this player yet.' : 'nflverse data arrives with the nightly update.'),
  ])];
}

/** The sentence under the chart: latest value against his earlier weeks. */
export function trendSentence(label, fmt, pts) {
  const got = pts.filter((p) => p.y != null);
  if (!got.length) return `No ${label.toLowerCase()} recorded yet.`;
  const last = got[got.length - 1];
  if (got.length === 1) return `${label} ${fmt(last.y)} in week ${last.x}, his only game so far.`;
  const prior = got.slice(0, -1).slice(0, 3);
  const base = prior.reduce((a, p) => a + p.y, 0) / prior.length;
  const span = prior.length === 1 ? `week ${prior[0].x}` : `weeks ${prior[0].x}–${prior[prior.length - 1].x}`;
  const diff = last.y - base;
  const rel = base ? Math.abs(diff) / Math.abs(base) : Math.abs(diff);
  const word = rel < 0.08 ? 'steady' : diff > 0 ? 'up' : 'down';
  return word === 'steady'
    ? `${label} ${fmt(last.y)} in week ${last.x}, steady against ${fmt(base)} over ${span}.`
    : `${label} ${fmt(last.y)} in week ${last.x}, ${word} from ${fmt(base)} over ${span}.`;
}

function trendsSection(u, f) {
  const avail = TREND_ORDER.filter((k) => u.weeks.some((w) => w[k] != null));
  if (!avail.length) return null;
  let key = avail.includes(DEFAULT_METRIC[f.pos]) ? DEFAULT_METRIC[f.pos] : avail[0];
  const chips = el('div', { class: 'pv-chips', role: 'group', 'aria-label': 'Usage metric' });
  const chart = el('div', { class: 'pv-chart' });
  const line = el('p', { class: 'pv-trend', 'aria-live': 'polite' });
  const help = el('div', { class: 'pv-help' });
  const draw = () => {
    chips.textContent = '';
    for (const k of avail) {
      chips.appendChild(el('button', {
        type: 'button', class: 'pv-chip', 'aria-pressed': String(k === key),
        onclick: () => { key = k; draw(); },
      }, [METRICS[k].label]));
    }
    const m = METRICS[key];
    const pts = u.weeks.map((w) => ({ x: w.week, y: w[key] }));
    chart.textContent = '';
    chart.appendChild(lineChart({ points: pts, yFormat: m.fmt, label: m.label, avg: u.posAverages?.[key] ?? null }));
    line.textContent = trendSentence(m.label, m.fmt, pts);
    help.textContent = '';
    help.appendChild(explain(m.help));
  };
  draw();
  return usageBlock('pv-usage', 'Usage trends', 'team', [
    el('p', { class: 'section-note', text: `By week, from play-by-play and snap counts${u.throughWeek ? `, through week ${u.throughWeek}` : ''}.` }),
    chips, line, chart, help,
  ]);
}

function figureWithAvg(u, f, key, label, fmt = METRICS[key]?.fmt || d1) {
  const v = u.season?.[key];
  if (v == null) return null;
  const avg = u.posAverages?.[key];
  return { value: fmt(v), label, sublabel: avg == null ? null : `${f.pos} average ${fmt(avg)}` };
}

function seasonSection(u, f) {
  if (!u.season) return null;
  const rusher = f.pos === 'RB' || f.pos === 'QB';
  const items = [
    figureWithAvg(u, f, 'snap_pct', 'Snap share'),
    figureWithAvg(u, f, 'tgt_share', 'Target share'),
    figureWithAvg(u, f, 'ay_share', 'Air-yards share'),
    figureWithAvg(u, f, 'wopr', 'WOPR'),
    figureWithAvg(u, f, 'rz_tgt_share', 'Red-zone target share'),
    figureWithAvg(u, f, 'i10_tgt_share', 'Inside-10 target share'),
    rusher ? figureWithAvg(u, f, 'rush_share', 'Rush share') : null,
    rusher ? figureWithAvg(u, f, 'rz_car_share', 'Red-zone carry share') : null,
    rusher ? figureWithAvg(u, f, 'i10_car_share', 'Inside-10 carry share') : null,
    figureWithAvg(u, f, 'tgt_per_snap', 'Targets per snap'),
  ].filter(Boolean);
  if (!items.length) return null;
  return usageBlock('pv-season', 'Season usage', 'week', [
    el('p', { class: 'section-note', text: `${u.season.games} game${u.season.games === 1 ? '' : 's'} this season. Averages are for ${f.pos}s with at least 3 games.` }),
    figures(items),
    explain('Snap share is offensive snaps over team offensive snaps. Target share is targets over team pass attempts, sacks excluded. Air-yards share is his air yards over the team’s. WOPR is 1.5 × target share + 0.7 × air-yards share. Red-zone and inside-10 shares count targets (or carries) inside the 20 and the 10 yard lines.'),
  ]);
}

function rushingSection(u, f) {
  const s = u.season;
  if (!(f.pos === 'RB' || f.pos === 'QB') || !s || !(s.car >= 5)) return null;
  const stk = s.car ? s.stk_car / s.car : null;
  const lgt = s.car ? s.lgt_car / s.car : null;
  const items = [
    figureWithAvg(u, f, 'ypc', 'Yards per carry', d1),
    figureWithAvg(u, f, 'ypc_stk', 'Yards per carry into stacked boxes', d1),
    figureWithAvg(u, f, 'ypc_lgt', 'Yards per carry into light boxes', d1),
    stk == null ? null : { value: pct(stk), label: 'Carries into stacked boxes', sublabel: `${s.stk_car} of ${s.car} carries` },
    lgt == null ? null : { value: pct(lgt), label: 'Carries into light boxes', sublabel: `${s.lgt_car} of ${s.car} carries` },
  ].filter(Boolean);
  return usageBlock('pv-rush', 'Rushing splits', 'league', [
    el('p', { class: 'section-note', text: 'Box counts from FTN charting.' }),
    figures(items),
    explain('A light box has six or fewer defenders near the line, a stacked box has eight or more (FTN charting). Running into stacked boxes is harder, so a back who keeps his yards per carry up there is better than his raw average suggests. Only charted carries are counted.'),
  ]);
}

function chartingSection(u, f) {
  const s = u.season;
  if (!s || !(s.tgt >= 5)) return null;
  const items = [
    figureWithAvg(u, f, 'ypt_bl', 'Yards per target vs a blitz', d1),
    figureWithAvg(u, f, 'ypt_nbl', 'Yards per target, no blitz', d1),
    figureWithAvg(u, f, 'pa_share', 'Play-action share of targets'),
    figureWithAvg(u, f, 'scr_share', 'Screen share of targets'),
    figureWithAvg(u, f, 'cont_rate', 'Contested-catch rate', pct),
    figureWithAvg(u, f, 'catch_rate', 'Catch rate vs catchable targets', pct),
    figureWithAvg(u, f, 'drop_rate', 'Drop rate', pct),
    figureWithAvg(u, f, 'adot', 'Average depth of target', d1),
  ].filter(Boolean);
  if (!items.length) return null;
  return usageBlock('pv-chart-splits', 'Charting splits', 'team', [
    el('p', { class: 'section-note', text: 'Charting data from FTN.' }),
    figures(items),
    explain('Yards per target is receiving yards over targets, split by whether the defence blitzed. Contested-catch rate is catches over contested targets. Catch rate counts only catchable targets. Drop rate is drops over targets. aDOT is the average yards downfield at the catch spot of his targets. Charting is done by hand, so very small samples are noisy.'),
  ]);
}

function coverageSection(u, f) {
  const c = u.coverage;
  if (!c || !['WR', 'TE', 'RB'].includes(f.pos)) return null;
  const row = (name, routes, tgt, yds, yprr, tprr) => el('tr', {}, [
    el('th', { class: 'l', scope: 'row', text: name }),
    el('td', { text: routes == null ? '—' : String(routes) }), el('td', { text: tgt == null ? '—' : String(tgt) }),
    el('td', { text: yds == null ? '—' : String(yds) }), el('td', { class: 'big', text: d2(yprr) }), el('td', { class: 'big', text: d2(tprr) }),
  ]);
  const avg = u.posAverages || {};
  return usageBlock('pv-cov', 'Coverage and routes', 'league', [
    el('p', { class: 'section-note', text: u.coverageNote ? `${u.coverageNote[0].toUpperCase()}${u.coverageNote.slice(1)}.` : 'Coverage as charted by participation data.' }),
    el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet pv-table' }, [
      el('caption', { class: 'visually-hidden', text: 'Routes, targets and yards per route run against all coverage, man and zone' }),
      el('thead', {}, [el('tr', {}, ['Coverage', 'Routes', 'Targets', 'Yards', 'Yards per route', 'Targets per route'].map((h, i) => el('th', { class: i ? '' : 'l', scope: 'col', text: h })))]),
      el('tbody', {}, [
        row('All coverage', c.routes, c.tgt, c.yds, c.yprr, c.tprr),
        row('Against man', c.man_routes, c.man_tgt, c.man_yds, c.yprr_man, c.tprr_man),
        row('Against zone', c.zone_routes, c.zone_tgt, c.zone_yds, c.yprr_zone, c.tprr_zone),
        avg.yprr == null ? null : el('tr', { class: 'pv-avg-row' }, [
          el('th', { class: 'l', scope: 'row', text: `${f.pos} average` }), el('td', { text: '' }), el('td', { text: '' }), el('td', { text: '' }),
          el('td', { text: d2(avg.yprr) }), el('td', { text: d2(avg.tprr) }),
        ]),
      ]),
    ])]),
    explain('Yards per route run is receiving yards over routes. Routes are an estimate: every dropback he was on the field as a receiver counts, so blocking tight ends and backs show many routes and low per-route rates. Man and zone come from charted coverage on each play.'),
  ]);
}

/** "4 touchdowns on 2.1 expected: running hot, expect fewer". */
export function tdSentence(tds, gap) {
  const expected = tds - gap;
  const base = `${tds} touchdown${tds === 1 ? '' : 's'} on ${expected.toFixed(1)} expected`;
  if (gap >= 1) return `${base}: running hot, expect fewer.`;
  if (gap <= -1) return `${base}: running cold, expect more.`;
  return `${base}: right about where his usage says.`;
}

function tdSection(u) {
  const s = u.season;
  if (!s || s.td_gap == null) return null;
  const tds = (s.rec_td || 0) + (s.rush_td || 0);
  return usageBlock('pv-td', 'Touchdowns above expected', 'week', [
    el('p', { class: 'pv-trend', text: tdSentence(tds, s.td_gap) }),
    explain('Each target and carry has an expected touchdown value from a field-position model fit on 2025 (an end-zone target is worth far more than a short one at midfield). Touchdowns above expected is his actual total minus the sum. It tends to drift back toward zero, so a large gap is a reason to doubt the scoring pace.'),
  ]);
}

const WORD = { soft: 'soft', avg: 'average', tough: 'tough' };

/** "Fantasy playoffs (weeks 15–17): at NYJ soft, vs KC tough" with the overall word. Words carry the grade, colour only backs it up. */
function playoffLine(po) {
  if (!po || !po.weeks.length) return null;
  const items = po.weeks.map((g) => {
    const text = g.grade === 'bye' ? `bye in week ${g.week}` : !g.opp ? `no game in week ${g.week}` : `${g.home ? 'vs' : 'at'} ${g.opp}`;
    return el('li', {}, [
      el('span', { class: 'sub', text: `Week ${g.week}: ` }), text, ' ',
      g.grade && g.grade !== 'bye' ? el('span', { class: `tag ${GRADE_TAG[g.grade]}`, text: GRADE_WORD[g.grade] }) : null,
      g.ratio != null ? el('span', { class: 'sub', text: ` ${g.ratio.toFixed(2)}× average` }) : null,
    ]);
  });
  return el('div', { class: 'pv-playoffs' }, [
    el('h4', { class: 'pv-h2', text: `Fantasy playoffs (weeks ${po.weeks[0].week}–${po.weeks[po.weeks.length - 1].week})` }),
    el('p', { class: 'pv-trend', text: po.label
      ? `A ${WORD[po.label]} run: his team’s playoff opponents have allowed ${po.score.toFixed(2)}× the average to his position.`
      : 'Too few finished games to grade these opponents yet.' }),
    el('ul', { class: 'pv-playoff-list' }, items),
  ]);
}

const pctR = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

function quarterbackSection(u, f) {
  const s = u.season;
  if (f.pos !== 'QB' || !s || !(s.qb_db > 0)) return null;
  const withAvg = (key, label, fmt = pctR) => {
    if (s[key] == null) return null;
    const avg = u.posAverages?.[key];
    return { value: fmt(s[key]), label, sublabel: avg == null ? null : `QB average ${fmt(avg)}` };
  };
  const items = [
    { value: String(s.qb_db), label: 'Dropbacks', sublabel: `${s.qb_sacks} sacks, ${s.qb_scrambles} scrambles` },
    withAvg('scramble_rate', 'Scramble rate'),
    { value: String(s.designed_runs), label: 'Designed runs', sublabel: s.designed_run_share == null ? null : `${pctR(s.designed_run_share)} of his team’s` },
    withAvg('sack_rate', 'Sack rate'),
    withAvg('pressure_to_sack', 'Sacks per pressure'),
    { value: String(s.qb_hits), label: 'QB hits', sublabel: 'on his dropbacks' },
    withAvg('pa_rate', 'Play-action rate'),
  ].filter(Boolean);
  return usageBlock('pv-qb', 'Quarterback usage', 'league', [
    el('p', { class: 'section-note', text: `${s.games} game${s.games === 1 ? '' : 's'} this season. Averages are for quarterbacks with at least 60 dropbacks.` }),
    figures(items),
    explain('A dropback is a pass attempt, a sack or a scramble. Scramble rate is scrambles over dropbacks. Designed runs are his rushes that were not scrambles (kneel-downs excluded), and the share is over all of his team’s non-scramble runs. Sack rate is sacks over dropbacks. Sacks per pressure is sacks over plays where he was sacked or hit. Play-action rate is the share of FTN-charted dropbacks that were play-action. Legs add fantasy points that passing does not: scrambles and designed runs are carries.'),
  ]);
}

function usageSections(r, f) {
  const u = r.usage;
  if (!['QB', 'RB', 'WR', 'TE'].includes(f.pos)) return [];
  if (!u || !u.available) return usageEmpty(u);
  return [trendsSection(u, f), seasonSection(u, f), rushingSection(u, f), quarterbackSection(u, f), chartingSection(u, f), coverageSection(u, f), tdSection(u)]
    .filter(Boolean);
}

function outlookChart(o) {
  const items = o.next.map((g) => (g.grade === 'bye'
    ? { x: g.week, note: 'bye' }
    : { x: g.week, lo: g.floor, mid: g.proj, hi: g.ceiling }));
  if (!items.some((i) => i.hi > 0)) return null;
  return el('div', { class: 'pv-chart' }, [
    el('h4', { class: 'pv-h2', text: 'Floor to ceiling by week' }),
    barRange({ items, yFormat: n1, label: 'Projection range' }),
  ]);
}
