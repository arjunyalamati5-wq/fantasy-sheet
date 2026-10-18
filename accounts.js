// Linked Sleeper accounts, kept on this device only. Pure logic over an
// injected storage object, so it runs (and is tested) without a browser.
//
// Keys: ff.accounts = [{ username, userId?, followed: [{ id, name, season }] }],
// ff.activeAccount = username. ff.username / ff.leagueId / ff.leagueName stay
// in step, because the rest of the app reads those three.

export const USERNAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const K = { accounts: 'ff.accounts', active: 'ff.activeAccount', username: 'ff.username', leagueId: 'ff.leagueId', leagueName: 'ff.leagueName' };

const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');

export function cleanAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || !USERNAME_RE.test(str(a.username, 41))) continue;
    const key = a.username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const followed = (Array.isArray(a.followed) ? a.followed : [])
      .filter((l) => l && /^\d{1,24}$/.test(String(l.id ?? '')))
      .map((l) => ({ id: String(l.id), name: str(l.name) || 'League', season: str(String(l.season ?? ''), 4) }));
    out.push({ username: a.username, userId: a.userId ? String(a.userId).slice(0, 24) : undefined, followed });
  }
  return out;
}

export function createAccountStore(storage) {
  const read = (k) => { try { return storage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { if (v === null || v === undefined || v === '') storage.removeItem(k); else storage.setItem(k, v); } catch { /* private window: it just does not stick */ } };

  function list() {
    let parsed = null;
    try { parsed = JSON.parse(read(K.accounts)); } catch { /* corrupt: start over */ }
    let accounts = cleanAccounts(parsed);
    if (!accounts.length && !Array.isArray(parsed) && read(K.username) && USERNAME_RE.test(read(K.username))) {
      // An app that only ever knew one username: adopt it, with its league.
      const id = read(K.leagueId);
      accounts = [{ username: read(K.username), followed: id && /^\d+$/.test(id) ? [{ id, name: read(K.leagueName) || 'League', season: '' }] : [] }];
    }
    return accounts;
  }
  const save = (accounts) => write(K.accounts, JSON.stringify(accounts));
  const find = (accounts, name) => accounts.find((a) => a.username.toLowerCase() === String(name).toLowerCase());

  function active() {
    const accounts = list();
    return find(accounts, read(K.active)) || accounts[0] || null;
  }

  /** Point ff.username and the league keys at the active account. */
  function sync() {
    const a = active();
    if (!a) { write(K.active, null); write(K.username, null); write(K.leagueId, null); write(K.leagueName, null); return null; }
    write(K.active, a.username);
    write(K.username, a.username);
    const cur = a.followed.find((l) => l.id === read(K.leagueId));
    const pick = cur || a.followed[0] || null;
    write(K.leagueId, pick ? pick.id : null);
    write(K.leagueName, pick ? pick.name : null);
    return a;
  }

  return {
    list, active, sync,
    activeUsername: () => active()?.username || '',
    followedLeagues: () => active()?.followed || [],

    /** Add (or re-select) an account and make it the active one. */
    add(username, { userId } = {}) {
      const name = String(username ?? '').trim();
      if (!name) return { ok: false, error: 'Enter a Sleeper username.' };
      if (!USERNAME_RE.test(name)) return { ok: false, error: 'Sleeper usernames use letters, numbers, underscores, dots and dashes only.' };
      const accounts = list();
      const existing = find(accounts, name);
      if (existing) { if (userId) existing.userId = String(userId); }
      else accounts.push({ username: name, userId: userId ? String(userId) : undefined, followed: [] });
      save(accounts);
      write(K.active, (existing || find(accounts, name)).username);
      sync();
      return { ok: true, existed: Boolean(existing), account: find(list(), name) };
    },

    setFollowed(username, leagues) {
      const accounts = list();
      const a = find(accounts, username);
      if (!a) return { ok: false, error: 'That account is not saved on this device.' };
      a.followed = cleanAccounts([{ username: a.username, followed: leagues }])[0].followed;
      save(accounts);
      sync();
      return { ok: true };
    },

    switchTo(username) {
      const a = find(list(), username);
      if (!a) return { ok: false, error: 'That account is not saved on this device.' };
      write(K.active, a.username);
      write(K.leagueId, null); // the new account's first followed league, not the old one's
      sync();
      return { ok: true };
    },

    /** Choose which followed league the app shows. */
    selectLeague(id) {
      const l = active()?.followed.find((x) => x.id === String(id));
      if (!l) return { ok: false };
      write(K.leagueId, l.id);
      write(K.leagueName, l.name);
      return { ok: true };
    },

    remove(username) {
      const accounts = list().filter((a) => a.username.toLowerCase() !== String(username).toLowerCase());
      save(accounts);
      if (read(K.username)?.toLowerCase() === String(username).toLowerCase()) { write(K.username, null); write(K.leagueId, null); write(K.leagueName, null); }
      if (read(K.active)?.toLowerCase() === String(username).toLowerCase()) { write(K.active, null); write(K.leagueId, null); }
      sync();
      return { ok: true, remaining: accounts.length };
    },

    /** Remove the active account and every saved trace of it on this device. */
    signOut() {
      const a = active();
      if (a) this.remove(a.username);
      if (!list().length) { save([]); write(K.active, null); write(K.username, null); write(K.leagueId, null); write(K.leagueName, null); }
      return { ok: true, remaining: list().length };
    },
  };
}

/** Refresh intervals the schedule offers, in minutes. 0 is off. */
export const REFRESH_CHOICES = [0, 5, 15, 60];
export const normalizeInterval = (v) => { const n = Number(v); return REFRESH_CHOICES.includes(n) ? n : 0; };
