// The broadcast scoreboard and "on the field now": the composed widgets that
// sit on top of live.js's polling and ui.js's render primitives. Both are
// used on home; the scoreboard alone repeats on the matchup view.

import { load } from './store.js';
import {
  el, n1, loading, gridiron, matchupCaption, recordText, playerBadge, playerTags,
} from './ui.js';
import { getLive, onLive, setLiveNumber, weekUnderway, gameChip } from './live.js';

/**
 * Two team panels, the drive-tracker field between them, and one sentence.
 * Live points and win probability come from /api/live when it is running;
 * with no live feed (or before this week's games start) it shows the report's
 * own projections, exactly as it always has. `href` makes the whole thing a
 * link to the full matchup (home); leave it out on the matchup view itself.
 */
export function broadcastScoreboard(report, { href = null } = {}) {
  const kicker = el('p', {
    class: 'kicker',
    text: `Week ${report.week}, your ${recordText(report.me.record)} against their ${recordText(report.them.record)}`,
  });

  const meTeam = el('div', { class: 'bc-team', text: report.me.teamName });
  const mePts = el('div', { class: 'bc-pts live-num' });
  const meProjNum = el('b', {});
  const meProj = el('div', { class: 'bc-proj' }, ['projected ', meProjNum]);

  const themTeam = el('div', { class: 'bc-team', text: report.them.teamName });
  const themPts = el('div', { class: 'bc-pts live-num' });
  const themProjNum = el('b', {});
  const themProj = el('div', { class: 'bc-proj' }, ['projected ', themProjNum]);

  // Built once; later polls patch --pos and the label text directly rather
  // than replacing the field, so the ball only ever moves from where it
  // already is (no re-kickoff-from-midfield on every 30-second poll).
  const fieldNode = gridiron(report.winProbability, { me: report.me.teamName, them: report.them.teamName, large: true });
  const turfEl = fieldNode.querySelector('.turf');
  const ballLabel = fieldNode.querySelector('.ball b');

  const caption = el('p', { class: 'bc-caption' });

  const board = el('div', { class: 'broadcast' }, [
    el('div', { class: 'bc-panel bc-me' }, [meTeam, mePts, meProj]),
    el('div', { class: 'bc-mid' }, [fieldNode]),
    el('div', { class: 'bc-panel bc-them' }, [themTeam, themPts, themProj]),
  ]);

  const wrap = el(href ? 'a' : 'div', href ? { class: 'broadcast-wrap', href } : { class: 'broadcast-wrap' }, [
    kicker, board, caption,
  ]);

  function apply(data) {
    const m = data?.matchup;
    const winProbability = m?.winProbability ?? report.winProbability;
    const pct = Math.round(winProbability * 100);

    let meVal;
    let themVal;
    let showProj = false;
    if (m) {
      if (weekUnderway(m)) {
        meVal = m.me.points; themVal = m.them.points;
        showProj = true;
      } else {
        meVal = m.me.projectedFinal; themVal = m.them.projectedFinal;
      }
    } else {
      meVal = report.projected.me; themVal = report.projected.them;
    }

    setLiveNumber(mePts, n1(meVal));
    setLiveNumber(themPts, n1(themVal));
    // Before kickoff the big number is the projection, so the line beneath is
    // just the word "projected" (no repeated number); once games start the big
    // number is live points and the line gives the projected finish.
    meProjNum.textContent = showProj ? n1(m.me.projectedFinal) : '';
    themProjNum.textContent = showProj ? n1(m.them.projectedFinal) : '';

    if (turfEl) turfEl.style.setProperty('--pos', `${Math.min(94, Math.max(6, pct))}%`);
    if (ballLabel) ballLabel.textContent = `${pct}%`;
    fieldNode.setAttribute('aria-label', `${pct}% chance to win. Midfield would be an even game.`);

    caption.textContent = m
      ? `You win ${pct} of every 100 simulations from here.`
      : matchupCaption(report);
  }

  apply(getLive());
  const unsub = onLive((data) => {
    if (!wrap.isConnected) { unsub(); return; } // the view moved on; stop listening
    apply(data);
  });

  return wrap;
}

/** Home's async placeholder: loads the matchup report, then swaps itself for
 * the scoreboard — the same shape `gameStrip()` used to have. */
export function scoreboardSlot({ href = null } = {}) {
  const slot = el('div', { class: 'broadcast-wrap is-pending' }, [loading('Simulating this week…')]);
  load('matchup').then(({ report: r }) => {
    slot.replaceWith(r.error
      ? el('div', { class: 'broadcast-wrap' }, [el('p', { class: 'kicker', text: r.error })])
      : broadcastScoreboard(r, { href }));
  }).catch((err) => {
    slot.replaceChildren(el('p', { class: 'kicker', text: `The matchup did not load. ${err.message}` }));
  });
  return slot;
}

// ---------------------------------------------------------------- on the field

/**
 * Your starters as rows: headshot, name, team stripe, a game chip and his
 * points. With a live feed running these are live points and the real game
 * clock; with none (or nothing live yet) it falls back to the lineup
 * report's projections, so the section still says something true.
 */
export function onFieldRows() {
  const body = el('div', { class: 'onfield-rows' }, [loading('Loading your lineup…')]);
  const section = el('section', { class: 'onfield', 'aria-label': 'On the field now' }, [
    el('h2', { text: 'On the field now' }),
    body,
  ]);

  let mode = null; // null (not built yet) | 'live' | 'fallback'
  let rows = [];
  let builtIds = ''; // the starters the live rows were built for
  let fallbackRequested = false;
  // False once live starters arrive, so a lineup report still in flight from
  // before the first poll cannot land on top of the live rows.
  let wantFallback = false;

  // Headshot and name, then an Out/Doubtful/Questionable tag when he has one.
  // Only the injury: the game chip already says "Bye" or "Started".
  const injuryTags = (p) => playerTags({ injury: p.injury });
  const who = (p, tags) => el('div', { class: 'of-who' }, [
    playerBadge(p, { meta: `${p.position} ${p.team}` }), tags,
  ]);

  const emptyRow = () => el('p', {
    class: 'section-note', style: 'padding: 14px 18px; margin: 0',
    text: 'Nobody is set to start this week yet.',
  });

  function buildFallback(report) {
    mode = 'fallback';
    body.textContent = '';
    rows = [];
    const starters = report.set.assignments.filter((a) => a.player);
    if (!starters.length) { body.appendChild(emptyRow()); return; }
    for (const a of starters) {
      const p = a.player;
      const chipText = p.locked ? 'Started' : (p.onBye ? 'Bye' : (p.opponent || 'Scheduled'));
      body.appendChild(el('div', { class: 'of-row' }, [
        who(p, el('span', { class: 'of-tags' }, injuryTags(p))),
        el('span', { class: `of-chip${p.locked ? ' is-live' : ''}`, text: chipText }),
        el('div', { class: 'of-pts' }, [el('b', { text: n1(a.points) }), el('small', { text: 'projected' })]),
      ]));
    }
  }

  // As on Sleeper and the matchup table: until the week's first kickoff the
  // number is his projection; from then on it is points scored (0.0 for
  // anyone yet to play) with the projection beneath.
  function showPoints(p, ptsNum, projSmall, underway) {
    setLiveNumber(ptsNum, n1(underway ? p.points : p.projected));
    projSmall.textContent = underway ? `proj ${n1(p.projected)}` : 'projected';
  }

  function buildLive(starters, underway) {
    mode = 'live';
    body.textContent = '';
    rows = [];
    if (!starters.length) { body.appendChild(emptyRow()); return; }
    for (const p of starters) {
      // Built with its number already in, so only a later change flashes.
      const ptsNum = el('b', { class: 'live-num', text: n1(underway ? p.points : p.projected) });
      const projSmall = el('small');
      showPoints(p, ptsNum, projSmall, underway);
      const chip = gameChip(p);
      const tags = el('span', { class: 'of-tags' }, injuryTags(p));
      body.appendChild(el('div', { class: 'of-row' }, [
        who(p, tags),
        chip,
        el('div', { class: 'of-pts' }, [ptsNum, projSmall]),
      ]));
      rows.push({ id: p.player_id, chip, ptsNum, projSmall, tags });
    }
  }

  function apply(data) {
    const starters = data?.matchup?.me?.starters;
    if (starters && starters.length) {
      wantFallback = false;
      const underway = weekUnderway(data.matchup);
      // Rebuild, not patch, when the lineup itself changed in Sleeper: a
      // benched player must leave the list and the new starter must appear.
      const ids = starters.map((p) => p.player_id).join();
      if (mode !== 'live' || ids !== builtIds) { buildLive(starters, underway); builtIds = ids; return; }
      const byId = new Map(starters.map((p) => [p.player_id, p]));
      for (const row of rows) {
        const p = byId.get(row.id);
        if (!p) continue;
        showPoints(p, row.ptsNum, row.projSmall, underway);
        row.chip.textContent = p.gameLabel || '';
        row.chip.classList.toggle('is-live', p.gameState === 'in');
        row.tags.replaceChildren(...injuryTags(p));
      }
      return;
    }
    // No live starters to show: fall back to the lineup report. Fetched at
    // most once — load()'s own cache keeps it fresh without asking again on
    // every 30-second poll.
    if (mode === 'live' || (mode === null && !fallbackRequested)) {
      fallbackRequested = true;
      wantFallback = true;
      load('lineup').then(({ report }) => {
        if (!section.isConnected || !wantFallback) return;
        if (!report.error) buildFallback(report);
      }).catch(() => {});
    }
  }

  apply(getLive());
  const unsub = onLive((data) => {
    if (!section.isConnected) { unsub(); return; }
    apply(data);
  });

  return section;
}
