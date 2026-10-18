import { state, api, post, load, clearCache, accounts, followedLeagues, startAutoRefresh } from './store.js';
import { $, el, emptyState, loading, callout, field, signed, headshot, n1, reportClientError } from './ui.js';
import {
  lineupView, matchupView, exposureView, marketView, waiversView, seasonView, leagueView,
} from './views.js';
import { tradesView, advisorView, dynastyView } from './tradeviews.js';
import { newsView, rankingsView, propsView, bettingView, transactionsView } from './research.js';
import { playersView, playerView } from './playerview.js';
import { takesView, takesPreview } from './takesview.js';
import { methodView } from './methodview.js';
import { bracketView } from './bracketview.js';
import { draftRoomView } from './draftroom.js';
import { frontOfficeView } from './frontoffice.js';
import { whatIfView, mountWhatIfBanner } from './whatifview.js';
import { streamView } from './streamview.js';
import { tradeFinderView } from './tradefinder.js';
import { plannerView } from './plannerview.js';
import { oppScoutView } from './oppscout.js';
import { startAlerts, alertsSettingsBlock, alertsPanel } from './alerts.js';
import { contenderBlock, ageProfileBlock, injuryFlagsBlock, historyView } from './homeextras.js';
import { draftView, dfsView, startSitView } from './draftviews.js';
import { communityView } from './community.js';
import { rawIcon } from './icons.js';
import { setTheme, nextTheme, themeLabel, resolvedTheme } from './theme.js';
import { startLive, pokeLive, mountScoreBug, getLive, onLive, weekUnderway } from './live.js';
import { onFieldRows } from './broadcast.js';
import { planView, planPreview } from './planview.js';
import { modelView } from './modelview.js';
import { mountTicker } from './ticker.js';
import { wordmark, riseWords, armReveals, countUp, goArrow } from './motion.js';

// Group, label, and the views inside it. The group id doubles as the band
// colour; `why` is the plain answer each view gives, shown on the home sheet.
const GROUPS = [
  // The plan has its own button in the nav, not a tab: it is the call to action.
  ['plan', 'Game plan', [
    ['plan', 'Game plan', planView, 'Your to-do list for the week'],
  ]],
  ['takes', 'Hot takes', [
    ['takes', 'Hot takes', takesView, 'Reads from real numbers, each with its track record'],
  ]],
  ['whatif', 'What-if lab', [
    ['whatif', 'What-if lab', whatIfView, 'Try a move or pick results; every page follows'],
  ]],
  ['team', 'My team', [
    ['lineup', 'Lineup', lineupView, 'Your best legal lineup'],
    ['planner', 'Bye and injury planner', plannerView, 'Every week left: holes, and the pickup to fill each'],
    ['startsit', 'Start or sit', startSitView, 'Compare any two of your players'],
    ['exposure', 'Exposure', exposureView, 'What each starter is worth to you'],
  ]],
  ['week', 'This week', [
    ['matchup', 'Matchup', matchupView, 'Your chance to win this week'],
    ['scout', 'Scout your opponent', oppScoutView, 'Their weak spots, lineup and waiver habits'],
    ['betting', 'Betting board', bettingView, 'What Vegas expects each team to score'],
    ['props', 'Stat lines', propsView, 'Each player\'s projected stat line'],
  ]],
  ['waivers', 'Waivers', [
    ['waivers', 'Waivers', waiversView, 'Who is free and worth a claim'],
    ['stream', 'Streaming', streamView, 'Kickers and defences for the next three weeks'],
    ['transactions', 'League activity', transactionsView, 'Every add, drop and trade'],
  ]],
  ['trades', 'Trades', [
    ['trades', 'Build a trade', tradesView, 'What a trade does to both lineups'],
    ['tradefinder', 'Trade finder', tradeFinderView, 'Every trade in the league, ranked by your odds'],
    ['market', 'Buy and sell', marketView, 'Who is used more than he scores'],
    ['dynasty', 'Dynasty and picks', dynastyView, 'Future picks, contenders and rebuilders'],
  ]],
  ['league', 'League', [
    ['league', 'Power and benches', leagueView, 'Who is actually strongest'],
    ['season', 'Playoff odds', seasonView, 'Odds, clinch marks and seeds from the real schedule'],
    ['bracket', 'Bracket', bracketView, 'Pick the playoffs; exact title odds'],
    ['history', 'League history', historyView, 'Every past season, all-time records'],
  ]],
  ['research', 'Research', [
    ['rankings', 'Rest-of-season ranks', rankingsView, 'Who is worth most from here'],
    ['players', 'Scouting report', playersView, 'Every player: facts, outlook, game log'],
    ['model', 'Model lab', modelView, 'How accurate the predictions are'],
  ]],
  ['draft', 'Draft', [
    ['draftroom', 'Draft room', draftRoomView, 'Rankings, tiers, mocks and a live assistant'],
    ['draft', 'Draft recap', draftView, 'Steals and reaches from your draft'],
  ]],
  ['dfs', 'Daily fantasy', [
    ['dfs', 'Optimiser', dfsView, 'The best lineup under a salary cap'],
  ]],
  ['feeds', 'Feeds', [
    ['news', 'News', newsView, 'NFL stories, your players first'],
    ['community', 'Community', communityView, 'What r/fantasyfootball is saying'],
  ]],
  ['office', 'Front office', [
    ['frontoffice', 'Front office', frontOfficeView, 'Accounts, refresh, saved data and data health'],
    ['method', 'Under the hood', methodView, 'Where every number comes from'],
  ]],
  ['advisor', 'Advisor', [
    ['advisor', 'Advisor', advisorView, 'Explains and ranks the numbers'],
  ]],
];

const TABS = GROUPS.flatMap(([, , views]) => views);
// The Model lab is private: shown only when the server has it switched on.
const hiddenView = (id) => id === 'model' && !state.overview?.modelLab;
// Views that open with their own visible h2, so the router adds no hidden one.
const SELF_TITLED = new Set(['trades', 'mock', 'dfs', 'startsit', 'search', 'sources', 'advisor', 'plan', 'model', 'players', 'takes', 'method', 'bracket', 'draftroom', 'frontoffice', 'whatif', 'history', 'dynasty', 'stream', 'tradefinder', 'planner', 'scout']);
// A player's own page lives at #player/<id>, inside the scouting report.
const playerId = (viewId) => (/^player\/([0-9]{1,12}|[A-Z]{2,3})$/.exec(viewId || '') || [])[1] || null;
const groupOf = (viewId) => {
  const id = playerId(viewId) ? 'players' : viewId;
  return GROUPS.find(([, , v]) => v.some(([vid]) => vid === id)) || null;
};
const viewOf = (viewId) => {
  const pid = playerId(viewId);
  if (pid) return [viewId, 'Scouting report', (panel) => playerView(panel, pid)];
  return TABS.find(([id]) => id === viewId) || null;
};

// ---------------------------------------------------------------- masthead

function renderAppBar() {
  const bar = $('#appbar');
  bar.textContent = '';
  const o = state.overview;
  // The wordmark is your team, the way a studio's name runs across its site.
  const name = o?.myTeam?.name || o?.league?.name || 'Fantasy sheet';
  const meta = el('p', {
      class: 'masthead-meta',
      text: o
        ? `${o.league.name}, week ${o.week}${o.myTeam ? `. You are ${o.myTeam.record}.` : `. ${o.league.teams} teams.`}`
        : 'Analysis for your Sleeper league, in your league\'s own scoring.',
  });
  bar.appendChild(el('div', { class: 'appbar-inner' }, [
    wordmark(name),
    el('div', { class: 'masthead-row' }, [meta, o ? leaguePicker() : null]),
  ]));
  renderActions();
}

/** The buttons beside the menu: theme, league, and the game plan. */
function renderActions() {
  const o = state.overview;
  const actions = $('#navactions');
  actions.textContent = '';
  actions.appendChild(el('button', {
    class: 'icon-btn circle',
    title: `Theme: ${themeLabel()}. Click to change.`,
    'aria-label': `Theme: ${themeLabel()}. Click to change.`,
    onclick: () => { setTheme(nextTheme()); renderActions(); },
    html: rawIcon(resolvedTheme() === 'dark' ? 'moon' : 'sun'),
  }));
  if (o) {
    actions.appendChild(el('button', { class: 'pill-btn', onclick: switchLeague, text: 'Switch account' }));
    actions.appendChild(el('a', {
      class: 'cta cta-dark', href: '#plan', 'aria-current': state.tab === 'plan' ? 'page' : null,
    }, [el('span', { class: 'cta-label', text: 'Game plan' }), goArrow()]));
  }
}

// Every league this Sleeper account is in, fetched once a session, so any of
// them is one pick away instead of a trip back through the setup screen.
let myLeagues = null;
function leaguePicker() {
  const select = el('select', { class: 'league-pick', 'aria-label': 'League' }, [
    el('option', { value: state.leagueId, text: state.overview?.league?.name || state.leagueName || 'This league' }),
  ]);
  const fill = (leagues) => {
    select.replaceChildren(...leagues.map((l) => el('option', { value: l.id, selected: l.id === state.leagueId, text: l.name })));
  };
  const followed = followedLeagues();
  if (followed.length > 1) { myLeagues = followed; fill(followed); }
  else if (myLeagues) fill(myLeagues);
  else if (state.username) {
    api('leagues', { username: state.username, league: null, roster: null })
      .then((d) => { myLeagues = d.leagues || []; if (myLeagues.length) fill(myLeagues); })
      .catch(() => {});
  }
  select.addEventListener('change', () => {
    const l = (myLeagues || []).find((x) => x.id === select.value);
    if (l && l.id !== state.leagueId) chooseLeague(l);
  });
  return select;
}

// ---------------------------------------------------------------- nav

function renderTabs() {
  const nav = $('#tabs');
  nav.textContent = '';
  if (!state.overview) { nav.hidden = true; return; }
  nav.hidden = false;
  nav.setAttribute('aria-label', 'Sections');

  const advisorOn = Boolean(state.overview.advisor?.enabled);
  const active = groupOf(state.tab);
  if (active) nav.setAttribute('data-band', active[0]);
  else nav.removeAttribute('data-band');

  // Plain links: these change the page, so they are navigation, not tabs.
  // `aria-current` marks the open section and the open view.
  const primary = el('div', { class: 'tab-row primary' });
  primary.appendChild(el('a', {
    href: '#home',
    'data-band': 'home',
    'aria-current': state.tab === 'home' ? 'page' : null,
    text: 'Home',
  }));
  for (const [gid, label, views] of GROUPS) {
    if (gid === 'advisor' && !advisorOn) continue;
    if (gid === 'plan') continue; // it has its own button beside the menu
    const isOpen = active && active[0] === gid;
    primary.appendChild(el('a', {
      href: `#${views[0][0]}`,
      'data-band': gid,
      'aria-current': isOpen ? (views.length === 1 ? 'page' : 'true') : null,
      text: label,
    }));
  }
  nav.appendChild(primary);

  if (active && active[2].length > 1) {
    const secondary = el('div', { class: 'tab-row secondary' });
    for (const [id, label] of active[2]) {
      if (hiddenView(id)) continue;
      secondary.appendChild(el('a', {
        href: `#${id}`,
        'aria-current': state.tab === id || (id === 'players' && playerId(state.tab)) ? 'page' : null,
        text: label,
      }));
    }
    nav.appendChild(secondary);
  }
}

// ---------------------------------------------------------------- home

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};
const plural = (n, one, many) => (n === 1 ? one : many);

function matchupAnswer(winProbability, them) {
  const pct = Math.round(winProbability * 100);
  return { ans: `${pct}%`, tone: pct >= 50 ? 'good' : 'bad', why: `chance to beat ${them}`, them };
}

// The one live answer each view can give on the home sheet. Anything that
// fails to load simply leaves its row without a number; the view explains.
const ANSWERS = {
  lineup: async () => {
    const r = (await load('lineup')).report;
    if (r.error) return null;
    const b = r.pointsLeftOnBench;
    if (b > 0.05) return { ans: signed(b), tone: 'bad', why: 'points left on your bench' };
    // With games under way, "set" can mean no legal move is left rather than
    // that the lineup was already the best one.
    return r.blockedByLocks
      ? { ans: 'Set', tone: 'good', why: 'No moves left: the rest are already playing' }
      : { ans: 'Set', tone: 'good', why: 'Your best lineup is already in' };
  },
  matchup: async () => {
    const r = (await load('matchup')).report;
    if (r.error) return null;
    // Once games start the live feed's chance is the current one (before
    // them the two simulations agree), and the row keeps following it.
    return matchupAnswer(getLive()?.matchup?.winProbability ?? r.winProbability, r.them.teamName);
  },
  waivers: async () => {
    const r = (await load('waivers')).report;
    if (r.emptyMessage) return null;
    const n = r.rows.filter((x) => x.wouldStart).length;
    return n
      ? { ans: String(n), tone: 'good', why: `${plural(n, 'free agent', 'free agents')} would start for you` }
      : { ans: '0', why: 'No free agent beats your starters' };
  },
  transactions: async () => {
    const r = (await load('transactions')).report;
    const n = r.rows.filter((x) => x.week === state.overview.week).length;
    return { ans: String(n), why: `${plural(n, 'move', 'moves')} across the league this week` };
  },
  market: async () => {
    const r = (await load('market')).report;
    if (r.emptyMessage) return null;
    const n = r.sellCandidates.length;
    return n
      ? { ans: String(n), why: `of your players ${plural(n, 'is', 'are')} worth selling high` }
      : { ans: '0', why: 'None of your players are due to sell high' };
  },
  league: async () => {
    const r = (await load('power')).report;
    const mine = r.rows.find((x) => x.isMine);
    if (!mine) return null;
    return { ans: ordinal(mine.rank), why: `power ranking out of ${r.rows.length}` };
  },
  season: async () => {
    const r = (await load('season')).report;
    const mine = r.teams?.find((t) => String(t.rosterId) === String(state.rosterId));
    if (!mine) return null;
    return { ans: `${Math.round(mine.playoffOdds * 100)}%`, why: 'chance to make the playoffs' };
  },
};

function homeView(root) {
  const o = state.overview;
  const advisorOn = Boolean(o.advisor?.enabled);

  for (const w of o.warnings || []) root.appendChild(callout(w, 'amber'));
  root.appendChild(heroSentence());
  root.appendChild(planPreview());
  root.appendChild(alertsPanel());
  root.appendChild(takesPreview(3));
  root.appendChild(el('div', { class: 'home-extras' }, [contenderBlock(), injuryFlagsBlock(), ageProfileBlock()]));
  root.appendChild(onFieldRows());

  const stack = el('div', { class: 'stack' });
  for (const [gid, label, views] of GROUPS) {
    if (gid === 'advisor' && !advisorOn) continue;
    if (gid === 'plan') continue;
    const rows = el('div', { class: 'block-rows' });
    const block = el('section', { class: 'stack-block home-block', 'data-band': gid, 'aria-label': label }, [
      el('div', { class: 'block-head' }, [el('h2', { class: 'block-title', text: label })]),
      rows,
    ]);
    for (const [id, vlabel, , why] of views) {
      if (hiddenView(id)) continue;
      const ans = el('span', { class: 'ans' });
      const note = el('span', { class: 'why', text: why });
      rows.appendChild(el('a', { class: 'play', href: `#${id}` }, [
        el('span', { class: 'what', text: vlabel }), ans, note, goArrow(),
      ]));
      let first = true;
      const show = (a) => {
        ans.textContent = a.ans;
        ans.classList.remove('good', 'bad');
        if (a.tone) ans.classList.add(a.tone);
        note.textContent = a.why;
        if (first) { first = false; countUp(ans); }
      };
      ANSWERS[id]?.().then((a) => {
        if (!a) return;
        show(a);
        if (id !== 'matchup') return;
        const unsub = onLive((data) => {
          if (!ans.isConnected) { unsub(); return; }
          const wp = data?.matchup?.winProbability;
          if (wp != null) show(matchupAnswer(wp, a.them));
        });
      }).catch(() => {});
    }
    stack.appendChild(block);
  }
  root.appendChild(stack);
}

/**
 * The opening line: the week's matchup as one sentence, with your starters'
 * faces set into it the way a studio sets photos between the words of its
 * headline. Before kickoff it is the chance to win; once games start, the
 * score; when they are over, the result. The words rise in once; later polls
 * only change the verb and the numbers.
 */
function heroSentence() {
  const hero = el('section', { class: 'hero', 'aria-label': 'Your matchup' });
  load('matchup').then(({ report: r }) => {
    if (r.error) { hero.appendChild(el('p', { class: 'hero-sub', text: r.error })); return; }
    const faces = (side) => el('span', { class: 'faces' },
      [...side.starters].sort((x, y) => y.projected - x.projected).slice(0, 3).map((p) => headshot(p, { size: 72 })));
    const myFaces = faces(r.me);
    const theirFaces = faces(r.them);
    const line = el('h2', { class: 'hero-title' });
    let said = '';
    // Rebuilt as words each time, so the line wraps between any two of them;
    // only the first build rises in, later ones just change the words.
    const say = (verb, tail) => {
      const text = `${r.me.teamName} ${verb} ${r.them.teamName} ${tail}`;
      if (text === said) return;
      const first = !said;
      said = text;
      line.removeAttribute('aria-label');
      line.replaceChildren(r.me.teamName, ' ', myFaces, ` ${verb} ${r.them.teamName} `, theirFaces, ` ${tail}`);
      riseWords(line, { step: 70 });
      line.classList.toggle('settled', !first);
    };
    const go = el('button', {
      class: 'hero-go', type: 'button', 'aria-label': 'Jump to your game plan',
      onclick: () => document.querySelector('.plan-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, [goArrow({ dir: 'down' })]);
    hero.append(el('p', { class: 'kicker', text: `Week ${r.week}` }), line, go);

    const apply = (data) => {
      const m = data?.matchup;
      let v; let t;
      if (m && weekUnderway(m)) {
        const done = (m.me.starters || []).concat(m.them.starters || []).every((p) => p.gameState === 'post' || p.gameState == null);
        const ahead = m.me.points >= m.them.points;
        v = done ? (ahead ? 'beat' : 'lost to') : (ahead ? 'leads' : 'trails');
        t = `${n1(m.me.points)} to ${n1(m.them.points)}.`;
      } else {
        const wp = m?.winProbability ?? r.winProbability;
        v = 'takes on';
        t = `with a ${Math.round(wp * 100)}% chance to win.`;
      }
      say(v, t);
    };
    apply(getLive());
    const unsub = onLive((data) => { if (!hero.isConnected) { unsub(); return; } apply(data); });
  }).catch((err) => hero.appendChild(el('p', { class: 'hero-sub', text: `The matchup did not load. ${err.message}` })));
  return hero;
}

// ---------------------------------------------------------------- footer

function renderFooter() {
  const foot = $('#foot');
  foot.textContent = '';
  foot.appendChild(el('span', { text: 'Data from Sleeper, nflverse, DynastyProcess, ESPN, Reddit and Open-Meteo, saved on this computer between visits.' }));
  foot.appendChild(el('button', {
    class: 'btn ghost',
    style: 'margin-left:auto',
    onclick: async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Refreshing…';
      try {
        await post('clear-cache', {});
        clearCache();
        state.overview = null;
        await boot();
      } finally {
        e.target.disabled = false;
        e.target.textContent = 'Refresh data';
      }
    },
  }, ['Refresh data']));
}

// ---------------------------------------------------------------- setup

const STATUS = { pre_draft: 'not drafted yet', drafting: 'drafting now', in_season: 'in season', complete: 'season over' };

function setupScreen(message = null) {
  const main = $('#main');
  main.textContent = '';
  const box = el('div', { class: 'setup' });
  const card = el('div', { class: 'card' });

  card.appendChild(el('h2', { class: 'section-title', text: 'Connect your league' }));
  card.appendChild(el('p', { class: 'section-note', text: 'Enter the Sleeper username you play under. Nothing is sent anywhere except Sleeper\'s public API.' }));
  if (message) card.appendChild(callout(message, 'warn'));

  const input = el('input', { type: 'text', value: state.username, placeholder: 'your Sleeper username', autocapitalize: 'none', spellcheck: 'false' });
  const list = el('div', { class: 'league-list' });
  const button = el('button', { class: 'btn' }, ['Find my leagues']);

  const find = async () => {
    const username = input.value.trim();
    if (!username) return;
    list.textContent = '';
    list.appendChild(loading('Looking up your leagues…'));
    try {
      const data = await api('leagues', { username, league: null, roster: null });
      list.textContent = '';
      state.username = username;
      localStorage.setItem('ff.username', username);

      if (!data.leagues.length) {
        list.appendChild(emptyState('No leagues found',
          `Sleeper has no ${data.season} NFL leagues for "${username}". Check the spelling.`));
        return;
      }
      for (const l of data.leagues) {
        list.appendChild(el('button', { onclick: () => chooseLeague(l) }, [
          el('div', { class: 'lname', text: l.name }),
          el('div', { class: 'lmeta', text: `${l.teams} teams, ${l.scoringType}${STATUS[l.status] ? `, ${STATUS[l.status]}` : ''}` }),
        ]));
      }
    } catch (err) {
      list.textContent = '';
      list.appendChild(emptyState('Could not look that up', err.message));
    }
  };

  button.addEventListener('click', find);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });

  card.appendChild(field('Sleeper username', input));
  card.appendChild(el('div', { style: 'margin-top:14px' }, [button]));
  card.appendChild(list);
  box.appendChild(card);
  main.appendChild(box);
  input.focus();
}

function chooseLeague(league) {
  // Keep the linked-accounts list (front office) in step with the choice.
  try {
    accounts.add(state.username);
    const followed = accounts.followedLeagues();
    if (!followed.some((l) => l.id === league.id)) accounts.setFollowed(state.username, [...followed, { id: league.id, name: league.name, season: league.season }]);
    accounts.selectLeague(league.id);
  } catch { /* storage blocked: the plain keys below still work */ }
  state.leagueId = league.id;
  state.leagueName = league.name;
  localStorage.setItem('ff.leagueId', league.id);
  localStorage.setItem('ff.leagueName', league.name);
  clearCache();
  state.overview = null;
  location.hash = 'home';
  boot();
}

function switchLeague() {
  state.leagueId = '';
  state.overview = null;
  localStorage.removeItem('ff.leagueId');
  clearCache();
  renderAppBar();
  renderTabs();
  setupScreen();
}

// ---------------------------------------------------------------- routing

function route({ userNavigated = false } = {}) {
  const main = $('#main');
  if (!state.overview) return;

  // Pages that moved keep their old links working.
  const MOVED = { mock: 'draftroom', sources: 'frontoffice', search: 'players' };
  if (MOVED[state.tab]) { state.tab = MOVED[state.tab]; history.replaceState(null, '', `#${state.tab}`); }
  if (state.tab !== 'home' && (!viewOf(state.tab) || hiddenView(state.tab))) state.tab = 'home';
  renderTabs();
  main.textContent = '';
  // Views clear their own container, so the view's heading sits just outside
  // it — unless the view prints its own title, which would say it twice.
  const title = state.tab === 'home' ? 'This week at a glance' : viewOf(state.tab)[1];
  if (!SELF_TITLED.has(state.tab) && !playerId(state.tab)) main.appendChild(el('h2', { class: 'visually-hidden', text: title }));
  document.title = state.tab === 'home'
    ? `${state.overview.league.name} | Fantasy Sheet`
    : `${title} | Fantasy Sheet`;
  const panel = el('section', { class: 'panel', 'aria-label': title, tabindex: '-1' });
  main.appendChild(panel);

  if (state.tab === 'home') homeView(panel);
  else viewOf(state.tab)[2](panel);
  renderActions(); // the plan button marks itself as the current page
  window.scrollTo(0, 0);
  // A new view replaces the page. Start focus there, so keyboard and screen-
  // reader users land on it rather than on a nav link that was just redrawn.
  // Unless the view already put focus somewhere useful (search focuses its box).
  if (userNavigated && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
}

/**
 * A data table may scroll sideways on a narrow screen (WCAG 1.4.10 allows it
 * for tables), but a scrolling box must be reachable by keyboard. Any table
 * box that actually overflows becomes a focusable, labelled region; one that
 * fits is left alone, so it adds no tab stop.
 */
function markScrollableTables() {
  for (const box of document.querySelectorAll('#main .table-scroll')) {
    const scrolls = box.scrollWidth > box.clientWidth + 1;
    if (scrolls && !box.hasAttribute('tabindex')) {
      box.setAttribute('tabindex', '0');
      box.setAttribute('role', 'region');
      box.setAttribute('aria-label', tableLabel(box));
    } else if (!scrolls && box.hasAttribute('tabindex')) {
      box.removeAttribute('tabindex');
      box.removeAttribute('role');
      box.removeAttribute('aria-label');
    }
  }
}
/** A scrolling table's name: its caption, or the nearest heading above it. */
function tableLabel(box) {
  const caption = box.querySelector('caption')?.textContent;
  if (caption) return caption;
  for (let n = box.previousElementSibling; n; n = n.previousElementSibling) {
    if (/^H[2-4]$/.test(n.tagName)) return n.textContent;
  }
  return 'Table';
}
let markQueued = false;
const queueMark = () => {
  if (markQueued) return;
  markQueued = true;
  requestAnimationFrame(() => { markQueued = false; markScrollableTables(); });
};
new MutationObserver(() => { queueMark(); armReveals($('#main')); }).observe($('#main'), { childList: true, subtree: true });
window.addEventListener('resize', queueMark);

window.addEventListener('hashchange', () => {
  state.tab = location.hash.slice(1) || 'home';
  route({ userNavigated: true });
});


let liveStarted = false;

async function boot() {
  renderAppBar();
  renderFooter();
  if (!state.tab) state.tab = 'home';

  if (!state.leagueId) {
    renderTabs();
    setupScreen();
    return;
  }

  const main = $('#main');
  // Draw at once from the last overview this browser saw for the league, then
  // swap in the fresh one: no blank wait while the server builds the league.
  const savedKey = `ff.overview.${state.leagueId}`;
  let saved = null;
  try {
    const raw = JSON.parse(localStorage.getItem(savedKey) || 'null');
    if (raw && Date.now() - raw.at < 24 * 60 * 60_000 && raw.data?.league) saved = raw.data;
  } catch { /* no saved copy */ }
  const sig = (o) => JSON.stringify([o?.league?.week, o?.myTeam?.rosterId, o?.myTeam?.record, o?.league?.name]);
  if (saved) {
    state.overview = saved;
    state.rosterId = saved.myTeam?.rosterId ?? null;
    renderAppBar();
    route();
  } else {
    main.textContent = '';
    main.appendChild(loading('Loading your league. The first run pulls a few megabytes of player data…'));
  }

  try {
    const fresh = await api('overview');
    try { localStorage.setItem(savedKey, JSON.stringify({ at: Date.now(), data: fresh })); } catch { /* storage full or blocked */ }
    const changed = !saved || sig(saved) !== sig(fresh);
    state.overview = fresh;
    state.rosterId = fresh.myTeam?.rosterId ?? null;
    renderAppBar();
    if (changed) route();
    // /api/live needs a league to mean anything; start polling once one is
    // chosen, and re-poll immediately on every later league switch rather
    // than showing the outgoing league's scores for up to 5 more minutes.
    if (!liveStarted) { liveStarted = true; startLive(); } else { pokeLive(); }
  } catch (err) {
    // With a saved copy on screen, keep it and say the numbers may be old.
    if (saved) {
      $('#alert').textContent = `Showing your last saved view; could not refresh: ${err.message}`;
      return;
    }
    state.overview = null;
    renderAppBar();
    renderTabs();
    setupScreen(`Could not load that league: ${err.message}`);
  }
}

mountScoreBug($('#scorebug'));
mountTicker($('#ticker'));
// The menu sticks just under the ticker, wherever the ticker's height lands.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--tk-h', `${$('#ticker').offsetHeight}px`);
}).observe($('#ticker'));
state.tab = location.hash.slice(1) || 'home';
// The front office changes accounts and leagues; follow it from here.
window.addEventListener('ff:account-changed', () => {
  myLeagues = null;
  renderAppBar();
  if (state.leagueId) { location.hash = 'home'; boot(); } else { renderTabs(); setupScreen(); }
});
// Auto-refresh on open, at the interval set in the front office (off by default).
startAutoRefresh(() => { if (!state.leagueId) return; clearCache(); route(); });
// A what-if changes every page: redraw the one on screen (the lab redraws itself).
window.addEventListener('ff:whatif-changed', (e) => {
  if (e.detail?.reason) $('#alert').textContent = `${e.detail.reason} The what-if was cleared.`;
  if (state.overview && state.tab !== 'whatif') route();
});
mountWhatIfBanner($('#whatif-banner'));
// Script errors anywhere reach the server log too, so a page that breaks in
// one browser can be diagnosed from the log.
window.addEventListener('error', (e) => reportClientError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportClientError('promise', e.reason));
// Game-day alerts: check your starters while the tab is open (notifications only if you turned them on).
startAlerts();
// Offline: the worker keeps the app and the last answers for each page.
window.addEventListener('ff:offline', () => { $('#offline-note').hidden = false; });
window.addEventListener('online', () => { $('#offline-note').hidden = true; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* no offline copy, nothing else changes */ });
boot();
