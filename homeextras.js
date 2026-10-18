// Small blocks for the home page: contender or rebuilder, roster age, injury
// flags on your starters, and the league's history. Each returns a node the
// page can place anywhere; each loads its own data and says so when it cannot.

import { load } from './store.js';
import { el, n1, emptyState, loading } from './ui.js';
import { block } from './seg.js';
import { riseWords } from './motion.js';

/** Fill a block's body from a promise, with a loading line and an honest failure. */
function fill(node, promise, render) {
  const body = el('div', { class: 'hx-body' }, [loading('Reading the league…')]);
  node.appendChild(body);
  promise.then((data) => body.replaceChildren(render(data.report)), (err) => {
    body.replaceChildren(emptyState('This did not load', err.message));
  });
  return node;
}

const pctOf = (v) => `${Math.round(v * 100)}`;

// ---------------------------------------------------------------- contender or rebuilder

/** "Contender or rebuilder": your label and one sentence, with the league underneath. */
export function contenderBlock() {
  const node = block({
    band: 'plan', id: 'hx-contender-title', title: 'Contender or rebuilder', className: 'hx-block',
    note: 'Win-now strength is your playoff odds plus expected points. Future strength is dynasty value plus youth, or this season\'s value and age in a redraft league.',
  });
  return fill(node, load('profile'), (r) => {
    if (!r.mine) return el('p', { class: 'hx-lede', text: 'There is no team of yours to read in this league.' });
    const m = r.mine;
    const league = el('details', { class: 'hx-league' }, [
      el('summary', { text: 'How the whole league reads' }),
      el('ul', { class: 'hx-list' }, r.league.map((t) => el('li', {}, [
        el('span', { text: t.teamName }), ' ',
        el('span', { class: `tag ${t.label === 'contender' ? 'pine' : t.label === 'rebuilder' ? 'amber' : ''}`, text: t.word }),
        t.isMine ? el('span', { class: 'tag', text: 'You' }) : null,
      ]))),
    ]);
    return el('div', {}, [
      riseWords(el('h3', { class: 'hx-label', text: m.word })),
      el('p', { class: 'hx-lede', text: m.sentence }),
      el('p', { class: 'hx-scores' }, [
        el('span', {}, [el('strong', { text: pctOf(m.now) }), ' win-now']),
        el('span', {}, [el('strong', { text: pctOf(m.future) }), ' future']),
        el('span', { class: 'hx-quad', text: m.quadrantText }),
      ]),
      r.oddsUsed ? null : el('p', { class: 'hx-note', text: 'Playoff odds were not available, so win-now strength uses expected points alone.' }),
      league,
    ]);
  });
}

// ---------------------------------------------------------------- age profile

export function ageProfileBlock() {
  const node = block({ band: 'team', id: 'hx-age-title', title: 'Roster age profile', className: 'hx-block' });
  return fill(node, load('profile'), (r) => {
    const a = r.age;
    if (!a.available) return el('p', { class: 'hx-lede', text: a.sentence });
    const t = el('table', { class: 'sheet hx-table' });
    t.appendChild(el('caption', { class: 'visually-hidden', text: 'Average age by position, your roster against the league' }));
    t.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Position' }),
      el('th', { scope: 'col', text: 'You' }),
      el('th', { scope: 'col', text: 'League' }),
      el('th', { class: 'l', scope: 'col', text: 'Against the league' }),
    ])]));
    const tb = el('tbody');
    for (const row of a.rows) {
      if (row.mine == null) continue;
      const word = row.diff == null || Math.abs(row.diff) < 0.3 ? 'About the same'
        : `${Math.abs(row.diff).toFixed(1)} years ${row.diff < 0 ? 'younger' : 'older'}`;
      tb.appendChild(el('tr', {}, [
        el('th', { class: 'l', scope: 'row', text: `${row.position} (${row.players})` }),
        el('td', { class: 'num', text: n1(row.mine) }),
        el('td', { class: 'num', text: n1(row.league) }),
        el('td', { class: 'l', text: word }),
      ]));
    }
    t.appendChild(tb);
    return el('div', {}, [
      el('p', { class: 'hx-lede', text: a.sentence }),
      el('div', { class: 'table-scroll' }, [t]),
    ]);
  });
}

// ---------------------------------------------------------------- injury flags

export function injuryFlagsBlock() {
  const node = block({ band: 'week', id: 'hx-injury-title', title: 'Your starters in Sleeper', className: 'hx-block' });
  return fill(node, load('profile'), (r) => {
    const inj = r.injuries;
    if (!inj.flags.length) return el('p', { class: 'hx-lede', text: inj.sentence });
    const serious = new Set(['Out', 'IR', 'PUP', 'Doubtful', 'Sus', 'NA', 'DNR']);
    return el('div', {}, [
      el('p', { class: 'hx-lede', text: inj.sentence }),
      el('ul', { class: 'hx-list' }, inj.flags.map((f) => el('li', {}, [
        el('span', { class: 'hx-name', text: `${f.name} (${f.position})` }), ' ',
        el('span', { class: `tag ${serious.has(f.status) ? 'brick' : 'amber'}`, text: f.status }),
        f.bodyPart || f.practice ? el('span', { class: 'hx-note', text: ` ${[f.bodyPart, f.practice && `practice: ${f.practice}`].filter(Boolean).join(', ')}` }) : null,
      ]))),
    ]);
  });
}

// ---------------------------------------------------------------- league history

function simpleTable(caption, head, rows) {
  const t = el('table', { class: 'sheet hx-table' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: caption }));
  t.appendChild(el('thead', {}, [el('tr', {}, head.map((h, i) => el('th', { class: h.l ? 'l' : null, scope: 'col', text: h.text })))]));
  const tb = el('tbody');
  for (const cells of rows) {
    tb.appendChild(el('tr', { class: cells.mine ? 'is-mine' : null }, cells.cells.map((c, i) =>
      (i === 0 ? el('th', { class: 'l', scope: 'row' }, c) : el('td', { class: head[i].l ? 'l' : 'num' }, c)))));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

const you = () => el('span', { class: 'tag', text: 'You' });
const trophy = () => el('span', { class: 'tag pine', text: 'Champion' });

function historyBody(r) {
  if (!r.available) return emptyState('No history yet', r.message || 'This league has no finished seasons on Sleeper yet.');
  const out = el('div', { class: 'hx-history' });
  out.appendChild(el('p', { class: 'hx-lede', text: `Follows the league back through ${r.seasons.length} past season${r.seasons.length === 1 ? '' : 's'}.${r.youFound ? '' : ' Your username was not found, so your finish and head-to-head records are left out.'}` }));

  out.appendChild(el('h4', { class: 'hx-sub', text: 'Season by season' }));
  out.appendChild(simpleTable('Each past season: champion, your finish, record and points',
    [{ l: true, text: 'Season' }, { l: true, text: 'Champion' }, { l: true, text: 'Your finish' }, { text: 'Record' }, { text: 'Points' }],
    r.seasons.map((s) => ({
      mine: s.champion?.isYou,
      cells: [
        [s.season],
        [s.champion ? s.champion.teamName : 'Not decided', s.champion?.isYou ? you() : null],
        [s.you ? s.you.finish : '—'],
        [s.you ? s.you.record : '—'],
        [s.you ? n1(s.you.pointsFor) : '—'],
      ],
    }))));

  out.appendChild(el('h4', { class: 'hx-sub', text: 'All-time standings' }));
  out.appendChild(simpleTable('All-time record by manager across these seasons',
    [{ l: true, text: 'Manager' }, { text: 'Record' }, { text: 'Win %' }, { text: 'Points' }, { text: 'Titles' }],
    r.allTime.map((a) => ({
      mine: a.isYou,
      cells: [
        [a.name || 'Unknown', a.isYou ? you() : null],
        [`${a.w}-${a.l}${a.t ? `-${a.t}` : ''}`],
        [`${Math.round(a.winPct * 1000) / 10}%`],
        [Math.round(a.pf).toLocaleString('en-US')],
        [String(a.titles)],
      ],
    }))));

  if (r.headToHead.length) {
    out.appendChild(el('h4', { class: 'hx-sub', text: 'Head to head' }));
    out.appendChild(simpleTable('Your regular-season record against each manager',
      [{ l: true, text: 'Manager' }, { text: 'Record' }, { text: 'Points for' }, { text: 'Points against' }],
      r.headToHead.map((h) => ({
        cells: [
          [h.name || 'Unknown'],
          [`${h.w}-${h.l}${h.t ? `-${h.t}` : ''}`],
          [n1(h.pointsFor)],
          [n1(h.pointsAgainst)],
        ],
      }))));
  }

  const best = [];
  if (r.bestWeek) best.push(`The best single week in the league: ${n1(r.bestWeek.points)} points by ${r.bestWeek.teamName}${r.bestWeek.isYou ? ' (you)' : ''}, week ${r.bestWeek.week} of ${r.bestWeek.season}.`);
  if (r.yourBestWeek && !(r.bestWeek && r.bestWeek.isYou && r.bestWeek.points === r.yourBestWeek.points)) {
    best.push(`Your best: ${n1(r.yourBestWeek.points)} points, week ${r.yourBestWeek.week} of ${r.yourBestWeek.season}.`);
  }
  if (best.length) {
    out.appendChild(el('h4', { class: 'hx-sub', text: 'Best single week' }));
    for (const b of best) out.appendChild(el('p', { class: 'hx-lede', text: b }));
  }
  return out;
}

/** League history as a block for the home page. */
export function historyBlock() {
  const node = block({
    band: 'league', id: 'hx-history-title', title: 'League history', className: 'hx-block',
    note: 'Follows the league back through its past seasons, managers matched by their Sleeper account.',
  });
  return fill(node, load('history'), historyBody);
}

/** League history as its own page. */
export function historyView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'League history' })));
  root.appendChild(historyBlock());
}
