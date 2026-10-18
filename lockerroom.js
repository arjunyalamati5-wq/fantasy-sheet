// The locker room: every player on one table, and the best lineup by the
// numbers for any week left, with pin and bench buttons that re-solve it.

import { load, state } from './store.js';
import { el, n1, announce, callout, playerName, shortSlot } from './ui.js';
import { segmented, block, gradeTag, range } from './seg.js';

const GROUP_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

// ---------------------------------------------------------------- "Back in week"

// The manager's own return weeks for players who are out, kept in this browser
// as ff.irReturn.<leagueId> = { playerId: week } and sent to the server as
// ir=pid:week,... so later weeks, waivers and the season simulation use them.
const OUT_STATUSES = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR']);
const LONG_STATUSES = new Set(['IR', 'PUP', 'NA']);
const DEFAULT_IR_WEEKS = 4;
const LAST_WEEK = 18;
const irKey = () => `ff.irReturn.${state.leagueId}`;

export function readIr() {
  try {
    const raw = JSON.parse(localStorage.getItem(irKey()) || '{}');
    const out = {};
    for (const [pid, wk] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (/^[A-Za-z0-9_]{1,24}$/.test(pid) && Number.isInteger(wk) && wk > 0 && wk <= LAST_WEEK) out[pid] = wk;
    }
    return out;
  } catch { return {}; }
}

function writeIr(map) {
  try { localStorage.setItem(irKey(), JSON.stringify(map)); } catch { /* a private window: the choice lasts until reload */ }
}

/** `pid:week,pid:week` for the server: only weeks after the current one, and players still out. */
export function irParam(map = readIr(), week = 0, outIds = null) {
  return Object.entries(map)
    .filter(([pid, wk]) => wk > week && (!outIds || outIds.has(pid)))
    .map(([pid, wk]) => `${pid}:${wk}`).join(',');
}

const irListeners = new Set();
function irChanged() { for (const fn of [...irListeners]) fn(); }
function onIrChange(node, fn) {
  const handler = () => { if (!node.isConnected) { irListeners.delete(handler); return; } fn(); };
  irListeners.add(handler);
}

/** The select under an out player's name. The default is what the server assumes without a choice. */
function backInWeek(p, week) {
  const map = readIr();
  const long = LONG_STATUSES.has(p.injury?.status);
  const defaultWeek = long ? week + DEFAULT_IR_WEEKS : week + 1;
  const sel = el('select', {
    'aria-label': `Week ${p.name} is back`,
    onchange: (e) => {
      const next = readIr();
      if (e.target.value) next[p.player_id] = Number(e.target.value); else delete next[p.player_id];
      writeIr(next);
      announce(e.target.value ? `${p.name} counted out until week ${e.target.value}.` : `${p.name} back to the default return.`);
      irChanged();
    },
  }, [
    el('option', { value: '', selected: !map[p.player_id], text: `Default (week ${Math.min(defaultWeek, LAST_WEEK)})` }),
    ...Array.from({ length: Math.max(0, LAST_WEEK - week) }, (_, i) => week + 1 + i).map((w) =>
      el('option', { value: String(w), selected: map[p.player_id] === w, text: `Week ${w}` })),
  ]);
  return el('label', { class: 'ir-pick' }, [el('span', { class: 'ir-pick-label', text: `${p.injury.status}: back in week ` }), sel]);
}

const pct = (v) => (v == null ? null : `${Math.round(v * 100)}%`);

function rosterTableNode(r, rows) {
  const wk = r.week;
  const cols = r.rosterColumns || {};
  const t = el('table', { class: 'sheet locker' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: 'Your whole roster: season average, next week with a bad and a good week, rest-of-season total, usage, trade value and next opponent' }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Player' }),
    el('th', { class: 'wide', scope: 'col', text: 'Per game' }),
    el('th', { scope: 'col', text: `Week ${wk}` }),
    el('th', { class: 'wide', scope: 'col', text: 'Bad week to good week' }),
    el('th', { class: 'wide', scope: 'col', text: 'Rest of season' }),
    cols.usage ? el('th', { class: 'wide', scope: 'col', text: 'Snaps / targets' }) : null,
    cols.tradeValue ? el('th', { class: 'wide', scope: 'col', text: 'Trade value' }) : null,
    el('th', { class: 'l wide', scope: 'col', text: 'Next opponent' }),
  ])]));

  const tb = el('tbody');
  for (const pos of GROUP_ORDER) {
    const group = rows.filter((p) => p.position === pos);
    if (!group.length) continue;
    for (const p of group) {
      const next = p.nextGame;
      const snap = pct(p.usage?.snap); const tgt = pct(p.usage?.target);
      const usageText = [snap ? `${snap} of snaps` : null, tgt ? `${tgt} of targets` : null].filter(Boolean).join(', ');
      const sumBits = [
        p.gamesPlayed > 0 ? `${n1(p.seasonAverage)} a game` : null,
        p.ceiling > 0 ? `range ${range(p.floor, p.ceiling)}` : null,
        `${n1(p.rosTotal)} rest of season`,
        usageText || null,
        p.tradeValue ? `trade value ${p.tradeValue.value.toLocaleString('en-US')}` : null,
        next ? `next ${next.opponent}${next.grade ? `, ${next.grade === 'avg' ? 'average' : next.grade} matchup` : ''}` : null,
      ].filter(Boolean).join(', ');
      const out = OUT_STATUSES.has(p.injury?.status);
      tb.appendChild(el('tr', { class: p.isStarter ? 'is-starter' : '' }, [
        el('th', { class: 'l player', scope: 'row' }, [
          playerName(p),
          p.isStarter ? el('span', { class: 'tag', text: 'Starting' }) : null,
          out ? el('span', { class: 'tag brick', text: p.injury.status }) : null,
          out ? backInWeek(p, wk) : null,
          el('span', { class: 'sub narrow-only', text: sumBits }),
        ]),
        el('td', { class: 'num wide', text: p.gamesPlayed > 0 ? n1(p.seasonAverage) : '—' }),
        el('td', { class: 'num', text: p.onBye ? 'Bye' : n1(p.projected) }),
        el('td', { class: 'num wide dim-num', text: p.ceiling > 0 ? range(p.floor, p.ceiling) : '—' }),
        el('td', { class: 'num wide', text: r.plan?.weeks?.length ? n1(p.rosTotal) : '—' }),
        cols.usage ? el('td', { class: 'num wide dim-num', text: usageText ? [snap, tgt].map((x) => x || '—').join(' / ') : '—' }) : null,
        cols.tradeValue ? el('td', { class: 'num wide', text: p.tradeValue ? p.tradeValue.value.toLocaleString('en-US') : '—' }) : null,
        el('td', { class: 'l wide' }, next ? [next.opponent, ' ', gradeTag(next.grade)] : ['—']),
      ]));
    }
  }
  t.appendChild(tb);
  return t;
}

/**
 * The whole roster: average, next week with its range, the rest of the year,
 * usage and trade value when known, the next opponent. Players who are out get
 * a "Back in week" choice; changing it asks the server again so rest-of-season
 * totals use it.
 */
export function rosterBlock(r) {
  const rows = r.roster || [];
  if (!rows.length) return null;
  const holder = el('div', { class: 'table-scroll' });
  let ticket = 0;
  const draw = (report) => holder.replaceChildren(rosterTableNode(report, report.roster));
  draw(r);

  async function refresh() {
    const mine = ++ticket;
    const outIds = new Set(r.roster.filter((p) => OUT_STATUSES.has(p.injury?.status)).map((p) => p.player_id));
    const ir = irParam(readIr(), r.week, outIds);
    holder.setAttribute('aria-busy', 'true');
    try {
      const res = await load('locker', ir ? { ir } : {});
      if (mine !== ticket) return;
      draw({ ...r, roster: res.report.roster, rosterColumns: res.report.rosterColumns, plan: res.report.plan });
    } catch (err) {
      if (mine !== ticket) return;
      holder.before(callout(`The roster could not be refreshed: ${err.message}`, 'warn'));
    } finally {
      if (mine === ticket) holder.removeAttribute('aria-busy');
    }
  }
  onIrChange(holder, refresh);
  // Choices saved earlier in this browser apply from the first look.
  const outIds = new Set(rows.filter((p) => OUT_STATUSES.has(p.injury?.status)).map((p) => p.player_id));
  if (irParam(readIr(), r.week, outIds)) refresh();

  const hasOut = rows.some((p) => OUT_STATUSES.has(p.injury?.status));
  return block({
    band: 'team', id: 'locker-roster', title: 'Your whole roster',
    note: 'Bad week to good week is the range a typical player at that position lands in about 6 weeks in 10 (the 20th to the 80th percentile of weekly results against his own average). Matchups compare the points a defence has allowed his position with the league average.'
      + (hasOut ? ' A player on injured reserve counts again four weeks out; set "back in week" to say when he really returns.' : '')
      + ' Questionable players count 85% of their projection this week, doubtful 30%, out 0.',
  }, [holder]);
}

/**
 * The best lineup by the numbers, one week at a time. State lives here (the
 * week, the pins, the benches); every change asks the server to solve again.
 */
export function bestByNumbers(r) {
  const plan = r.plan;
  if (!plan || !plan.best) return null;
  const weeks = plan.weeks.length ? plan.weeks : [plan.week];
  let week = plan.week;
  const pins = new Set();
  const benches = new Set();
  let ticket = 0;

  const body = el('div', { class: 'bbn-body' });
  const clear = el('button', { type: 'button', class: 'btn ghost mini-clear', hidden: true, text: 'Clear pins and benches',
    onclick: () => { pins.clear(); benches.clear(); refresh(); } });

  const tabs = segmented({
    label: 'Week', className: 'weektabs',
    options: weeks.map((w) => ({ id: w, label: w === plan.week ? `Week ${w}, now` : `Week ${w}` })),
    value: week,
    onChange: (w) => { week = Number(w); refresh(); },
  });

  function toggle(kind, id) {
    const mine = kind === 'pin' ? pins : benches;
    const other = kind === 'pin' ? benches : pins;
    if (mine.has(id)) mine.delete(id); else { mine.add(id); other.delete(id); }
    refresh(`${kind}:${id}`);
  }

  function control(kind, p) {
    const on = (kind === 'pin' ? pins : benches).has(p.player_id);
    return el('button', {
      type: 'button', class: 'mini', 'aria-pressed': String(on), 'data-key': `${kind}:${p.player_id}`,
      'aria-label': `${kind === 'pin' ? 'Pin' : 'Bench'} ${p.name}`,
      title: kind === 'pin' ? 'Start him this week if a slot can hold him' : 'Keep him out of the lineup',
      onclick: () => toggle(kind, p.player_id),
    }, [kind === 'pin' ? 'Pin' : 'Bench']);
  }

  function row(slot, p, points) {
    if (!p) {
      return el('tr', {}, [
        el('td', { class: 'slot', text: shortSlot(slot) }),
        el('th', { class: 'player', scope: 'row' }, [el('span', { class: 'pname', text: 'Nobody can fill this slot' })]),
        el('td', { class: 'stat mid' }), el('td', { class: 'stat wide' }), el('td', { class: 'big', text: '0.0' }), el('td', { class: 'ctl' }),
      ]);
    }
    const flags = [];
    if (p.pinned) flags.push('Pinned');
    if (p.benched) flags.push('Benched');
    return el('tr', { class: p.pinned ? 'is-pinned' : p.benched ? 'is-benched' : '' }, [
      el('td', { class: 'slot', text: shortSlot(slot) }),
      el('th', { class: 'player', scope: 'row' }, [
        playerName(p, { opp: p.opponent }),
        ...flags.map((f) => el('span', { class: 'tag', text: f })),
        p.grade ? el('span', { class: 'psub narrow-only', text: `${p.grade === 'avg' ? 'Average' : p.grade[0].toUpperCase() + p.grade.slice(1)} matchup` }) : null,
      ]),
      el('td', { class: 'stat mid' }, p.onBye ? ['Bye'] : [p.opponent || '', ' ', gradeTag(p.grade)]),
      el('td', { class: 'stat wide', text: p.ceiling > 0 ? range(p.floor, p.ceiling) : '' }),
      el('td', { class: 'big', text: p.onBye ? 'Bye' : n1(points) }),
      el('td', { class: 'ctl' }, [control('pin', p), control('bench', p)]),
    ]);
  }

  function render(b) {
    const t = el('table', { class: 'roster bbn-table' });
    t.appendChild(el('caption', { class: 'visually-hidden', text: `Best lineup for week ${b.week}, then the bench, with pin and bench buttons` }));
    t.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Slot' }),
      el('th', { class: 'l', scope: 'col', text: 'Player' }),
      el('th', { class: 'mid', scope: 'col', text: 'Opponent' }),
      el('th', { class: 'wide', scope: 'col', text: 'Bad to good week' }),
      el('th', { scope: 'col', text: 'Points' }),
      el('th', { scope: 'col', text: 'Your say' }),
    ])]));
    const starters = el('tbody');
    for (const a of b.assignments) starters.appendChild(row(a.slot, a.player, a.points));
    t.appendChild(starters);
    if (b.bench.length) {
      const bench = el('tbody');
      bench.appendChild(el('tr', { class: 'group' }, [el('th', { colspan: 6, scope: 'rowgroup', text: 'Bench' })]));
      for (const p of b.bench) bench.appendChild(row(p.position, p, p.projected));
      t.appendChild(bench);
    }

    const notes = [];
    if (b.cost > 0.05) notes.push(`Your pins and benches cost ${n1(b.cost)} points against the best lineup (${n1(b.unconstrainedTotal)}).`);
    if (b.unplaced.length) notes.push('A pinned player could not be started because no open slot can legally hold him.');
    const weekNote = b.week === plan.week
      ? 'This week uses real projections. '
      : 'Later weeks use each player’s per-game value, nothing on a bye, and nothing for players on injured reserve. ';

    body.replaceChildren(
      el('p', { class: 'bbn-total' }, [
        el('strong', { text: n1(b.total) }), ` projected points in week ${b.week}. `, weekNote,
      ]),
      ...notes.map((n) => el('p', { class: 'sp-warn', text: n })),
      el('div', { class: 'table-scroll' }, [t]),
    );
    clear.hidden = !(pins.size || benches.size);
    return notes.length ? `${n1(b.total)} points. ${notes.join(' ')}` : `${n1(b.total)} points.`;
  }

  async function refresh(focusKey = null) {
    const mine = ++ticket;
    body.setAttribute('aria-busy', 'true');
    try {
      let report;
      if (week === plan.week && !pins.size && !benches.size) report = plan.best;
      else {
        const params = { for: week };
        const ir = irParam(readIr(), plan.week);
        if (ir) params.ir = ir;
        if (pins.size) params.pin = [...pins].join(',');
        if (benches.size) params.bench = [...benches].join(',');
        report = (await load('lineup-best', params)).report;
      }
      if (mine !== ticket) return; // a newer click already asked for another answer
      const said = render(report);
      if (focusKey) body.querySelector(`[data-key="${focusKey}"]`)?.focus();
      announce(`Week ${report.week} lineup updated. ${said}`);
    } catch (err) {
      if (mine !== ticket) return;
      body.replaceChildren(callout(`That lineup could not be worked out: ${err.message}`, 'warn'));
    } finally {
      if (mine === ticket) body.removeAttribute('aria-busy');
    }
  }

  render(plan.best);
  onIrChange(body, () => { if (week !== plan.week || pins.size || benches.size) refresh(); });
  return block({
    band: 'week', id: 'locker-best', title: 'The best lineup by the numbers',
    note: 'Pick any week left in the regular season. Pin a player to start him if a slot can hold him; bench one to keep him out. The lineup is solved again each time.',
  }, [tabs, body, clear]);
}
