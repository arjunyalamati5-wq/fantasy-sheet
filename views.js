import { machineBlock } from './whatifview.js';
import { state, load, post, clearCache, forget } from './store.js';
import {
  el, frag, figures, emptyState, callout, bar, n1, n2, pct0, signed,
  renderAsync, warningsBlock, playerTable, playerBadge, checkList,
  shortSlot, ownerNote,
} from './ui.js';
import { broadcastScoreboard } from './broadcast.js';
import { getLive, onLive, setLiveNumber, weekUnderway } from './live.js';
import { riseWords } from './motion.js';
import { rosterBlock, bestByNumbers } from './lockerroom.js';
import { claimBlock, risersBlock } from './waiverparts.js';
import { playoffPicture } from './playoffpicture.js';

/** A big rising title above a view, in the studio's voice. Returns the node to append. */
function heroTitle(text) {
  return riseWords(el('h2', { class: 'hero-title', text }));
}

/** Mount a view under its hero title; the body is what renderAsync fills. */
function mountWithHero(root, title) {
  root.textContent = '';
  root.appendChild(heroTitle(title));
  const body = el('div');
  root.appendChild(body);
  return body;
}

// ---------------------------------------------------------------- Lineup

const plural = (n, one, many) => (n === 1 ? one : many);

export function lineupView(root) {
  renderAsync(mountWithHero(root, 'The locker room'), load('lineup'), (data) => {
    const r = data.report;
    if (r.error) return emptyState('No roster yet', r.error);
    const lockedTotal = r.locked.starters + r.locked.bench;
    return frag([
      warningsBlock(),
      lineupFigures(r),
      // Alerts end with their own "check before kickoff"; the heading says it once.
      checkList('Check before kickoff',
        r.alerts.map((a) => a.message.replace(/\s*Check before kickoff\.?$/, ''))),
      el('h3', { class: 'sub-title', text: 'Changes worth making' }),
      lockedTotal > 0 ? el('p', { class: 'section-note', text: lockedNote(r.locked) }) : null,
      r.swaps.length ? movesList(r.swaps) : noSwapsState(r),
      el('h3', { class: 'sub-title', text: 'Your best lineup' }),
      playerTable({ rows: lineupRows(r), caption: 'Your best lineup, then your bench' }),
      rosterBlock(r),
      bestByNumbers(r),
    ]);
  });
}

/** Kickoff has already frozen part of the roster; say so before the manager
 * wonders why an obvious-looking swap isn't listed below. */
function lockedNote(locked) {
  const parts = [];
  if (locked.starters) parts.push(`${locked.starters} of your starters`);
  if (locked.bench) parts.push(`${locked.bench} bench ${plural(locked.bench, 'player', 'players')}`);
  // "Kicked off" is what the lock actually tracks (his game has started);
  // "playing" would still read as true of a game that finished hours ago.
  const has = locked.starters + locked.bench === 1 ? 'has' : 'have';
  return `${parts.join(' and ')} ${has} already kicked off, `
    + 'so the changes below only use players whose games have not started.';
}

/** No swap can mean two different things: the lineup really is the best one
 * possible, or kickoff has locked away the only players who could improve it. */
function noSwapsState(r) {
  // "Nothing left" only when kickoff actually ruled out a better lineup.
  if (!r.blockedByLocks) {
    return emptyState('Nothing to change',
      'You are already starting the highest-projecting legal lineup. Check back after injury news breaks.');
  }
  return emptyState('Nothing left to change',
    'Among everyone whose game has not started yet, you are already starting the highest-projecting legal lineup. '
    + 'Anyone who might have improved it further has already kicked off.');
}

function lineupFigures(r) {
  const gap = r.pointsLeftOnBench;
  return figures([
    { value: n1(r.optimal.total), label: 'Your best lineup', sublabel: 'projected points this week' },
    { value: n1(r.set.total), label: 'The lineup you have set' },
    gap > 0.05
      ? { value: signed(gap), label: 'Left on your bench', sublabel: 'make the changes below', tone: 'warn' }
      : { value: '0.0', label: 'Left on your bench', sublabel: 'your best lineup is set', tone: 'good' },
  ]);
}

/**
 * The gain as the reason sentence states it: both projections rounded the way
 * they are printed, so a card never says +0.0 beside "0.1 more points".
 */
function shownGain(s) {
  const r1 = (n) => Math.round((n ?? 0) * 10) / 10;
  const gap = r1(s.startInstead.projected) - r1(s.bench?.projected);
  // Rounding both numbers separately, as the card prints them, can flip a
  // tiny raw gain negative; keep that sign (a real, if small, loss) instead
  // of always reading it as a positive rounding artifact.
  if (Math.abs(gap) < 0.05) return gap < 0 ? '-<0.1' : '+<0.1';
  return signed(gap);
}

/** Each suggested change as a sentence: start this player here, instead of that one. */
function movesList(swaps) {
  return el('div', { class: 'moves' }, swaps.map((s) => {
    const say = el('div', { class: 'say' }, [
      'Start ', el('strong', { text: s.startInstead.name }),
      ' at ', el('span', { class: 'slotname', text: shortSlot(s.slot) }),
    ]);
    say.append(s.bench ? ` instead of ${s.bench.name}` : ' in the empty slot');
    const gain = shownGain(s);
    return el('div', { class: 'move' }, [
      say,
      el('div', { class: `gain${gain.startsWith('-') ? ' neg' : ''}` }, [gain, el('small', { text: 'pts' })]),
      el('ul', {}, s.reasons.map((x) => el('li', { text: x }))),
    ]);
  }));
}

/** Starters then bench in one table, so every column lines up the whole way down. */
function lineupRows(r) {
  const setIds = new Set(r.set.assignments.map((a) => a.player?.player_id).filter(Boolean));
  const optimalIds = new Set(r.optimal.assignments.map((a) => a.player?.player_id).filter(Boolean));
  const rows = r.optimal.assignments.map((a) => {
    const promote = a.player && !setIds.has(a.player.player_id);
    return {
      slot: a.slot,
      player: a.player,
      value: n1(a.points),
      className: promote ? 'is-move' : null,
      note: promote ? 'On your bench right now' : null,
      emptyText: 'Nobody on your roster can legally fill this slot',
    };
  });
  if (!r.bench.length) return rows;
  rows.push({ group: 'Bench' });
  for (const p of r.bench) {
    const demote = setIds.has(p.player_id) && !optimalIds.has(p.player_id);
    rows.push({
      slot: p.position,
      player: p,
      value: n1(p.projected),
      className: demote ? 'is-drop' : null,
      note: demote ? 'In your lineup right now' : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- Matchup

export function matchupView(root) {
  renderAsync(root, load('matchup'), (data) => {
    const r = data.report;
    if (r.error) return emptyState('No matchup this week', r.error);

    const benchNotes = [r.me, r.them]
      .filter((side) => side.pointsLeftOnBench > 0.5)
      .map((side) => `${side.teamName} has ${n1(side.pointsLeftOnBench)} points left on the bench.`);

    return frag([
      warningsBlock(),
      broadcastScoreboard(r),
      r.swings.length ? swingsBlock(r.swings) : null,
      el('h3', { class: 'sub-title', text: 'Starters, head to head' }),
      headToHead(r),
      benchNotes.length ? el('p', { class: 'section-note', text: benchNotes.join(' ') }) : null,
      el('h3', { class: 'sub-title', text: 'How the week could go' }),
      el('p', {
        class: 'section-note',
        text: `From ${r.runs.toLocaleString()} simulated weeks. A bad week is a score you fall below 1 time in 10; a good week, one you beat 1 time in 10.`,
      }),
      rangeTable(r),
    ]);
  });
}

function swingsBlock(swings) {
  return frag([
    el('h3', { class: 'sub-title', text: 'Who this week hinges on' }),
    el('p', {
      class: 'section-note',
      text: 'How far your chance of winning falls if each player is swapped for a typical free agent.',
    }),
    playerTable({
      rows: swings.map((p) => ({ slot: p.position, player: p, value: `${Math.round(p.swing * 100)}%` })),
      stats: ['opp', 'avg', 'snap'],
      valueHead: 'At stake',
    }),
  ]);
}

/** Bad, typical and good weeks for both teams, and the margin between them. */
function rangeTable(r) {
  const line = (label, cells, cls = '') => el('tr', { class: cls }, [
    el('th', { class: 'l', scope: 'row', text: label }),
    ...cells,
  ]);
  const scores = (v) => ['floor', 'median', 'ceiling'].map((k) => el('td', { class: 'num', text: n1(v[k]) }));
  const margins = ['floor', 'median', 'ceiling'].map((k) => el('td', {
    class: `num ${r.margin[k] < 0 ? 'neg' : ''}`, text: signed(r.margin[k]),
  }));

  const t = el('table', { class: 'sheet' }, [
    el('thead', {}, [el('tr', {}, [
      el('td', {}),
      el('th', { scope: 'col', text: 'Bad week' }),
      el('th', { scope: 'col', text: 'Typical' }),
      el('th', { scope: 'col', text: 'Good week' }),
    ])]),
    el('tbody', {}, [
      line(r.me.teamName, scores(r.scores.me), 'mine'),
      line(r.them.teamName, scores(r.scores.them)),
      line('Your margin', margins),
    ]),
  ]);
  return el('div', { class: 'table-scroll' }, [t]);
}

/** Both starting lineups on one table, slot against slot. */
function headToHead(r) {
  const t = el('table', { class: 'roster h2h' });
  t.appendChild(el('caption', { class: 'visually-hidden', text: `${r.me.teamName} against ${r.them.teamName}, slot by slot` }));
  const meHead = el('th', { class: 'pcol', scope: 'col', 'aria-label': `${r.me.teamName} projected`, text: 'Proj' });
  const themHead = el('th', { class: 'l pcol', scope: 'col', 'aria-label': `${r.them.teamName} projected`, text: 'Proj' });
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l side', scope: 'col', text: r.me.teamName }),
    meHead,
    el('th', { class: 'slot', scope: 'col', text: 'Slot' }),
    themHead,
    el('th', { class: 'them side', scope: 'col', text: r.them.teamName }),
  ])]));

  const side = (p, cls) => el('td', { class: `player ${cls}` }, p
    ? [playerBadge(p, { meta: `${p.position} ${p.team}` }), el('span', { class: 'psub', text: p.opponent || (p.onBye ? 'Bye' : '') })]
    : [el('span', { class: 'pname', text: 'Nobody set' })]);

  const tb = el('tbody');
  const liveRows = [];
  const n = Math.max(r.me.starters.length, r.them.starters.length);
  for (let i = 0; i < n; i++) {
    const a = r.me.starters[i];
    const b = r.them.starters[i];
    const pa = a?.projected ?? 0;
    const pb = b?.projected ?? 0;
    const meNum = el('span', { class: 'live-num', text: n1(pa) });
    const themNum = el('span', { class: 'live-num', text: n1(pb) });
    const meChipSlot = el('small');
    const themChipSlot = el('small');
    tb.appendChild(el('tr', {}, [
      side(a, 'me'),
      el('td', { class: `big ${pa < pb ? 'lean' : ''}` }, [meNum, meChipSlot]),
      el('th', { class: 'slot', scope: 'row', text: shortSlot(a?.slot || b?.slot) }),
      el('td', { class: `big l ${pb < pa ? 'lean' : ''}` }, [themNum, themChipSlot]),
      side(b, 'them'),
    ]));
    if (a) liveRows.push({ id: a.player_id, side: 'me', proj: pa, num: meNum, chip: meChipSlot });
    if (b) liveRows.push({ id: b.player_id, side: 'them', proj: pb, num: themNum, chip: themChipSlot });
  }
  t.appendChild(tb);
  const meTotal = el('span', { class: 'live-num', text: n1(r.projected.me) });
  const themTotal = el('span', { class: 'live-num', text: n1(r.projected.them) });
  t.appendChild(el('tfoot', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'row', text: 'Total' }),
    el('td', { class: 'big' }, [meTotal]),
    el('td', {}),
    el('td', { class: 'big l' }, [themTotal]),
    el('td', {}),
  ])]));
  const box = el('div', { class: 'table-scroll' }, [t]);
  liveAugmentHeadToHead(box, liveRows, {
    r, heads: [meHead, themHead], totals: { me: meTotal, them: themTotal, proj: r.projected },
  });
  return box;
}

/** Live points and a game chip per starter, patched in place on every poll
 * instead of redrawing the table (which would drop keyboard focus and
 * re-trigger the scrolling region's own focus/label logic for no reason). */
// The live lineups the matchup table was last refetched for. Module-wide, not
// per table: a redrawn table must not refetch again for the same lineups, or a
// lineup the report can never match (a player it does not know) would refetch
// on every poll.
let h2hRefreshedFor = null;

function liveAugmentHeadToHead(box, rows, { r, heads, totals }) {
  const idsOf = (list) => list.map((x) => x.id ?? x.player_id).sort().join();
  const tableIds = { me: idsOf(rows.filter((x) => x.side === 'me')), them: idsOf(rows.filter((x) => x.side === 'them')) };

  function showProjections() {
    heads[0].textContent = heads[1].textContent = 'Proj';
    heads[0].setAttribute('aria-label', `${r.me.teamName} projected`);
    heads[1].setAttribute('aria-label', `${r.them.teamName} projected`);
    setLiveNumber(totals.me, n1(totals.proj.me));
    setLiveNumber(totals.them, n1(totals.proj.them));
    for (const row of rows) { setLiveNumber(row.num, n1(row.proj)); row.chip.textContent = ''; }
  }

  function apply(data) {
    const m = data?.matchup;
    // No live feed (or it failed mid-game): back to the report's projections,
    // the same fallback the scoreboard above makes, so the two never disagree.
    if (!m) { showProjections(); return; }
    // A lineup changed in Sleeper since this table was built: its rows are the
    // wrong players, so fetch the matchup again and redraw it (once per change).
    const liveIds = `${idsOf(m.me.starters || [])}/${idsOf(m.them.starters || [])}`;
    if (liveIds !== `${tableIds.me}/${tableIds.them}` && h2hRefreshedFor !== liveIds) {
      h2hRefreshedFor = liveIds;
      forget('matchup');
      load('matchup').then(({ report }) => {
        if (box.isConnected && !report.error) box.replaceWith(headToHead(report));
      }).catch(() => {});
    }
    const all = [...(m.me.starters || []), ...(m.them.starters || [])];
    const byId = new Map(all.map((p) => [p.player_id, p]));
    // As on Sleeper: until the week's first kickoff the columns are
    // projections; from then on they are points scored, 0.0 for anyone yet
    // to play, with each player's projection beside his game.
    const underway = weekUnderway(m);
    heads[0].textContent = heads[1].textContent = underway ? 'Pts' : 'Proj';
    heads[0].setAttribute('aria-label', `${r.me.teamName} ${underway ? 'points' : 'projected'}`);
    heads[1].setAttribute('aria-label', `${r.them.teamName} ${underway ? 'points' : 'projected'}`);
    setLiveNumber(totals.me, n1(underway ? m.me.points : totals.proj.me));
    setLiveNumber(totals.them, n1(underway ? m.them.points : totals.proj.them));
    for (const row of rows) {
      const p = byId.get(row.id);
      if (!p) continue;
      setLiveNumber(row.num, n1(underway ? p.points : row.proj));
      // A bye (gameState null, label "Bye") has no projection to show.
      row.chip.textContent = underway && p.gameState != null
        ? `proj ${n1(p.projected)}, ${p.gameLabel}`
        : p.gameLabel;
    }
  }
  apply(getLive());
  const unsub = onLive((data) => {
    if (!box.isConnected) { unsub(); return; }
    apply(data);
  });
}

// ---------------------------------------------------------------- Exposure

export function exposureView(root) {
  renderAsync(root, load('exposure'), (data) => {
    const r = data.report;
    if (r.error) return emptyState('No roster yet', r.error);

    if (!r.rows.length) {
      return frag([
        warningsBlock(),
        el('p', { class: 'section-note', text: r.note }),
        emptyState('Nothing to show yet',
          'This view needs a full starting lineup. Set your lineup in Sleeper and come back.'),
      ]);
    }

    const top = r.rows[0];
    return frag([
      warningsBlock(),
      el('p', { class: 'section-note', text: r.note }),
      figures([
        { value: n1(top.lineupCost), label: 'Most exposed to', sublabel: top.name, tone: 'warn' },
        { value: String(r.rows.filter((p) => p.lineupCost >= 2).length), label: 'Starters who would cost you 2+ points if they sat' },
      ]),
      playerTable({
        rows: r.rows.map((p, i) => ({
          slot: p.position, player: p, value: n1(p.lineupCost), note: p.note,
          tone: i < 2 ? 'neg' : '',
        })),
        stats: ['opp', 'total', 'avg', 'snap', 'tgt'],
        valueHead: 'Lost if he sits',
        caption: 'Your starters, ranked by how much you would lose without each one',
      }),
    ]);
  });
}

// ---------------------------------------------------------------- Buy / Sell

export function marketView(root) {
  renderAsync(root, load('market'), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);

    out.appendChild(el('p', { class: 'section-note', text: 'Comparing how much a player is used against how much he has scored. "Used more than" and "Scored more than" place him among players at his position: 85% means ahead of 85 in 100. Heavy usage with thin scoring usually corrects upward. Light usage with fat scoring usually corrects downward.' }));

    if (r.emptyMessage) {
      out.appendChild(emptyState('Not enough games yet', r.emptyMessage));
      return out;
    }

    const section = (title, note, rows, kind) => {
      out.appendChild(el('h3', { class: 'sub-title', text: title }));
      if (!rows.length) {
        out.appendChild(emptyState('Nothing here this week',
          kind === 'buy'
            ? 'No player on another roster is being used much more than he is scoring. Look again after next week\'s games.'
            : 'None of your players is scoring more than his usage supports. Nothing to sell high on right now.'));
        return;
      }
      out.appendChild(el('p', { class: 'section-note', text: note }));
      out.appendChild(playerTable({
        rows: rows.map((p) => ({
          slot: p.position, player: p,
          value: `${p.divergence > 0 ? '+' : ''}${Math.round(p.divergence * 100)}`,
          tone: p.divergence > 0 ? 'pos' : 'neg',
          note: ownerNote(p),
        })),
        stats: ['opp', 'total', 'avg', 'snap', 'tgt', 'usagePct', 'scorePct'],
        valueHead: 'Usage minus scoring rank',
        caption: `${title}, ranked by how far usage and scoring have pulled apart`,
      }));
    };

    // Every row used to repeat this same explanation with only the numbers
    // swapped; the numbers now live in the table's own columns (snaps,
    // targets, average, usage rank, scoring rank), so the mechanism only
    // needs saying once, here, not on every one of thirty-odd rows.
    section('Buy low',
      'On other rosters: doing the snap and target work below without the scoring to match yet, so the points may catch up. Ask about these before they do.',
      r.buyTargets, 'buy');
    section('Sell high',
      'On your roster: scoring more than the snap and target work below usually supports, so the points may correct down. Move them while the number still looks good.',
      r.sellCandidates, 'sell');
    return out;
  });
}

// ---------------------------------------------------------------- Waivers

export function waiversView(root) {
  const out = mountWithHero(root, 'The waiver wire');

  renderAsync(out, Promise.all([load('waivers'), load('streaming')]), ([wData, sData]) => {
    const w = wData.report;
    const s = sData.report;
    const box = frag([warningsBlock()]);

    if (w.faab) {
      box.appendChild(figures([
        { value: `$${w.faab.remaining.toLocaleString()}`, label: 'FAAB left to spend', sublabel: `of $${w.faab.budget.toLocaleString()} to start the season` },
        { value: String(w.faab.claims), label: 'Waiver claims processed so far this season' },
      ]));
    }

    box.appendChild(el('h3', { class: 'sub-title', text: 'What your lineup needs most' }));
    box.appendChild(needsTable(w.positionNeeds));

    if (w.emptyMessage) {
      box.appendChild(el('h3', { class: 'sub-title', text: 'Trending adds who are free in your league' }));
      // A dead feed and a genuinely quiet waiver wire read as the same
      // "nothing here" otherwise; trendingAvailable tells them apart, so the
      // title says which one this is (the message itself already does too).
      box.appendChild(w.trendingAvailable === false
        ? emptyState('The trending feed is unavailable', w.emptyMessage)
        : emptyState('Nobody available', w.emptyMessage));
    } else {
      box.appendChild(claimBlock(w));
    }
    const risers = risersBlock(w.risers);
    if (risers) box.appendChild(risers);

    box.appendChild(el('h2', { class: 'section-title', style: 'margin-top:40px', text: 'Streaming this week' }));
    box.appendChild(el('p', { class: 'section-note', text: s.note }));
    for (const pos of ['DEF', 'K', 'QB', 'TE']) {
      const g = s.groups[pos];
      if (!g) continue;
      box.appendChild(el('h3', { class: 'sub-title', text: `Best free ${g.label}` }));
      if (g.emptyMessage) { box.appendChild(emptyState('None available', g.emptyMessage)); continue; }
      box.appendChild(playerTable({
        rows: g.rows.map((p) => ({ slot: p.position, player: p, value: n1(p.projected), note: p.context })),
        stats: ['opp', 'total', 'avg', 'snap', 'tgt'],
        valueHead: 'Projected this week',
        caption: `Best free ${g.label} this week`,
      }));
    }
    return box;
  });
}

/** What your lineup needs, position by position — the top of a claim sheet. */
function needsTable(needs) {
  const t = el('table', { class: 'sheet' });
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Position' }),
    el('th', { scope: 'col', text: 'You carry' }),
    el('th', { scope: 'col', text: 'A free agent would add' }),
  ])]));
  const tb = el('tbody');
  for (const need of needs) {
    const short = need.gain > 0.1;
    tb.appendChild(el('tr', {}, [
      el('th', { class: 'l', scope: 'row', text: need.position }),
      el('td', { class: 'num', text: String(need.count) }),
      el('td', { class: `num ${short ? 'pos' : ''}`, text: short ? signed(need.gain) : 'Covered' }),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

// ---------------------------------------------------------------- Season

export function seasonView(root) {
  renderAsync(mountWithHero(root, 'The playoff picture'), load('season'), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);
    // A finished season still has a final table; it just has nothing left to simulate.
    if (r.emptyMessage) out.appendChild(emptyState('Season complete', r.emptyMessage));
    out.appendChild(playoffPicture(r));
    out.appendChild(machineBlock(r.machine));
    return out;
  });
}

// ---------------------------------------------------------------- League

export function leagueView(root) {
  renderAsync(root, Promise.all([load('power'), load('efficiency')]), ([pData, eData]) => {
    const power = pData.report;
    const eff = eData.report;
    const out = frag([warningsBlock()]);

    out.appendChild(el('h3', { class: 'sub-title', text: 'Power rankings' }));
    out.appendChild(el('p', { class: 'section-note', text: power.note }));

    const t1 = el('table', { class: 'sheet' });
    t1.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Team' }),
      el('th', { class: 'wide', scope: 'col', text: 'Record' }),
      el('th', { class: 'wide', scope: 'col', text: 'Points so far' }),
      el('th', { class: 'wide', scope: 'col', text: 'Best lineup worth' }),
      el('th', { class: 'l wide', scope: 'col', text: 'Carried by' }),
      el('th', { scope: 'col', text: 'Above replacement' }),
    ])]));
    const tb1 = el('tbody');
    for (const r of power.rows) {
      tb1.appendChild(el('tr', { class: r.isMine ? 'mine' : '' }, [
        el('th', { class: 'l', scope: 'row' }, [
          el('span', { class: 'rank-badge', text: `#${r.rank}` }), r.teamName,
          el('span', { class: 'sub narrow-only', text: `${r.record}, ${n1(r.pointsFor)} points so far, best lineup worth ${n1(r.lineupValue)}. Carried by ${r.best.map((b) => `${b.name} (${b.position})`).join(', ')}.` }),
        ]),
        el('td', { class: 'wide', text: r.record }),
        el('td', { class: 'num wide', text: n1(r.pointsFor) }),
        el('td', { class: 'num wide', text: n1(r.lineupValue) }),
        el('td', { class: 'l wide', text: r.best.map((b) => `${b.name} (${b.position})`).join(', ') }),
        el('td', { class: 'num', text: n1(r.vor) }),
      ]));
    }
    t1.appendChild(tb1);
    out.appendChild(el('div', { class: 'table-scroll' }, [t1]));

    out.appendChild(el('h3', { class: 'sub-title', text: 'Points left on the bench' }));
    if (eff.emptyMessage) {
      out.appendChild(emptyState('No results yet', eff.emptyMessage));
      return out;
    }
    out.appendChild(el('p', { class: 'section-note', text: `Across ${eff.weeksCounted} completed week${eff.weeksCounted === 1 ? '' : 's'}: how many points each manager left sitting on their bench by not starting their best available lineup.` }));

    const t2 = el('table', { class: 'sheet' });
    t2.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Manager' }),
      el('th', { class: 'wide', scope: 'col', text: 'Points scored' }),
      el('th', { class: 'wide', scope: 'col', text: 'Best possible' }),
      el('th', { scope: 'col', text: 'Left on bench' }),
      el('th', { class: 'wide', scope: 'col', text: 'Per week' }),
      el('th', { scope: 'col', text: 'Started their best' }),
    ])]));
    const tb2 = el('tbody');
    for (const r of eff.rows) {
      tb2.appendChild(el('tr', { class: r.isMine ? 'mine' : '' }, [
        el('th', { class: 'l', scope: 'row' }, [
          r.teamName,
          el('span', { class: 'sub narrow-only', text: `${n1(r.actual)} scored of ${n1(r.optimal)} possible, ${n1(r.perWeekLeftOnBench)} a week left on the bench` }),
        ]),
        el('td', { class: 'num wide', text: n1(r.actual) }),
        el('td', { class: 'num wide', text: n1(r.optimal) }),
        el('td', { class: `num ${r.pointsLeftOnBench > 0 ? 'neg' : ''}`, text: n1(r.pointsLeftOnBench) }),
        el('td', { class: 'num wide', text: n1(r.perWeekLeftOnBench) }),
        el('td', {}, [
          el('div', { class: 'num', text: pct0(r.efficiency) }),
          el('div', { style: 'margin-top:4px' }, [bar(r.efficiency ?? 0)]),
        ]),
      ]));
    }
    t2.appendChild(tb2);
    out.appendChild(el('div', { class: 'table-scroll' }, [t2]));
    return out;
  });
}
