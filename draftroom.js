// The draft room: rankings by value over replacement, tiers, a seeded mock
// draft, and a live assistant that follows the league's real Sleeper draft.
// Everything is said in words as well as colour; boards scroll inside their
// own frame so a phone never scrolls sideways as a page.

import { state, api, load } from './store.js';
import { el, n1, signed, emptyState } from './ui.js';
import { riseWords, goArrow } from './motion.js';
import { segmented, block } from './seg.js';

const TABS = [
  { id: 'rankings', label: 'Rankings' },
  { id: 'tiers', label: 'Tiers' },
  { id: 'mock', label: 'Mock' },
  { id: 'live', label: 'Live assistant' },
];

// Kept between visits to the room within a session.
const room = { tab: null, touched: false, filter: 'ALL', limit: 75, drafted: new Set(), stopLive: null };

// ------------------------------------------------------------------ storage

const mockKey = () => `ff.draftroom.mock.${state.leagueId}`;
function readMock() {
  try { return JSON.parse(localStorage.getItem(mockKey())) || null; } catch { return null; }
}
function writeMock(m) {
  try { if (m) localStorage.setItem(mockKey(), JSON.stringify(m)); else localStorage.removeItem(mockKey()); } catch { /* private mode: the mock just is not remembered */ }
}

// ------------------------------------------------------------------ small parts

const word = (text, cls = '') => el('span', { class: `tag ${cls}`.trim(), text });
const pad2 = (n) => String(n).padStart(2, '0');
const pickLabel = (round, pickNo, teams) => `${round}.${pad2(((pickNo - 1) % teams) + 1)}`;

/** A table with a caption and real headers. head: [text | {text, cls}], rows: [{cells, mine, cls}]; a cell is a node, a string or {c, cls, th}. */
function sheet(caption, head, rows) {
  const t = el('table', { class: 'sheet dr-table' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: caption }));
  t.appendChild(el('thead', {}, [el('tr', {}, head.map((h) => {
    const o = typeof h === 'string' ? { text: h } : h;
    return el('th', { scope: 'col', class: o.cls || null, text: o.text });
  }))]));
  const tb = el('tbody');
  for (const r of rows) {
    tb.appendChild(el('tr', { class: [r.mine ? 'mine' : '', r.cls || ''].join(' ').trim() || null }, r.cells.map((c, i) => {
      const o = c && typeof c === 'object' && 'c' in c ? c : { c };
      const isTh = o.th || (i === 0 && r.header);
      return el(isTh ? 'th' : 'td', { class: o.cls || null, scope: isTh ? 'row' : null }, [].concat(o.c ?? '—'));
    })));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

function playerCell(r, extra = null) {
  return {
    th: true, cls: 'l',
    c: [
      el('span', { class: 'pname', text: r.name }),
      r.team ? el('span', { class: 'pclub', text: r.team }) : null,
      extra,
      el('span', { class: 'sub narrow-only', text: `${r.position}${r.tier ? `, tier ${r.tier}` : ''}` }),
    ],
  };
}

const adpText = (adp) => (adp == null ? 'no adp' : `on adp · ${adp.toFixed(1)}`);

// ------------------------------------------------------------------ countdown

function untilText(c) {
  const bits = [];
  if (c.days) bits.push(`${c.days} ${c.days === 1 ? 'day' : 'days'}`);
  if (c.hours || c.days) bits.push(`${c.hours} ${c.hours === 1 ? 'hour' : 'hours'}`);
  bits.push(`${c.minutes} ${c.minutes === 1 ? 'minute' : 'minutes'}`);
  return bits.join(', ');
}

/** Time until the draft, recounted every minute from the start time, and the draft slot. */
function countdownBlock(data) {
  const out = el('p', { class: 'dr-clock' });
  const sub = el('p', { class: 'sp-note' });
  const draft = data.draft;
  const paint = () => {
    const ms = (data.countdown?.startTime || 0) - Date.now();
    if (draft?.status === 'complete') { out.textContent = 'the draft is done'; sub.textContent = 'a saved draft you can replay in the live assistant.'; return; }
    if (draft?.status === 'drafting' || draft?.status === 'paused') { out.textContent = draft.status === 'paused' ? 'the draft is paused' : 'the draft is under way'; sub.textContent = ''; return; }
    if (!data.countdown?.startTime) { out.textContent = '—'; sub.textContent = data.countdown?.message || 'no draft time is set yet. the commissioner sets it in sleeper.'; return; }
    if (ms <= 0) { out.textContent = 'any minute now'; sub.textContent = 'the start time has passed; the commissioner has not opened the room yet.'; return; }
    const mins = Math.floor(ms / 60_000);
    out.textContent = untilText({ days: Math.floor(mins / 1440), hours: Math.floor((mins % 1440) / 60), minutes: mins % 60 });
    sub.textContent = `starts ${new Date(data.countdown.startTime).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
  };
  paint();
  const timer = setInterval(() => { if (!out.isConnected) clearInterval(timer); else paint(); }, 60_000);

  const slot = data.order?.mySlot
    ? el('p', { class: 'dr-slot' }, [word('your draft slot'), ` ${data.order.mySlot} of ${draft?.teams || data.league.teams}`])
    : el('p', { class: 'dr-slot', text: data.orderMessage || 'the draft order is not set yet.' });
  return block({ band: 'draft', id: 'dr-clock-h', title: 'Time until the draft' }, [out, sub, slot]);
}

// ------------------------------------------------------------------ rankings

function visibleRows(data) {
  return data.rankings.filter((r) => !r.drafted && !room.drafted.has(String(r.id)));
}

function rankingsPanel(data) {
  const host = el('div');
  host.appendChild(countdownBlock(data));
  const body = el('div');
  const positions = ['ALL', ...data.replacement.map((l) => l.position)];

  const draw = () => {
    body.textContent = '';
    const all = visibleRows(data);
    const hidden = data.rankings.length - all.length;
    const rows = all.filter((r) => room.filter === 'ALL' || r.position === room.filter);
    const shown = rows.slice(0, room.limit);
    const showMarket = data.marketAvailable;

    const head = [
      { text: '#', cls: 'l' }, { text: 'Player', cls: 'l' }, { text: 'Pos', cls: 'l wide' }, { text: 'Tier', cls: 'wide' },
      { text: 'Points', cls: 'wide' }, { text: 'Value over replacement' }, { text: 'Adp' },
    ];
    if (showMarket) head.push({ text: 'FantasyCalc', cls: 'wide' });

    body.appendChild(el('p', { class: 'sp-note', text: data.notes.rankings }));
    if (!data.marketAvailable) body.appendChild(el('p', { class: 'sp-warn', role: 'status', text: data.marketMessage }));
    if (hidden > 0) body.appendChild(el('p', { class: 'sp-note', text: `drafted players are hidden · ${hidden} off the board.` }));
    body.appendChild(sheet(
      `Rankings by value over replacement, ${room.filter === 'ALL' ? 'all positions' : room.filter}`,
      head,
      shown.map((r) => ({
        cells: [
          { c: String(r.rank), cls: 'l dim-num' },
          playerCell(r),
          { c: r.position, cls: 'l wide' },
          { c: r.tier ? String(r.tier) : '—', cls: 'num wide' },
          { c: n1(r.points), cls: 'num wide' },
          { c: signed(r.vor), cls: `num ${r.vor >= 0 ? 'pos' : 'neg'}` },
          { c: r.adp == null ? word('no adp') : el('span', {}, [n1(r.adp), el('span', { class: 'sub', text: 'on adp' })]), cls: 'num' },
          ...(showMarket ? [{ c: r.market ? String(r.market.value) : '—', cls: 'num wide' }] : []),
        ],
      })),
    ));
    if (rows.length > shown.length) {
      body.appendChild(el('button', {
        type: 'button', class: 'btn ghost', onclick: () => { room.limit += 50; draw(); },
      }, [`Show 50 more (${rows.length - shown.length} left)`]));
    }
  };

  host.appendChild(el('div', { class: 'dr-filters' }, [
    segmented({
      label: 'Filter rankings by position', value: room.filter,
      options: positions.map((p) => ({ id: p, label: p === 'ALL' ? 'All' : p })),
      onChange: (id) => { room.filter = id; room.limit = 75; draw(); },
    }),
  ]));
  host.appendChild(body);
  draw();

  host.appendChild(block({
    band: 'research', id: 'dr-repl-h', title: 'Replacement level by position',
    note: 'the last starter your league can field at each position, all teams together. a flex slot is shared by the positions that can fill it.',
  }, [sheet('Replacement level by position',
    ['Position', { text: 'Starters per team', cls: 'wide' }, { text: 'Starters in the league', cls: 'wide' }, 'Replacement player', 'Replacement points'].map((h) => (typeof h === 'string' ? { text: h, cls: h === 'Position' ? 'l' : '' } : h)),
    data.replacement.map((l) => ({
      cells: [{ c: l.position, th: true, cls: 'l' }, { c: n1(l.startersPerTeam), cls: 'num wide' }, { c: String(l.startersInLeague), cls: 'num wide' }, { c: `#${l.replacementRank}`, cls: 'num' }, { c: n1(l.replacementPoints), cls: 'num' }],
    })))]));

  if (data.rookies?.available && data.rookies.rows.length) host.appendChild(rookieBlock(data.rookies.rows));
  return host;
}

function rookieBlock(rows) {
  return block({
    band: 'waivers', id: 'dr-rookie-h', title: `Rookie class, top ${rows.length}`,
    note: 'dynasty values from fantasycalc, rookies only.',
  }, [sheet(`Rookie class, top ${rows.length}`, [{ text: '#', cls: 'l' }, { text: 'Player', cls: 'l' }, { text: 'Pos', cls: 'l wide' }, 'Dynasty value'],
    rows.map((r) => ({ cells: [{ c: String(r.rank), cls: 'l dim-num' }, playerCell({ ...r, tier: null }), { c: r.position || '—', cls: 'l wide' }, { c: String(r.value), cls: 'num' }] })))]);
}

// ------------------------------------------------------------------ tiers

function tiersPanel(data) {
  const host = el('div');
  host.appendChild(el('p', { class: 'sp-lede', text: 'tiers to study' }));
  host.appendChild(el('p', { class: 'sp-note', text: data.notes.tiers }));
  const gone = (id) => room.drafted.has(String(id));
  for (const level of data.replacement) {
    const mine = data.tiers.filter((t) => t.position === level.position);
    if (!mine.length) continue;
    host.appendChild(block({ band: 'draft', id: `dr-tier-${level.position}`, title: level.position }, [
      sheet(`${level.position} tiers by value over replacement`,
        [{ text: 'Tier', cls: 'l' }, { text: 'Players', cls: 'l' }, 'Value over replacement', { text: 'Drop from the tier above', cls: 'wide' }],
        mine.map((t) => {
          const left = t.players.filter((p) => !gone(p.id));
          const names = left.map((p) => p.name).join(', ');
          return {
            cells: [
              { c: `Tier ${t.tier}`, th: true, cls: 'l' },
              { c: [names || 'everyone in this tier is drafted', left.length < t.players.length ? el('span', { class: 'sub', text: `${t.players.length - left.length} drafted` }) : null], cls: 'l' },
              { c: `${n1(t.vorHigh)} to ${n1(t.vorLow)}`, cls: 'num' },
              { c: t.gapBefore == null ? 'top tier' : `−${n1(t.gapBefore)}`, cls: 'num wide' },
            ],
          };
        })),
    ]));
  }
  return host;
}

// ------------------------------------------------------------------ the board and grade

/** Rounds across teams. The grid scrolls inside its own frame; your column is marked in words and tint. */
function boardGrid({ caption, columns, cells }) {
  const t = el('table', { class: 'sheet dr-board' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: `${caption} Your column is highlighted.` }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { scope: 'col', class: 'l', text: 'Round' }),
    ...columns.map((c) => el('th', { scope: 'col', class: c.isMine ? 'mine-col' : null }, [c.teamName, c.isMine ? el('span', { class: 'sub', text: 'you' }) : null])),
  ])]));
  const tb = el('tbody');
  cells.forEach((row, i) => {
    tb.appendChild(el('tr', {}, [
      el('th', { scope: 'row', class: 'l', text: String(i + 1) }),
      ...columns.map((c, j) => {
        const cell = row[j];
        if (!cell) return el('td', { class: c.isMine ? 'mine-col' : null }, ['']);
        const cls = [c.isMine ? 'mine-col' : '', cell.isMine ? 'mine-cell' : '', cell.onClock ? 'clock-cell' : ''].join(' ').trim();
        return el('td', { class: cls || null, 'data-pos': cell.player?.position || null }, [
          el('span', { class: 'pn', text: String(cell.pickNo) }),
          cell.player
            ? el('span', { class: 'bp' }, [cell.player.name, el('span', { class: 'sub', text: `${cell.player.position || ''} ${cell.player.team || ''}`.trim() })])
            : cell.onClock ? word('on the clock') : cell.traded && cell.ownerName ? el('span', { class: 'sub', text: `via trade, ${cell.ownerName}` }) : null,
        ]);
      }),
    ]));
  });
  t.appendChild(tb);
  return el('div', { class: 'table-scroll board-scroll', tabindex: '0', role: 'region', 'aria-label': caption }, [t]);
}

function gradeBlock(grade, { id = 'dr-grade-h' } = {}) {
  const me = grade.mine;
  const kids = [];
  if (!me || !me.picks) {
    kids.push(el('p', { class: 'phase-empty', text: 'no picks yet, so there is nothing to grade.' }));
  } else {
    const d = me.vsMedian;
    kids.push(el('p', { class: 'dr-grade-line' }, [
      `vs the median team: `,
      el('strong', { text: `${signed(d)} points` }),
      ` ${d > 0 ? 'above' : d < 0 ? 'below' : 'level with'} the median. ranked ${me.rank} of ${grade.teams.filter((t) => t.picks).length}.`,
    ]));
    kids.push(sheet('Projected starting lineup by team, against the median team',
      [{ text: 'Rank', cls: 'l' }, { text: 'Team', cls: 'l' }, 'Starters, projected points', 'Against the median'],
      grade.teams.filter((t) => t.picks).map((t) => ({
        mine: t.isMine,
        cells: [{ c: String(t.rank), cls: 'l dim-num' }, { c: [t.teamName, t.isMine ? word('you') : null], th: true, cls: 'l' }, { c: n1(t.total), cls: 'num' }, { c: `${signed(t.vsMedian)}${t.vsMedian > 0 ? ' above' : t.vsMedian < 0 ? ' below' : ''}`, cls: `num ${t.vsMedian >= 0 ? 'pos' : 'neg'}` }],
      }))));
    if (grade.lineup.length) {
      kids.push(sheet('Your starting lineup by position, against the league median',
        [{ text: 'Position', cls: 'l' }, 'You', 'League median', 'Difference'],
        grade.lineup.map((p) => ({
          cells: [{ c: p.position, th: true, cls: 'l' }, { c: n1(p.mine), cls: 'num' }, { c: n1(p.median), cls: 'num' },
            { c: `${signed(p.mine - p.median)}`, cls: `num ${p.mine - p.median >= 0 ? 'pos' : 'neg'}` }],
        }))));
    }
  }
  return block({ band: 'league', id, title: 'Your draft grade', note: "your projected starting lineup, against every other team's." }, kids);
}

function bestAvailableList(rows, { onPick = null, caption }) {
  if (!rows.length) return el('p', { class: 'phase-empty', text: 'nobody is left on the board.' });
  return sheet(caption,
    [{ text: 'Player', cls: 'l' }, { text: 'Pos', cls: 'l wide' }, 'Value over replacement', 'Adp', ...(onPick ? [{ text: 'Pick', cls: '' }] : [])],
    rows.map((p) => ({
      cells: [
        playerCell({ ...p, tier: p.tier }, p.fillsNeed ? word('fills a need', 'pine') : null),
        { c: p.position, cls: 'l wide' }, { c: signed(p.vor), cls: 'num pos' },
        { c: p.adp == null ? 'no adp' : n1(p.adp), cls: 'num' },
        ...(onPick ? [{ c: el('button', { type: 'button', class: 'btn', 'aria-label': `Draft ${p.name}`, onclick: () => onPick(p) }, ['Draft']) }] : []),
      ],
    })));
}

// ------------------------------------------------------------------ mock

function mockPanel(data) {
  const host = el('div');
  const teams = data.draft?.teams || data.league.teams;
  const saved = readMock() || {};
  const m = {
    slot: Math.min(Number(saved.slot) || data.order?.mySlot || 1, teams),
    seed: Number.isFinite(Number(saved.seed)) && saved.seed !== undefined ? Number(saved.seed) : 1,
    mine: Array.isArray(saved.mine) ? saved.mine : [],
    started: Boolean(saved.started),
  };
  const save = () => writeMock(m);

  const slotSel = el('select', { id: 'dr-slot' }, Array.from({ length: teams }, (_, i) => el('option', { value: String(i + 1), selected: i + 1 === m.slot }, [`${i + 1} of ${teams}${data.order?.mySlot === i + 1 ? ' (your real slot)' : ''}`])));
  const seedIn = el('input', { type: 'number', id: 'dr-seed', min: '0', max: '2147483647', value: String(m.seed), inputmode: 'numeric' });
  const quickOut = el('div', { 'aria-live': 'polite' });
  const fullOut = el('div');

  const read = () => {
    m.slot = Number(slotSel.value) || 1;
    m.seed = Math.max(0, Math.round(Number(seedIn.value)) || 0);
  };
  const fieldOf = (label, ctl, hint) => el('div', { class: 'field' }, [el('label', { for: ctl.id, text: label }), ctl, hint ? el('span', { class: 'sub', text: hint }) : null]);

  const status = (out, text) => { out.replaceChildren(el('p', { class: 'phase-empty', role: 'status', text })); };

  async function quick() {
    read();
    status(quickOut, 'drafting at your slot…');
    try {
      const r = (await api('draftmock', { slot: m.slot, seed: m.seed, quick: 1 })).report;
      if (!r.available) { quickOut.replaceChildren(emptyState('No mock draft', r.emptyMessage)); return; }
      quickOut.replaceChildren(block({
        band: 'waivers', id: 'dr-quick-h', title: 'Quick mock',
        note: `a quick auto-draft at ${r.usedRealSlot ? 'your real slot' : `slot ${r.mySlot}`}, seed ${r.seed}. bots draft by adp, a little noise and roster need.`,
      }, [
        el('p', { class: 'dr-first' }, [el('strong', { text: 'your first picks: ' }), r.firstPicks.map((p) => `${p.name} (${p.position})`).join(', ')]),
        sheet('Your quick mock picks', [{ text: 'Pick', cls: 'l' }, { text: 'Player', cls: 'l' }, 'Value over replacement'],
          r.mine.map((p) => ({ cells: [{ c: pickLabel(p.round, p.pickNo, r.teams), cls: 'l dim-num' }, playerCell(p), { c: signed(p.vor), cls: 'num' }] }))),
        gradeInner(r.grade),
      ]));
    } catch (err) {
      quickOut.replaceChildren(emptyState('The quick mock did not run', err.message));
    }
  }

  async function full() {
    read();
    status(fullOut, 'the room is drafting…');
    try {
      const r = (await api('draftmock', { slot: m.slot, seed: m.seed, mine: m.mine.join(',') })).report;
      if (!r.available) { fullOut.replaceChildren(emptyState('No mock draft', r.emptyMessage)); return; }
      // A saved pick the replay no longer accepts (a player gone) is dropped.
      if (r.mine.length < m.mine.length) { m.mine = r.mine.map((p) => p.id); save(); }
      paintFull(r);
    } catch (err) {
      fullOut.replaceChildren(emptyState('The mock draft could not continue', err.message));
    }
  }

  function paintFull(r) {
    const cells = Array.from({ length: r.rounds }, () => Array(r.teams));
    for (const p of r.picks) cells[p.round - 1][p.slot - 1] = { pickNo: p.pickNo, isMine: p.byUser, player: { name: p.name, position: p.position, team: p.team } };
    if (r.onClock) cells[r.onClock.round - 1][r.onClock.slot - 1] = { pickNo: r.onClock.pickNo, isMine: true, onClock: true };
    const parts = [];
    if (r.complete) {
      parts.push(block({ band: 'draft', id: 'dr-mock-h', title: 'The mock draft is done', note: 'your roster and grade are below. change the seed for different bots.' }, [mineTable(r)]));
    } else {
      parts.push(block({ band: 'draft', id: 'dr-mock-h', title: `You're on the clock · pick ${r.onClock.pickNo}`, note: `round ${r.onClock.round}. choose anyone still on the board; the bots replay the same way for seed ${r.seed}.` }, [
        el('div', { class: 'toolbar' }, [
          el('button', { type: 'button', class: 'btn ghost', disabled: m.mine.length ? null : true, onclick: () => { m.mine.pop(); save(); full(); } }, ['Undo last pick']),
        ]),
      ]));
      parts.push(block({ band: 'team', id: 'dr-mock-best-h', title: 'Best available', note: r.needs.filled ? 'every starting slot is filled. depth from here.' : 'starting slots you have not filled: ' + Object.entries(r.needs.counts).map(([s, n]) => `${n} ${s}`).join(', ') },
        [bestAvailableList(r.bestAvailable, { caption: 'Best available in the mock draft', onPick: (p) => { m.mine.push(p.id); save(); full(); } })]));
      if (r.mine.length) parts.push(block({ band: 'waivers', id: 'dr-mock-mine-h', title: 'Your picks' }, [mineTable(r)]));
    }
    parts.push(block({ band: 'feeds', id: 'dr-mock-board-h', title: 'The board', note: 'your column is highlighted.' }, [boardGrid({ caption: 'The mock draft board, rounds by teams.', columns: r.columns, cells })]));
    if (r.complete) parts.push(gradeBlock(r.grade, { id: 'dr-mock-grade-h' }));
    fullOut.replaceChildren(...parts);
  }

  const mineTable = (r) => sheet('Your picks in the mock draft', [{ text: 'Pick', cls: 'l' }, { text: 'Player', cls: 'l' }, 'Value over replacement'],
    r.mine.map((p) => ({ cells: [{ c: pickLabel(p.round, p.pickNo, r.teams), cls: 'l dim-num' }, playerCell(p), { c: signed(p.vor), cls: 'num' }] })));

  host.appendChild(block({
    band: 'draft', id: 'dr-mock-setup-h', title: 'Mock draft', note: 'the same seed replays the same bots. bots draft by adp, a little noise and roster need.',
  }, [
    el('div', { class: 'toolbar' }, [
      fieldOf('Your draft slot', slotSel),
      fieldOf('Seed', seedIn, 'same seed, same bots'),
      el('button', { type: 'button', class: 'btn', onclick: quick }, ['Quick mock']),
      el('button', { type: 'button', class: 'btn', onclick: () => { read(); m.mine = []; m.started = true; save(); full(); } }, ['Start a mock draft']),
      el('button', { type: 'button', class: 'btn ghost', onclick: () => { m.mine = []; m.started = false; writeMock(null); fullOut.replaceChildren(); quickOut.replaceChildren(); } }, ['Reset']),
    ]),
  ]));
  host.appendChild(quickOut);
  host.appendChild(fullOut);
  if (m.started) full(); // a draft left half way comes back where it was
  return host;
}

/** The grade, without its own block (inside the quick mock's). */
function gradeInner(grade) {
  const b = gradeBlock(grade, { id: `dr-quick-grade-${Math.random().toString(36).slice(2, 7)}` });
  b.className = 'dr-inner';
  b.removeAttribute('data-band');
  return b;
}

// ------------------------------------------------------------------ live assistant

const SIGN_WORD = { steal: 'steal', reach: 'reach', fair: 'fair' };

function valueCell(v) {
  if (!v) return { c: 'no adp', cls: 'dim' };
  return { c: [`${signed(v.delta)} `, word(SIGN_WORD[v.kind], v.kind === 'steal' ? 'pine' : v.kind === 'reach' ? 'brick' : '')], cls: 'num' };
}

function clockBlock(r) {
  if (r.mode === 'none') return block({ band: 'draft', id: 'dr-live-h', title: 'No draft in progress' }, [el('p', { class: 'sp-lede', text: r.message })]);
  if (r.supported === false) return block({ band: 'draft', id: 'dr-live-h', title: 'This draft is not supported' }, [el('p', { class: 'sp-lede', text: r.message })]);
  if (r.mode === 'replay') {
    return block({ band: 'draft', id: 'dr-live-h', title: 'Replay · this is not live', note: r.replayNote }, [
      el('p', { class: 'sp-lede', text: `${r.picksMade} of ${r.totalPicks} picks, ${r.type}.` }),
      el('a', { class: 'cta', href: '#draft' }, [el('span', { class: 'cta-label', text: 'See the draft recap' }), goArrow()]),
    ]);
  }
  if (r.mode === 'waiting') {
    return block({ band: 'draft', id: 'dr-live-h', title: 'Waiting for the draft to start', note: r.orderSet ? null : r.orderMessage }, [
      el('p', { class: 'sp-lede', text: "the assistant is on. it checks sleeper and wakes up when the first pick is made." }),
    ]);
  }
  if (!r.orderSet || !r.onClock) {
    return block({ band: 'draft', id: 'dr-live-h', title: r.picksMade >= r.totalPicks ? 'The draft is done' : 'The draft is live', note: r.orderMessage }, [
      el('p', { class: 'sp-lede', text: `${r.picksMade} of ${r.totalPicks} picks made.` }),
    ]);
  }
  const c = r.onClock;
  const paused = r.status === 'paused' ? word('paused') : null;
  if (c.isMine) {
    return block({ band: 'draft', id: 'dr-live-h', title: "You're on the clock", note: `the draft is waiting on you · pick ${c.pickNo}, round ${c.round}${c.traded ? ' (a traded pick)' : ''}.` }, [paused]);
  }
  const away = r.picksUntilMine;
  return block({ band: 'draft', id: 'dr-live-h', title: `On the clock: ${c.teamName || `slot ${c.slot}`}`, note: `pick ${c.pickNo}, round ${c.round}.` }, [
    el('p', { class: 'sp-lede', text: r.myNextPick == null ? 'you have no picks left.' : away === 0 ? "you're up next." : `you pick in ${away} ${away === 1 ? 'pick' : 'picks'} · pick ${r.myNextPick}.` }),
    paused,
  ]);
}

function liveSections(r) {
  const out = [clockBlock(r)];
  if (r.mode === 'none' || r.supported === false) {
    if (r.supported === false && r.feed?.length) out.push(feedBlock(r));
    return out;
  }
  if (r.mode === 'waiting' && !r.picksMade) return out;

  out.push(block({ band: 'team', id: 'dr-live-best-h', title: 'Best available', note: 'by value over replacement · drafted players are hidden.' },
    [bestAvailableList(r.bestAvailable, { caption: 'Best available by value over replacement' })]));

  const runRows = r.runs.rows;
  out.push(block({ band: 'week', id: 'dr-live-runs-h', title: 'Positional runs', note: `picks by position over the last ${r.runs.window} picks.` }, [
    runRows.length
      ? el('ul', { class: 'dr-runs' }, runRows.map((x) => el('li', {}, [`${x.position} · ${x.count}`, x.run ? word('a run', 'amber') : null])))
      : el('p', { class: 'phase-empty', text: 'no picks yet.' }),
  ]));

  out.push(block({ band: 'waivers', id: 'dr-live-needs-h', title: 'Your needs', note: r.needsMessage }, [
    r.needs.filled ? null : el('ul', { class: 'dr-runs' }, Object.entries(r.needs.counts).map(([s, n]) => el('li', { text: `${n} × ${s.replace('_', ' ').toLowerCase()}` }))),
  ]));

  out.push(block({ band: 'league', id: 'dr-live-gone-h', title: 'Likely gone before your pick', note: r.myNextPick ? `players whose adp falls before pick ${r.myNextPick}.` : null }, [
    r.likelyGone.length
      ? sheet('Players likely gone before your pick', [{ text: 'Player', cls: 'l' }, { text: 'Pos', cls: 'l wide' }, 'Adp', 'Value over replacement'],
        r.likelyGone.map((p) => ({ cells: [playerCell({ ...p, tier: null }), { c: p.position, cls: 'l wide' }, { c: n1(p.adp), cls: 'num' }, { c: signed(p.vor), cls: 'num' }] })))
      : el('p', { class: 'phase-empty', text: r.likelyGoneMessage }),
  ]));

  out.push(feedBlock(r));
  out.push(block({ band: 'feeds', id: 'dr-live-board-h', title: 'The board', note: 'your column is highlighted.' }, [boardGrid({ caption: 'The draft board, rounds by teams.', columns: r.board.columns, cells: r.board.cells })]));
  out.push(gradeBlock(r.grade));
  return out;
}

function feedBlock(r) {
  return block({ band: 'trades', id: 'dr-live-feed-h', title: 'Pick feed', note: 'newest first · value is the pick number against adp.' }, [
    r.feed.length
      ? sheet('Every pick, newest first', [{ text: 'Pick', cls: 'l' }, { text: 'Player', cls: 'l' }, { text: 'Team', cls: 'l wide' }, 'Value'],
        r.feed.map((p) => ({
          mine: p.isMine,
          cells: [{ c: pickLabel(p.round, p.pickNo, r.teams), cls: 'l dim-num' }, playerCell({ ...p, tier: null }, p.isMine ? word('you') : null), { c: p.teamName, cls: 'l wide' }, valueCell(p.value)],
        })))
      : el('p', { class: 'phase-empty', text: 'no picks have been made yet.' }),
  ]);
}

/** The announcement for picks that arrived since the last look. */
function newPicksMessage(r, lastSeen) {
  const fresh = (r.feed || []).filter((p) => p.pickNo > lastSeen).sort((a, b) => a.pickNo - b.pickNo);
  if (!fresh.length) return null;
  const say = (p) => `Pick ${p.pickNo}: ${p.teamName} took ${p.name}, ${p.position || 'unknown position'}.`;
  const tail = fresh.length > 3 ? `${fresh.length - 3} more picks. ` : '';
  const shown = fresh.slice(-3).map(say).join(' ');
  const clock = r.onClock ? ` ${r.onClock.isMine ? "You're on the clock." : `${r.onClock.teamName || 'Next team'} is on the clock.`}` : '';
  return `${tail}${shown}${clock}`;
}

function livePanel(data, root) {
  const host = el('div', { class: 'dr-live' });
  const region = el('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const note = el('p', { class: 'sp-note dr-poll' });
  const body = el('div', {}, [el('p', { class: 'phase-empty', role: 'status', text: 'reading the draft from sleeper…' })]);
  host.append(region, note, body);

  let stopped = false;
  let timer = null;
  let lastSeen = null;
  let signature = '';

  async function tick() {
    clearTimeout(timer);
    if (stopped) return;
    if (!root.isConnected || room.tab !== 'live') { stop(); return; }
    if (document.hidden) { note.textContent = 'paused while this tab is hidden.'; return; } // resumes on visibilitychange
    let wait = 15;
    try {
      const r = (await api('draftlive')).report;
      if (stopped) return;
      if (r.mode !== 'none') room.drafted = new Set(r.status === 'drafting' || r.status === 'paused' ? r.pickedIds || [] : []);
      const sig = [r.mode, r.status, r.picksMade, r.onClock?.pickNo, r.orderSet, r.supported].join('|');
      if (sig !== signature) {
        signature = sig;
        const scroll = body.querySelector('.board-scroll')?.scrollLeft || 0;
        body.replaceChildren(...liveSections(r).filter(Boolean));
        const bs = body.querySelector('.board-scroll');
        if (bs) {
          bs.scrollLeft = scroll;
          const mineCol = bs.querySelector('th.mine-col');
          if (!scroll && mineCol) bs.scrollLeft = Math.max(0, mineCol.offsetLeft - 90);
        }
        const msg = lastSeen == null ? null : newPicksMessage(r, lastSeen);
        if (msg) region.textContent = msg;
      }
      lastSeen = r.feed?.[0]?.pickNo ?? lastSeen ?? 0;
      wait = r.pollSeconds;
      note.textContent = wait > 0
        ? `checking sleeper every ${wait} seconds while this tab is open.`
        : r.mode === 'replay' ? 'replay · this is not live.' : '';
    } catch (err) {
      note.textContent = `sleeper did not answer (${err.message}). trying again in ${wait} seconds.`;
    }
    if (!stopped && wait > 0) timer = setTimeout(tick, wait * 1000);
  }
  const onVis = () => { if (!document.hidden && !stopped) tick(); else clearTimeout(timer); };
  function stop() {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
  }
  document.addEventListener('visibilitychange', onVis);
  room.stopLive = stop;
  tick();
  return host;
}

// ------------------------------------------------------------------ the room

export function draftRoomView(root) {
  room.stopLive?.();
  room.stopLive = null;
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'The draft room' })));
  root.appendChild(el('p', { class: 'hero-sub', text: 'rankings, mock drafts and a live assistant for draft day.' }));

  const panel = el('div', { class: 'dr-panel' });
  let board = null;
  let tabs = null;

  const show = (id) => {
    room.stopLive?.();
    room.stopLive = null;
    room.tab = id;
    panel.textContent = '';
    if (id === 'live') { panel.appendChild(livePanel(board, root)); return; }
    if (!board) { panel.appendChild(el('p', { class: 'phase-empty', role: 'status', text: 'loading the board…' })); return; }
    if (board.available === false) { panel.appendChild(emptyState('Rankings are not available', board.emptyMessage)); if (id === 'rankings') panel.appendChild(countdownBlock(board)); return; }
    panel.appendChild(id === 'rankings' ? rankingsPanel(board) : id === 'tiers' ? tiersPanel(board) : mockPanel(board));
  };

  const mountTabs = (active) => {
    const next = segmented({
      label: 'Draft room sections', value: active, className: 'dr-tabs',
      options: TABS, onChange: (id) => { room.touched = true; show(id); },
    });
    tabs?.replaceWith(next);
    tabs = next;
    return next;
  };
  root.appendChild(mountTabs(room.tab || 'rankings'));
  root.appendChild(panel);
  show(room.tab || 'rankings');

  load('draftboard').then((res) => {
    if (!root.isConnected) return;
    board = res.report;
    const underWay = board.draft && (board.draft.status === 'drafting' || board.draft.status === 'paused');
    if (!room.touched && underWay && room.tab !== 'live') {
      // Draft day: open on the assistant.
      mountTabs('live');
      show('live');
    } else if (room.tab !== 'live') {
      show(room.tab || 'rankings');
    }
  }).catch((err) => {
    if (!root.isConnected) return;
    board = { available: false, emptyMessage: err.message, draft: null, countdown: {}, order: {}, league: { teams: 12 } };
    if (room.tab !== 'live') show(room.tab || 'rankings');
  });
}
