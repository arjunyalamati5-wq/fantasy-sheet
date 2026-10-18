// The bracket: Sleeper's real playoff bracket when it exists (finished games
// locked, the rest yours to pick), otherwise the projected one from the
// simulation, with exact title odds beside every team and a losers bracket below.

import { load } from './store.js';
import { el, frag, emptyState, loading, announce, field, callout, warningsBlock } from './ui.js';
import { riseWords } from './motion.js';
import { block } from './seg.js';
import { upsetControl, readUpset, saveUpset } from './playoffpicture.js';

const STYLE_OPTIONS = [
  ['sleeper', 'Follow Sleeper’s own'],
  ['toilet', 'Toilet bowl (losers advance)'],
  ['consolation', 'Consolation (winners advance)'],
];

const pctText = (p) => {
  if (p === null || p === undefined) return '';
  if (p > 0 && p < 0.005) return '<1%';
  if (p > 0.995 && p < 1) return '>99%';
  return `${Math.round(p * 100)}%`;
};

function readStyle() {
  try {
    const v = localStorage.getItem('ff.losers');
    return STYLE_OPTIONS.some(([k]) => k === v) ? v : 'toilet';
  } catch { return 'toilet'; }
}

/** The picks as the API takes them: round-game:team, comma separated. */
const picksParam = (picks) => picks.map((p) => `${p.game}:${p.rosterId}`).join(',');

export function bracketView(root) {
  root.textContent = '';
  root.appendChild(riseWords(el('h2', { class: 'hero-title', text: 'The bracket' })));
  const body = el('div', { class: 'bk-page' });
  root.appendChild(body);

  const st = { picks: [], style: readStyle(), upset: readUpset(), data: null, seq: 0 };

  const bodyHost = el('div', { class: 'bk-body' });
  const controls = el('div', { class: 'bk-controls' });
  body.append(controls, bodyHost);

  const reset = el('button', {
    type: 'button', class: 'mini bk-reset', text: 'Reset picks', disabled: true,
    onclick: () => { st.picks = []; refresh('Picks cleared.'); },
  });
  const styleSelect = el('select', {
    id: 'bk-style',
    onchange: () => {
      st.style = styleSelect.value;
      try { localStorage.setItem('ff.losers', st.style); } catch { /* not remembered */ }
      refresh();
    },
  }, STYLE_OPTIONS.map(([v, label]) => el('option', { value: v, text: label, selected: v === st.style })));

  controls.append(
    upsetControl({
      value: st.upset,
      onChange: (v) => { st.upset = v; saveUpset(v); refresh(); },
      id: 'bk-upset',
    }),
    field('Losers bracket style', styleSelect, { class: 'field bk-style-field' }),
    reset,
  );

  async function refresh(message) {
    const mine = ++st.seq;
    // Keep the place on screen: the scroll offsets and whichever team had focus.
    const scrolls = [...bodyHost.querySelectorAll('.bk-scroll')].map((n) => n.scrollLeft);
    const focused = document.activeElement?.dataset?.key;
    if (!st.data) { bodyHost.textContent = ''; bodyHost.appendChild(loading('Walking every possible bracket…')); }
    else bodyHost.setAttribute('aria-busy', 'true');
    try {
      const data = await load('bracket', { picks: picksParam(st.picks) || null, losers: st.style, upset: st.upset });
      if (mine !== st.seq) return;
      st.data = data;
      // Keep only picks the server could use (a changed pick can orphan later ones).
      st.picks = [...games(data.winners), ...games(data.losers)]
        .filter((g) => g.picked && g.forcedTo != null)
        .map((g) => ({ game: g.id, rosterId: g.forcedTo }));
      reset.disabled = st.picks.length === 0;
      bodyHost.removeAttribute('aria-busy');
      bodyHost.textContent = '';
      bodyHost.appendChild(render(data));
      [...bodyHost.querySelectorAll('.bk-scroll')].forEach((n, i) => { n.scrollLeft = scrolls[i] || 0; });
      if (focused) bodyHost.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
      if (message) announce(message);
    } catch (err) {
      if (mine !== st.seq) return;
      bodyHost.removeAttribute('aria-busy');
      bodyHost.textContent = '';
      bodyHost.appendChild(emptyState('That did not load', err.message));
      announce(`That did not load. ${err.message}`, { assertive: true });
      console.error(err);
    }
  }

  function render(data) {
    const out = frag([warningsBlock()]);
    out.appendChild(sourceNote(data));
    if (!data.winners) {
      out.appendChild(emptyState('No bracket yet', 'This league has fewer than two playoff teams, so there is nothing to draw.'));
      return out;
    }
    out.appendChild(block({
      band: 'league', id: 'bk-winners', title: 'Winners bracket',
      note: data.winners.reseed ? 'This league reseeds: after the first round the best seed left plays the worst.' : null,
    }, [bracketTree(data.winners, data.titleOdds, 'winners')]));
    if (data.losers) {
      const toilet = data.losers.style === 'toilet';
      out.appendChild(block({
        band: 'week', id: 'bk-losers',
        title: toilet ? 'Toilet bowl' : 'Consolation bracket',
        note: toilet
          ? 'The teams that missed the playoffs. The loser of each game advances, and the team that loses every round is crowned the worst team in the league. Click the team that gets flushed.'
          : 'The teams that missed the playoffs. Winners advance.',
      }, [bracketTree(data.losers, toilet ? data.worstOdds : {}, 'losers')]));
    }
    out.appendChild(el('p', { class: 'sp-legend' }, [
      el('strong', { text: 'How this is worked out: ' }),
      'the bracket is built from the seeds and your league’s own playoff settings: byes for the top seeds when the field is not a power of two, the usual 1v8, 4v5, 3v6, 2v7 pairings, and reseeding if the league reseeds. ',
      'Each round is scored like a regular-season game, from each team’s expected lineup points in the round’s playoff week and the same weekly spread; a two-week round adds the two weeks’ points and the variances. ',
      'The title odds on the bracket are exact (every possible set of results is walked), so they add to 100%. ',
      'The standings’ title column comes from the season simulation instead, which plays the playoffs inside every simulated season.',
    ]));
    return out;
  }

  function sourceNote(data) {
    const sleeper = data.source === 'sleeper';
    const parts = [
      sleeper
        ? 'From Sleeper’s bracket: games already played are locked, the rest are yours to pick.'
        : 'Sleeper has no bracket yet, so this is the projected one: seeds from the simulation.',
    ];
    if (!sleeper) parts.push('Each team’s most likely seed from the simulation, filled from the likeliest pairing down so no two teams share a seed.');
    const wrap = el('div', { class: 'bk-source' }, [
      el('span', { class: `tag ${sleeper ? 'pine' : 'amber'}`, text: sleeper ? 'Sleeper bracket' : 'Projected' }),
      el('p', { text: parts.join(' ') }),
    ]);
    if (sleeper && data.winners && data.winners.locksMatch === false) {
      return frag([wrap, callout('Sleeper’s first-round pairings differ from the seeds worked out here, so some finished games may not be locked in. Picks still work.', 'amber')]);
    }
    return wrap;
  }

  function togglePick(game, team) {
    const same = st.picks.find((p) => p.game === game.id && String(p.rosterId) === String(team.rosterId));
    st.picks = st.picks.filter((p) => p.game !== game.id);
    if (!same) st.picks.push({ game: game.id, rosterId: team.rosterId });
    refresh(same ? `Pick removed for ${team.name}.` : `Picked ${team.name} in round ${game.round}, game ${game.m}.`);
  }

  function teamButton(game, slot, odds, kind, bracket) {
    // A team in a later round with no game feeding it got there on a bye.
    const isBye = game.round > 1 && !slot.from && !slot.reseed && slot.seed != null;
    const advancing = game.forcedTo != null && String(game.forcedTo) === String(slot.rosterId);
    const verb = kind === 'losers' && bracket.style === 'toilet' ? 'gets flushed' : 'advances';
    const label = `${slot.name}${slot.seed ? `, seed ${slot.seed}` : ''}${odds[slot.rosterId] != null ? `, ${pctText(odds[slot.rosterId])} to ${kind === 'losers' && bracket.style === 'toilet' ? 'be crowned worst' : 'win it all'}` : ''}`;
    const btn = el('button', {
      type: 'button', class: `bk-team${advancing ? ' is-advancing' : ''}`,
      'aria-pressed': String(advancing),
      'aria-label': `${label}. ${game.locked ? 'Final result.' : `Press to pick this team as the one that ${verb}.`}`,
      'data-key': `${game.id}:${slot.rosterId}:${kind}`,
      disabled: game.locked ? true : null,
      onclick: () => togglePick(game, { rosterId: slot.rosterId, name: slot.name }),
    }, [
      el('span', { class: 'bk-seed', 'aria-hidden': 'true', text: slot.seed ? String(slot.seed) : '·' }),
      el('span', { class: 'bk-name' }, [
        el('span', { class: 'bk-tname', text: slot.name }),
        isBye ? el('span', { class: 'bk-flag', text: 'Bye' }) : null,
        advancing ? el('span', { class: 'bk-flag', text: game.locked ? (verb === 'advances' ? 'Won' : 'Moves on') : 'Picked' }) : null,
      ]),
      el('span', { class: 'bk-odds', 'aria-hidden': 'true', text: odds[slot.rosterId] != null ? pctText(odds[slot.rosterId]) : '' }),
    ]);
    return btn;
  }

  function openSlot(slot, game, bracket) {
    let heading;
    if (slot.from) heading = `Winner of game ${slot.from}`;
    else if (slot.reseed) heading = slot.reseed === 'higher' ? 'Best seed left' : 'Lowest seed left';
    else heading = 'To be decided';
    if (slot.from && bracket.advance === 'loser') heading = `Moves on from game ${slot.from}`;
    const top = (slot.candidates || []).slice(0, 3);
    return el('div', { class: 'bk-open' }, [
      el('span', { class: 'bk-open-title', text: heading }),
      top.length
        ? el('ul', { class: 'bk-cands', 'aria-label': 'Most likely teams here' }, top.map((c) =>
          el('li', {}, [el('span', { text: c.name }), el('span', { class: 'bk-cand-p', text: ` ${pctText(c.p)}` })])))
        : null,
    ]);
  }

  function bracketTree(bracket, odds, kind) {
    const scroll = el('div', {
      class: 'bk-scroll', tabindex: '0', role: 'region',
      'aria-label': `${kind === 'losers' ? 'Losers' : 'Winners'} bracket, scrolls sideways`,
    });
    const tree = el('div', { class: 'bk' });
    const rounds = bracket.rounds;
    rounds.forEach((rd, ri) => {
      const next = rounds[ri + 1];
      const joins = next && rd.games.length === next.games.length * 2;
      const weeks = rd.weeks.length === 1 ? `Week ${rd.weeks[0]}` : `Weeks ${rd.weeks[0]} and ${rd.weeks[rd.weeks.length - 1]}`;
      const col = el('section', { class: `bk-round${joins ? ' joins' : ''}`, 'aria-labelledby': `bk-${kind}-r${rd.round}` }, [
        el('h4', { id: `bk-${kind}-r${rd.round}`, class: 'bk-round-title' }, [
          el('span', { text: rd.name }), el('span', { class: 'bk-weeks', text: weeks }),
        ]),
        el('ol', { class: 'bk-games' }, rd.games.map((g) => {
          const slots = g.slots.map((s) => (s.rosterId ? teamButton(g, s, odds, kind, bracket) : openSlot(s, g, bracket)));
          return el('li', { class: 'bk-li' }, [
            el('div', {
              class: `bk-game${g.locked ? ' is-locked' : ''}`, role: 'group',
              'aria-label': `${rd.name}, game ${g.m}${g.locked ? ', finished' : ''}`,
            }, [
              ...slots,
              g.locked ? el('span', { class: 'bk-lock', text: 'Final' }) : null,
            ]),
          ]);
        })),
      ]);
      tree.appendChild(col);
    });

    // The last slot: who takes the whole thing.
    const toilet = kind === 'losers' && bracket.style === 'toilet';
    const heading = kind === 'winners' ? 'Wins the whole thing'
      : toilet ? 'Crowned the worst team in the league' : 'Consolation champion';
    const champs = bracket.champion.filter((c) => c.p > 0).slice(0, 6);
    const top = champs[0];
    tree.appendChild(el('section', { class: 'bk-round bk-champ', 'aria-labelledby': `bk-${kind}-champ` }, [
      el('h4', { id: `bk-${kind}-champ`, class: 'bk-round-title' }, [el('span', { text: heading })]),
      el('div', { class: 'bk-trophy' }, [
        top && top.p > 0.999999
          ? el('p', { class: 'bk-crowned' }, [el('strong', { text: top.name }), toilet ? ' is flushed all the way.' : ' takes it.'])
          : el('ol', { class: 'bk-contenders' }, champs.map((c) => el('li', {}, [
            el('span', { class: 'bk-c-name', text: c.name }),
            el('span', { class: 'bk-c-p', text: pctText(c.p) }),
            el('span', { class: 'bar-track', 'aria-hidden': 'true' }, [el('span', { class: 'bar-fill', style: `width:${Math.round(c.p * 100)}%`, text: '' })]),
          ]))),
      ]),
    ]));
    scroll.appendChild(tree);
    return scroll;
  }

  refresh();
}

function games(b) {
  return b ? b.rounds.flatMap((r) => r.games) : [];
}
