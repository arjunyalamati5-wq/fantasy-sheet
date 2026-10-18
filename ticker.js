// The ticker: every NFL game this week, scrolling across the top of every
// page the way a broadcast runs scores along the bottom of the screen. Games
// with one of your starters in them carry a dot. Live games first, then the
// rest in kickoff order. It pauses under the pointer or keyboard focus, and
// for anyone who asks for less motion it is a plain row that scrolls by hand.

import { el } from './ui.js';
import { getLive, onLive } from './live.js';

const ORDER = { in: 0, pre: 1, post: 2 };

function gameItem(g, mine) {
  const live = g.state === 'in';
  const score = (team, pts) => el('span', { class: 'tk-team' }, [
    el('span', { class: 'tk-code', text: team }),
    pts != null ? el('b', { text: String(pts) }) : null,
  ]);
  return el('li', { class: `tk-game${live ? ' is-live' : ''}${mine ? ' is-mine' : ''}` }, [
    mine ? el('span', { class: 'tk-mine', title: 'One of your starters plays in this game' }) : null,
    score(g.away, g.awayScore),
    el('span', { class: 'tk-at', text: g.state === 'pre' ? 'at' : '' }),
    score(g.home, g.homeScore),
    el('span', { class: 'tk-label', text: g.label }),
  ]);
}

export function mountTicker(host) {
  const track = host.querySelector('.ticker-track');
  let lastKey = '';

  function render(data) {
    const games = data?.games || [];
    if (!games.length) { host.hidden = true; lastKey = ''; return; }
    host.hidden = false;
    const myTeams = new Set((data.matchup?.me?.starters || []).map((p) => p.team));
    const sorted = [...games].sort((a, b) => (ORDER[a.state] ?? 3) - (ORDER[b.state] ?? 3)
      || String(a.kickoff).localeCompare(String(b.kickoff)));
    // Rebuild only when something on it changed, so the marquee does not jump.
    const key = sorted.map((g) => `${g.gameId}:${g.awayScore}:${g.homeScore}:${g.label}`).join('|') + [...myTeams].join();
    if (key === lastKey) return;
    lastKey = key;
    const list = () => el('ul', { class: 'tk-list' }, sorted.map((g) => gameItem(g, myTeams.has(g.home) || myTeams.has(g.away))));
    const first = list();
    first.setAttribute('aria-label', 'This week\'s NFL games');
    // A second copy makes the loop seamless; screen readers hear it once.
    const second = list();
    second.setAttribute('aria-hidden', 'true');
    track.replaceChildren(first, second);
    // Speed is per item, so a full slate does not race past.
    track.style.setProperty('--tk-dur', `${Math.max(30, sorted.length * 6)}s`);
  }

  render(getLive());
  onLive(render);
}
