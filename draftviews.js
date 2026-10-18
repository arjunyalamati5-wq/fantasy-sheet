import { state, load, post } from './store.js';
import {
  el, frag, figures, emptyState, callout, field, announce, n1, signed,
  renderAsync, warningsBlock, loading, playerTable,
} from './ui.js';

// ---------------------------------------------------------------- Draft recap

export function draftView(root) {
  renderAsync(root, load('draft'), (data) => {
    const r = data.report;
    if (!r.available) return emptyState('No draft to show', r.emptyMessage);

    const out = frag([warningsBlock()]);
    out.appendChild(el('p', { class: 'section-note', text: r.note }));
    if (!r.adpAvailable) {
      out.appendChild(callout('Average draft position was not available for this draft, so picks are graded on what each player is worth now rather than on where he went.', 'amber'));
    }

    out.appendChild(el('h3', { class: 'sub-title', text: 'How each manager drafted' }));
    out.appendChild(gradesTable(r.grades));

    if (r.steals.length) {
      out.appendChild(el('h3', { class: 'sub-title', text: 'Best value picks' }));
      out.appendChild(pickTable(r.steals, 'The best value in the draft'));
    }
    if (r.reaches.length) {
      out.appendChild(el('h3', { class: 'sub-title', text: 'Picks that went early' }));
      out.appendChild(pickTable(r.reaches, 'Picks the field would not have made this soon'));
    }

    out.appendChild(el('h3', { class: 'sub-title', text: 'Every pick' }));
    out.appendChild(pickTable(r.rows, 'Every pick of the draft, in order'));
    return out;
  });
}

/** Manager by manager, the way a report card lists a term's grades: a rank,
 * how much was drafted, and the pick that made it and the one that did not. */
function gradesTable(grades) {
  const t = el('table', { class: 'sheet' });
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Manager' }),
    el('th', { class: 'wide', scope: 'col', text: 'Picks' }),
    el('th', { scope: 'col', text: 'Still rostered' }),
    el('th', { class: 'l wide', scope: 'col', text: 'Best pick' }),
    el('th', { class: 'l wide', scope: 'col', text: 'Worst pick' }),
    el('th', { scope: 'col', text: 'Points per week drafted' }),
  ])]));
  const tb = el('tbody');
  for (const g of grades) {
    tb.appendChild(el('tr', { class: g.isMine ? 'mine' : '' }, [
      el('th', { class: 'l', scope: 'row' }, [
        el('span', { class: 'rank-badge', text: `#${g.rank}` }), g.teamName,
        el('span', { class: 'sub narrow-only', text: `${g.picks.length} picks. Best: ${g.best ? `${g.best.player.name}, pick ${g.best.pickNo}` : 'none'}. Worst: ${g.worst ? `${g.worst.player.name}, pick ${g.worst.pickNo}` : 'none'}.` }),
      ]),
      el('td', { class: 'num wide', text: String(g.picks.length) }),
      el('td', { class: 'num', text: String(g.kept) }),
      el('td', { class: 'l wide', text: g.best ? `${g.best.player.name}, pick ${g.best.pickNo}` : '—' }),
      el('td', { class: 'l wide', text: g.worst ? `${g.worst.player.name}, pick ${g.worst.pickNo}` : '—' }),
      el('td', { class: 'num', text: n1(g.valueNow) }),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

function pickTable(rows, caption) {
  return playerTable({
    rows: rows.map((p) => {
      const move = p.label?.level === 'steal' ? 'is-move' : p.label?.level === 'reach' ? 'is-drop' : '';
      return {
        slot: `${p.round}.${String(p.pickNo).padStart(2, '0')}`,
        player: p.player,
        value: n1(p.valueNow),
        tone: move === 'is-move' ? 'pos' : move === 'is-drop' ? 'neg' : '',
        className: `${move} ${p.isMine ? 'mine' : ''}`.trim() || null,
        note: pickNote(p),
      };
    }),
    stats: [],
    valueHead: 'Worth now',
    caption,
  });
}

function pickNote(p) {
  const bits = [];
  if (p.label && p.label.level !== 'fair') bits.push(`${p.label.text}.`);
  bits.push(`${p.teamName}${p.stillOnDrafter ? '' : p.stillRostered ? ', since traded or claimed' : ', no longer rostered'}.`);
  if (p.isKeeper) bits.push('A keeper, not a fresh pick.');
  if (p.adp != null) bits.push(`The field drafted him at pick ${p.adp} on average.`);
  const reach = Math.round(p.reach ?? 0);
  if (reach) bits.push(`Taken ${Math.abs(reach)} pick${Math.abs(reach) === 1 ? '' : 's'} ${reach > 0 ? 'later' : 'earlier'} than the field.`);
  if (p.seasonPoints != null) bits.push(`Projected for ${n1(p.seasonPoints)} points this season.`);
  return bits.join(' ');
}

// ---------------------------------------------------------------- Mock draft

const mock = { setup: null, taken: [], onClock: null, slot: 1, seed: 1 };

export function mockDraftView(root) {
  root.textContent = '';
  root.appendChild(el('h2', { class: 'section-title', text: 'Mock draft' }));
  const intro = el('p', { class: 'section-note' });
  root.appendChild(intro);

  const controls = el('div', { class: 'toolbar' });
  const body = el('div');
  root.appendChild(controls);
  root.appendChild(body);

  const slotInput = el('select', {}, []);
  const seedInput = el('input', { type: 'text', value: '1', style: 'width:80px' });

  renderAsync(body, load('mockdraft', { slot: mock.slot }), (data) => {
    const r = data.report;
    if (!r.available) return emptyState('Cannot build a mock draft', r.emptyMessage);
    mock.setup = r;
    intro.textContent = r.note;

    slotInput.textContent = '';
    for (let i = 1; i <= r.teams; i++) {
      slotInput.appendChild(el('option', { value: i, selected: i === mock.slot }, [`Pick ${i} of ${r.teams}`]));
    }

    controls.textContent = '';
    controls.appendChild(field('Your draft slot', slotInput));
    controls.appendChild(field('Randomness seed', seedInput));
    controls.appendChild(el('button', { class: 'btn', onclick: startDraft }, ['Start the draft']));
    controls.appendChild(el('button', { class: 'btn ghost', onclick: reset }, ['Reset']));

    return emptyState('Ready when you are',
      `You pick at slot ${mock.slot} of ${r.teams}, over ${r.rounds} rounds. The other managers draft off real average draft position. Press Start the draft.`);
  });

  function reset() {
    mock.taken = [];
    mock.onClock = null;
    body.textContent = '';
    body.appendChild(emptyState('Reset', 'Press Start the draft to begin again.'));
  }

  async function startDraft() {
    mock.slot = Number(slotInput.value) || 1;
    mock.seed = Number(seedInput.value) || 1;
    mock.taken = [];
    await advance();
  }

  async function advance(myPick = null) {
    if (!mock.setup) return;
    if (myPick) {
      const pickNo = mock.taken.length + 1;
      mock.taken.push({ ...myPick, pickNo, round: Math.ceil(pickNo / mock.setup.teams), slot: mock.slot, byUser: true });
    }
    body.textContent = '';
    body.appendChild(loading('The room is drafting…'));
    try {
      const res = await post('mock-pick', {
        board: mock.setup.board,
        teams: mock.setup.teams,
        rounds: mock.setup.rounds,
        mySlot: mock.slot,
        taken: mock.taken,
        seed: mock.seed,
      });
      mock.taken = res.taken;
      mock.onClock = res.onTheClock;
      render(res);
    } catch (err) {
      body.textContent = '';
      body.appendChild(emptyState('The draft could not continue', err.message));
    }
  }

  function render(res) {
    body.textContent = '';
    const gone = new Set(mock.taken.map((t) => t.player_id));
    const available = mock.setup.board.filter((p) => !gone.has(p.player_id));
    const myPicks = mock.taken.filter((t) => t.slot === mock.slot);

    if (res.complete) {
      body.appendChild(callout('The draft is finished. Your roster is below.'));
    } else if (res.onTheClock) {
      body.appendChild(callout(`You are on the clock — pick ${res.onTheClock.pickNo}, round ${res.onTheClock.round}. Choose anyone still on the board.`));
    }

    if (res.grade) {
      body.appendChild(figures([
        { value: n1(res.grade.startingTotal), label: 'Projected points from your starters', sublabel: 'for the whole season, in your scoring' },
        { value: String(myPicks.length), label: 'Players drafted' },
        { value: Object.entries(res.grade.byPosition).map(([k, v]) => `${v}${k}`).join(' '), label: 'Roster shape' },
      ]));
    }

    if (!res.complete && res.onTheClock) {
      body.appendChild(el('h3', { class: 'sub-title', text: 'Best available' }));
      const list = el('div', { class: 'picker', style: 'max-height:340px' });
      for (const p of available.slice(0, 60)) {
        list.appendChild(el('button', {
          class: 'picker-item',
          onclick: () => advance(p),
        }, [
          el('span', { class: 'pos', text: p.position }),
          el('span', { class: 'pname' }, [p.name, el('span', { class: 'club', text: p.team || '' })]),
          el('span', { class: 'pval', text: `adp ${p.adp}` }),
        ]));
      }
      body.appendChild(list);
    }

    if (myPicks.length) {
      body.appendChild(el('h3', { class: 'sub-title', text: 'Your roster' }));
      body.appendChild(rosterTable(res.grade?.assignments || []));
    }

    body.appendChild(el('h3', { class: 'sub-title', text: 'Picks so far' }));
    body.appendChild(playerTable({
      rows: [...mock.taken].reverse().slice(0, 40).map((t) => ({
        slot: `${t.round}.${String(t.pickNo).padStart(2, '0')}`,
        player: { name: t.name, position: t.position, team: t.team || '' },
        value: n1(t.seasonPoints),
        note: `Team ${t.slot}.${t.byUser ? ' Your pick.' : ''}`,
        className: t.byUser ? 'mine' : null,
      })),
      stats: [],
      valueHead: 'Projected for the season',
      caption: 'Every pick made so far, most recent first',
    }));
  }
}

/** The lineup slots are known before the players are; a slot without a name
 * yet still needs its row, so this is a plain sheet table, not a player one. */
function rosterTable(assignments) {
  const t = el('table', { class: 'sheet' });
  t.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { class: 'l', scope: 'col', text: 'Slot' }),
    el('th', { class: 'l', scope: 'col', text: 'Player' }),
    el('th', { scope: 'col', text: 'Projected for the season' }),
  ])]));
  const tb = el('tbody');
  for (const a of assignments) {
    tb.appendChild(el('tr', {}, [
      el('th', { class: 'l', scope: 'row', text: a.slot }),
      el('td', { class: 'l', text: a.name ? `${a.name}${a.position ? ` (${a.position})` : ''}` : 'Not yet filled' }),
      el('td', { class: 'num', text: n1(a.seasonPoints) }),
    ]));
  }
  t.appendChild(tb);
  return el('div', { class: 'table-scroll' }, [t]);
}

// ---------------------------------------------------------------- DFS

export function dfsView(root) {
  root.textContent = '';
  root.appendChild(el('h2', { class: 'section-title', text: 'Daily fantasy optimiser' }));
  root.appendChild(el('p', { class: 'section-note', text: 'Builds the highest-projecting lineup that fits under the salary cap. The answer is exact, not a good guess.' }));

  const contest = el('select', {}, [
    el('option', { value: 'dk_classic' }, ['DraftKings NFL Classic — $50,000 cap']),
    el('option', { value: 'fd_classic' }, ['FanDuel NFL Classic — $60,000 cap']),
  ]);
  const csv = el('textarea', {
    rows: 6,
    placeholder: 'Paste the salary CSV here (Position,Name,Salary,TeamAbbrev,…)',
    style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px',
  });
  const output = el('div');

  root.appendChild(callout('Daily-fantasy salaries are not published by any free source, so they have to come from the contest itself. On DraftKings that is the "Export to CSV" link on the draft screen. Everything else on this page needs no file.', 'amber'));
  root.appendChild(field('Contest', contest, { style: 'margin-bottom:12px' }));
  root.appendChild(field('Salary file', csv));
  root.appendChild(el('div', { class: 'toolbar', style: 'margin-top:12px' }, [
    el('button', { class: 'btn', onclick: run }, ['Build the best lineup']),
    el('button', { class: 'btn ghost', onclick: () => { csv.value = ''; output.textContent = ''; } }, ['Clear']),
  ]));
  root.appendChild(output);

  async function run() {
    if (!csv.value.trim()) {
      output.textContent = '';
      output.appendChild(emptyState('No salary file yet', 'Paste the CSV your DFS site exports, then press Build the best lineup.'));
      return;
    }
    output.textContent = '';
    output.appendChild(loading('Solving the salary cap…'));
    try {
      const res = await post('dfs', { salaryCsv: csv.value, contestId: contest.value });
      const r = res.report;
      output.textContent = '';
      if (r.error) {
        output.appendChild(emptyState('That file could not be read', r.error));
        announce(`That file could not be read. ${r.error}`, { assertive: true });
        return;
      }

      const result = r.result;
      if (result.error) {
        output.appendChild(emptyState('No lineup fits', result.error));
        announce(`No lineup fits. ${result.error}`, { assertive: true });
        return;
      }
      announce(`Best lineup built: ${n1(result.points)} projected points.`);

      output.appendChild(figures([
        { value: n1(result.points), label: 'Projected points', tone: 'good' },
        { value: `$${result.salary.toLocaleString()}`, label: 'Salary used', sublabel: `$${result.salaryLeft.toLocaleString()} left under the cap` },
        { value: String(result.lineup.length), label: 'Players' },
      ]));
      output.appendChild(callout(r.scoringNote, 'amber'));
      output.appendChild(el('p', { class: 'section-note', text: r.matchNote }));

      output.appendChild(playerTable({
        rows: result.lineup.map((p) => ({
          slot: p.slot,
          player: { name: p.name, position: p.position, team: p.team },
          value: n1(p.points),
          note: `$${p.salary.toLocaleString()} salary, ${n1(p.value)} points per $1,000. Projection from ${p.source}.`,
        })),
        stats: [],
        valueHead: 'Projected points',
        caption: 'Your optimised daily-fantasy lineup',
      }));
    } catch (err) {
      output.textContent = '';
      output.appendChild(emptyState('Could not build a lineup', err.message));
    }
  }
}

// ---------------------------------------------------------------- Start / Sit

export function startSitView(root) {
  const wrap = el('div');
  root.textContent = '';
  root.appendChild(el('h2', { class: 'section-title', text: 'Start or sit' }));
  root.appendChild(el('p', { class: 'section-note', text: 'Pick two players. The answer accounts for your whole lineup, not just which one projects higher — the loser may still start in a flex.' }));
  root.appendChild(wrap);

  renderAsync(wrap, load('rosters'), (data) => {
    const mine = data.report.rosters.find((r) => r.isMine) || data.report.rosters[0];
    const out = frag([]);
    const selection = [];

    const result = el('div', { style: 'margin-top:24px' });
    const list = el('div', { class: 'picker', style: 'max-height:320px' });

    const redraw = () => {
      for (const btn of list.querySelectorAll('.picker-item')) {
        btn.setAttribute('aria-pressed', selection.includes(btn.dataset.id) ? 'true' : 'false');
      }
    };

    for (const p of mine.players) {
      list.appendChild(el('button', {
        class: 'picker-item', 'data-id': p.player_id, 'aria-pressed': 'false',
        onclick: () => {
          const i = selection.indexOf(p.player_id);
          if (i >= 0) selection.splice(i, 1);
          else { selection.push(p.player_id); if (selection.length > 2) selection.shift(); }
          redraw();
          if (selection.length === 2) compare();
        },
      }, [
        el('span', { class: 'pos', text: p.position }),
        el('span', { class: 'pname', text: p.name }),
        el('span', { class: 'pval', text: n1(p.projected) }),
      ]));
    }

    async function compare() {
      result.textContent = '';
      result.appendChild(loading('Simulating both…'));
      try {
        const res = await load('startsit', { a: selection[0], b: selection[1] });
        const r = res.report;
        result.textContent = '';
        if (r.error) { result.appendChild(emptyState('Cannot compare those', r.error)); return; }

        result.appendChild(figures([
          { value: r.recommend.name, label: 'Start him', tone: 'good' },
          { value: `${Math.round(r.outscoreProbability * 100)}%`, label: `chance ${r.a.name} outscores ${r.b.name}` },
          { value: signed(r.spread.median), label: 'Typical gap between them' },
        ]));
        result.appendChild(callout(r.verdict));

        result.appendChild(playerTable({
          rows: [r.a, r.b].map((p) => ({
            slot: p.position, player: p, value: n1(p.lineupCost),
            note: p.startsInSlot ? `Currently makes your lineup at ${p.startsInSlot}.` : 'Does not make your lineup as it stands.',
          })),
          stats: ['opp', 'total', 'avg', 'snap', 'tgt'],
          valueHead: 'Lost from your lineup without him',
          caption: `${r.a.name} against ${r.b.name}`,
        }));
      } catch (err) {
        result.textContent = '';
        result.appendChild(emptyState('Could not compare', err.message));
      }
    }

    out.appendChild(el('h3', { class: 'sub-title', text: 'Choose two players' }));
    out.appendChild(list);
    out.appendChild(result);
    result.appendChild(emptyState('Pick two', 'Select two players above and the comparison appears here.'));
    return out;
  });
}
