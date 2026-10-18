// Live scores: polls GET /api/live on the contract in prime-time-spec.md §1,
// pauses while the tab is hidden, and hands every subscriber the same
// payload (or null, on a 404/failure — the score bug and every broadcast
// widget then just hide their live parts and fall back to projections).

import { api } from './store.js';
import { el, n1 } from './ui.js';

const DEFAULT_INTERVAL = 30_000;

let payload = null;      // last successful /api/live response, or null
let timer = null;
let usingStub = false;
const listeners = new Set();

/** A contract-shaped fixture for local testing (?stublive=1 only — never
 * reached by a real visitor, since nothing else sets this flag). Exercises
 * every state (pre, in, post, bye) and the documented nulls: no score before
 * kickoff, and an ESPN-down "In progress" game with no clock. */
const STUB_PAYLOAD = {
  week: 3,
  updatedAt: new Date().toISOString(),
  anyLive: true,
  nextRefreshMs: 6000,
  games: [
    { gameId: '2026_03_LAC_BUF', away: 'LAC', home: 'BUF', awayScore: 17, homeScore: 24, state: 'in', period: 3, clock: '8:42', kickoff: new Date(Date.now() - 2 * 3600e3).toISOString(), label: 'Q3 8:42' },
    { gameId: '2026_03_KC_DEN', away: 'KC', home: 'DEN', awayScore: null, homeScore: null, state: 'pre', period: null, clock: null, kickoff: new Date(Date.now() + 3 * 3600e3).toISOString(), label: 'Sun 4:25pm' },
    { gameId: '2026_03_SF_SEA', away: 'SF', home: 'SEA', awayScore: 27, homeScore: 20, state: 'post', period: 4, clock: null, kickoff: new Date(Date.now() - 5 * 3600e3).toISOString(), label: 'Final' },
    { gameId: '2026_03_MIA_NYJ', away: 'MIA', home: 'NYJ', awayScore: null, homeScore: null, state: 'in', period: null, clock: null, kickoff: new Date(Date.now() - 1 * 3600e3).toISOString(), label: 'In progress' },
  ],
  matchup: {
    winProbability: 0.61,
    me: {
      rosterId: 1, teamName: 'Yalam', points: 98.4, projectedFinal: 131.2,
      starters: [
        { player_id: '6813', name: 'Jonathan Taylor', position: 'RB', team: 'IND', slot: 'RB', points: 22.4, projected: 19.9, projectedRemaining: 0, gameState: 'post', gameLabel: 'Final' },
        { player_id: '4046', name: 'Justin Herbert', position: 'QB', team: 'LAC', slot: 'QB', points: 18.6, projected: 21.0, projectedRemaining: 7.4, gameState: 'in', gameLabel: 'Q3 8:42' },
        { player_id: '7564', name: 'Puka Nacua', position: 'WR', team: 'LAR', slot: 'WR', points: 0, projected: 14.8, projectedRemaining: 14.8, gameState: 'pre', gameLabel: 'Sun 4:25pm' },
      ],
    },
    them: {
      rosterId: 2, teamName: 'Sussybakamogus', points: 81.2, projectedFinal: 124.0,
      starters: [
        { player_id: '9509', name: 'Bijan Robinson', position: 'RB', team: 'ATL', slot: 'RB', points: 16.1, projected: 17.5, projectedRemaining: 0, gameState: 'post', gameLabel: 'Final' },
        { player_id: '5849', name: 'Trevor Lawrence', position: 'QB', team: 'JAX', slot: 'QB', points: 12.3, projected: 18.2, projectedRemaining: 6.9, gameState: 'in', gameLabel: 'Q3 8:42' },
        { player_id: '4098', name: 'Travis Kelce', position: 'TE', team: 'KC', slot: 'TE', points: 0, projected: 0, projectedRemaining: 0, gameState: null, gameLabel: 'Bye' },
      ],
    },
  },
};

export function isStub() { return usingStub; }
export function getLive() { return payload; }

/** Subscribe to every poll (success -> payload, failure -> null). Returns an
 * unsubscribe function; a widget whose DOM has been torn down should call it
 * (or just check `node.isConnected` and self-unsubscribe, the pattern every
 * broadcast widget below uses, since views have no explicit unmount hook). */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let tickSeq = 0;

function notify() {
  for (const fn of listeners) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

async function tick() {
  if (document.hidden) return; // resumed by the visibilitychange listener below
  // Only the newest poll may land: after a league switch, a response still in
  // flight for the old league must not overwrite the new one.
  const seq = ++tickSeq;
  let next;
  try {
    next = usingStub ? structuredClone(STUB_PAYLOAD) : await api('live');
  } catch {
    // 404 (endpoint missing) or any other failure: soft-fail, same as the
    // rest of this app — hide the live parts, keep the page working.
    next = null;
  }
  if (seq !== tickSeq) return;
  payload = next;
  notify();
  schedule();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, payload?.nextRefreshMs || DEFAULT_INTERVAL);
}

export function startLive() {
  usingStub = new URLSearchParams(location.search).get('stublive') === '1';
  tick();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { clearTimeout(timer); tick(); }
  });
}

/** Re-poll right away (a league switch changes who "me" and "them" are). */
export function pokeLive() {
  clearTimeout(timer);
  payload = null; // the old league's score must not linger while the new one loads
  notify();
  tick();
}

/** Has any starter's game, on either side, kicked off? Until then every view
 * shows projections; from then on, points scored (0.0 for anyone yet to
 * play), as Sleeper does. One rule, so the bug, the scoreboard, the matchup
 * table and the on-field rows never disagree about which they are showing. */
export function weekUnderway(m) {
  return [...(m?.me?.starters || []), ...(m?.them?.starters || [])]
    .some((p) => p.gameState === 'in' || p.gameState === 'post');
}

// ---------------------------------------------------------------- numbers

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Update one number in place; if it actually changed, underline it in the
 * line-to-gain yellow and let the underline fade — never a redraw, never any
 * motion at all under prefers-reduced-motion. */
export function setLiveNumber(node, text) {
  if (!node || text == null || node.textContent === String(text)) return;
  node.textContent = text;
  if (reduceMotion()) return;
  node.style.transition = 'none';
  node.style.borderBottomColor = 'var(--line)';
  void node.offsetWidth; // force reflow, so the fade below actually animates
  node.style.transition = 'border-bottom-color 1400ms ease-out';
  node.style.borderBottomColor = 'transparent';
}

// ---------------------------------------------------------------- chips

/** "Q3 8:42" / "Halftime" / "Final" / "Sun 4:25pm" — the label the contract
 * already sends, presented as a small live-aware chip. */
export function gameChip(starter) {
  if (!starter) return null;
  return el('span', { class: `of-chip${starter.gameState === 'in' ? ' is-live' : ''}`, text: starter.gameLabel || '' });
}

// ---------------------------------------------------------------- score bug

/**
 * The one status line a whole matchup reduces to. No single game clock
 * describes a fantasy week, so the bug follows whichever of the two lineups'
 * games is most relevant right now: any game in progress first, otherwise
 * the next kickoff still to come, otherwise every game is done and it reads
 * Final. Until the week's first kickoff the points shown are the projection;
 * from then on they are points scored, even between game windows.
 */
export function scoreBugModel(m) {
  const starters = [...(m.me.starters || []), ...(m.them.starters || [])];
  const live = starters.find((p) => p.gameState === 'in');
  const pre = starters.find((p) => p.gameState === 'pre');
  const state = live ? 'in' : pre ? 'pre' : 'post';
  // "In progress" stands in for the clock when a game is live but ESPN's
  // feed is down; "Live, In progress" would just say the same thing twice.
  const status = state === 'in'
    ? (live.gameLabel && live.gameLabel !== 'In progress' ? `Live, ${live.gameLabel}` : 'Live')
    : state === 'pre' ? pre.gameLabel : 'Final';
  const underway = weekUnderway(m);
  const mePts = underway ? m.me.points : m.me.projectedFinal;
  const themPts = underway ? m.them.points : m.them.projectedFinal;
  return {
    state, status, underway,
    meName: m.me.teamName, themName: m.them.teamName,
    mePts: n1(mePts), themPts: n1(themPts),
    winPct: Math.round((m.winProbability ?? 0.5) * 100),
  };
}

/**
 * Mount the sticky score bug once, into the static host index.html reserves
 * under the masthead. It is alive for the whole session (never torn down by
 * routing), so it subscribes to every poll directly rather than through the
 * self-unsubscribing pattern the per-view broadcast widgets use.
 */
export function mountScoreBug(host) {
  let refs = null;

  function build() {
    host.textContent = '';
    const dot = el('span', { class: 'sb-dot' });
    const statusText = el('span', {});
    const meTeam = el('span', { class: 'sb-team' });
    const mePts = el('span', { class: 'sb-pts live-num' });
    const ball = el('span', { class: 'sb-ball' });
    const themPts = el('span', { class: 'sb-pts live-num' });
    const themTeam = el('span', { class: 'sb-team' });
    const win = el('span', { class: 'sb-win live-num' });

    const link = el('a', { class: 'sb-link', href: '#matchup' }, [
      el('span', { class: 'sb-status' }, [dot, statusText]),
      el('span', { class: 'sb-chip sb-me' }, [meTeam, mePts]),
      el('span', { class: 'sb-field', 'aria-hidden': 'true' }, [ball]),
      el('span', { class: 'sb-chip sb-them' }, [themPts, themTeam]),
      win,
    ]);
    host.appendChild(link);
    refs = { link, dot, statusText, meTeam, mePts, ball, themPts, themTeam, win };
  }

  function render(data) {
    const m = data?.matchup;
    if (!m) { host.hidden = true; return; } // /api/live missing, failed, or no matchup this week
    if (!refs) build();
    host.hidden = false;
    const s = scoreBugModel(m);
    // Sleeper's scores could not be refreshed: say so instead of passing an
    // old score off as the live one (the clock beside it is still current).
    const asOf = data.scoresStale && data.scoresAsOf
      ? new Date(data.scoresAsOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    const status = data.scoresStale ? 'Scores delayed' : s.status;
    refs.link.setAttribute('aria-label',
      `${status}${asOf ? `, last updated ${asOf}` : ''}. ${s.meName} ${s.mePts}, ${s.themName} ${s.themPts}${s.underway ? '' : ' projected'}, ${s.winPct}% chance to win. Open the matchup.`);
    refs.dot.classList.toggle('is-live', s.state === 'in' && !data.scoresStale);
    refs.statusText.textContent = status;
    refs.statusText.title = asOf ? `Scores last updated ${asOf}` : '';
    refs.meTeam.textContent = s.meName;
    refs.themTeam.textContent = s.themName;
    setLiveNumber(refs.mePts, s.mePts);
    setLiveNumber(refs.themPts, s.themPts);
    setLiveNumber(refs.win, `${s.winPct}%`);
    refs.ball.style.setProperty('--pos', `${Math.min(94, Math.max(6, s.winPct))}%`);
  }

  render(getLive());
  onLive(render);
}
