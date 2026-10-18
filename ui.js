// Rendering helpers. No state, no fetching.

import { state } from './store.js';
import { teamColor } from './teamColors.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};
export const frag = (children) => {
  const f = document.createDocumentFragment();
  for (const c of [].concat(children)) if (c) f.appendChild(c);
  return f;
};

// ---------- formatting ----------

export const n1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(1));
export const n2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(2));
export const pct0 = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
export const signed = (v, digits = 1) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}`);

// ---------- shared render pieces ----------

export function figures(items) {
  return el('div', { class: 'figures' }, items.filter(Boolean).map((f) =>
    el('div', { class: 'figure' }, [
      el('div', { class: `value ${f.tone ? `is-${f.tone}` : ''}`, text: f.value }),
      el('div', { class: 'label', text: f.label }),
      f.sublabel ? el('div', { class: 'sublabel', text: f.sublabel }) : null,
    ])
  ));
}

export function emptyState(title, body) {
  // h3: it sits under a view's h2 or a section's h3, never deeper.
  return el('div', { class: 'empty' }, [el('h3', { text: title }), el('p', { text: body })]);
}

/**
 * A labelled form control. The label is tied to its control with for/id, so
 * it names the control for screen readers and clicking it focuses the field.
 */
let fieldCount = 0;
export function field(label, control, attrs = {}) {
  if (!control.id) control.id = `field-${++fieldCount}`;
  return el('div', { class: 'field', ...attrs }, [el('label', { for: control.id, text: label }), control]);
}

/**
 * Tell screen-reader users something without moving their focus: how many
 * results came back, or an error they would otherwise not notice. Assertive
 * is for errors only.
 */
export function announce(message, { assertive = false } = {}) {
  const region = document.getElementById(assertive ? 'alert' : 'announce');
  if (!region) return;
  region.textContent = '';
  // Set after a tick, so the same words said twice are still read twice.
  setTimeout(() => { region.textContent = message; }, 60);
}

/** A link target only if it is a web address; anything else (javascript:, data:) is dropped. */
export function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

export function callout(text, kind = '') {
  return el('div', { class: `callout ${kind}` }, [typeof text === 'string' ? document.createTextNode(text) : text]);
}

/** Who holds a player right now, as one plain clause for a row's note line. */
export function ownerNote(p) {
  if (p.isMine) return 'On your roster.';
  if (p.isFreeAgent || p.ownedBy === 'Free agent') return 'A free agent.';
  return p.ownedBy ? `Owned by ${p.ownedBy}.` : '';
}

export function playerTags(p) {
  const tags = [];
  if (p.onBye) tags.push(el('span', { class: 'tag brick', text: 'on bye' }));
  if (p.injury?.status) {
    const serious = ['Out', 'IR', 'PUP', 'Doubtful'].includes(p.injury.status);
    tags.push(el('span', { class: `tag ${serious ? 'brick' : 'amber'}`, text: p.injury.status }));
  }
  // His game has kicked off: Sleeper will not let anyone move him now.
  if (p.locked) tags.push(el('span', { class: 'tag', title: 'His game has kicked off, so he cannot be moved in or out of a lineup.', text: 'Game started' }));
  for (const flag of p.weather?.flags || []) {
    tags.push(el('span', { class: 'tag amber', title: p.weather.summary || '', text: flag }));
  }
  return tags;
}

/** A story's source, worded so the words (not just the colour) carry the
 * weight: a byline reporter reads stronger than a forum post about it. */
export function credibilityTag(cred) {
  if (!cred) return null;
  const text = cred.via ? `${cred.label} via ${cred.via}` : cred.label;
  return el('span', { class: `tag ${cred.tier <= 2 ? 'pine' : ''}`, title: cred.domain || '', text });
}

/**
 * Short codes for the narrow slot column. "SUPER_FLEX" does not fit on a phone
 * and overruns the player's name; the full wording stays in the slot headings.
 */
const SHORT_SLOT = {
  SUPER_FLEX: 'SFLX', QB_FLEX: 'SFLX', REC_FLEX: 'W/T', WRRB_FLEX: 'W/R',
  IDP_FLEX: 'IDP', WRT: 'FLEX',
};

export function shortSlot(slot) {
  if (!slot) return '';
  return SHORT_SLOT[slot] || slot;
}

// ---------- headshots ----------

/**
 * A player's headshot, ringed 3px in his club's colour (a team defense gets
 * its shield instead of a face). Decorative only — the name sits right next
 * to it — so `alt=""`; a dead image just disappears and leaves the ring.
 */
export function headshot(p, { size = 32 } = {}) {
  if (!p?.player_id) return null;
  const isDef = p.position === 'DEF';
  const src = isDef
    ? `https://sleepercdn.com/images/team_logos/nfl/${String(p.team || '').toLowerCase()}.png`
    : `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`;
  return el('span', {
    // Size as a variable, not an inline width, so a phone rule can shrink it.
    class: 'headshot-ring', style: `--stripe:${teamColor(p.team)};--hs:${size}px`,
  }, [
    el('img', {
      class: 'headshot', src, alt: '', loading: 'lazy', width: size, height: size,
      onerror: (e) => { e.target.style.visibility = 'hidden'; },
    }),
  ]);
}

/** A headshot beside a name/position line, the compact unit the broadcast
 * rows (on the field now, head-to-head) repeat down the page. */
export function playerBadge(p, { size = 32, meta = null } = {}) {
  return el('span', { class: 'badge' }, [
    headshot(p, { size }),
    el('span', { class: 'badge-text' }, [
      el('span', { class: 'pname', text: p?.name || 'Nobody set' }),
      meta ? el('span', { class: 'pclub', text: meta }) : null,
    ]),
  ]);
}

// ---------- roster tables ----------

/**
 * Name, position and club, then any injury or bye tags. `opp` rides along
 * with the club and shows only on a phone, where the opponent column is gone.
 */
export function playerName(p, { opp = null } = {}) {
  return frag([
    el('span', { class: 'pname', text: p.name }),
    el('span', { class: 'pclub' }, [`${p.position} ${p.team}`, opp ? el('span', { class: 'popp', text: ` ${opp}` }) : null]),
    ...playerTags(p),
  ]);
}

// Stat columns a roster table can carry. `wide` columns drop out on a phone.
// A blank cell means "does not apply" (a kicker has no targets); a dash means
// the number exists in principle but there is no data for it yet.
const STATS = {
  opp: { head: 'Opponent', mid: true, get: (p) => p.opponent || (p.onBye ? 'Bye' : '') },
  total: { head: 'Game total', wide: true, get: (p) => (p.gameTotal != null ? String(p.gameTotal) : '') },
  avg: { head: 'Per game', get: (p) => (p.gamesPlayed > 0 ? n1(p.seasonAverage) : '—') },
  snap: { head: 'Snaps', wide: true, get: (p) => (p.snapShare ? pct0(p.snapShare) : '') },
  tgt: {
    head: 'Targets', wide: true,
    get: (p) => (p.targetShare && !['QB', 'K', 'DEF'].includes(p.position) ? pct0(p.targetShare) : ''),
  },
  usagePct: { head: 'Used more than', get: (p) => (p.usagePercentile != null ? pct0(p.usagePercentile) : '') },
  scorePct: { head: 'Scored more than', get: (p) => (p.scoringPercentile != null ? pct0(p.scoringPercentile) : '') },
  bid: { head: 'Bid', get: (p) => (p.bid?.suggested != null ? `$${p.bid.suggested.toLocaleString()}` : '') },
};

const colClass = (k) => (STATS[k].wide ? 'wide' : STATS[k].mid ? 'mid' : '');

// A `wide` column's value, said as a phrase for the phone-only summary line
// that replaces it once its own column is hidden (≤720px). Order reads the
// way a manager would say it aloud: the game as a whole, then his share of it.
const WIDE_PHRASE = {
  total: (v) => `Game total ${v}`,
  snap: (v) => `${v} of snaps`,
  tgt: (v) => `${v} of targets`,
};

/** "Game total 47.5, 71% of snaps, 22% of targets" — every `wide` stat this
 * table carries that has a value for this player, joined into one sentence
 * fragment. Empty when the table carries no `wide` stats, or none apply. */
function wideSummary(p, stats) {
  const bits = stats
    .filter((k) => STATS[k].wide && WIDE_PHRASE[k])
    .map((k) => {
      const v = STATS[k].get(p);
      return v ? WIDE_PHRASE[k](v) : null;
    })
    .filter(Boolean);
  return bits.join(', ');
}

/**
 * A roster as a table: each heading printed once, every figure in its column.
 * rows: { slot, player, value, tone, note, className, emptyText } or { group }.
 */
export function playerTable({ rows, valueHead = 'Projected', stats = ['opp', 'total', 'avg', 'snap', 'tgt'], caption }) {
  const table = el('table', { class: 'roster' });
  if (caption) table.appendChild(el('caption', { class: 'visually-hidden', text: caption }));

  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Slot' }),
    el('th', { class: 'l', scope: 'col', text: 'Player' }),
    ...stats.map((k) => el('th', { scope: 'col', class: colClass(k) || null, text: STATS[k].head })),
    el('th', { scope: 'col', text: valueHead }),
  ])]));

  // Each group ("Bench", "Would start") gets its own tbody, so its heading
  // labels exactly the rows under it.
  let body = el('tbody');
  const span = stats.length + 3;
  for (const r of rows) {
    if (r.group) {
      if (body.childNodes.length) table.appendChild(body);
      body = el('tbody');
      body.appendChild(el('tr', { class: 'group' }, [el('th', { colspan: span, scope: 'rowgroup', text: r.group })]));
      continue;
    }
    const p = r.player;
    const summary = p ? wideSummary(p, stats) : '';
    body.appendChild(el('tr', { class: r.className || null }, [
      el('td', { class: 'slot', text: shortSlot(r.slot) }),
      // The player is the row's header, so a screen reader names him with every number.
      el('th', { class: 'player', scope: 'row' }, p
        ? [
            playerName(p, { opp: stats.includes('opp') ? STATS.opp.get(p) : null }),
            r.note ? el('span', { class: 'psub', text: r.note }) : null,
            // The columns a phone hides (Game total, Snaps, Targets) still
            // need saying somewhere; this line only shows there (CSS), so it
            // says nothing twice on a wide screen where the columns are back.
            summary ? el('span', { class: 'psub narrow-only', text: summary }) : null,
          ]
        : [el('span', { class: 'pname', text: r.emptyText || 'Nobody set' })]),
      ...stats.map((k) => {
        const v = p ? STATS[k].get(p) : '';
        return el('td', { class: `stat ${colClass(k)}`, text: v });
      }),
      el('td', { class: `big ${r.tone || ''}`, text: r.value }),
    ]));
  }
  table.appendChild(body);
  return el('div', { class: 'table-scroll' }, [table]);
}

/**
 * Injury and depth flags gathered into one list, not a stack of banners.
 * Returns an empty fragment when there is nothing to flag, so callers can
 * append the result unconditionally.
 */
export function checkList(title, items) {
  if (!items.length) return frag([]);
  return el('div', { class: 'checks' }, [
    el('h3', { text: title }),
    el('ul', {}, items.map((t) => el('li', { text: t }))),
  ]);
}

// ---------- the field ----------

const BALL = `<svg viewBox="0 0 26 16" aria-hidden="true"><ellipse cx="13" cy="8" rx="12" ry="7" fill="#7b4120" stroke="#fff" stroke-width="1.2"/><path d="M8.5 8h9M10.5 6.2v3.6M13 6.2v3.6M15.5 6.2v3.6" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/></svg>`;

/**
 * Win chance drawn as field position. You drive left to right; midfield is a
 * coin flip, and the ball sits nearer their end zone the likelier you win.
 */
export function gridiron(probability, { me, them, large = false } = {}) {
  const pct = Math.round(probability * 100);
  const node = el('div', {
    class: `gridiron${large ? ' is-large' : ''}`,
    role: 'img',
    'aria-label': `${pct}% chance to win. Midfield would be an even game.`,
  });

  const turf = el('div', { class: 'turf' });
  for (const yd of [10, 20, 30, 40, 50, 60, 70, 80, 90]) {
    const label = yd <= 50 ? yd : 100 - yd;
    turf.appendChild(el('div', {
      class: `yard${label % 20 === 10 && label !== 50 ? ' minor' : ''}`,
      style: `left:${yd}%`,
    }, [el('span', { text: String(label) })]));
  }
  // Clamp so the label never runs off the turf at the extremes.
  const pos = Math.min(94, Math.max(6, pct));
  const scrimmage = el('div', { class: 'scrimmage' });
  const ball = el('div', { class: 'ball' }, [el('b', { text: `${pct}%` }), el('span', { html: BALL })]);
  turf.append(scrimmage, ball);

  node.append(
    el('div', { class: 'endzone me', title: me || 'You' }, [el('span', { text: me || 'You' })]),
    turf,
    el('div', { class: 'endzone them', title: them || 'Them' }, [el('span', { text: them || 'Them' })]),
  );

  // No entrance animation: the ball starts exactly where the probability
  // says. Only a later, live change moves it (the CSS transition on
  // .scrimmage/.ball still fires whenever something sets --pos again).
  turf.style.setProperty('--pos', `${pos}%`);
  return node;
}

/** The matchup in one plain sentence. */
export function matchupCaption(r) {
  const pct = Math.round(r.winProbability * 100);
  const m = r.margin.median;
  const typical = Math.abs(m) < 0.05 ? 'a dead heat'
    : `a ${n1(Math.abs(m))}-point ${m > 0 ? 'win' : 'loss'}`;
  return `You win ${pct} of every 100 simulated weeks. The typical result is ${typical}.`;
}

export const recordText = (x) => (x ? `${x.wins}-${x.losses}${x.ties ? `-${x.ties}` : ''}` : '');

export function bar(fraction, kind = '') {
  const track = el('div', { class: 'bar-track' });
  track.appendChild(el('div', { class: `bar-fill ${kind}`, style: `width:${Math.max(0, Math.min(1, fraction)) * 100}%` }));
  return track;
}


export function loading(message = 'Working out the numbers…') {
  return el('div', { class: 'loading', text: message });
}

export function warningsBlock() {
  const w = state.overview?.warnings || [];
  if (!w.length) return null;
  return frag(w.map((text) => callout(text, 'amber')));
}

/** Render a promise into a container: spinner, then content or a readable error. */
/** Send a browser error to the server log (best effort, never throws). */
export function reportClientError(kind, err) {
  if (window.FF_STATIC) { console.error(kind, err); return; } // no server to tell on the static site
  try {
    fetch('/api/client-log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, route: location.hash, message: err?.message || String(err), stack: err?.stack || '' }),
    }).catch(() => {});
  } catch { /* nothing to do */ }
}

export async function renderAsync(container, promise, renderFn) {
  container.textContent = '';
  container.appendChild(loading());
  try {
    const data = await promise;
    container.textContent = '';
    const out = renderFn(data);
    if (out) container.appendChild(out);
  } catch (err) {
    container.textContent = '';
    container.appendChild(emptyState('That did not load', err.message
      + ' If this keeps happening, try Refresh data at the bottom of the page.'));
    announce(`That did not load. ${err.message}`, { assertive: true });
    // A render bug and a failed request look the same on screen; keep the difference in the console.
    console.error(err);
    reportClientError('render', err);
  }
}
