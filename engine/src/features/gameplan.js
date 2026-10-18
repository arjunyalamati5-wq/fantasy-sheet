import { lineupReport } from './lineup.js';
import { matchupReport } from './matchup.js';
import { waiverReport } from './waivers.js';
import { streamingReport } from './streaming.js';
import { tradeTargets } from './trades.js';
import { marketReport } from './market.js';
import { seasonReport } from './standings.js';
import { kickoffLabel } from './live.js';
import { slotLabel } from '../lineup.js';

/**
 * The week as a to-do list. Every other report answers one question; this one
 * reads them all and says what to do, in the order it has to be done: what is
 * broken now, what to claim before waivers run, what to check before kickoff,
 * and what to work on for the rest of the season. Each step says why and
 * links to the view where it can be done.
 */
export async function gamePlanReport(ctx, rosterId = ctx.myRoster?.roster_id) {
  const [lineup, matchup, waivers, streaming, trades, market, season] = await Promise.all([
    safe(() => lineupReport(ctx, rosterId)),
    safe(() => matchupReport(ctx, rosterId, { runs: 6_000 })),
    safe(() => waiverReport(ctx, rosterId)),
    safe(() => streamingReport(ctx, rosterId)),
    safe(() => tradeTargets(ctx, rosterId)),
    safe(() => marketReport(ctx)),
    safe(() => seasonReport(ctx)),
  ]);
  const week = Number(ctx.week);
  return buildGamePlan({
    week, rosterId, lineup, matchup, waivers, streaming, trades, market, season,
    now: Date.now(),
    kickoffOf: (team) => ctx.schedule?.gameFor?.(team, week)?.kickoff ?? null,
    onByeNextWeek: (team) => Boolean(team && ctx.schedule?.isOnBye?.(team, week + 1)),
  });
}

/** One report failing must not sink the plan; that phase just has less in it. */
async function safe(fn) {
  try {
    const r = await fn();
    return r && !r.error ? r : null;
  } catch {
    return null;
  }
}

const n1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const pct = (p) => `${Math.round(p * 100)}%`;
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Pure: reports in, plan out. Exported for tests. */
export function buildGamePlan({
  week, rosterId, lineup, matchup, waivers, streaming, trades, market, season,
  now = Date.now(), kickoffOf = () => null, onByeNextWeek = () => false,
}) {
  const fix = [];
  const claim = [];
  const kickoff = [];
  const longer = [];
  const starters = (lineup?.optimal?.assignments || []).filter((a) => a.player);

  // ---------------------------------------------------------------- fix now
  for (const a of lineup?.alerts || []) {
    if (a.level !== 'error') continue;
    fix.push({ tone: 'urgent', title: a.message, href: '#lineup' });
  }
  for (const s of lineup?.swaps || []) {
    if (s.gain < 0.5) continue;
    fix.push({
      tone: 'gain',
      title: `Start ${s.startInstead.name} at ${slotLabel(s.slot)}${s.bench ? ` instead of ${s.bench.name}` : ''}`,
      detail: s.reasons.join(' '),
      gain: s.gain,
      href: '#lineup',
    });
  }

  // ---------------------------------------------------------------- waivers
  const adds = (waivers?.rows || [])
    .filter((w) => w.wouldStart && w.lineupGain >= 0.5)
    .sort((a, b) => b.lineupGain - a.lineupGain)
    .slice(0, 3);
  for (const w of adds) {
    const bid = w.bid?.suggested != null ? ` Bid about ${money(w.bid.suggested)}.` : '';
    claim.push({
      tone: 'gain',
      title: `Claim ${w.name} (${w.position} ${w.team})`,
      detail: `He would start for you and adds about ${n1(w.lineupGain)} points a week.${bid}`,
      gain: w.lineupGain,
      href: '#waivers',
    });
  }
  for (const pos of ['K', 'DEF']) {
    const mine = starters.find((a) => a.player.position === pos);
    const best = streaming?.groups?.[pos]?.rows?.[0];
    if (!best) continue;
    const edge = best.projected - (mine?.points ?? 0);
    if (edge < 1.5) continue;
    claim.push({
      tone: 'gain',
      title: `Stream ${best.name} at ${pos === 'K' ? 'kicker' : 'defence'}`,
      detail: `${best.name} projects ${n1(best.projected)}${mine ? ` against ${n1(mine.points)} for ${mine.player.name}` : ''}`
        + `${best.opponent ? `, ${best.opponent}` : ''}${best.context ? `. ${best.context}` : '.'}`,
      gain: edge,
      href: '#waivers',
    });
  }
  if (waivers?.faab && season?.weeksRemaining) {
    const { remaining, budget } = waivers.faab;
    const perWeek = remaining / Math.max(1, season.weeksRemaining);
    claim.push({
      tone: 'info',
      title: `You have ${money(remaining)} of ${money(budget)} left: about ${money(perWeek)} a week`,
      detail: `${season.weeksRemaining} weeks remain. Spend big only on a player who would start for you; a bench stash is worth the minimum.`,
      href: '#waivers',
    });
  }

  // ---------------------------------------------------------------- kickoff
  const timed = starters
    .map((a) => ({ a, at: kickoffOf(a.player.team) }))
    .filter((x) => Number.isFinite(x.at) && x.at > now && !x.a.player.locked)
    .sort((x, y) => x.at - y.at);
  if (timed.length) {
    const first = timed[0];
    kickoff.push({
      tone: 'info',
      title: `Your first lock is ${first.a.player.name}, ${kickoffLabel(first.at)}`,
      detail: 'Each player locks when his own game kicks off. Make every change involving him before then.',
      href: '#lineup',
    });
  }
  for (const a of lineup?.alerts || []) {
    if (a.level !== 'warn') continue;
    const starter = starters.find((s) => s.player.name === a.player);
    const at = starter ? kickoffOf(starter.player.team) : null;
    const cover = starter && (lineup?.bench || []).find((b) => b.position === starter.player.position && !b.onBye
      && !['Out', 'IR', 'Doubtful'].includes(b.injury?.status));
    kickoff.push({
      tone: 'urgent',
      title: `Check ${a.player} before ${Number.isFinite(at) ? kickoffLabel(at) : 'kickoff'}`,
      detail: `${a.message.replace(/\s*Check before kickoff\.?$/, '.')}`
        + `${cover ? ` If he is ruled out, ${cover.name} (${n1(cover.projected)} projected) is your cover.` : ''}`,
      href: '#lineup',
    });
  }
  const flex = flexTip(lineup, kickoffOf, now);
  if (flex) kickoff.push(flex);
  for (const a of starters) {
    const flags = a.player.weather?.flags || [];
    if (!flags.length) continue;
    kickoff.push({
      tone: 'info',
      title: `${flags.join(', ')} for ${a.player.name}`,
      detail: `${a.player.weather.summary}. Weather never changes a projection here; weigh it yourself on a close call.`,
      href: '#lineup',
    });
  }
  if (matchup) {
    const wp = matchup.winProbability;
    const med = matchup.margin?.median ?? 0;
    const lean = wp < 0.4
      ? { title: `You are the underdog (${pct(wp)}): chase upside`, detail: `The typical result is a ${n1(Math.abs(med))}-point loss. On a close start or sit call, pick the player with the bigger ceiling; a safe floor rarely wins this one.` }
      : wp > 0.65
        ? { title: `You are the favourite (${pct(wp)}): play it safe`, detail: `The typical result is a ${n1(med)}-point win. On a close call, pick the steadier player; you only lose to a disaster.` }
        : { title: `A close one (${pct(wp)}): every point counts`, detail: `The typical result is within ${n1(Math.abs(med))} points either way. Small edges, a kicker or defence stream included, can decide it.` };
    kickoff.push({ tone: 'info', ...lean, href: '#matchup' });
  }

  // ---------------------------------------------------------------- longer
  const target = (trades?.rows || []).find((t) => t.difficulty?.level !== 'hard');
  if (target) {
    longer.push({
      tone: 'gain',
      title: `Ask ${target.fromTeam} about ${target.target.name} for ${target.piece.name}`,
      detail: `Adds ${n1(target.myGain)} points a week to your lineup, and ${target.theirCost <= 0 ? `they improve by ${n1(-target.theirCost)} too` : `costs them only ${n1(target.theirCost)}`}.`,
      gain: target.myGain,
      href: '#trades',
    });
  }
  const sell = (market?.sellCandidates || [])[0];
  if (sell) {
    longer.push({ tone: 'info', title: `Sell high on ${sell.name}`, detail: sell.explanation, href: '#market' });
  }
  const byes = starters.filter((a) => onByeNextWeek(a.player.team));
  if (byes.length) {
    const names = byes.map((a) => a.player.name);
    longer.push({
      tone: byes.length >= 2 ? 'urgent' : 'info',
      title: `${byes.length} of your starters ${byes.length === 1 ? 'is' : 'are'} on bye next week`,
      detail: `${names.join(', ')}. Line up cover now, while the waiver wire still has it.`,
      href: '#waivers',
    });
  }
  const mine = (season?.teams || []).find((t) => String(t.rosterId) === String(rosterId));
  if (mine) {
    const odds = mine.playoffOdds;
    const outlook = odds >= 0.8
      ? { title: `Playoffs look likely (${pct(odds)})`, detail: 'Build for December: turn bench depth into a weekly starter upgrade, and stash backups for your best players.' }
      : odds >= 0.4
        ? { title: `On the playoff bubble (${pct(odds)})`, detail: 'Every week counts now. Favour players who help this week over long-term stashes.' }
        : { title: `Playoffs are a long shot (${pct(odds)})`, detail: 'Take swings: trade depth for upside, and claim the breakout candidates other managers are too cautious to start.' };
    longer.push({ tone: 'info', ...outlook, href: '#season' });
  }

  const phases = [
    { id: 'fix', title: 'Fix your lineup', when: 'Now', steps: fix },
    { id: 'claim', title: 'Work the waiver wire', when: 'Before waivers run', steps: claim },
    { id: 'kickoff', title: 'Get ready for kickoff', when: 'Before your first game', steps: kickoff },
    { id: 'longer', title: 'Plan for the season', when: 'This week and beyond', steps: longer },
  ];
  const gainOnTable = [...fix, ...claim].reduce((t, s) => t + (s.gain || 0), 0);
  return {
    week,
    winProbability: matchup?.winProbability ?? null,
    opponent: matchup?.them?.teamName ?? null,
    playoffOdds: mine?.playoffOdds ?? null,
    gainOnTable: Math.round(gainOnTable * 10) / 10,
    phases,
    todo: phases.reduce((t, p) => t + p.steps.filter((s) => s.tone !== 'info').length, 0),
  };
}

/**
 * Flex flexibility: the FLEX should hold the starter whose game kicks off
 * last, so a late scratch can still be swapped for anyone at any position.
 * If an earlier-game player is in FLEX while a later-game RB/WR/TE sits in
 * his own slot, say which two to swap.
 */
export function flexTip(lineup, kickoffOf, now = Date.now()) {
  const assigned = (lineup?.optimal?.assignments || []).filter((a) => a.player && !a.player.locked);
  const flex = assigned.find((a) => a.slot === 'FLEX');
  if (!flex) return null;
  const flexAt = kickoffOf(flex.player.team);
  if (!Number.isFinite(flexAt) || flexAt <= now) return null;
  const later = assigned
    .filter((a) => ['RB', 'WR', 'TE'].includes(a.slot) && a.player.position === flex.player.position)
    .map((a) => ({ a, at: kickoffOf(a.player.team) }))
    .filter((x) => Number.isFinite(x.at) && x.at > flexAt)
    .sort((x, y) => y.at - x.at)[0];
  if (!later) return null;
  return {
    tone: 'info',
    title: `Put ${later.a.player.name} in your FLEX and ${flex.player.name} at ${later.a.slot}`,
    detail: `${later.a.player.name} plays later (${kickoffLabel(later.at)} against ${kickoffLabel(flexAt)}). With the later game in FLEX, a late scratch can still be replaced by a player at any position.`,
    href: '#lineup',
  };
}
