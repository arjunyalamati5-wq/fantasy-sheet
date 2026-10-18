// Model lab: how good the predictions are, shown honestly. Practice results,
// a week-by-week chart, the live record, and this week's predictions.

import { load } from './store.js';
import { el, n1, signed, field, renderAsync, emptyState, safeHref, credibilityTag } from './ui.js';
import { riseWords } from './motion.js';

const NAMES = {
  thisSeason: 'the this-season correction model',
  thisSeasonBlend: 'the this-season blend',
  typicalBlend: 'the typical-game blend',
  typical: 'the typical-game correction model',
  blend: 'the blend',
  correction: 'the correction model',
  halfTrees: 'the tree model',
  sleeperScaled: "Sleeper's projection scaled down",
  sleeper: "Sleeper's own projection",
};
const TITLES = {
  thisSeason: 'Correction, this season weighted ×6',
  thisSeasonBlend: 'Blend, this season weighted ×10',
  typicalBlend: 'Typical-game blend', typical: 'Typical-game correction', blend: 'Blend',
  correction: 'Correction model', halfTrees: 'Tree model',
  sleeperScaled: 'Sleeper scaled down (no model)', sleeper: "Sleeper's projection",
};
const ORDER = ['thisSeasonBlend', 'thisSeason', 'typicalBlend', 'typical', 'blend', 'correction', 'halfTrees', 'sleeperScaled', 'sleeper'];
const SLOTS = { tue: 'Tue', thu: 'Thu', sun: 'Sun' };
const POSITIONS = ['All', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const SVG_NS = 'http://www.w3.org/2000/svg';

const pct1 = (f) => (f == null ? '—' : `${(f * 100).toFixed(1)}%`);
const pct0 = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);
const n2 = (v) => (v == null ? '—' : Number(v).toFixed(2));

function edgeText(key, edge) {
  if (key === 'sleeper') return 'Baseline';
  if (edge == null) return '—';
  const p = Math.abs(edge * 100);
  if (p < 0.05) return 'same';
  return `${p.toFixed(1)}% ${edge > 0 ? 'better' : 'worse'}`;
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function heroSentence(data) {
  const live = data.practice.trials[data.model];
  const trained = when(data.trainedAt);
  const head = `Week ${data.week}. The live model is ${NAMES[data.model] || data.model}${trained ? `, retrained ${trained}` : ''}.`;
  if (!live) return head;
  const weeks = live.byWeek?.length || 0;
  const span = weeks ? `the last ${weeks} weeks of practice` : 'practice';
  const same = data.model === 'sleeper';
  const parts = [`${head} Over ${span} it missed by ${n2(live.model.mae)} points on average${same ? ', which is exactly Sleeper\'s own number.' : `, against ${n2(live.sleeper.mae)} for Sleeper.`}`];
  // Be straight about where the gain comes from: aiming at the typical game
  // lowers the average miss even with no model at all.
  const scaled = data.practice.trials.sleeperScaled;
  const shrinks = /^typical|^sleeperScaled/.test(data.model);
  if (scaled && shrinks) {
    parts.push(`Simply scaling Sleeper's numbers down gets ${n2(scaled.model.mae)}, so most of the gain is from aiming at the typical game, not from knowing more.`);
  } else if (!same && live.model.rmse != null) {
    parts.push(`Its big misses are ${live.model.rmse < live.sleeper.rmse ? 'smaller' : 'no smaller'} too (${n2(live.model.rmse)} against ${n2(live.sleeper.rmse)}), and it runs ${Math.abs(live.model.bias) < 0.1 ? 'neither high nor low' : live.model.bias > 0 ? `${n2(live.model.bias)} points high` : `${n2(-live.model.bias)} points low`} on average.`);
  }
  if (live.startSit?.model != null) {
    parts.push(`It picks the better of two players ${pct0(live.startSit.model)} of the time, against ${pct0(live.startSit.sleeper)} for Sleeper.`);
  }
  if (data.missing?.length) parts.push(`${data.missing.length} past week${data.missing.length === 1 ? '' : 's'} could not be loaded, so some inputs have gaps.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- practice

function practiceTable(data) {
  const trials = data.practice.trials;
  const rows = ORDER.filter((k) => trials[k]).map((k) => {
    const t = trials[k];
    const isLive = k === data.model;
    return el('tr', { class: isLive ? 'mine' : '' }, [
      el('th', { scope: 'row', class: 'l' }, [
        TITLES[k],
        isLive ? el('span', { class: 'tag', text: 'Live' }) : null,
      ]),
      el('td', { text: n2(t.model.mae) }),
      el('td', { text: edgeText(k, t.edge) }),
      el('td', { text: pct0(t.startSit?.model) }),
      el('td', { text: pct0(t.coverage) }),
    ]);
  });
  const table = el('table', { class: 'sheet' }, [
    el('caption', { class: 'model-caption', text: 'Practice means predicting weeks that were already played, using only the weeks before each one. The live approach is tagged "Live". A lower average miss is better.' }),
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', class: 'l', text: 'Approach' }),
      el('th', { scope: 'col', text: 'Average miss (pts)' }),
      el('th', { scope: 'col', text: 'vs Sleeper' }),
      el('th', { scope: 'col', text: 'Start/sit calls right' }),
      el('th', { scope: 'col', text: 'Results inside the range' }),
    ])]),
    el('tbody', {}, rows),
  ]);
  return el('div', { class: 'table-scroll' }, [table]);
}

// ---------------------------------------------------------------- chart

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

function weekChart(weeks, liveName) {
  const W = 640; const H = 300;
  const m = { l: 44, r: 16, t: 16, b: 44 };
  const all = weeks.flatMap((w) => [w.model, w.sleeper]);
  let lo = Math.floor((Math.min(...all) - 0.2) * 2) / 2;
  let hi = Math.ceil((Math.max(...all) + 0.2) * 2) / 2;
  if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
  const x = (i) => m.l + (weeks.length === 1 ? (W - m.l - m.r) / 2 : (i * (W - m.l - m.r)) / (weeks.length - 1));
  const y = (v) => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);
  const path = (key) => weeks.map((w, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(w[key]).toFixed(1)}`).join(' ');

  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.5) ticks.push(v);
  const children = [
    ...ticks.map((v) => svg('g', {}, [
      svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'chart-grid' }),
      Object.assign(svg('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-text' }), { textContent: v.toFixed(1) }),
    ])),
    svg('path', { d: path('sleeper'), class: 'chart-line sleeper', fill: 'none' }),
    svg('path', { d: path('model'), class: 'chart-line model', fill: 'none' }),
    ...weeks.map((w, i) => svg('circle', { cx: x(i), cy: y(w.model), r: 3.5, class: 'chart-dot model' })),
    ...weeks.map((w, i) => Object.assign(
      svg('text', { x: x(i), y: H - m.b + 18, 'text-anchor': 'middle', class: 'chart-text' }),
      { textContent: `W${w.week}` },
    )),
    Object.assign(svg('text', { x: W / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-text' }), { textContent: 'Week (average miss in points, lower is better)' }),
  ];
  const first = weeks[0]; const last = weeks[weeks.length - 1];
  const label = `Line chart of average miss in points per week, ${weeks.length} weeks from week ${first.week} to week ${last.week}. `
    + `${liveName} went from ${n2(first.model)} to ${n2(last.model)}; Sleeper went from ${n2(first.sleeper)} to ${n2(last.sleeper)}. The same numbers are in the table below.`;
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'model-chart', role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' }, children);
}

function weekBlock(data) {
  const t = data.practice.trials[data.model];
  const weeks = t?.byWeek || [];
  const block = el('section', { class: 'model-block stack-block', 'data-band': 'week', 'aria-labelledby': 'model-weeks' }, [
    el('h3', { id: 'model-weeks', class: 'phase-title', text: 'Week by week' }),
  ]);
  if (!weeks.length) {
    block.appendChild(el('p', { class: 'phase-empty', text: 'No practice weeks to chart yet.' }));
    return block;
  }
  const liveName = TITLES[data.model] || data.model;
  const legend = el('ul', { class: 'chart-legend' }, [
    el('li', {}, [el('span', { class: 'swatch model', 'aria-hidden': 'true' }), `${liveName} (solid line)`]),
    el('li', {}, [el('span', { class: 'swatch sleeper', 'aria-hidden': 'true' }), "Sleeper's projection (dashed line)"]),
  ]);
  // The same numbers for screen readers. The wrapper is what hides it: a table
  // ignores the 1px box and would widen the page on a phone.
  const hidden = el('div', { class: 'visually-hidden' }, [el('table', {}, [
    el('caption', { text: `Average miss in points per week, ${liveName} against Sleeper` }),
    el('thead', {}, [el('tr', {}, ['Season', 'Week', liveName, 'Sleeper', 'Players'].map((h) => el('th', { scope: 'col', text: h })))]),
    el('tbody', {}, weeks.map((w) => el('tr', {}, [
      el('th', { scope: 'row', text: String(w.season) }),
      el('td', { text: String(w.week) }), el('td', { text: n2(w.model) }),
      el('td', { text: n2(w.sleeper) }), el('td', { text: String(w.n) }),
    ]))),
  ])]);
  block.appendChild(el('div', { class: 'chart-wrap' }, [weekChart(weeks, liveName), legend, hidden]));
  return block;
}

// ---------------------------------------------------------------- live record

function liveBlock(data) {
  const block = el('section', { class: 'model-block stack-block', 'data-band': 'waivers', 'aria-labelledby': 'model-live' }, [
    el('h3', { id: 'model-live', class: 'phase-title', text: 'Live practice' }),
    el('p', { class: 'phase-when', text: "Every Tuesday, Thursday and Sunday morning the app saves Sleeper's projection and the model's prediction, and grades both after the games." }),
  ]);
  if (!data.live?.length) {
    block.appendChild(emptyState('Nothing saved yet', 'The first snapshot will be taken next Tuesday, Thursday or Sunday morning, as long as the app is running.'));
    return block;
  }
  const rows = data.live.map((s) => {
    const g = s.grade;
    let mm = 'Waiting for the games'; let sm = ''; let winner = '';
    if (g) {
      mm = n2(g.model.mae); sm = n2(g.sleeper.mae);
      const d = g.model.mae - g.sleeper.mae;
      winner = Math.abs(d) < 0.005 ? 'Tie' : d < 0 ? 'Model' : 'Sleeper';
    }
    const waiting = !g;
    return el('tr', {}, [
      el('th', { scope: 'row', class: 'l', text: `Week ${s.week}` }),
      el('td', { class: 'l', text: `${SLOTS[s.slot] || s.slot} ${when(s.takenAt)}`.trim() }),
      waiting
        ? el('td', { class: 'l', colspan: 3, text: mm })
        : [el('td', { text: mm }), el('td', { text: sm }), el('td', { text: winner })],
    ].flat());
  });
  block.appendChild(el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet' }, [
    el('caption', { class: 'model-caption', text: 'Each saved snapshot, graded once its games are final. The average miss is in points per player; lower wins.' }),
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', class: 'l', text: 'Week' }),
      el('th', { scope: 'col', class: 'l', text: 'Taken' }),
      el('th', { scope: 'col', text: "Model's miss" }),
      el('th', { scope: 'col', text: "Sleeper's miss" }),
      el('th', { scope: 'col', text: 'Winner' }),
    ])]),
    el('tbody', {}, rows),
  ])]));
  return block;
}

// ---------------------------------------------------------------- predictions

const POS_WORDS = {
  QB: 'quarterbacks', RB: 'running backs', WR: 'wide receivers', TE: 'tight ends', K: 'kickers', DEF: 'defences',
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// "7% more" / "10% fewer" / "about average" for a ratio against 1.
function ratioWords(r, more, fewer) {
  const p = Math.round((r - 1) * 100);
  if (Math.abs(r - 1) <= 0.03 || p === 0) return 'about average';
  return `${Math.abs(p)}% ${p > 0 ? more : fewer}`;
}

// Plain sentences explaining one prediction, built only from what the server sent.
export function reasons(row) {
  const w = row.why || {};
  const out = [];
  const games = w.games || 0;
  if (w.injury || w.practice) {
    const prac = { DNP: 'did not practise', Limited: 'was limited in practice', Full: 'practised in full' }[w.practice];
    out.push(`This week he ${[w.injury ? `is listed ${w.injury}` : null, prac].filter(Boolean).join(' and ')}.`);
  }
  if (!games || !isNum(w.seasonAvg)) out.push('No games this season yet.');
  else {
    const l3 = isNum(w.last3) ? ` (${n1(w.last3)} over his last 3)` : '';
    out.push(`Averaging ${n1(w.seasonAvg)} over ${games} ${games === 1 ? 'game' : 'games'} this season${l3}.`);
  }
  if (w.missedLast) out.push("Missed his team's last game.");
  if (isNum(w.tdShare) && w.tdShare >= 0.2) {
    const pc = Math.round(w.tdShare * 100);
    out.push(w.tdShare >= 0.3
      ? `${pc}% of his points came from touchdowns, a lot of them, and those usually fall back.`
      : `${pc}% of his points came from touchdowns, which usually fall back.`);
  }
  const tg = ['WR', 'TE', 'RB'].includes(row.pos) && w.targets > 0 ? `${n1(w.targets)} targets a game` : '';
  const sn = w.snapShare > 0 ? `${Math.round(w.snapShare * 100)}% of snaps lately` : '';
  if (tg || sn) out.push(`${[tg, sn].filter(Boolean).join(' and ')}.`);
  if (row.opp) {
    const who = POS_WORDS[row.pos] || 'his position';
    const parts = [];
    if (isNum(w.oppVsPos)) {
      const base = ratioWords(w.oppVsPos, 'more', 'fewer');
      let s = base === 'about average'
        ? `${row.opp} gives up about the average number of points to ${who}`
        : `${row.opp} gives up ${base} points than average to ${who}`;
      if (isNum(w.oppVsPosLast4)) {
        const l4 = ratioWords(w.oppVsPosLast4, 'more', 'fewer');
        s += l4 === 'about average' ? ' (about average over its last 4)' : ` (${l4} over its last 4)`;
      }
      parts.push(s);
    }
    const allowed = [];
    if (isNum(w.oppPtsAllowed)) allowed.push(`${n1(w.oppPtsAllowed)} points`);
    if (isNum(w.oppYdsAllowed)) allowed.push(`${Math.round(w.oppYdsAllowed)} yards`);
    if (allowed.length) {
      const tail = `allows ${allowed.join(' and ')} a game`;
      parts.push(parts.length ? tail : `${row.opp} ${tail}`);
    }
    if (parts.length) out.push(`${parts.join(', and ')}.`);
  }
  const rel = (v) => `${n1(Math.abs(v))} ${v > 0 ? 'more' : 'less'}`;
  if (isNum(w.vsDefenceLikeThis) && Math.abs(w.vsDefenceLikeThis) >= 0.5) {
    out.push(`Against defences like this he scores ${rel(w.vsDefenceLikeThis)} than his average.`);
  }
  if (isNum(w.homeOrAway) && Math.abs(w.homeOrAway) >= 0.5 && typeof w.home === 'boolean') {
    out.push(`${w.home ? 'At home' : 'On the road'} he scores ${rel(w.homeOrAway)} than his average.`);
  }
  if (isNum(w.teamImplied)) out.push(`His team is expected to score ${Math.round(w.teamImplied)} points (Vegas).`);
  if (isNum(row.avg)) out.push(`His average game: ${n1(row.avg)}.`);
  return out;
}

const COLS = 7;

// "Buzz: hot — 12,400 managers added him in the last 2 days, ..." from /api/buzz.
// Returns null when there is nothing honest to say (no buzz data loaded at all).
export function buzzSentence(buzz, id) {
  if (!buzz?.available) return null;
  if (!buzz.available.sleeper) return "Buzz: Sleeper's trending feed is unavailable right now, so there is no add/drop signal.";
  const b = buzz.players?.[String(id)];
  if (!b) return 'Buzz: quiet, nobody is adding or dropping him much.';
  const fmt = (v) => Math.round(v).toLocaleString('en-US');
  const bits = [];
  if (b.adds || b.drops) {
    bits.push(`${fmt(b.adds)} ${b.adds === 1 ? 'manager' : 'managers'} added him and ${fmt(b.drops)} dropped him in the last 2 days`);
  }
  if (b.mentions) {
    const mood = b.positive > b.negative ? ' (mostly positive)' : b.negative > b.positive ? ' (mostly negative)' : '';
    bits.push(`${b.mentions} Reddit ${b.mentions === 1 ? 'post mentions' : 'posts mention'} him${mood}`);
  }
  return `Buzz: ${String(b.label).toLowerCase()}${bits.length ? ` — ${bits.join(', ')}` : ''}.`;
}

function ago(iso) {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

// "Latest news" under a player's reasons. Never throws: a failure is one line.
function newsList(items) {
  if (!items.length) return el('p', { class: 'why-news-note', text: 'No recent stories mention him.' });
  return el('ul', { class: 'why-news-list' }, items.map((it) => {
    const href = safeHref(it.url);
    const head = href
      ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: it.title })
      : el('span', { text: it.title });
    const cred = credibilityTag(it.credibility);
    const when = ago(it.published);
    return el('li', {}, [
      head,
      el('span', { class: 'why-news-meta' }, [` ${it.source || ''}`, cred, when ? ` ${when}` : null]),
      it.quote ? el('blockquote', { class: 'why-quote', text: it.quote }) : null,
    ]);
  }));
}

async function fillNews(box, id) {
  box.replaceChildren(el('p', { class: 'why-news-note', text: 'Loading news…' }));
  try {
    const data = await load('player-news', { player: id });
    box.replaceChildren(newsList(Array.isArray(data?.items) ? data.items : []));
  } catch {
    box.replaceChildren(el('p', { class: 'why-news-note', text: 'News could not be loaded right now.' }));
  }
}

// Hot / Cold / Quiet as text, so colour is never the only signal. Blank with no data.
function buzzTag(buzz, id) {
  const b = buzz?.players?.[String(id)];
  if (!b || !buzz.available?.sleeper) return null;
  const cls = { Hot: 'amber', Cold: 'brick' }[b.label] || '';
  return el('span', { class: `tag buzz-tag ${cls}`.trim(), text: b.label });
}

function predictionRows(p, mine, buzz) {
  // Like for like: Sleeper projects an average game, so compare the model's average game.
  const diff = (p.avg ?? p.pred) - p.proj;
  const big = Math.abs(diff) >= 2;
  const id = `why-${String(p.id).replace(/[^\w-]/g, '_')}`;
  const news = el('div', { class: 'why-news', 'aria-live': 'polite' });
  const detail = el('tr', { id, class: 'why-row', hidden: true }, [
    el('td', { colspan: COLS, class: 'l' }, [
      el('ul', { class: 'why-list' }, [...reasons(p), buzzSentence(buzz, p.id)].filter(Boolean).map((s) => el('li', { text: s }))),
      el('h4', { class: 'why-news-title', text: 'Latest news' }),
      news,
    ]),
  ]);
  let newsStarted = false;
  const btn = el('button', {
    type: 'button', class: 'row-action', 'aria-expanded': 'false', 'aria-controls': id,
    onclick: () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      detail.hidden = !open;
      if (open && !newsStarted) { newsStarted = true; fillNews(news, p.id); }
    },
  }, [p.name, el('span', { class: 'visually-hidden', text: ': why this prediction' })]);
  const row = el('tr', { class: mine ? 'mine' : '' }, [
    el('th', { scope: 'row', class: 'l' }, [
      btn, mine ? el('span', { class: 'tag', text: 'Yours' }) : null,
      el('span', { class: 'sub', text: `${p.pos} ${p.team}${p.opp ? ` vs ${p.opp}` : ''}` }),
    ]),
    el('td', { text: n1(p.proj) }),
    el('td', { text: n1(p.pred) }),
    el('td', { class: 'wide', text: n1(p.avg) }),
    el('td', { text: `${n1(p.lo)}–${n1(p.hi)}` }),
    el('td', { class: 'wide' }, [buzzTag(buzz, p.id)]),
    el('td', {}, [big ? el('strong', { text: signed(diff) }) : signed(diff)]),
  ]);
  return [row, detail];
}

function predictionsBlock(pred, mineIds, buzz) {
  const block = el('section', { class: 'model-block stack-block', 'data-band': 'team', 'aria-labelledby': 'model-preds' }, [
    el('h3', { id: 'model-preds', class: 'phase-title', text: "This week's predictions" }),
  ]);
  const rows = pred?.rows || [];
  if (!rows.length) {
    block.appendChild(emptyState('No predictions yet', 'They appear once this week\'s projections are out.'));
    return block;
  }
  const select = el('select', {}, POSITIONS.map((p) => el('option', { value: p, text: p })));
  const body = el('tbody');
  const mineRows = rows.filter((r) => mineIds.has(String(r.id)));
  const status = el('p', { class: 'phase-when', 'aria-live': 'polite' });
  const draw = () => {
    const pos = select.value;
    const others = rows.filter((r) => !mineIds.has(String(r.id)) && (pos === 'All' || r.pos === pos)).slice(0, 40);
    body.replaceChildren(...mineRows.flatMap((r) => predictionRows(r, true, buzz)), ...others.flatMap((r) => predictionRows(r, false, buzz)));
    status.textContent = `${mineRows.length} of your players, then the top ${others.length} ${pos === 'All' ? 'other players' : `other ${pos}s`}.`;
  };
  select.addEventListener('change', draw);
  draw();
  block.appendChild(field('Show other players at', select, { class: 'field model-filter' }));
  block.appendChild(status);
  block.appendChild(el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet' }, [
    el('caption', { class: 'model-caption', text: "Sleeper's projection against the model's prediction, in fantasy points. The typical game is his most likely score; the average game is what he scores on average, counting the chance of a big day. The likely range holds the result about 8 times in 10. The difference is the model's average game minus Sleeper's projection (both are averages); 2 points or more is in bold. Select a player's name to see why." }),
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', class: 'l', text: 'Player' }),
      el('th', { scope: 'col', text: 'Sleeper' }),
      el('th', { scope: 'col', text: 'Model: typical game' }),
      el('th', { scope: 'col', class: 'wide', text: 'Model: average game' }),
      el('th', { scope: 'col', text: 'Likely range' }),
      el('th', { scope: 'col', class: 'wide', text: 'Buzz' }),
      el('th', { scope: 'col', text: 'Difference' }),
    ])]),
    body,
  ])]));
  block.appendChild(el('p', { class: 'phase-when', text: "Buzz is the crowd's mood (Sleeper adds and drops, Reddit). It does not change the model's number. TikTok has no open API, so it isn't included." }));
  return block;
}

// ---------------------------------------------------------------- view

export function modelView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'How good are the predictions?' })));
  const body = el('div');
  root.appendChild(body);
  const mineIds = new Set();
  const extras = Promise.all([
    load('predictions').catch(() => null),
    load('rosters').catch(() => null),
    load('buzz').catch(() => null),
  ]);
  renderAsync(body, Promise.all([load('model'), extras]), ([data, [pred, rosters, buzz]]) => {
    const mine = rosters?.report?.rosters?.find((r) => r.isMine);
    for (const p of mine?.players || []) mineIds.add(String(p.player_id));
    const trials = data.practice?.trials || {};
    const out = el('div', {}, [
      el('p', { class: 'hero-sub', text: heroSentence(data) }),
    ]);
    if (Object.keys(trials).length) {
      out.appendChild(el('section', { class: 'model-block stack-block', 'data-band': 'research', 'aria-labelledby': 'model-practice' }, [
        el('h3', { id: 'model-practice', class: 'phase-title', text: `Practice: the last ${trials[data.model]?.byWeek?.length || 8} weeks` }),
        practiceTable(data),
      ]));
    } else {
      out.appendChild(emptyState('No practice results yet', 'The model has not been graded on past weeks yet.'));
    }
    out.appendChild(weekBlock(data));
    out.appendChild(liveBlock(data));
    out.appendChild(predictionsBlock(pred, mineIds, buzz));
    return out;
  });
}
