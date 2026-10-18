// Game-day alerts. startAlerts() polls GET /api/alerts while the tab is
// visible, notifies once per alert (browser notification if the person
// allowed it, otherwise an in-page toast), and never asks for permission on
// its own: only the button in alertsSettingsBlock() does.

import { api, state } from './store.js';
import { el } from './ui.js';

const DEFAULT_MS = 15 * 60_000;
const MIN_MS = 60_000;

let latest = null;
let timer = null;
let started = false;
const listeners = new Set();

const seenKey = () => `ff.alerts.seen.${state.leagueId}`;
function readSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || '[]')); } catch { return new Set(); }
}
function writeSeen(set) {
  try { localStorage.setItem(seenKey(), JSON.stringify([...set].slice(-200))); } catch { /* private window */ }
}

export function permissionState() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission; // granted | denied | default
}

const stateWords = () => ({
  granted: 'On. You will get a notification when one of your starters is ruled out.',
  denied: 'Blocked by the browser. Allow notifications for this site in the browser settings; until then alerts show inside the page.',
  default: 'Off. Alerts show inside the page while it is open.',
  unsupported: 'Not supported in this browser. Alerts show inside the page while it is open.',
})[permissionState()];

function swapLine(a) {
  const s = a.swap;
  if (!s) return 'No available player fits that slot.';
  const gain = s.pointsGained >= 0 ? `+${s.pointsGained.toFixed(1)}` : s.pointsGained.toFixed(1);
  return `Start ${s.in.name} (${s.in.source}) instead${s.out ? ` of ${s.out.name}` : ''}: ${gain} projected points.`;
}

// ------------------------------------------------------------------ notify

async function notify(a) {
  const body = `${a.text} ${swapLine(a)}`;
  if (permissionState() === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.showNotification('Game-day alert', { body, tag: a.id, icon: '/favicon.ico', data: { url: '/#lineup' } });
        return;
      }
      new Notification('Game-day alert', { body, tag: a.id });
      return;
    } catch { /* fall through to the toast */ }
  }
  toast(a, body);
}

function toastHost() {
  let host = document.getElementById('alert-toasts');
  if (!host) {
    host = el('div', { id: 'alert-toasts', class: 'alert-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
}

function toast(a, body) {
  const node = el('div', { class: `alert-toast is-${a.level}` }, [
    el('p', { text: body }),
    el('div', { class: 'alert-actions' }, [
      el('a', { href: '#lineup', text: 'Open lineup', onclick: () => node.remove() }),
      el('button', { type: 'button', text: 'Dismiss', 'aria-label': 'Dismiss alert', onclick: () => node.remove() }),
    ]),
  ]);
  toastHost().appendChild(node);
}

// ------------------------------------------------------------------ polling

export function getAlerts() { return latest; }
export function onAlerts(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function checkAlerts() {
  if (!state.leagueId) return null;
  try {
    latest = await api('alerts', { wi: null });
  } catch { return null; }
  const seen = readSeen();
  const fresh = (latest.alerts || []).filter((a) => a.level !== 'info' && !seen.has(a.id));
  for (const a of fresh) { seen.add(a.id); await notify(a); }
  if (fresh.length) writeSeen(seen);
  for (const fn of listeners) { try { fn(latest); } catch { /* a dead panel */ } }
  return latest;
}

function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;
  const ms = Math.max(MIN_MS, Number(latest?.nextCheckMs) || DEFAULT_MS);
  timer = setTimeout(async () => { await checkAlerts(); schedule(); }, ms);
}

/** Call once after boot. Safe to call twice. */
export function startAlerts() {
  if (started) return;
  started = true;
  const kick = async () => { await checkAlerts(); schedule(); };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer); else kick();
  });
  kick();
}

// ------------------------------------------------------------------ views

/** A small sheet with the on/off button, the state in words, and a test button. */
export function alertsSettingsBlock() {
  const status = el('p', { class: 'alerts-state', role: 'status', text: stateWords() });
  const enable = el('button', { type: 'button', class: 'alerts-btn', text: 'Turn on game-day alerts', onclick: async () => {
    if (permissionState() === 'unsupported') return;
    try { await Notification.requestPermission(); } catch { /* old browsers use a callback form */ }
    status.textContent = stateWords();
    sync();
  } });
  const test = el('button', { type: 'button', class: 'alerts-btn', text: 'Send a test alert', onclick: () => notify({
    id: `test:${Date.now()}`, level: 'info', text: 'This is a test. A real alert names the starter and the swap to make.',
    swap: null,
  }) });
  const sync = () => {
    enable.disabled = ['granted', 'denied', 'unsupported'].includes(permissionState());
  };
  sync();
  return el('section', { class: 'alerts-sheet', 'aria-labelledby': 'alerts-h' }, [
    el('h3', { id: 'alerts-h', text: 'Game-day alerts' }),
    el('p', { class: 'alerts-lede', text: 'Hear about it before kickoff when a starter is ruled out, with the swap to make. Checks every 15 minutes, every 2 minutes near kickoff, while this page is open.' }),
    status,
    el('div', { class: 'alert-actions' }, [enable, test]),
  ]);
}

/** The current alerts as a list, each with the swap and a link to the lineup. Refreshes itself. */
export function alertsPanel(root = el('section', { class: 'alerts-panel', 'aria-label': 'Current alerts' })) {
  const draw = (data) => {
    root.replaceChildren();
    const list = data?.alerts || [];
    if (!list.length) {
      root.appendChild(el('p', { class: 'alerts-none', text: data ? 'No alerts. Every starter who has not kicked off looks fine.' : 'Checking your starters…' }));
      return;
    }
    root.appendChild(el('ul', { class: 'alerts-list' }, list.map((a) => el('li', { class: `alert-row is-${a.level}` }, [
      el('strong', { text: a.text }),
      el('span', { class: 'alert-swap', text: swapLine(a) }),
      a.swap ? el('a', { href: '#lineup', text: 'Make this swap' }) : null,
    ]))));
  };
  draw(latest);
  const off = onAlerts((d) => { if (root.isConnected) draw(d); else off(); });
  if (!latest) checkAlerts();
  return root;
}
