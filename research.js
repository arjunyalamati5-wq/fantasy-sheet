import { state, load, post } from './store.js';
import {
  el, frag, emptyState, callout, field, announce, safeHref, n1, signed,
  renderAsync, warningsBlock, playerTable, ownerNote, credibilityTag,
} from './ui.js';

// ---------------------------------------------------------------- News

export function newsView(root) {
  renderAsync(root, load('news'), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);
    if (!r.available) return emptyState('The news feed is offline', r.emptyMessage);

    out.appendChild(el('p', { class: 'section-note', text: r.note }));

    if (r.aboutMyRoster.length) {
      out.appendChild(el('h3', { class: 'sub-title', text: 'About players you hold' }));
      for (const a of r.aboutMyRoster.slice(0, 12)) out.appendChild(article(a, true));
    }

    out.appendChild(el('h3', { class: 'sub-title', text: 'Around the league' }));
    const rest = r.articles.filter((a) => a.mentionsMyPlayers.length === 0);
    if (!rest.length) {
      out.appendChild(emptyState('Nothing else today', 'Every story in the feed already mentions one of your players.'));
    }
    for (const a of rest.slice(0, 25)) out.appendChild(article(a, false));
    return out;
  });
}

function article(a, mine) {
  const box = el('div', { class: 'story' });
  const head = el('div', { class: 'story-head' }, [
    a.link
      ? el('a', { class: 'story-title', href: safeHref(a.link), target: '_blank', rel: 'noopener noreferrer', text: a.headline })
      : el('span', { class: 'story-title', text: a.headline }),
  ]);
  box.appendChild(head);

  if (mine && a.mentionsMyPlayers.length) {
    const tags = el('div', { style: 'margin:4px 0 2px' });
    for (const p of a.mentionsMyPlayers) {
      tags.appendChild(el('span', { class: 'tag pine', text: `${p.name} (${p.position})` }));
    }
    box.appendChild(tags);
  }
  if (a.description) box.appendChild(el('p', { class: 'story-body', text: a.description }));
  const cred = credibilityTag(a.credibility);
  if (cred) cred.style.marginLeft = '0';
  box.appendChild(el('div', { class: 'story-foot' }, [
    cred,
    a.published ? el('span', { text: new Date(a.published).toLocaleString() }) : null,
  ]));
  return box;
}

// ---------------------------------------------------------------- Rankings

export function rankingsView(root) {
  const wrap = el('div');
  root.textContent = '';
  root.appendChild(wrap);
  let freeOnly = false;

  const draw = () => renderAsync(wrap, load('rankings', { free: freeOnly ? 1 : 0 }), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);

    out.appendChild(el('p', { class: 'section-note', text: `${r.note} ${r.weeksRemaining} weeks of the regular season remain.` }));
    out.appendChild(el('div', { class: 'toolbar' }, [
      el('button', {
        class: `btn ${freeOnly ? 'ghost' : ''}`,
        onclick: () => { freeOnly = false; draw(); },
      }, ['Everyone']),
      el('button', {
        class: `btn ${freeOnly ? '' : 'ghost'}`,
        onclick: () => { freeOnly = true; draw(); },
      }, ['Free agents only']),
    ]));

    out.appendChild(el('h3', { class: 'sub-title', text: 'Overall, all positions' }));
    out.appendChild(rankTable(r.overall, true, 'Every rostered and free-agent player, ranked overall'));

    for (const [pos, g] of Object.entries(r.groups)) {
      out.appendChild(el('h3', { class: 'sub-title', text: `${pos} rest of season` }));
      out.appendChild(el('p', { class: 'section-note', text: `Replacement level is the number ${g.replacementRank} ${pos} in the league, worth about ${n1(g.replacementValue)} points a week. Anyone above that is worth more than what you could pick up free.` }));
      out.appendChild(rankTable(g.rows.slice(0, 24), false, `${pos}, ranked rest of season`));
    }
    return out;
  });
  draw();
}

function rankTable(rows, showVor, caption) {
  if (!rows.length) {
    return emptyState('Nobody to rank yet', 'This fills in once players have been valued for the season ahead.');
  }
  return playerTable({
    rows: rows.map((p) => ({
      slot: `#${p.rank}`, player: p,
      value: showVor ? n1(p.vor) : n1(p.value),
      note: ownerNote(p),
      className: p.isMine ? 'mine' : null,
    })),
    stats: ['opp', 'total', 'avg', 'snap', 'tgt'],
    valueHead: showVor ? 'Above replacement' : 'Points per week',
    caption,
  });
}

// ---------------------------------------------------------------- Search

export function searchView(root) {
  root.textContent = '';
  root.appendChild(el('h2', { class: 'section-title', text: 'Find a player' }));
  root.appendChild(el('p', { class: 'section-note', text: 'Search by name, position or team. Every number is in your league\'s scoring.' }));

  const input = el('input', { type: 'text', placeholder: 'name, position (RB) or team (KC)', style: 'min-width:260px', autocapitalize: 'none' });
  const results = el('div');

  let timer = null;
  const run = () => {
    const q = input.value.trim();
    if (q.length < 2) {
      results.textContent = '';
      results.appendChild(emptyState('Start typing', 'Enter at least two letters. A surname works best.'));
      return;
    }
    renderAsync(results, load('search', { q }), (data) => {
      const r = data.report;
      if (r.emptyMessage) {
        announce('No match.');
        return emptyState('No match', r.emptyMessage);
      }
      announce(`${r.total} match${r.total === 1 ? '' : 'es'}.`);
      return frag([
        el('p', { class: 'section-note', text: `${r.total} match${r.total === 1 ? '' : 'es'}${r.total > r.rows.length ? `, showing the closest ${r.rows.length}` : ''}.` }),
        playerTable({
          rows: r.rows.map((p) => ({
            slot: p.position, player: p, value: n1(p.value), note: ownerNote(p),
            className: p.isMine ? 'mine' : null,
          })),
          stats: ['opp', 'total', 'avg', 'snap', 'tgt'],
          valueHead: 'Points per week',
          caption: `Search results for ${q}`,
        }),
      ]);
    });
  };

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  root.appendChild(el('div', { class: 'toolbar' }, [
    field('Search', input, { style: 'flex:1' }),
  ]));
  root.appendChild(results);
  results.appendChild(emptyState('Start typing', 'Enter at least two letters. A surname works best.'));
  input.focus();
}

// ---------------------------------------------------------------- Projected stat lines

export function propsView(root) {
  const wrap = el('div');
  root.textContent = '';
  root.appendChild(wrap);
  let scope = 'mine';

  const draw = () => renderAsync(wrap, load('props', { scope }), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);
    out.appendChild(callout(r.disclaimer, 'amber'));

    out.appendChild(el('div', { class: 'toolbar' }, [
      ...[['mine', 'My roster'], ['free', 'Free agents'], ['all', 'Everyone']].map(([id, label]) =>
        el('button', { class: `btn ${scope === id ? '' : 'ghost'}`, onclick: () => { scope = id; draw(); } }, [label])),
    ]));

    if (r.emptyMessage) { out.appendChild(emptyState('Nothing to show', r.emptyMessage)); return out; }

    out.appendChild(playerTable({
      rows: r.rows.map((p) => ({
        slot: p.position, player: p, value: n1(p.fantasyPoints),
        note: p.lines.map((l) => `${l.projected} ${l.label}`).join(', '),
      })),
      stats: ['opp', 'total', 'avg', 'snap', 'tgt'],
      valueHead: 'Fantasy points',
      caption: 'Projected stat lines, scored in your league',
    }));
    return out;
  });
  draw();
}

// ---------------------------------------------------------------- Betting board

export function bettingView(root) {
  renderAsync(root, load('betting'), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);
    if (!r.available) return emptyState('No lines available', r.emptyMessage);

    out.appendChild(el('p', { class: 'section-note', text: r.note }));
    if (r.emptyMessage) { out.appendChild(emptyState('No lines yet', r.emptyMessage)); return out; }

    out.appendChild(bettingBoard(r.games));
    return out;
  });
}

/** One row per game: the line, then each side's expected total. Kickoff time
 * and which of your players are on the field ride with the matchup name. */
function bettingBoard(games) {
  const t = el('table', { class: 'sheet' });
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Game' }),
    el('th', { class: 'l', scope: 'col', text: 'Line' }),
    el('th', { class: 'wide', scope: 'col', text: 'Away expected' }),
    el('th', { class: 'wide', scope: 'col', text: 'Home expected' }),
    el('th', { scope: 'col', text: 'Total' }),
  ])]));
  const tb = el('tbody');
  for (const g of games) {
    const when = [g.weekday, g.kickoff].filter(Boolean).join(', ');
    tb.appendChild(el('tr', {}, [
      el('th', { class: 'l wrap-cell compact', scope: 'row' }, [
        `${g.away} at ${g.home}`,
        when ? el('span', { class: 'sub', text: when }) : null,
        g.myPlayers.length
          ? el('span', { class: 'sub', text: `Your players: ${g.myPlayers.map((p) => `${p.name} (${p.position}, ${p.team})`).join(', ')}` })
          : null,
        g.impliedAway != null && g.impliedHome != null
          ? el('span', { class: 'sub narrow-only', text: `Expected: ${g.away} ${g.impliedAway}, ${g.home} ${g.impliedHome}` })
          : null,
      ].filter(Boolean)),
      el('td', { class: 'l wrap-cell compact' }, [
        g.favourite ? `${g.favourite} favoured by ${g.favouriteBy}` : 'No line posted',
        g.readout ? el('span', { class: 'sub', text: g.readout }) : null,
      ].filter(Boolean)),
      el('td', { class: 'num wide', text: g.impliedAway == null ? '—' : String(g.impliedAway) }),
      el('td', { class: 'num wide', text: g.impliedHome == null ? '—' : String(g.impliedHome) }),
      el('td', { class: 'num', text: g.total == null ? '—' : String(g.total) }),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

// ---------------------------------------------------------------- Transactions

export function transactionsView(root) {
  renderAsync(root, load('transactions'), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);
    if (r.emptyMessage) return emptyState('Nothing has happened yet', r.emptyMessage);

    out.appendChild(el('p', { class: 'section-note', text: `Every completed add, drop, waiver claim and trade in the league: ${r.total} so far this season, newest first.` }));
    out.appendChild(transactionsTable(r.rows));
    return out;
  });
}

function transactionsTable(rows) {
  const t = el('table', { class: 'sheet' });
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Move' }),
    el('th', { class: 'l wide', scope: 'col', text: 'Week' }),
    el('th', { scope: 'col', text: 'Points per week gained' }),
  ])]));
  const tb = el('tbody');
  for (const row of rows) {
    tb.appendChild(el('tr', {}, [
      el('th', { class: 'l wrap-cell', scope: 'row' }, [
        row.typeLabel,
        row.faabSpent ? el('span', { class: 'tag amber', style: 'margin-left:8px', text: `$${row.faabSpent} bid` }) : null,
        el('span', { class: 'sub', text: row.summary }),
        row.created ? el('span', { class: 'sub', text: new Date(row.created).toLocaleString() }) : null,
        el('span', { class: 'sub narrow-only', text: `Week ${row.week}` }),
      ].filter(Boolean)),
      el('td', { class: 'l wide', text: `Week ${row.week}` }),
      el('td', { class: `num ${row.netValue < 0 ? 'neg' : row.netValue > 0 ? 'pos' : ''}`, text: signed(row.netValue) }),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}
