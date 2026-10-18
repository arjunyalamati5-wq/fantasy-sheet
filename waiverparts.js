// The waiver wire: free agents ranked by what they add to your lineup over
// the stretch you choose, and the players whose roles are growing.

import { whatIfButton } from './whatifview.js';
import { el, n1, signed, pct0, emptyState, playerName } from './ui.js';
import { segmented, block, gradeTag, liftText } from './seg.js';

// The server's own words for a bench-only claim start with the exact clause
// the group heading already says; say it once, not twice.
const CRACK_LINEUP_PREFIX = /^He would not crack your lineup yet, but /i;
// Sentences of a bid's text that the Bid column or the budget figure already
// say. A rule-of-thumb bid keeps its own "bid about $X (Y% of the budget)".
const BID_REPEATS = /\bbid about \$|^Bid \$|^You have \$[\d,]+ left\.$/i;
const RULE_REPEATS = /^You have \$[\d,]+ left\.$/i;

/** Split into sentences without a lookbehind (Safari < 16.4 throws on `(?<=`). */
function splitSentences(text) {
  const parts = text.split('. ');
  return parts.map((s, i) => (i < parts.length - 1 ? `${s}.` : s));
}

/** The one-line note under a claim: why him, how many added him, what the bid costs. */
export function claimNote(p, wouldStart, faabActive) {
  let note = p.reason;
  if (!wouldStart && CRACK_LINEUP_PREFIX.test(note)) {
    note = note.replace(CRACK_LINEUP_PREFIX, '').replace(/^./, (c) => c.toUpperCase());
  }
  if (faabActive && p.bid) {
    const priced = p.bid.basis === 'none' ? [p.bid.text]
      : splitSentences(p.bid.text).filter((s) => !(p.bid.basis === 'rule' ? RULE_REPEATS : BID_REPEATS).test(s));
    note = `${note} ${priced.join(' ')}`;
  }
  return note;
}

const playoffWord = (g) => (g === 'avg' ? 'average' : g);

const weeksText = (weeks) => {
  if (!weeks.length) return 'no weeks left';
  return weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks[0]} to ${weeks[weeks.length - 1]}`;
};

/** The claim sheet with its horizon toggle. */
export function claimBlock(w) {
  const faab = Boolean(w.faab);
  let horizon = 'next';
  const holder = el('div', { class: 'claims' });
  const info = el('p', { class: 'sp-note', 'aria-live': 'polite' });

  function draw() {
    const meta = w.horizons.find((h) => h.id === horizon);
    info.textContent = `Lineup lift is how many more points your best lineup scores with him added, summed over ${weeksText(meta.weeks)}. Starts is the weeks he would be in that lineup. Playoff weeks grades the opponents his team faces when your league plays its playoffs.`;
    const ranked = [...w.rows].sort((a, b) =>
      b.horizons[horizon].lift - a.horizons[horizon].lift || b.addsLast48h - a.addsLast48h);
    const helps = ranked.filter((p) => p.horizons[horizon].lift > 0.05);
    const rest = ranked.filter((p) => p.horizons[horizon].lift <= 0.05);

    const t = el('table', { class: 'sheet claim-sheet' });
    t.appendChild(el('caption', { class: 'visually-hidden', text: `Free agents trending up, ranked by lineup lift over ${weeksText(meta.weeks)}` }));
    t.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Player' }),
      el('th', { scope: 'col', text: 'Lineup lift' }),
      el('th', { scope: 'col', text: 'Starts' }),
      el('th', { class: 'wide', scope: 'col', text: 'Ceiling' }),
      el('th', { class: 'l wide', scope: 'col', text: 'Next matchup' }),
      el('th', { class: 'l wide', scope: 'col', text: 'Playoff weeks' }),
      el('th', { class: 'wide', scope: 'col', text: 'Adds in 48 hours' }),
      el('th', { class: 'l wide', scope: 'col', text: 'Drop' }),
      faab ? el('th', { scope: 'col', text: 'Bid' }) : null,
    ])]));

    const cols = faab ? 9 : 8;
    const row = (p, starts) => {
      const h = p.horizons[horizon];
      const dropText = p.drop ? `${p.drop.name} (${p.drop.position})` : '';
      const phone = [
        p.ceiling > 0 ? `ceiling ${n1(p.ceiling)}` : null,
        p.playoffs?.label ? `playoff weeks ${playoffWord(p.playoffs.label)}` : null,
        p.matchup ? `next ${p.matchup.opponent}${p.matchup.grade ? `, ${p.matchup.grade === 'avg' ? 'average' : p.matchup.grade} matchup` : ''}` : null,
        `${p.addsLast48h.toLocaleString()} adds in 48 hours`,
        dropText ? `drop ${dropText}` : null,
      ].filter(Boolean).join(', ');
      return el('tr', { class: starts ? 'is-move' : '' }, [
        el('th', { class: 'l player', scope: 'row' }, [
          playerName(p),
          el('span', { class: 'psub', text: claimNote(p, p.wouldStart, faab) }),
          el('span', { class: 'psub narrow-only', text: phone.charAt(0).toUpperCase() + phone.slice(1) }),
          p.player_id ? whatIfButton([`a.${p.player_id}`, ...(p.drop?.player_id ? [`d.${p.drop.player_id}`] : [])], 'Try in the lab', { ariaLabel: `Try adding ${p.name} in the what-if lab` }) : null,
        ]),
        el('td', { class: `num ${starts ? 'pos' : ''}`, text: liftText(h.lift) }),
        el('td', { class: 'num', 'aria-label': `${h.starts} of ${h.weeks} weeks`, text: h.weeks ? `${h.starts}/${h.weeks}` : '—' }),
        el('td', { class: 'num wide', text: p.ceiling > 0 ? n1(p.ceiling) : '—' }),
        el('td', { class: 'l wide' }, p.matchup ? [p.matchup.opponent, ' ', gradeTag(p.matchup.grade)] : ['—']),
        el('td', { class: 'l wide', title: p.playoffs?.summary || '' }, p.playoffs?.label
          ? [gradeTag(p.playoffs.label), el('span', { class: 'sub', text: `weeks ${p.playoffs.weeks[0].week}–${p.playoffs.weeks[p.playoffs.weeks.length - 1].week}` })]
          : ['—']),
        el('td', { class: 'num wide', text: p.addsLast48h.toLocaleString() }),
        el('td', { class: 'l wide', text: dropText || (w.rosterFull ? '—' : 'Open roster spot') }),
        faab ? el('td', { class: 'num', text: p.bid?.suggested != null ? `$${p.bid.suggested.toLocaleString()}` : '' }) : null,
      ]);
    };

    const tbHelps = el('tbody', {}, helps.map((p) => row(p, true)));
    t.appendChild(tbHelps);
    if (rest.length) {
      t.appendChild(el('tbody', {}, [
        el('tr', { class: 'group' }, [el('th', { colspan: cols, scope: 'rowgroup', text: meta.weeks.length ? 'Would not crack your lineup in this stretch' : 'Nothing to measure in this stretch' })]),
        ...rest.map((p) => row(p, false)),
      ]));
    }
    holder.replaceChildren(
      !meta.weeks.length
        ? emptyState('No weeks left here', 'That stretch of the season has already been played. Pick another.')
        : el('div', { class: 'table-scroll' }, [t]),
    );
  }

  const tabs = segmented({
    label: 'Stretch of the season',
    options: w.horizons.map((h) => ({ id: h.id, label: h.label })),
    value: horizon,
    onChange: (id) => { horizon = id; draw(); },
  });
  draw();
  return block({ band: 'waivers', id: 'claim-sheet', title: 'Trending adds who are free in your league' }, [tabs, info, holder]);
}

const sp = (v) => (v == null ? '—' : pct0(v));
const pp = (d) => (d == null ? '' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(Math.round(d * 100))} pts`);

/** Role changes: the last two weeks against the weeks before, snaps and targets. */
export function risersBlock(risers) {
  if (!risers) return null;
  if (!risers.available) {
    return block({ band: 'research', id: 'risers', title: 'Usage risers' }, [emptyState('Not available yet', risers.message || 'There is no usage data to compare yet.')]);
  }
  let scope = 'free';
  const holder = el('div');
  const last = risers.weeks.recent;
  const noteText = `Snap share and target share over weeks ${last.join(' and ')}, against the weeks before. The sample column is how many games sit on each side.`;

  function draw() {
    const list = risers[scope];
    if (!list.length) {
      holder.replaceChildren(emptyState('Nobody is rising', scope === 'free'
        ? 'No free agent has seen a real jump in snaps or targets over the last two weeks.'
        : 'Nobody has seen a real jump in snaps or targets over the last two weeks.'));
      return;
    }
    const t = el('table', { class: 'sheet' });
    t.appendChild(el('caption', { class: 'visually-hidden', text: `Players whose snap or target share rose over weeks ${last.join(' and ')}` }));
    t.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Player' }),
      el('th', { scope: 'col', text: 'Snap share' }),
      el('th', { class: 'wide', scope: 'col', text: 'Target share' }),
      el('th', { class: 'wide', scope: 'col', text: 'Points per game' }),
      el('th', { class: 'wide', scope: 'col', text: 'Sample' }),
    ])]));
    const tb = el('tbody');
    for (const p of list) {
      const sample = `${p.sample.recent} against ${p.sample.before} games`;
      const phone = [
        p.target.now != null ? `targets ${sp(p.target.now)} from ${sp(p.target.before)}` : null,
        p.points.change != null ? `${signed(p.points.change)} points a game` : null,
        sample,
        scope === 'all' ? (p.isFreeAgent ? 'free agent' : (p.ownedBy ? `on ${p.ownedBy}` : null)) : null,
      ].filter(Boolean).join(', ');
      tb.appendChild(el('tr', {}, [
        el('th', { class: 'l player', scope: 'row' }, [
          playerName(p),
          scope === 'all' ? el('span', { class: 'psub', text: p.isFreeAgent ? 'A free agent.' : (p.ownedBy ? `Owned by ${p.ownedBy}.` : '') }) : null,
          el('span', { class: 'psub narrow-only', text: phone.charAt(0).toUpperCase() + phone.slice(1) }),
        ]),
        el('td', { class: 'num' }, [
          sp(p.snap.now),
          el('span', { class: 'sub', text: p.snap.delta != null ? `${pp(p.snap.delta)} from ${sp(p.snap.before)}` : '' }),
        ]),
        el('td', { class: 'num wide' }, [
          p.target.now != null ? sp(p.target.now) : '—',
          el('span', { class: 'sub', text: p.target.delta != null ? `${pp(p.target.delta)} from ${sp(p.target.before)}` : '' }),
        ]),
        el('td', { class: `num wide ${p.points.change > 0 ? 'pos' : p.points.change < 0 ? 'neg' : ''}` }, [
          p.points.now != null ? n1(p.points.now) : '—',
          el('span', { class: 'sub', text: p.points.change != null ? `${signed(p.points.change)} from ${n1(p.points.before)}` : '' }),
        ]),
        el('td', { class: 'num wide', text: sample }),
      ]));
    }
    t.appendChild(tb);
    holder.replaceChildren(el('div', { class: 'table-scroll' }, [t]));
  }

  const tabs = segmented({
    label: 'Which players',
    options: [{ id: 'free', label: 'Free agents' }, { id: 'all', label: 'All players' }],
    value: scope,
    onChange: (id) => { scope = id; draw(); },
  });
  draw();
  return block({ band: 'research', id: 'risers', title: 'Usage risers', note: noteText }, [tabs, holder]);
}
