// The what-if lab: try a move or pick a result and watch your numbers move.
// The scenario lives in this browser (store.js) and rides along with every
// request, so every page — lineup, matchup, odds, bracket, waivers — shows
// the what-if until it is cleared. Nothing is sent to Sleeper.

import { state, api, load, whatIf, setWhatIf, whatIfToggle } from './store.js';
import { el, renderAsync, emptyState, field, pct0, n1, announce } from './ui.js';
import { riseWords } from './motion.js';

// ---------------------------------------------------------------- shared pieces

/** "Try it in the what-if lab" button for any page: adds the item(s) and opens the lab. */
export function whatIfButton(items, label = 'Try it in the what-if lab', { ariaLabel = null } = {}) {
  const list = Array.isArray(items) ? items : [items];
  return el('button', {
    type: 'button', class: 'pill-btn wi-try', 'aria-label': ariaLabel,
    onclick: () => {
      const have = whatIf().split(';').filter(Boolean);
      setWhatIf([...have, ...list.filter((x) => !have.includes(x))].join(';'));
      location.hash = 'whatif';
    },
    text: label,
  });
}

/**
 * The banner under the menu while a what-if is on: what it changes, and
 * buttons to open the lab or go back to the real league.
 */
export function mountWhatIfBanner(host) {
  const draw = async () => {
    host.textContent = '';
    const key = whatIf();
    if (!key || !state.leagueId) { host.hidden = true; return; }
    host.hidden = false;
    const text = el('p', { class: 'wi-banner-text', text: 'You are looking at a what-if.' });
    host.append(el('div', { class: 'wi-banner-inner' }, [
      el('span', { class: 'wi-banner-tag', text: 'What-if' }),
      text,
      el('a', { class: 'pill-btn', href: '#whatif', text: 'Open the lab' }),
      el('button', { type: 'button', class: 'pill-btn', onclick: () => { setWhatIf(''); announce('Back to the real league.'); }, text: 'Back to the real league' }),
    ]));
    try {
      const d = await load('whatif');
      const list = d.report.changes.map((c) => c.text);
      if (list.length) text.textContent = `You are looking at a what-if: ${list.join('; ')}.`;
    } catch { /* the banner still says a what-if is on */ }
  };
  window.addEventListener('ff:whatif-changed', draw);
  draw();
  return draw;
}

// ---------------------------------------------------------------- the lab

const delta = (before, after, fmt) => {
  if (before == null || after == null) return '—';
  const d = after - before;
  // A change in a percentage is in points: 97% to 99% is up 2 points, not 2%.
  const change = fmt === pct0 ? `${Math.round(Math.abs(d) * 100)} point${Math.round(Math.abs(d) * 100) === 1 ? '' : 's'}` : fmt(Math.abs(d));
  const none = Math.abs(d) < 1e-9 || change === '0 points' || Number(change) === 0;
  return `${fmt(before)} → ${fmt(after)}${none ? '' : ` (${d > 0 ? 'up' : 'down'} ${change})`}`;
};

const MARK_TEXT = {
  x: 'With this, you have clinched a playoff spot.',
  y: 'With this, you have clinched your division.',
  e: 'With this, you are eliminated.',
  d: 'With this, you are out of the division race.',
};

function effectBlock(r) {
  const rows = [
    [r.lineup?.fromNextWeek ? `Your lineup, points a week from week ${r.lineup.fromWeek}` : 'Your best lineup this week', r.lineup ? delta(r.lineup.before, r.lineup.after, n1) : '—'],
    ['Playoff odds', r.playoffs ? delta(r.playoffs.before, r.playoffs.after, pct0) : '—'],
    ['Title odds', r.title && r.title.before != null ? delta(r.title.before, r.title.after, pct0) : '—'],
    ['Expected wins', r.expectedWins ? delta(r.expectedWins.before, r.expectedWins.after, n1) : '—'],
  ];
  return el('section', { class: 'stack-block', 'data-band': 'league', 'aria-labelledby': 'wi-effect' }, [
    el('h3', { class: 'phase-title', id: 'wi-effect', text: 'What it changes' }),
    el('p', { class: 'phase-when', text: r.changes.length ? 'Against the real league. Trades count from next week, as in Sleeper.' : 'Nothing is in the what-if yet. Add a move or pick a result below.' }),
    el('dl', { class: 'wi-effect' }, rows.map(([k, v]) => el('div', { class: 'wi-effect-row' }, [el('dt', { text: k }), el('dd', { text: v })]))),
    r.mark && MARK_TEXT[r.mark] ? el('p', { class: 'phase-when', text: MARK_TEXT[r.mark] }) : null,
  ]);
}

const STATUS_WORD = { bye: 'on bye', out: 'out', unknown: 'unknown' };
const signedPts = (x) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`);

/** A diverging bar per week: how many points the trade adds or costs your lineup. */
function weekBars(weeks) {
  const max = Math.max(1, ...weeks.map((w) => Math.abs(w.you.delta)));
  return el('ol', { class: 'wi-bars', 'aria-hidden': 'true' }, weeks.map((w) => {
    const share = Math.min(1, Math.abs(w.you.delta) / max);
    return el('li', { class: `wi-bar ${w.you.delta >= 0 ? 'is-up' : 'is-down'}${w.phase === 'playoffs' ? ' is-playoff' : ''}` }, [
      el('span', { class: 'wi-bar-week', text: `W${w.week}` }),
      el('span', { class: 'wi-bar-track' }, [el('span', { class: 'wi-bar-fill', style: `--share:${share}` })]),
      el('span', { class: 'wi-bar-val', text: signedPts(w.you.delta) }),
    ]);
  }));
}

/** Week by week: both lineups, your real opponent, and who is missing. */
function weekTable(t) {
  const why = (w) => {
    const bits = [];
    const sentOff = w.players.filter((p) => p.dir === 'sent' && p.status !== 'plays');
    const gotOff = w.players.filter((p) => p.dir === 'got' && p.status !== 'plays');
    for (const p of sentOff) bits.push(`${p.name} ${STATUS_WORD[p.status] || p.status}`);
    for (const p of gotOff) bits.push(`${p.name} ${STATUS_WORD[p.status] || p.status}`);
    // A starter missing only in the traded lineup is the hole the trade opens
    // that week (say, your backup tight end's bye once the starter is gone).
    const before = new Set(w.absent?.you?.before || []);
    const fresh = (w.absent?.you?.after || []).filter((n) => !before.has(n) && !w.players.some((p) => p.name === n));
    if (fresh.length) bits.push(`${fresh.join(', ')} off that week, and after the trade ${fresh.length === 1 ? 'he would' : 'they would'} start`);
    // Slots the trade leaves empty that week: the clearest reason for a dip.
    const holes = (list, base) => { const left = [...(base || [])]; return (list || []).filter((s) => { const i = left.indexOf(s); if (i >= 0) { left.splice(i, 1); return false; } return true; }); };
    const newHoles = holes(w.empty?.you?.after, w.empty?.you?.before);
    const filled = holes(w.empty?.you?.before, w.empty?.you?.after);
    if (newHoles.length) bits.push(`no one left to start at ${newHoles.join(', ')} that week`);
    if (filled.length) bits.push(`fills your empty ${filled.join(', ')} spot that week`);
    if (!bits.length) {
      // A normal week: the swap itself, at each side's weekly value.
      const side = (dir) => w.players.filter((p) => p.dir === dir);
      const val = (list) => list.reduce((a, p) => a + (p.value || 0), 0);
      const got = side('got');
      const sent = side('sent');
      bits.push(`all play: ${got.map((p) => p.name).join(' and ')} (${n1(val(got))} a week) in for ${sent.map((p) => p.name).join(' and ')} (${n1(val(sent))})`);
    }
    return bits.join('; ');
  };
  const rows = t.weeks.map((w) => el('tr', { class: w.phase === 'playoffs' ? 'is-playoff' : '' }, [
    el('th', { scope: 'row', class: 'l', text: `Week ${w.week}${w.phase === 'playoffs' ? ' (playoffs)' : ''}` }),
    el('td', { class: 'num', text: `${n1(w.you.before)} → ${n1(w.you.after)}` }),
    el('td', { class: `num ${w.you.delta > 0.05 ? 'pos' : w.you.delta < -0.05 ? 'neg' : ''}`, text: signedPts(w.you.delta) }),
    el('td', { class: 'l', text: w.match ? `${w.match.vsPartner ? 'vs them: ' : ''}${w.match.opponent}, ${pct0(w.match.before)} → ${pct0(w.match.after)}` : w.phase === 'playoffs' ? 'if you make it' : '—' }),
    el('td', { class: 'num wide', text: signedPts(w.them.delta) }),
    el('td', { class: 'l wide', text: why(w) }),
  ]));
  const regular = t.weeks.filter((w) => w.phase === 'regular');
  const playoffs = t.weeks.filter((w) => w.phase === 'playoffs');
  const sum = (list) => list.reduce((a, w) => a + w.you.delta, 0);
  return el('div', { class: 'wi-weeks' }, [
    el('h5', { class: 'wi-sub', text: 'Week by week' }),
    el('p', { class: 'phase-when', text: `Regular season ${signedPts(sum(regular))} points for you over ${regular.length} weeks; fantasy playoffs ${signedPts(sum(playoffs))} over ${playoffs.length}. Byes and injuries are counted week by week, so one bad week can matter more than the average.` }),
    weekBars(t.weeks),
    el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Week by week trade table' }, [el('table', { class: 'sheet wi-week-table' }, [
      el('caption', { class: 'visually-hidden', text: 'What the trade does each week: your lineup, the change, your win chance against that week\'s opponent, their change, and who is missing' }),
      el('thead', {}, [el('tr', {}, [
        el('th', { scope: 'col', class: 'l', text: 'Week' }),
        el('th', { scope: 'col', text: 'Your lineup' }),
        el('th', { scope: 'col', text: 'Change' }),
        el('th', { scope: 'col', class: 'l', text: 'Win chance' }),
        el('th', { scope: 'col', class: 'wide', text: 'Their change' }),
        el('th', { scope: 'col', class: 'l wide', text: 'Why' }),
      ])]),
      el('tbody', {}, rows),
    ])]),
  ]);
}

/** How each player is valued: per game played, not a total dented by missed weeks. */
function valueTable(t) {
  return el('div', { class: 'wi-values' }, [
    el('h5', { class: 'wi-sub', text: 'How each player is valued' }),
    el('p', { class: 'phase-when', text: 'Value is points per game he played, blended with his projection for the next week he plays. Weeks he missed count as missed, not as zeros, so an injury earlier in the year does not drag him down.' }),
    el('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Player values in this trade' }, [el('table', { class: 'sheet' }, [
      el('caption', { class: 'visually-hidden', text: 'Each traded player: games played and missed, points per game, the misleading per-week average, and the value used' }),
      el('thead', {}, [el('tr', {}, ['Player', 'Side', 'Games', 'Per game played', 'Per week incl. missed', 'Value used'].map((h, i) => el('th', { scope: 'col', class: i < 2 ? 'l' : '', text: h })))]),
      el('tbody', {}, t.players.map((p) => el('tr', {}, [
        el('th', { scope: 'row', class: 'l', text: `${p.name}${p.pos ? `, ${p.pos}` : ''}` }),
        el('td', { class: 'l', text: p.dir === 'sent' ? 'You send' : 'You get' }),
        el('td', { class: 'num', text: `${p.gamesPlayed}${p.gamesMissed ? ` (missed ${p.gamesMissed})` : ''}` }),
        el('td', { class: 'num', text: p.perGame == null ? '—' : n1(p.perGame) }),
        el('td', { class: 'num', text: p.perWeekOverAllWeeks == null ? '—' : `${n1(p.perWeekOverAllWeeks)}${p.gamesMissed ? ' (undersells him)' : ''}` }),
        el('td', { class: 'num', text: n1(p.value) }),
      ]))),
    ])]),
  ]);
}

function tradeCard(t) {
  const side = (title, x) => el('div', { class: 'wi-side' }, [
    el('h4', { text: title }),
    el('dl', {}, [
      ['Points a week, from week ' + t.fromWeek, x.weeklyBefore != null ? delta(x.weeklyBefore, x.weeklyAfter, n1) : '—'],
      ['Rest of the regular season', x.restOfSeason != null ? `${x.restOfSeason > 0 ? '+' : ''}${n1(x.restOfSeason)} points over ${t.weeksLeft} week${t.weeksLeft === 1 ? '' : 's'}` : '—'],
      ['Playoff odds', x.playoffs ? delta(x.playoffs.before, x.playoffs.after, pct0) : '—'],
      ['Title odds', x.title ? delta(x.title.before, x.title.after, pct0) : '—'],
      ['Expected wins', x.expectedWins ? delta(x.expectedWins.before, x.expectedWins.after, n1) : '—'],
    ].map(([k, v]) => el('div', { class: 'wi-side-row' }, [el('dt', { text: k }), el('dd', { text: v })]))),
  ]);
  const names = (list) => list.map((p) => `${p.name}${p.pos ? ` (${p.pos})` : ''}`).join(' and ');
  return el('article', { class: 'wi-trade-card' }, [
    el('h4', { class: 'wi-trade-title', text: `You send ${names(t.give)}; you get ${names(t.get)}` }),
    el('p', { class: 'wi-trade-verdict', text: t.verdict }),
    el('div', { class: 'wi-sides' }, [side('You', t.you), side(t.them.name, t.them)]),
    t.intoLineup.length || t.outOfLineup.length
      ? el('p', { class: 'phase-when', text: [
        t.intoLineup.length ? `Into your starting lineup: ${t.intoLineup.join(', ')}.` : '',
        t.outOfLineup.length ? `Out of it: ${t.outOfLineup.join(', ')}.` : '',
      ].filter(Boolean).join(' ') })
      : el('p', { class: 'phase-when', text: 'Your starting lineup keeps the same names; the trade changes depth.' }),
    t.players?.length ? valueTable(t) : null,
    t.weeks?.length ? weekTable(t) : null,
  ]);
}

/** What each trade in the what-if does, to both teams. */
function tradesBlock(r) {
  if (!r.trades?.length) return null;
  return el('section', { class: 'stack-block', 'data-band': 'trades', 'aria-labelledby': 'wi-trades' }, [
    el('h3', { class: 'phase-title', id: 'wi-trades', text: r.trades.length === 1 ? 'What this trade does' : 'What these trades do' }),
    el('p', { class: 'phase-when', text: `Trades take effect next week, as in Sleeper. ${r.trades.length > 1 ? 'Each card shows the league with every trade in the what-if made.' : 'Both teams are re-solved for every week left and the season is simulated again.'}` }),
    ...r.trades.map(tradeCard),
  ]);
}

function scenarioBlock(r) {
  const items = whatIf().split(';').filter(Boolean);
  return el('section', { class: 'stack-block', 'data-band': 'team', 'aria-labelledby': 'wi-list' }, [
    el('h3', { class: 'phase-title', id: 'wi-list', text: 'Your what-if' }),
    items.length
      ? el('ul', { class: 'wi-list' }, items.map((item, i) => el('li', {}, [
        el('span', { text: r.changes[i]?.text || item }),
        el('button', { type: 'button', class: 'pill-btn', 'aria-label': `Remove: ${r.changes[i]?.text || item}`, onclick: () => whatIfToggle(item), text: 'Remove' }),
      ])))
      : el('p', { class: 'phase-when', text: 'Empty. Every page shows the real league.' }),
    r.ignoredPicks?.length ? el('p', { class: 'phase-when', text: `${r.ignoredPicks.length} pick${r.ignoredPicks.length === 1 ? '' : 's'} name a team with no game that week and ${r.ignoredPicks.length === 1 ? 'is' : 'are'} not used.` }) : null,
    items.length ? el('button', { type: 'button', class: 'btn', onclick: () => setWhatIf(''), text: 'Clear the what-if' }) : null,
  ]);
}

function movesBlock() {
  const box = el('section', { class: 'stack-block', 'data-band': 'waivers', 'aria-labelledby': 'wi-moves' }, [
    el('h3', { class: 'phase-title', id: 'wi-moves', text: 'Add, drop or trade' }),
  ]);
  const results = el('ul', { class: 'wi-results', 'aria-live': 'polite' });
  const input = el('input', { type: 'search', placeholder: 'Free agent name', autocomplete: 'off' });
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      results.textContent = '';
      if (q.length < 2) return;
      try {
        const d = await api('players', { q, scope: 'free', wi: null });
        for (const p of d.report.rows.slice(0, 8)) {
          results.append(el('li', {}, [
            el('span', { text: `${p.name}, ${p.pos}${p.team ? ` ${p.team}` : ''}${p.proj != null ? `, ${n1(p.proj)} projected` : ''}` }),
            el('button', { type: 'button', class: 'pill-btn', onclick: () => whatIfToggle(`a.${p.id}`), text: `Add ${p.name}` }),
          ]));
        }
        if (!results.children.length) results.append(el('li', { text: 'No free agent by that name.' }));
      } catch (err) { results.append(el('li', { text: err.message })); }
    }, 250);
  });
  box.append(field('Add a free agent', input), results);

  // Trade ideas both managers should like: one click to see what they do.
  const ideas = el('div', { class: 'wi-ideas' });
  box.append(ideas);
  renderAsync(ideas, load('handshake', { wi: null }), (d) => {
    const rows = (d.report.rows || []).slice(0, 4);
    if (!rows.length) return el('p', { class: 'phase-when', text: 'No trade both managers gain from right now. Build your own below.' });
    const names = (list) => list.map((p) => p.name).join(' and ');
    return el('div', {}, [
      el('h4', { text: 'Trade ideas both teams gain from' }),
      el('ul', { class: 'wi-results' }, rows.map((t) => {
        const item = `t.${t.partner.rosterId}.${t.send.map((p) => p.player_id).join('+')}.${t.get.map((p) => p.player_id).join('+')}`;
        return el('li', {}, [
          el('span', { text: `Send ${names(t.send)} to ${t.partner.teamName} for ${names(t.get)}` }),
          el('button', { type: 'button', class: 'pill-btn', 'aria-label': `See what trading ${names(t.send)} for ${names(t.get)} does`, onclick: () => whatIfToggle(item), text: 'See what it does' }),
        ]);
      })),
    ]);
  });

  // Your roster: drop buttons. Another team: trade by ticking both sides.
  const tradeBox = el('div', { class: 'wi-trade' });
  box.append(tradeBox);
  renderAsync(tradeBox, load('rosters', { wi: null }), (d) => {
    const rosters = d.report.rosters;
    const mine = rosters.find((r) => r.isMine);
    if (!mine) return emptyState('No team of yours', 'Roster moves need your team in this league.');
    const give = new Set();
    const get = new Set();
    const partnerSel = el('select', {}, rosters.filter((r) => !r.isMine).map((r) => el('option', { value: r.rosterId, text: r.teamName })));
    const theirs = el('div', { class: 'wi-cols-col' });
    const tick = (set, id, label) => {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => (cb.checked ? set.add(id) : set.delete(id)));
      return el('label', { class: 'wi-tick' }, [cb, ` ${label}`]);
    };
    const drawTheirs = () => {
      get.clear();
      const r = rosters.find((x) => String(x.rosterId) === partnerSel.value);
      theirs.replaceChildren(el('h4', { text: `From ${r.teamName}` }), ...r.players.map((p) => tick(get, p.player_id, `${p.name}, ${p.position}`)));
    };
    partnerSel.addEventListener('change', drawTheirs);
    drawTheirs();
    const ours = el('div', { class: 'wi-cols-col' }, [
      el('h4', { text: 'From you' }),
      ...mine.players.map((p) => el('div', { class: 'wi-own' }, [
        tick(give, p.player_id, `${p.name}, ${p.position}`),
        el('button', { type: 'button', class: 'mini', 'aria-label': `Drop ${p.name}`, onclick: () => whatIfToggle(`d.${p.player_id}`), text: 'Drop' }),
      ])),
    ]);
    const msg = el('p', { class: 'phase-when', role: 'status' });
    return el('div', {}, [
      field('Trade with', partnerSel),
      el('div', { class: 'wi-cols' }, [ours, theirs]),
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => {
          if (!give.size || !get.size) { msg.textContent = 'Tick at least one player on each side.'; return; }
          whatIfToggle(`t.${partnerSel.value}.${[...give].join('+')}.${[...get].join('+')}`);
        },
        text: 'Add this trade to the what-if',
      }),
      msg,
    ]);
  });
  return box;
}

/** The playoff machine: pick the winner of any game left; odds and marks follow. */
export function machineBlock(machine, { band = 'league' } = {}) {
  const items = whatIf().split(';').filter(Boolean);
  const box = el('section', { class: 'stack-block', 'data-band': band, 'aria-labelledby': 'wi-machine' }, [
    el('h3', { class: 'phase-title', id: 'wi-machine', text: 'Playoff machine' }),
    el('p', { class: 'phase-when', text: 'Pick winners, watch it move. Click a team to pick it to win; click again to undo. Odds, clinch marks and the bracket follow your picks.' }),
  ]);
  if (!machine?.length) { box.append(el('p', { text: 'No regular-season games left to pick.' })); return box; }
  machine.forEach((wk, i) => {
    const games = el('ul', { class: 'wi-games' });
    for (const g of wk.games) {
      const itemA = `w.${wk.week}.${g.a}`;
      const itemB = `w.${wk.week}.${g.b}`;
      const btn = (name, item, other, chance) => el('button', {
        type: 'button', class: 'wi-team', 'aria-pressed': String(items.includes(item)),
        onclick: () => whatIfToggle(item, { conflicts: [other] }),
      }, [el('span', { class: 'wi-team-name', text: name }), chance != null ? el('span', { class: 'wi-team-chance', text: pct0(chance) }) : null]);
      games.append(el('li', {}, [el('div', { class: 'wi-game', role: 'group', 'aria-label': `Week ${wk.week}: ${g.aName} against ${g.bName}` }, [
        btn(g.aName, itemA, itemB, g.aWinChance),
        el('span', { class: 'wi-vs', 'aria-hidden': 'true', text: 'vs' }),
        btn(g.bName, itemB, itemA, g.aWinChance == null ? null : 1 - g.aWinChance),
      ])]));
    }
    const picked = wk.games.filter((g) => g.picked).length;
    box.append(el('details', { class: 'wi-week', open: i === 0 }, [
      el('summary', { text: `Week ${wk.week}${picked ? `, ${picked} picked` : ''}` }), games,
    ]));
  });
  return box;
}

export function whatIfView(root) {
  root.textContent = '';
  root.append(riseWords(el('h2', { class: 'hero-title', text: 'What-if lab' })));
  root.append(el('p', { class: 'hero-sub', text: 'Try an add, a drop, a trade or a result. Every page follows until you go back to the real league.' }));
  const body = el('div');
  root.append(body);
  const draw = () => renderAsync(body, load('whatif'), (d) => el('div', {}, [
    effectBlock(d.report),
    tradesBlock(d.report),
    scenarioBlock(d.report),
    movesBlock(),
    machineBlock(d.report.machine),
  ]));
  draw();
  const onChange = () => { if (state.tab === 'whatif') draw(); };
  window.addEventListener('ff:whatif-changed', onChange);
  // Leaving the page stops listening, so an old lab never redraws in the background.
  window.addEventListener('hashchange', () => window.removeEventListener('ff:whatif-changed', onChange), { once: true });
}
