import { whatIfButton } from './whatifview.js';
import { state, load, post } from './store.js';
import { goArrow, riseWords } from './motion.js';
import {
  el, frag, figures, emptyState, callout, field, announce, n1, signed, renderAsync, warningsBlock, loading, playerTable, playerName,
} from './ui.js';

const mkt = (n) => (n == null ? '' : Math.round(n).toLocaleString('en-US'));
const pct = (n) => `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${Math.abs(n).toFixed(1)}%`;

const builder = { partnerId: null, give: new Set(), get: new Set(), givePicks: new Set(), getPicks: new Set() };

const pctText = (v) => { const x = v * 100; return `${x < 10 && x > 0 ? x.toFixed(1) : Math.round(x)}%`; };
const ptsChange = (d) => { const x = d * 100; return Math.abs(x) < 0.5 ? 'no change' : `${x > 0 ? 'up' : 'down'} ${Math.abs(x).toFixed(1)} points`; };

export function tradesView(root) {
  // Rendered synchronously, not inside renderAsync below: a self-titled view
  // must show its heading immediately, not only once the roster data has
  // loaded (renderAsync would otherwise show a spinner under no h2 at all).
  root.textContent = '';
  root.appendChild(el('h2', { class: 'section-title', text: 'Build a trade' }));
  root.appendChild(el('p', { class: 'section-note', text: 'A trade is graded on what it does to your starting lineup, not on raw point totals. Swapping bench players changes nothing you can actually score.' }));
  const body = el('div');
  root.appendChild(body);

  renderAsync(body, load('rosters'), (data) => {
    const rosters = data.report.rosters;
    const mine = rosters.find((r) => r.isMine) || rosters[0];
    if (!builder.partnerId) {
      builder.partnerId = (rosters.find((r) => !r.isMine) || {}).rosterId ?? null;
    }

    const out = frag([warningsBlock()]);

    const partnerSelect = el('select', {
      onchange: (e) => {
        builder.partnerId = e.target.value;
        builder.get.clear();
        builder.getPicks.clear();
        redraw();
      },
    }, rosters.filter((r) => !r.isMine).map((r) =>
      el('option', { value: r.rosterId, selected: String(r.rosterId) === String(builder.partnerId) }, [r.teamName])));

    out.appendChild(el('div', { class: 'toolbar' }, [
      field('Trade with', partnerSelect),
      el('button', { class: 'btn', onclick: () => analyze() }, ['Analyse this trade']),
      el('button', {
        class: 'btn ghost',
        onclick: () => { builder.give.clear(); builder.get.clear(); builder.givePicks.clear(); builder.getPicks.clear(); redraw(); },
      }, ['Clear']),
    ]));

    const cols = el('div', { class: 'two-col' });
    out.appendChild(cols);
    const result = el('div', { style: 'margin-top:26px' });
    out.appendChild(result);
    const dealsBox = el('section', { class: 'stack-block tr-deals', 'data-band': 'trades', 'aria-labelledby': 'tr-deals-title', style: 'margin-top:44px' });
    out.appendChild(dealsBox);
    const targetsBox = el('div', { style: 'margin-top:44px' });
    out.appendChild(targetsBox);
    const dynastyBox = el('section', { class: 'stack-block tr-dynasty', 'data-band': 'league', 'aria-labelledby': 'tr-dynasty-title', style: 'margin-top:44px' });
    out.appendChild(dynastyBox);

    function redraw() {
      cols.textContent = '';
      const partner = rosters.find((r) => String(r.rosterId) === String(builder.partnerId));
      const picks = data.report.picks || {};
      cols.appendChild(pickerColumn('You give', mine.teamName, mine.players, builder.give, redraw,
        picks[String(mine.rosterId)] || [], builder.givePicks));
      cols.appendChild(pickerColumn(
        'You get', partner ? partner.teamName : 'pick a team',
        partner ? partner.players : [], builder.get, redraw,
        partner ? picks[String(partner.rosterId)] || [] : [], builder.getPicks
      ));
    }

    async function analyze() {
      if (!builder.give.size && !builder.get.size && !builder.givePicks.size && !builder.getPicks.size) {
        result.textContent = '';
        result.appendChild(emptyState('Pick some players first',
          'Choose at least one player from each side, then press Analyse.'));
        return;
      }
      result.textContent = '';
      result.appendChild(loading('Re-solving both lineups and your playoff odds…'));
      try {
        const res = await post('trade', {
          partnerId: builder.partnerId,
          give: [...builder.give],
          get: [...builder.get],
          givePicks: [...builder.givePicks],
          getPicks: [...builder.getPicks],
        });
        result.textContent = '';
        result.appendChild(renderTradeResult(res.report));
        // Players-only trades can be tried across the whole app.
        if (!res.report.error && builder.give.size && builder.get.size && !builder.givePicks.size && !builder.getPicks.size) {
          result.appendChild(whatIfButton(`t.${builder.partnerId}.${[...builder.give].join('+')}.${[...builder.get].join('+')}`, 'Try this trade in the what-if lab'));
        }
        announce(res.report.error || `Trade graded ${res.report.grade.letter}: ${res.report.grade.label}.`);
      } catch (err) {
        result.textContent = '';
        result.appendChild(emptyState('Could not analyse that', err.message));
        announce(`Could not analyse that. ${err.message}`, { assertive: true });
      }
    }

    redraw();
    const loadDeal = ({ partnerId, give, get }) => {
      builder.partnerId = partnerId;
      partnerSelect.value = String(partnerId);
      builder.give = new Set(give);
      builder.get = new Set(get);
      builder.givePicks.clear();
      builder.getPicks.clear();
      redraw();
      analyze();
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    loadHandshake(dealsBox, loadDeal);
    dynastySection(dynastyBox);
    loadTargets(targetsBox, (row) => loadDeal({
      partnerId: row.fromRosterId, give: [row.piece.player_id], get: [row.target.player_id],
    }));

    return out;
  });
}

function pickerColumn(title, teamName, players, selection, onChange, picks = [], pickSel = null) {
  const box = el('div');
  box.appendChild(el('h3', { class: 'sub-title', text: title }));
  box.appendChild(el('p', { class: 'section-note', style: 'margin-top:-6px', text: teamName }));
  if (!players.length) {
    box.appendChild(emptyState('No players', 'Pick a trade partner above to see their roster.'));
    return box;
  }
  const list = el('div', { class: 'picker' });
  for (const p of players) {
    list.appendChild(el('button', {
      class: 'picker-item',
      'aria-pressed': selection.has(p.player_id) ? 'true' : 'false',
      onclick: () => {
        if (selection.has(p.player_id)) selection.delete(p.player_id);
        else selection.add(p.player_id);
        onChange();
      },
    }, [
      el('span', { class: 'pos', text: p.position }),
      el('span', { class: 'pname', text: p.name }),
      el('span', { class: 'pval', text: n1(p.value) }),
      el('span', { class: 'pros', title: 'Rest-of-season value', 'aria-label': `Rest-of-season value ${n1(p.rosValue)}`, text: n1(p.rosValue) }),
      p.market != null ? el('span', { class: 'pmkt', title: 'Market trade value (FantasyCalc)', 'aria-label': `Market value ${mkt(p.market)}`, text: mkt(p.market) }) : null,
    ]));
  }
  if (picks.length && pickSel) {
    list.appendChild(el('p', { class: 'picker-group', text: 'Future draft picks' }));
    for (const pk of picks) {
      list.appendChild(el('button', {
        class: 'picker-item is-pick',
        'aria-pressed': pickSel.has(pk.key) ? 'true' : 'false',
        'aria-label': `${pk.label} pick${pk.own ? '' : `, originally ${pk.from}'s`}`,
        onclick: () => {
          if (pickSel.has(pk.key)) pickSel.delete(pk.key); else pickSel.add(pk.key);
          onChange();
        },
      }, [
        el('span', { class: 'pos', text: 'PICK' }),
        el('span', { class: 'pname', text: pk.own ? pk.label : `${pk.label} (${pk.from})` }),
        pk.value != null ? el('span', { class: 'pmkt', title: 'Dynasty pick value (FantasyCalc)', 'aria-label': `Pick value ${mkt(pk.value)}`, text: mkt(pk.value) }) : null,
      ]));
    }
  }
  box.appendChild(list);
  const hasMkt = players.some((p) => p.market != null);
  box.appendChild(el('p', { class: 'section-note', style: 'margin-top:6px;font-size:12px', text: `First number: worth per week in your league's scoring. Second: rest-of-season value (per week times games left, byes excluded).${hasMkt ? ' Third: market trade value. Market values: FantasyCalc.' : ''}` }));
  return box;
}

function renderTradeResult(r) {
  if (r.error) return emptyState('Not enough to analyse', r.error);
  const out = el('section', { class: 'tr-report stack-block', 'data-band': 'trades', 'aria-label': 'Trade report' });
  const tone = r.me.delta >= 0 ? 'good' : 'warn';

  out.appendChild(el('header', { class: 'tr-head' }, [
    el('div', { class: `tr-grade ${tone}`, role: 'img', 'aria-label': `Grade ${r.grade.letter}` }, [r.grade.letter]),
    el('div', { class: 'tr-head-text' }, [
      el('h3', { class: 'tr-verdict', text: r.grade.label }),
      el('p', { class: 'tr-sub', text: `${r.myTeam} and ${r.theirTeam}. ${r.acceptance.likelihood}.` }),
    ]),
  ]));
  out.appendChild(el('div', { class: 'tr-deltas' }, [
    deltaCard('Your lineup', r.me),
    deltaCard(`${r.theirTeam}'s lineup`, r.them),
  ]));

  out.appendChild(callout(r.verdict));
  if (r.line) out.appendChild(el('p', { class: `tr-line is-${r.line.key}`, text: r.line.text }));
  out.appendChild(oddsBlock(r));
  if (r.dynasty) out.appendChild(dynastyRead(r));
  out.appendChild(marketBlock(r));
  for (const w of r.depthWarnings) out.appendChild(callout(w.message, 'warn'));

  out.appendChild(el('h3', { class: 'sub-title', text: 'The trade' }));
  out.appendChild(ledger(r));

  const side = (label, s, teamName) => {
    const box = el('div');
    box.appendChild(el('h3', { class: 'sub-title', text: label }));
    box.appendChild(el('p', { class: 'section-note', text: `${teamName}'s starting lineup goes from ${n1(s.before)} to ${n1(s.after)} points a week.` }));
    const rows = [
      ...s.lineupChanges.nowStarting.map((p) => ({ slot: p.position, player: p, value: n1(p.value), tone: 'pos', className: 'is-move', note: 'Now starts.' })),
      ...s.lineupChanges.noLongerStarting.map((p) => ({ slot: p.position, player: p, value: n1(p.value), tone: 'neg', className: 'is-drop', note: 'No longer starts.' })),
    ];
    if (!rows.length) {
      box.appendChild(emptyState('No lineup change',
        'Nobody moves into or out of the starting lineup, so this trade does not change what gets scored.'));
    } else {
      box.appendChild(playerTable({ rows, valueHead: 'Worth per week', caption: `${teamName}'s lineup changes` }));
    }
    return box;
  };

  out.appendChild(el('div', { class: 'two-col', style: 'margin-top:22px' }, [
    side('Your lineup', r.me, r.myTeam),
    side('Their lineup', r.them, r.theirTeam),
  ]));

  if (state.overview?.advisor?.enabled) {
    const box = el('div', { style: 'margin-top:26px' });
    box.appendChild(el('div', { class: 'toolbar' }, [
      el('button', {
        class: 'btn ghost',
        onclick: () => askAboutTrade(box, 'trade', r),
      }, ['Second opinion']),
      el('button', {
        class: 'btn ghost',
        onclick: () => askAboutTrade(box, 'propose', r),
      }, ['Write the message to send them']),
    ]));
    out.appendChild(box);
  }
  return out;
}

/** Playoff odds before and after: yours, then theirs. Words carry the direction, not colour alone. */
function oddsBlock(r) {
  const o = r.odds;
  if (!o) return null;
  if (!o.available) return el('p', { class: 'section-note tr-odds-note', text: o.reason || 'Playoff odds are unavailable right now.' });
  const card = (label, s) => {
    const dir = Math.abs(s.playoffChange) < 0.005 ? 'flat' : s.playoffChange > 0 ? 'up' : 'down';
    return el('div', { class: `tr-odds-card is-${dir}` }, [
      el('span', { class: 'tr-delta-label', text: `${label} playoff odds` }),
      el('span', { class: 'tr-odds-num' }, [
        el('span', { class: 'was', text: pctText(s.playoffBefore) }),
        el('span', { 'aria-hidden': 'true', class: 'arrow', text: ' \u2192 ' }),
        el('span', { class: 'visually-hidden', text: ' to ' }),
        el('span', { class: 'now', text: pctText(s.playoffAfter) }),
      ]),
      el('span', { class: 'tr-delta-range', text: `${ptsChange(s.playoffChange)}. Title odds ${pctText(s.titleBefore)} to ${pctText(s.titleAfter)}.` }),
    ]);
  };
  return el('div', { class: 'tr-odds', role: 'group', 'aria-label': 'Playoff odds before and after this trade' }, [
    el('div', { class: 'tr-odds-cards' }, [card('Your', o.me), card(`${r.theirTeam}'s`, o.them)]),
    el('p', { class: 'section-note tr-odds-note', text: o.note }),
  ]);
}

const readAs = (l) => (l.label === 'undecided' ? 'undecided' : `a ${l.label}`);

/** The dynasty read: both labels, the weighting sentence, the grade, and the value gap. */
function dynastyRead(r) {
  const d = r.dynasty;
  if (!d.available) return el('p', { class: 'section-note', text: d.reason || 'The dynasty read is unavailable right now.' });
  const tone = d.combined >= 0.1 ? 'good' : d.combined <= -0.1 ? 'warn' : '';
  return el('div', { class: `tr-dyn ${tone}` }, [
    el('p', { class: 'tr-dyn-head' }, [
      el('strong', { text: `Dynasty read: ${d.grade.letter}, ${d.grade.label}.` }),
      d.myLabel ? ` You read as ${readAs(d.myLabel)} (${d.myLabel.quadrantText}).` : '',
      d.theirLabel ? ` ${r.theirTeam} reads as ${readAs(d.theirLabel)}.` : '',
    ]),
    ...d.sentences.map((t) => el('p', { text: t })),
    d.values ? el('p', { class: 'section-note', text: `By dynasty value you give ${mkt(d.values.giveTotal)} and get ${mkt(d.values.getTotal)}${d.values.gapPct == null ? '' : ` (${pct(d.values.gapPct)})`}${d.ageShift == null ? '' : `; what comes in is ${Math.abs(d.ageShift).toFixed(1)} years ${d.ageShift > 0 ? 'older' : 'younger'}`}. ${d.source ? `Values: ${d.source}.` : ''}` }) : null,
  ]);
}

/** The market's second opinion beside the lineup grade; never blocks the page. */
function marketBlock(r) {
  const m = r.market;
  if (!m) {
    return el('p', { class: 'section-note tr-market', text: 'Market values unavailable right now. The lineup grade above does not depend on them.' });
  }
  const tone = m.gapPct === null || Math.abs(m.gapPct) < 3 ? '' : m.gapPct > 0 ? 'good' : 'warn';
  return el('div', { class: `tr-market ${tone}` }, [
    m.compare ? el('p', { class: 'tr-market-compare', text: m.compare }) : null,
    el('p', { class: 'tr-market-line', text: m.sentence }),
    el('p', { class: 'section-note tr-market-credit', text: 'Market values: FantasyCalc' }),
  ]);
}

function deltaCard(label, s) {
  const up = s.delta >= 0;
  return el('div', { class: `tr-delta ${up ? 'good' : 'warn'}` }, [
    el('span', { class: 'tr-delta-label', text: label }),
    el('span', { class: 'tr-delta-num', text: `${signed(s.delta)} a week` }),
    el('span', { class: 'tr-delta-range', text: `${n1(s.before)} to ${n1(s.after)} points` }),
  ]);
}

/** What leaves your roster against what arrives on it, side by side. */
function ledger(r) {
  return el('div', { class: 'ledger-cols' }, [
    ledgerSide('You send', r.theirTeam, 'to', r.give),
    ledgerSide('You receive', r.theirTeam, 'from', r.get),
  ]);
}

function ledgerSide(title, teamName, prep, players) {
  const side = el('div', { class: 'side' });
  side.appendChild(el('h3', { class: 'sub-title', text: title }));
  side.appendChild(el('p', { class: 'section-note', text: `${prep === 'to' ? 'To' : 'From'} ${teamName}.` }));
  side.appendChild(players.length
    ? playerTable({ rows: players.map((p) => ({ slot: p.position, player: p, value: `${n1(p.value)} · ROS ${n1(p.rosValue)}${p.market != null ? ` · mkt ${mkt(p.market)}` : ''}` })), valueHead: 'Per week · rest of season · market', caption: `${title}, ${prep} ${teamName}` })
    : emptyState('Nothing here yet', 'Pick a player from this side above.'));
  return side;
}

async function askAboutTrade(box, action, r) {
  let output = box.querySelector('.advisor-output');
  if (!output) {
    output = el('div', { class: 'advisor-output' });
    box.appendChild(output);
  }
  output.textContent = '';
  output.appendChild(loading('Asking the advisor…'));
  try {
    const res = await post('advisor', {
      action,
      partnerId: r.partnerId,
      give: r.give.map((p) => p.player_id),
      get: r.get.map((p) => p.player_id),
    });
    output.textContent = '';
    if (res.error) { output.appendChild(el('p', { text: res.error })); return; }
    output.appendChild(el('h4', { text: res.label }));
    output.appendChild(document.createTextNode(res.text));
  } catch (err) {
    output.textContent = '';
    output.appendChild(el('p', { text: err.message }));
  }
}

function loadHandshake(box, onLoad) {
  box.appendChild(el('h2', { class: 'section-title', id: 'tr-deals-title', text: 'Handshake deals' }));
  box.appendChild(el('p', { class: 'section-note', text: 'Trades both managers should take: each side\'s best starting lineup improves over the rest of the season. Ranked by the smaller of the two gains, so the fairest deals come first.' }));
  const body = el('div');
  box.appendChild(body);
  renderAsync(body, load('handshake'), (data) => {
    const r = data.report;
    if (!r.rows.length) {
      return emptyState('No handshake deals right now', 'No one-for-one or two-for-one swap helps both lineups by enough. Check back after the next waiver run or injury news.');
    }
    return frag([
      r.marketAvailable === false ? el('p', { class: 'section-note', text: 'Market values unavailable right now.' }) : null,
      el('p', { class: 'section-note', text: `Gains are lineup points over the ${r.weeks} regular-season weeks left, with bye weeks counted. "Starts for you" is how many of those weeks the player you get would be in your best lineup.${r.marketAvailable ? ' Market gap: the FantasyCalc value you get against the value you send, so a small gap means the other manager should see it as fair. Market values: FantasyCalc.' : ''}` }),
      handshakeTable(r.rows, onLoad, r.marketAvailable),
    ]);
  });
}

function handshakeTable(rows, onLoad, hasMarket = false) {
  const names = (list) => list.map((p) => `${p.name} (${p.position}) ${n1(p.rosValue)}${p.market != null ? ` · mkt ${mkt(p.market)}` : ''}`).join(' + ');
  const t = el('table', { class: 'sheet tr-deal-table' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: 'Trades both managers should take, ranked by the smaller gain' }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: '#' }),
    el('th', { class: 'l', scope: 'col', text: 'You send' }),
    el('th', { class: 'l', scope: 'col', text: 'You get' }),
    el('th', { class: 'l wide', scope: 'col', text: 'Partner' }),
    el('th', { scope: 'col', text: 'Your gain' }),
    el('th', { class: 'wide', scope: 'col', text: 'Their gain' }),
    el('th', { class: 'wide', scope: 'col', text: 'Starts for you' }),
    hasMarket ? el('th', { class: 'wide', scope: 'col', text: 'Market gap' }) : null,
    el('th', { scope: 'col' }, [el('span', { class: 'visually-hidden', text: 'Load into the analyzer' })]),
  ])]));
  const tb = el('tbody');
  rows.forEach((row, i) => {
    tb.appendChild(el('tr', {}, [
      el('td', { class: 'l num', text: String(i + 1) }),
      el('th', { class: 'l wrap-cell', scope: 'row' }, [
        names(row.send),
        row.line ? el('span', { class: 'sub tr-line-sub', text: row.line.text }) : null,
        el('span', { class: 'sub narrow-only', text: `With ${row.partner.teamName}. ${row.why}` }),
      ]),
      el('td', { class: 'l wrap-cell', text: names(row.get) }),
      el('td', { class: 'l wide', text: row.partner.teamName }),
      el('td', { class: 'num pos', text: signed(row.yourGain) }),
      el('td', { class: 'num wide pos', text: signed(row.theirGain) }),
      el('td', { class: 'num wide', text: `${row.startsForYou} wk` }),
      hasMarket ? marketGapCell(row.market) : null,
      el('td', {}, [el('button', {
        type: 'button', class: 'btn ghost tr-load',
        'aria-label': `Load ${names(row.send)} for ${names(row.get)} into the analyzer`,
        onclick: () => onLoad({
          partnerId: row.partner.rosterId,
          give: row.send.map((p) => p.player_id),
          get: row.get.map((p) => p.player_id),
        }),
      }, ['Load ', goArrow()])]),
    ]));
  });
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

function marketGapCell(m) {
  if (!m || m.gapPct == null) return el('td', { class: 'num wide', text: '—' });
  const a = Math.abs(m.gapPct);
  const tone = a < 10 ? 'pos' : a >= 25 ? 'neg' : '';
  return el('td', {
    class: `num wide tr-gap ${tone}`,
    title: `You send ${mkt(m.sendTotal)} and get ${mkt(m.getTotal)} in market value`,
    text: pct(m.gapPct),
  });
}

function loadTargets(box, onPick) {
  box.appendChild(el('h2', { class: 'section-title', text: 'Trades worth asking about' }));
  const body = el('div');
  box.appendChild(body);

  renderAsync(body, load('trade-targets'), (data) => {
    const r = data.report;
    const out = frag([]);
    out.appendChild(el('p', { class: 'section-note', text: `One-for-one swaps across all ${r.scanned} other rosters that would add at least ${r.minGain} points a week to your lineup while costing the other manager no more than ${r.maxCost}. One row per player, using the cheapest piece you would have to give up.` }));

    if (!r.rows.length) {
      out.appendChild(emptyState('No easy trades right now',
        'No single swap improves your lineup without costing the other manager real points. Try the builder above for two-for-one ideas, or look at Buy / Sell for managers who might be overvaluing someone.'));
      return out;
    }

    out.appendChild(targetsTable(r.rows, onPick));
    out.appendChild(el('p', { class: 'section-note', style: 'margin-top:10px', text: 'Choose any row (click it, or tab to the player\'s name and press Enter) to load it into the builder above.' }));
    return out;
  });
}

/**
 * One row per target: who, from whom, for what, and how hard an ask — as real
 * columns, not the same paragraph shape repeated for forty players. The
 * player's name is a real button inside the row header, reachable with Tab
 * and activated with Enter or Space; the row itself also responds to a click
 * anywhere in it, for the mouse.
 */
/** The reason half of the server's "Easy ask — they improve too", as a sentence. */
function askWhy(difficulty) {
  const why = String(difficulty.label || '').split(' — ')[1];
  return why ? `${why.charAt(0).toUpperCase()}${why.slice(1)}. ` : '';
}

function targetsTable(rows, onPick) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const t = el('table', { class: 'sheet' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: 'One-for-one trades worth asking about, ranked by what each adds to your lineup' }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Player' }),
    el('th', { class: 'l wide', scope: 'col', text: 'From' }),
    el('th', { class: 'l wide', scope: 'col', text: 'You give up' }),
    el('th', { class: 'l wide', scope: 'col', text: 'How hard an ask' }),
    el('th', { scope: 'col', text: 'Added to your lineup' }),
  ])]));
  const tb = el('tbody');
  for (const row of rows) {
    const askTone = row.difficulty.level === 'easy' ? 'pine' : row.difficulty.level === 'hard' ? 'brick' : '';
    const activate = () => onPick(row);
    // The ranking figure must survive a phone; From/give-up/ask are `wide`
    // (hidden ≤720px) and folded into one sub-line instead, so nothing is
    // lost, it just moves from three columns into one sentence.
    const phoneSummary = `${row.fromTeam}. Give up ${row.piece.name} (${row.piece.position}). `
      + `${cap(row.difficulty.level)} ask: ${costStake(row.theirCost)}.`;
    // The player's name is a real button (keyboard and screen readers know it
    // loads the trade); clicking anywhere on the row does the same for a mouse.
    tb.appendChild(el('tr', { style: 'cursor:pointer', onclick: activate }, [
      el('th', { class: 'l wrap-cell', scope: 'row' }, [
        el('button', { type: 'button', class: 'row-action', onclick: (e) => { e.stopPropagation(); activate(); } }, [
          playerName(row.target),
          el('span', { class: 'visually-hidden', text: ' Load this trade into the builder' }),
        ]),
        el('span', { class: 'sub narrow-only', text: phoneSummary }),
      ]),
      el('td', { class: 'l wide', text: row.fromTeam }),
      el('td', { class: 'l wide', text: `${row.piece.name} (${row.piece.position})` }),
      el('td', { class: 'l wide' }, [
        el('span', { class: `tag ${askTone}`, style: 'margin-left:0', text: cap(row.difficulty.level) }),
        el('span', { class: 'sub', text: askWhy(row.difficulty) + costStake(row.theirCost) }),
      ]),
      el('td', { class: 'num pos', text: signed(row.myGain) }),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

/** The stake for the other manager, without the sign error of calling a
 * negative cost a "cost" — a negative cost is a gain. */
function costStake(theirCost) {
  return theirCost <= 0
    ? `They gain ${n1(Math.abs(theirCost))} a week too`
    : `Costs them ${n1(theirCost)} a week`;
}

// ---------------------------------------------------------------- Dynasty

/** Future picks, team labels and who holds the next picks; the explanation in a redraft league. */
export function dynastyBlocks(report) {
  if (!report.enabled) return el('p', { class: 'dyn-explain', text: report.message });
  const out = frag([]);
  const labelTable = el('table', { class: 'sheet dyn-table' });
  labelTable.appendChild(el('caption', { class: 'visually-hidden', text: 'Each team as a contender or a rebuilder' }));
  labelTable.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Team' }),
    el('th', { class: 'l', scope: 'col', text: 'Label' }),
    el('th', { class: 'wide', scope: 'col', text: 'Win-now' }),
    el('th', { class: 'wide', scope: 'col', text: 'Future' }),
    el('th', { class: 'l wide', scope: 'col', text: 'Reads as' }),
  ])]));
  const lb = el('tbody');
  for (const p of report.profiles) {
    const tone = p.label === 'contender' ? 'pine' : p.label === 'rebuilder' ? 'amber' : '';
    lb.appendChild(el('tr', { class: p.isMine ? 'is-mine' : null }, [
      el('th', { class: 'l wrap-cell', scope: 'row' }, [
        p.teamName, p.isMine ? el('span', { class: 'tag', text: 'You' }) : null,
        el('span', { class: 'sub narrow-only', text: p.quadrantText }),
      ]),
      el('td', { class: 'l' }, [el('span', { class: `tag ${tone}`, style: 'margin-left:0', text: p.word })]),
      el('td', { class: 'num wide', text: `${Math.round(p.now * 100)}` }),
      el('td', { class: 'num wide', text: `${Math.round(p.future * 100)}` }),
      el('td', { class: 'l wide', text: p.quadrantText }),
    ]));
  }
  labelTable.appendChild(lb);
  out.appendChild(el('h3', { class: 'sp-title', text: 'Contender or rebuilder' }));
  out.appendChild(el('p', { class: 'section-note', text: 'Win-now strength is playoff odds plus expected points. Future strength is dynasty value plus youth. Both are scored 0 to 100 against the rest of the league.' }));
  out.appendChild(el('div', { class: 'table-scroll' }, [labelTable]));

  const pk = report.picks;
  out.appendChild(el('h3', { class: 'sp-title', text: 'Future picks by team' }));
  out.appendChild(el('p', { class: 'section-note', text: `${pk.movedMessage} Showing ${pk.seasons.join(', ')} across ${pk.rounds} round${pk.rounds === 1 ? '' : 's'}.${report.tradedPicksAvailable ? '' : ' Sleeper\'s traded-picks list did not load, so every pick is shown with its original owner.'}` }));
  const t = el('table', { class: 'sheet dyn-table' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: 'Draft picks held by each team' }));
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Team' }),
    el('th', { scope: 'col', text: 'Picks' }),
    report.marketAvailable ? el('th', { class: 'wide', scope: 'col', text: 'Value' }) : null,
    el('th', { class: 'l', scope: 'col', text: 'Holds' }),
  ])]));
  const tb = el('tbody');
  for (const team of pk.teams) {
    const bySeason = pk.seasons.map((s) => {
      const list = team.picks.filter((x) => x.season === s);
      return list.length ? `${s}: ${list.map((x) => `${x.round}${x.own ? '' : ` (${x.from})`}`).join(', ')}` : null;
    }).filter(Boolean).join('; ');
    tb.appendChild(el('tr', { class: team.isMine ? 'is-mine' : null }, [
      el('th', { class: 'l wrap-cell', scope: 'row' }, [team.teamName, team.isMine ? el('span', { class: 'tag', text: 'You' }) : null]),
      el('td', { class: 'num', text: String(team.count) }),
      report.marketAvailable ? el('td', { class: 'num wide', text: mkt(team.value) }) : null,
      el('td', { class: 'l wrap-cell dyn-holds', text: `Round by season. ${bySeason}` }),
    ]));
  }
  t.appendChild(tb);
  out.appendChild(el('div', { class: 'table-scroll' }, [t]));

  const moved = pk.holders.filter((h) => h.traded);
  out.appendChild(el('h3', { class: 'sp-title', text: `Who holds the next picks (${pk.seasons[0]})` }));
  out.appendChild(moved.length
    ? el('ul', { class: 'dyn-moved' }, moved.map((h) => el('li', { text: `${h.label} round pick that began with ${h.original} is now held by ${h.holder}.` })))
    : el('p', { class: 'section-note', text: `Every ${pk.seasons[0]} pick is still with its original owner.` }));
  out.appendChild(el('p', { class: 'section-note', text: report.note }));
  return out;
}

function dynastySection(box) {
  box.appendChild(el('h2', { class: 'section-title', id: 'tr-dynasty-title', text: 'Dynasty' }));
  const body = el('div');
  box.appendChild(body);
  renderAsync(body, load('dynasty'), (data) => dynastyBlocks(data.report));
}

export function dynastyView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Dynasty' })));
  const body = el('section', { class: 'stack-block tr-dynasty', 'data-band': 'league', 'aria-label': 'Dynasty tools' });
  root.appendChild(body);
  const inner = el('div');
  body.appendChild(inner);
  renderAsync(inner, load('dynasty'), (data) => dynastyBlocks(data.report));
}

// ---------------------------------------------------------------- Advisor

export function advisorView(root) {
  root.textContent = '';
  const o = state.overview;
  if (!o?.advisor?.enabled) {
    root.appendChild(emptyState('The advisor is switched off',
      'Set an ANTHROPIC_API_KEY environment variable and restart the server to turn it on. Everything else in this app works without it.'));
    return;
  }

  root.appendChild(el('h2', { class: 'section-title', text: 'Ask the advisor' }));
  root.appendChild(el('p', { class: 'section-note', text: 'The advisor only sees the numbers this app computed. It does not know what NFL season it is, who is injured, or what anyone else ranks these players at — its job is to explain and prioritise what is on this page.' }));

  const output = el('div');
  const question = el('input', { type: 'text', placeholder: 'Optional: anything specific you want covered', style: 'min-width:280px;flex:1' });

  const bar = el('div', { class: 'toolbar' }, [
    ...o.advisor.actions
      .filter((a) => ['briefing', 'roster'].includes(a.id))
      .map((a) => el('button', { class: 'btn', onclick: () => ask(a.id) }, [a.label])),
    field('Add a question', question, { style: 'flex:1' }),
  ]);
  root.appendChild(bar);
  root.appendChild(output);
  root.appendChild(el('p', { class: 'section-note', style: 'margin-top:18px', text: 'Trade second opinions and the trade-proposal message live on the Trades tab, next to the trade you built.' }));

  async function ask(action) {
    output.textContent = '';
    output.appendChild(loading('Asking the advisor…'));
    try {
      const res = await post('advisor', { action, question: question.value.trim() || null });
      output.textContent = '';
      if (res.error) { output.appendChild(emptyState('The advisor could not answer', res.error)); return; }
      const box = el('div', { class: 'advisor-output' });
      box.appendChild(el('h4', { text: res.label }));
      box.appendChild(document.createTextNode(res.text));
      output.appendChild(box);
    } catch (err) {
      output.textContent = '';
      output.appendChild(emptyState('The advisor could not answer', err.message));
    }
  }
}
