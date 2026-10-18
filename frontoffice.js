// The Front office: linked accounts, refresh schedule, saved data and a
// health check on every source the app reads. Settings live on this device.

import { alertsSettingsBlock } from './alerts.js';
import { api, post, clearCache, state, accounts, applyAccount, browserCacheStats, autoRefreshMinutes, setAutoRefreshMinutes } from './store.js';
import { el, field, callout, announce, emptyState, safeHref } from './ui.js';
import { riseWords } from './motion.js';
import { sourcesView } from './community.js';
import { REFRESH_CHOICES } from './accounts.js';

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

// ---------------------------------------------------------------- small helpers

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
export function fmtAge(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return 'under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr` : `${Math.round(h / 24)} days`;
}

/** Tell the rest of the app the account or league changed. app.js listens for this. */
function accountChanged() {
  applyAccount();
  window.dispatchEvent(new CustomEvent('ff:account-changed'));
}

function block(band, id, title, note, children) {
  return el('section', { class: 'stack-block fo-block', 'data-band': band, 'aria-labelledby': id }, [
    el('h3', { id, class: 'fo-title', text: title }),
    note ? el('p', { class: 'fo-note', text: note }) : null,
    ...[].concat(children),
  ]);
}

/**
 * A two-step action: the first press asks, the second does it. Focus lands on
 * Cancel so an accidental Enter is safe, and Escape backs out.
 */
function confirmButton({ label, ask, confirmLabel, onConfirm, ghost = true }) {
  const wrap = el('div', { class: 'fo-confirm' });
  const start = el('button', { type: 'button', class: `btn${ghost ? ' ghost' : ''}`, text: label });
  const show = () => wrap.replaceChildren(start);
  start.addEventListener('click', () => {
    const cancel = el('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: () => { show(); start.focus(); } });
    const yes = el('button', { type: 'button', class: 'btn danger', text: confirmLabel, onclick: async () => {
      yes.disabled = true; cancel.disabled = true;
      try { await onConfirm(); } finally { show(); }
    } });
    const box = el('div', { class: 'fo-ask', role: 'group', 'aria-label': 'Confirm' }, [
      el('p', { class: 'fo-ask-text', text: ask }),
      el('div', { class: 'fo-actions' }, [yes, cancel]),
    ]);
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { show(); start.focus(); } });
    wrap.replaceChildren(box);
    cancel.focus();
  });
  show();
  return wrap;
}

function tableOf(headers, rows, { caption, cls = '' } = {}) {
  const t = el('table', { class: `sheet fo-table ${cls}` }, [
    caption ? el('caption', { class: 'visually-hidden', text: caption }) : null,
    el('thead', {}, [el('tr', {}, headers.map((h, i) => el('th', { scope: 'col', class: i === 0 ? 'l' : (h.left ? 'l' : ''), text: h.text || h })))]),
    el('tbody', {}, rows),
  ]);
  return el('div', { class: 'table-scroll fo-scroll' }, [t]);
}
const cell = (label, content, cls = '') => el('td', { 'data-label': label, class: cls }, [].concat(content));

// ---------------------------------------------------------------- linked accounts

async function leaguesFor(username) {
  const first = await api('leagues', { username, league: null, roster: null });
  const prev = String(Number(first.season) - 1);
  let older = [];
  try { older = (await api('leagues', { username, season: prev, league: null, roster: null })).leagues; } catch { /* the earlier season is a bonus */ }
  const seen = new Set();
  const leagues = [];
  for (const [season, list] of [[first.season, first.leagues], [prev, older]]) {
    for (const l of list || []) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      leagues.push({ ...l, season });
    }
  }
  return { user: first.user, leagues };
}

function accountsBlock() {
  const titleId = nextId('fo-acc');
  const list = el('ul', { class: 'fo-accounts' });
  const chooser = el('div', { class: 'fo-choose' });
  const live = el('p', { class: 'fo-status', role: 'status' });

  const err = el('p', { class: 'fo-error', id: nextId('fo-err'), role: 'alert' });
  const input = el('input', { type: 'text', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': err.id, placeholder: 'your Sleeper username' });
  const addBtn = el('button', { type: 'submit', class: 'btn', text: 'Add account' });
  const form = el('form', { class: 'fo-form', novalidate: true }, [field('Sleeper username', input), addBtn]);
  form.append(err);

  const say = (msg) => { live.textContent = msg; announce(msg); };

  function drawAccounts() {
    const all = accounts.list();
    const act = accounts.active();
    list.replaceChildren(...(all.length ? all.map((a) => {
      const isActive = act && a.username === act.username;
      return el('li', { class: `fo-account${isActive ? ' is-active' : ''}` }, [
        el('div', { class: 'fo-account-name' }, [
          el('strong', { text: a.username }),
          el('span', { class: 'fo-sub', text: `${a.followed.length} followed ${a.followed.length === 1 ? 'league' : 'leagues'}` }),
          isActive ? el('span', { class: 'tag pine', text: 'Viewing' }) : null,
        ]),
        el('div', { class: 'fo-actions' }, [
          isActive ? null : el('button', { type: 'button', class: 'btn ghost', 'aria-label': `View ${a.username}`, text: 'View', onclick: () => {
            accounts.switchTo(a.username); accountChanged(); drawAll(); say(`Now viewing ${a.username}.`);
          } }),
          el('button', { type: 'button', class: 'btn ghost', 'aria-label': `Remove ${a.username}`, text: 'Remove', onclick: () => {
            accounts.remove(a.username); accountChanged(); drawAll(); say(`Removed ${a.username} from this device.`);
          } }),
        ]),
      ]);
    }) : [el('li', { class: 'fo-empty', text: 'No account saved yet. Add your Sleeper username above.' })]));
  }

  async function drawChooser() {
    const a = accounts.active();
    chooser.replaceChildren();
    if (!a) return;
    const status = el('p', { class: 'fo-status', text: `Looking up ${a.username}'s leagues…` });
    chooser.append(status);
    let data;
    try { data = await leaguesFor(a.username); } catch (e) {
      status.replaceWith(callout(`Could not load the leagues for ${a.username}. ${e.message}`, 'warn'));
      return;
    }
    if (accounts.active()?.username !== a.username) return; // switched while loading
    if (!data.leagues.length) {
      chooser.replaceChildren(emptyState('No leagues to follow', 'No NFL leagues found for this account in the current or previous season.'));
      return;
    }
    const followedIds = new Set(a.followed.map((l) => l.id));
    const fs = el('fieldset', { class: 'fo-leagues' }, [el('legend', { text: 'Choose leagues to follow' })]);
    const boxes = data.leagues.map((l) => {
      const id = nextId('fo-lg');
      const box = el('input', { type: 'checkbox', id, value: l.id });
      box.checked = followedIds.has(l.id);
      fs.append(el('div', { class: 'fo-check' }, [
        box,
        el('label', { for: id }, [
          el('span', { class: 'fo-lname', text: l.name }),
          el('span', { class: 'fo-sub', text: `${l.season}, ${l.teams} teams, ${l.scoringType}` }),
        ]),
      ]));
      return { box, l };
    });
    const save = () => {
      const picked = boxes.filter((b) => b.box.checked).map(({ l }) => ({ id: l.id, name: l.name, season: l.season }));
      accounts.setFollowed(a.username, picked);
      accountChanged();
      drawAccounts();
      say(picked.length ? `Following ${picked.length} ${picked.length === 1 ? 'league' : 'leagues'}.` : 'Following no leagues. Pick one to see its pages.');
      drawViewing();
    };
    fs.addEventListener('change', save);
    const viewing = el('div', { class: 'fo-viewing' });
    function drawViewing() {
      const followed = accounts.followedLeagues();
      if (followed.length < 2) { viewing.replaceChildren(); return; }
      const sel = el('select', {}, followed.map((l) => el('option', { value: l.id, text: l.name })));
      sel.value = state.leagueId;
      sel.addEventListener('change', () => { accounts.selectLeague(sel.value); accountChanged(); say(`Now viewing ${sel.options[sel.selectedIndex].text}.`); });
      viewing.replaceChildren(field('League to view', sel));
    }
    drawViewing();
    chooser.replaceChildren(fs, el('p', { class: 'fo-sub', text: 'Changes save as you tick them. The league picker at the top lists only these.' }), viewing);
  }
  function drawAll() { drawAccounts(); drawChooser(); }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    input.removeAttribute('aria-invalid');
    const name = input.value.trim();
    const fail = (m) => { err.textContent = m; input.setAttribute('aria-invalid', 'true'); input.focus(); };
    if (!name) return fail('Enter a Sleeper username.');
    addBtn.disabled = true;
    addBtn.textContent = 'Checking…';
    try {
      const probe = await api('leagues', { username: name, league: null, roster: null });
      const r = accounts.add(probe.user?.username || name, { userId: probe.user?.id });
      if (!r.ok) return fail(r.error);
      input.value = '';
      accountChanged();
      drawAll();
      say(r.existed ? `${r.account.username} was already saved, so it is now the one you are viewing.` : `Added ${r.account.username}.`);
    } catch (e2) {
      fail(`Could not add "${name}". ${e2.message}`);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = 'Add account';
    }
  });

  const signOut = confirmButton({
    label: 'Sign out',
    ask: 'Remove the active account and clear its saved data from this device?',
    confirmLabel: 'Yes, sign out',
    onConfirm: async () => {
      accounts.signOut();
      accountChanged();
      drawAll();
      say('Signed out. The saved data for that account is cleared from this device.');
    },
  });

  drawAll();
  return block('team', titleId, 'Linked accounts',
    'Enter a Sleeper username to follow your leagues. There is no password: Sleeper does not offer one to third-party apps, and this app only reads public league data. Accounts are remembered on this device only. Pick which one to view, or remove it.',
    [form, list, chooser, el('div', { class: 'fo-signout' }, [signOut, el('p', { class: 'fo-sub', text: 'Signing out removes the active account and clears the saved data.' })]), live]);
}

// ---------------------------------------------------------------- refresh schedule

function scheduleBlock() {
  const titleId = nextId('fo-sch');
  const toggle = el('input', { type: 'checkbox', id: nextId('fo-auto') });
  const sel = el('select', {}, REFRESH_CHOICES.map((m) => el('option', { value: m, text: m ? `Every ${m} minutes` : 'Off' })));
  const status = el('p', { class: 'fo-status', role: 'status' });
  const draw = () => {
    const m = autoRefreshMinutes();
    toggle.checked = m > 0;
    sel.value = String(m);
    status.textContent = m ? `Refreshing every ${m} minutes while this tab is open. It pauses when the tab is hidden.` : 'Auto-refresh is off. Pages load fresh data when you open them, or when you press Refresh.';
  };
  toggle.addEventListener('change', () => { setAutoRefreshMinutes(toggle.checked ? 15 : 0); draw(); });
  sel.addEventListener('change', () => { setAutoRefreshMinutes(sel.value); draw(); });
  draw();
  return block('week', titleId, 'Refresh schedule',
    'The Refresh button on each page always goes back to the network. Requests are kept well under Sleeper\'s limits.',
    [el('div', { class: 'fo-row' }, [
      el('div', { class: 'fo-check' }, [toggle, el('label', { for: toggle.id, text: 'Auto-refresh on open' })]),
      field('Refresh interval', sel),
    ]), status]);
}

// ---------------------------------------------------------------- saved data

function cacheBlock() {
  const titleId = nextId('fo-cache');
  const body = el('div', { class: 'fo-cache' });
  const result = el('p', { class: 'fo-status', role: 'status' });

  async function draw() {
    body.replaceChildren(el('p', { class: 'fo-status', text: 'Reading what is saved…' }));
    let s = null;
    try { s = await api('cache-stats', { league: null, roster: null, username: null }); } catch (e) {
      body.replaceChildren(callout(`The server's saved data could not be read. ${e.message}`, 'warn'));
    }
    const b = browserCacheStats();
    const rows = [];
    if (s) {
      for (const g of s.groups) rows.push(el('tr', {}, [el('th', { scope: 'row', class: 'l', 'data-label': 'Kind', text: g.group }), cell('Entries', String(g.entries)), cell('Size', fmtBytes(g.bytes)), cell('Oldest', fmtAge(g.oldestAge))]));
      rows.push(el('tr', {}, [el('th', { scope: 'row', class: 'l', 'data-label': 'Kind', text: 'Built leagues, in server memory' }), cell('Entries', String(s.memory.entries)), cell('Size', 'n/a'), cell('Oldest', s.memory.entries ? fmtAge(s.memory.oldestAge) : 'none')]));
    }
    rows.push(el('tr', {}, [el('th', { scope: 'row', class: 'l', 'data-label': 'Kind', text: 'This browser (this page only)' }), cell('Entries', String(b.entries)), cell('Size', fmtBytes(b.bytes)), cell('Oldest', b.entries ? fmtAge(b.oldestAge) : 'none')]));
    const total = s ? el('p', { class: 'fo-sub', text: `On the server: ${s.total.entries} files, ${fmtBytes(s.total.bytes)} in all.` }) : null;
    const nodes = [tableOf(['Kind', 'Entries', 'Size', 'Oldest'], rows, { caption: 'Saved data by kind' }), total];
    body.replaceChildren(...nodes.filter(Boolean));
  }

  const clear = confirmButton({
    label: 'Clear all saved data',
    ask: 'Clear all saved data? Everything is fetched again on the next visit.',
    confirmLabel: 'Yes, clear it',
    onConfirm: async () => {
      let note = '';
      try {
        const r = await post('clear-cache', {});
        note = r.cleared ? 'Cleared the server\'s saved data and this browser\'s.' : `${r.note || 'The server was cleared recently.'} This browser's copy is cleared; the server's copy can be cleared again in about ten minutes.`;
      } catch (e) { note = `The server could not be cleared (${e.message}). This browser's copy is cleared.`; }
      clearCache();
      state.overview = null;
      result.textContent = note;
      announce(note);
      await draw();
    },
  });
  draw();
  return block('league', titleId, 'Saved data',
    'Answers are saved so pages open fast and the sources are not hammered. The server keeps files on disk; this page keeps a short-lived copy in the browser.',
    [body, el('div', { class: 'fo-signout' }, [clear]), result]);
}

// ---------------------------------------------------------------- data health

const LEVEL = {
  ok: { word: 'Working', icon: '✓' },
  warn: { word: 'Check', icon: '▲' },
  fail: { word: 'Failing', icon: '✕' },
};

export function healthSummary(tally) {
  const bits = [`${tally.ok} working`];
  if (tally.warn) bits.push(`${tally.warn} to check`);
  if (tally.fail) bits.push(`${tally.fail} failing`);
  return bits.join(', ');
}

function healthRow(r) {
  const lv = LEVEL[r.level] || LEVEL.warn;
  const link = safeHref(r.link);
  return el('tr', { class: `fo-lv-${r.level}` }, [
    el('th', { scope: 'row', class: 'l', 'data-label': 'Source' }, [
      el('span', { class: 'fo-src', text: r.label }),
      r.documented ? null : el('span', { class: 'tag amber', title: 'Not in the source\'s public documentation, so it can change without notice.', text: 'undocumented' }),
    ]),
    cell('Status', el('span', { class: `fo-level fo-${r.level}` }, [el('span', { 'aria-hidden': 'true', text: lv.icon }), ` ${lv.word}`])),
    cell('Detail', r.message, 'l wrap-cell'),
    cell('HTTP', r.status ? String(r.status) : 'n/a'),
    cell('Time', r.ms ? `${r.ms} ms` : 'n/a'),
    cell('Size', r.bytes ? fmtBytes(r.bytes) : 'n/a'),
    cell('Docs', link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Documentation for ${r.label}`, text: 'Docs' }) : 'local'),
  ]);
}

function healthBlock() {
  const titleId = nextId('fo-health');
  const out = el('div', { class: 'fo-health' });
  const btn = el('button', { type: 'button', class: 'btn', text: 'Run checks again' });

  async function run() {
    btn.disabled = true;
    out.replaceChildren(el('p', { class: 'fo-status', role: 'status', text: 'Checking every source… about ten seconds.' }));
    try {
      const h = await api('health');
      const rows = h.rows.map(healthRow);
      const parts = [
        el('p', { class: 'fo-summary', role: 'status', text: `${healthSummary(h.tally)}. Checked ${new Date(h.checkedAt).toLocaleTimeString()}.` }),
        tableOf([{ text: 'Source' }, 'Status', { text: 'Detail', left: true }, 'HTTP', 'Time', 'Size', 'Docs'], rows, { caption: 'Data source health', cls: 'fo-health-table' }),
        el('h4', { class: 'fo-sub-title', text: 'Unmatched player IDs' }),
      ];
      if (h.unmatched.length) {
        parts.push(el('p', { class: 'fo-sub', text: `${h.unmatchedCount} players in the usage data could not be matched to a Sleeper id${h.unmatched.length < h.unmatchedCount ? `; showing ${h.unmatched.length}` : ''}.` }));
        parts.push(tableOf(['Name', 'Team', 'Pos', { text: 'Reason', left: true }],
          h.unmatched.map((u) => el('tr', {}, [el('th', { scope: 'row', class: 'l', 'data-label': 'Name', text: u.name }), cell('Team', u.team), cell('Pos', u.pos), cell('Reason', u.reason, 'l wrap-cell')])),
          { caption: 'Players that could not be matched' }));
      } else {
        parts.push(el('p', { class: 'fo-sub', text: 'None reported. Either every player matched, or the usage data has not been built yet.' }));
      }
      out.replaceChildren(...parts);
      announce(`Data health: ${healthSummary(h.tally)}.`);
      if (h.version) window.dispatchEvent(new CustomEvent('ff:version', { detail: h.version }));
    } catch (e) {
      out.replaceChildren(callout(`The health check could not run. ${e.message}`, 'warn'));
      announce('The health check could not run.', { assertive: true });
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', run);
  run();
  return block('feeds', titleId, 'Data health',
    'Data health: checks every source this app reads. Sleeper\'s undocumented endpoints are marked, since they can change without notice.',
    [out, el('div', { class: 'fo-signout' }, [btn])]);
}

// ---------------------------------------------------------------- credits

function aboutBlock() {
  const titleId = nextId('fo-about');
  const social = el('div', { class: 'fo-social' });
  sourcesView(social, { embedded: true });
  const ver = el('p', { class: 'fo-sub' });
  api('cache-stats', { league: null, roster: null, username: null }).then((s) => { ver.textContent = s.version ? `Version ${s.version}. Settings are kept in this browser only.` : 'Settings are kept in this browser only.'; }).catch(() => { ver.textContent = 'Settings are kept in this browser only.'; });
  return block('research', titleId, 'Credits and about', null, [
    el('p', { class: 'fo-note', text: 'League data: Sleeper public API. Play-by-play and snap data: nflverse. Charting data: FTN Data via nflverse. Values: FantasyCalc. Weather: Open-Meteo (CC BY 4.0).' }),
    el('h4', { class: 'fo-sub-title', text: 'Social and news feeds' }),
    social, ver,
  ]);
}

// ---------------------------------------------------------------- view

export function frontOfficeView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'Front office' })));
  root.appendChild(el('p', { class: 'hero-sub', text: 'Your accounts, how fresh the data is, and whether every source is answering.' }));
  const stack = el('div', { class: 'fo-stack' }, [accountsBlock(), alertsSettingsBlock(), scheduleBlock(), cacheBlock(), healthBlock(), aboutBlock()]);
  root.appendChild(stack);
}
