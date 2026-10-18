// Opponent scouting: this week's opponent (or any team you pick) — where their
// lineup is thin, who they will probably start, how they spend their waiver
// budget, and which free agents are worth bidding against them for.

import { load } from './store.js';
import { el, renderAsync, emptyState, field, figures, callout, playerTags, n1, pct0, announce } from './ui.js';
import { riseWords } from './motion.js';
import { whatIfButton } from './whatifview.js';

const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US')}`);
const signedPts = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`);

function block(band, id, title, children) {
  return el('section', { class: 'stack-block os-block', 'data-band': band, 'aria-labelledby': id }, [
    el('h3', { id, class: 'phase-title', text: title }),
    ...children,
  ]);
}

const note = (text) => el('p', { class: 'phase-when os-note', text });

function sheet(caption, heads, rows) {
  return el('div', { class: 'table-scroll' }, [el('table', { class: 'sheet os-table' }, [
    el('caption', { class: 'visually-hidden', text: caption }),
    el('thead', {}, [el('tr', {}, heads.map((h) => el('th', { scope: 'col', class: h.cls || '', text: h.text })))]),
    el('tbody', {}, rows),
  ])]);
}

function who(p) {
  if (!p) return el('span', { class: 'os-empty', text: 'Empty slot' });
  return el('span', { class: 'os-who' }, [
    el('span', { class: 'pname', text: p.name }),
    el('span', { class: 'pclub', text: ` ${p.position} ${p.team || ''}`.trimEnd() }),
    ...playerTags(p),
  ]);
}

// ---------------------------------------------------------------- sections

function headToHead(r) {
  const pct = Math.round(r.winProbability * 100);
  const rows = r.headToHead.map((h) => el('tr', {}, [
    el('th', { scope: 'row', class: 'l', text: h.slotLabel }),
    el('td', { class: 'l' }, [who(h.mine)]),
    el('td', { class: 'num', text: h.mine ? n1(h.mine.points) : '0.0' }),
    el('td', { class: 'l' }, [who(h.theirs)]),
    el('td', { class: 'num', text: h.theirs ? n1(h.theirs.points) : '0.0' }),
    el('td', { class: `l os-edge ${h.diff > 0.5 ? 'is-you' : h.diff < -0.5 ? 'is-them' : ''}`, text: h.edge }),
  ]));
  return block('week', 'os-h2h', 'Head to head', [
    figures([
      { value: `${pct}%`, label: 'Chance you win', sublabel: r.isOpponent ? 'this week' : 'if you played them' },
      { value: n1(r.mine.projected), label: 'You, projected' },
      { value: n1(r.projected), label: 'Them, projected', sublabel: `${n1(r.floor)} to ${n1(r.ceiling)} range` },
    ]),
    note(r.headline),
    sheet('Your starter against theirs, slot by slot, with who has the edge',
      [{ text: 'Slot', cls: 'l' }, { text: 'You', cls: 'l' }, { text: 'Pts' }, { text: 'Them', cls: 'l' }, { text: 'Pts' }, { text: 'Edge', cls: 'l' }], rows),
  ]);
}

function weakSpots(r) {
  const kids = [note(r.weakSummary)];
  if (r.weakSpots.length) {
    kids.push(sheet('Slots where their starter is under the league median',
      [{ text: 'Slot', cls: 'l' }, { text: 'Their starter', cls: 'l' }, { text: 'Pts' }, { text: 'League median' }, { text: 'Gap' }],
      r.weakSpots.map((w) => {
        const row = r.lineup[w.index];
        return el('tr', {}, [
          el('th', { scope: 'row', class: 'l', text: w.slotLabel }),
          el('td', { class: 'l' }, [who(row?.player)]),
          el('td', { class: 'num', text: n1(w.points) }),
          el('td', { class: 'num', text: n1(w.leagueMedian) }),
          el('td', { class: 'num', text: `${Math.abs(w.delta).toFixed(1)} under` }),
        ]);
      })));
  }
  if (r.risks.length) {
    kids.push(el('h4', { class: 'os-sub', text: 'Injuries and byes in their lineup' }));
    kids.push(el('ul', { class: 'os-list' }, r.risks.map((x) => el('li', {}, [
      el('strong', { text: `${x.slotLabel}: ` }), `${x.name || 'Empty'}. ${x.risk}.`,
    ]))));
  } else {
    kids.push(note('No injuries or byes in their lineup right now.'));
  }
  kids.push(el('h4', { class: 'os-sub', text: 'Bench depth' }));
  kids.push(el('ul', { class: 'os-list' }, r.bench.map((b) => el('li', {}, [el('strong', { text: `${b.position}: ` }), b.note]))));
  if (r.theirNeeds.length) {
    kids.push(note(`Where a free agent helps them most: ${r.theirNeeds.map((n) => `${n.position} (+${n.gain.toFixed(1)})`).join(', ')}.`));
  }
  return block('team', 'os-weak', 'Their weak spots', kids);
}

function lineup(r) {
  const rows = r.lineup.map((l) => el('tr', {}, [
    el('th', { scope: 'row', class: 'l', text: l.slotLabel }),
    el('td', { class: 'l' }, [who(l.player)]),
    el('td', { class: 'num', text: n1(l.points) }),
    el('td', { class: 'num', text: l.player ? `${n1(l.floor)} to ${n1(l.ceiling)}` : '—' }),
    el('td', { class: 'l', text: l.risk || (l.weak ? 'Below the league median' : '') }),
  ]));
  return block('research', 'os-lineup', 'Who they will start', [
    note(r.sourceNote),
    sheet('Their likely lineup with projection and range',
      [{ text: 'Slot', cls: 'l' }, { text: 'Player', cls: 'l' }, { text: 'Proj' }, { text: 'Floor to ceiling' }, { text: 'Note', cls: 'l' }], rows),
    note(`Team total ${n1(r.projected)}, with a bad week near ${n1(r.floor)} and a good one near ${n1(r.ceiling)} (the 10th and 90th percent of simulated weeks).`),
  ]);
}

function habits(r) {
  if (!r.faabProfile) return block('waivers', 'os-habits', 'Their waiver habits', [note(r.faabNote)]);
  const p = r.faabProfile;
  return block('waivers', 'os-habits', 'Their waiver habits', [
    figures([
      { value: money(p.remaining), label: 'Budget left', sublabel: `of ${money(p.budget)}` },
      { value: `${p.won} of ${p.claims}`, label: 'Claims won', sublabel: p.lost ? `${p.lost} lost` : null },
      { value: money(p.totalSpent), label: 'Spent on wins' },
      { value: p.avgWinningBid == null ? '—' : money(Math.round(p.avgWinningBid)), label: 'Average winning bid', sublabel: p.maxWinningBid == null ? null : `most ${money(p.maxWinningBid)}` },
      { value: p.avgBidPct == null ? '—' : pct0(p.avgBidPct), label: 'Average bid, share of budget' },
    ]),
    note(p.text),
  ]);
}

function targetRow(p, kind) {
  const bid = p.bid;
  return el('tr', {}, [
    el('th', { scope: 'row', class: 'l' }, [who(p)]),
    el('td', { class: 'num', text: signedPts(p.gainTheirs) }),
    el('td', { class: 'num', text: kind === 'contested' ? signedPts(p.gainMine) : 'No gain' }),
    el('td', { class: 'num', text: bid?.suggested != null ? money(bid.suggested) : '—' }),
    el('td', { class: 'l' }, [
      bid ? el('span', { class: 'os-bidtext', text: bid.text }) : null,
      el('div', {}, [whatIfButton([`a.${p.player_id}`], 'Try it in the what-if lab', { ariaLabel: `Try adding ${p.name} in the what-if lab` })]),
    ]),
  ]);
}

function targets(r) {
  const heads = [{ text: 'Free agent', cls: 'l' }, { text: 'Helps them' }, { text: 'Helps you' }, { text: 'Bid' }, { text: 'Why', cls: 'l' }];
  const kids = [];
  kids.push(el('h4', { class: 'os-sub', text: 'Both of you would start them' }));
  kids.push(r.contested.length
    ? sheet('Free agents that would improve both lineups, with a bid to beat theirs', heads, r.contested.map((p) => targetRow(p, 'contested')))
    : note('No free agent would improve both lineups this week, so you are not bidding against each other.'));
  kids.push(el('h4', { class: 'os-sub', text: 'Worth blocking' }));
  kids.push(r.blocks.length
    ? sheet('Free agents that would only help them, worth claiming to keep from them', heads, r.blocks.map((p) => targetRow(p, 'block')))
    : note('Nobody available would improve their lineup this week.'));
  if (r.faab) kids.push(note(`You have ${money(r.faab.mineRemaining)} left. Bids are suggestions from their history, not predictions.`));
  return block('trades', 'os-targets', 'Players to block or bid against them for', kids);
}

// ---------------------------------------------------------------- view

function sections(data) {
  const r = data.report;
  if (r.error) return emptyState('Nothing to scout yet', r.error);
  return el('div', { class: 'os-sections' }, [headToHead(r), weakSpots(r), lineup(r), habits(r), targets(r)]);
}

export function oppScoutView(root) {
  root.textContent = '';
  const title = riseWords(el('h2', { class: 'hero-title', text: 'Scouting' }));
  const sub = el('p', { class: 'hero-sub', text: 'Where your opponent is thin, who they will start, and what to bid against them.' });
  const body = el('div', { class: 'os-body' });
  root.append(title, sub, body);

  const show = (rosterId, refocus = false) => {
    renderAsync(body, load('oppscout', { roster: rosterId || null }), (data) => {
      const r = data.report;
      const mineId = String(data.myTeam?.rosterId ?? '');
      const chosen = r?.rosterId != null ? String(r.rosterId) : '';
      if (r?.teamName) {
        title.replaceChildren();
        title.textContent = `Scouting ${r.teamName}`;
        riseWords(title);
      }
      const select = el('select', {
        class: 'os-pick',
        onchange: (e) => { announce('Loading that team'); show(e.target.value, true); },
      }, (data.teams || []).filter((t) => String(t.rosterId) !== mineId).map((t) => el('option', {
        value: String(t.rosterId), text: t.name,
        selected: String(t.rosterId) === chosen ? '' : null,
      })));
      select.value = chosen && [...select.options].some((o) => o.value === chosen) ? chosen : (select.options[0]?.value || '');
      const picker = el('div', { class: 'os-picker' }, [
        field('Scout a team', select),
        r && !r.error ? el('p', { class: 'phase-when', text: r.isOpponent ? 'This is your opponent this week.' : 'Not your opponent this week.' }) : null,
      ]);
      const wrap = el('div', {}, [picker, data.warnings?.length ? callout(data.warnings[0], 'warn') : null, sections(data)]);
      if (refocus) setTimeout(() => select.focus(), 0);
      return wrap;
    });
  };
  show(null);
}
