import { getTransactions } from '../sleeper.js';
import { describe } from './lineup.js';
import { round2 } from '../scoring.js';

/**
 * League activity: every add, drop, waiver claim and trade, newest first,
 * with what each move was worth in this league's scoring.
 */
export async function transactionsReport(ctx, { weeks = null, limit = 120 } = {}) {
  const target = weeks || [...ctx.completedWeeks, ctx.week];
  const batches = await Promise.all(target.map((w) => getTransactions(ctx.league.league_id, w)));

  const rows = [];
  target.forEach((week, i) => {
    for (const t of batches[i] || []) {
      if (t.status && t.status !== 'complete') continue;

      const teams = (t.roster_ids || []).map((id) => {
        const r = ctx.rosterOf(id);
        return { rosterId: id, name: r ? ctx.teamName(r) : `Roster ${id}` };
      });

      const side = (map) => Object.entries(map || {}).map(([pid, rosterId]) => {
        const p = ctx.playerOf(pid);
        const r = ctx.rosterOf(rosterId);
        return {
          player: p ? describe(ctx, p) : { player_id: pid, name: `Player ${pid}`, position: '?', value: 0 },
          toTeam: r ? ctx.teamName(r) : null,
          rosterId,
        };
      });

      const adds = side(t.adds);
      const drops = side(t.drops);

      rows.push({
        id: t.transaction_id,
        week,
        type: t.type,
        typeLabel: TYPE_LABELS[t.type] || t.type,
        created: t.created || null,
        teams,
        adds,
        drops,
        faabSpent: t.settings?.waiver_bid ?? null,
        draftPicks: (t.draft_picks || []).map((d) => ({
          season: d.season, round: d.round,
          from: ctx.rosterOf(d.previous_owner_id)?.roster_id ?? d.previous_owner_id,
          to: ctx.rosterOf(d.owner_id)?.roster_id ?? d.owner_id,
        })),
        // What the move was worth, in points per week, to whoever made it.
        netValue: round2(
          adds.reduce((s, a) => s + (a.player.value || 0), 0)
          - drops.reduce((s, d) => s + (d.player.value || 0), 0)
        ),
        summary: summarise(t, adds, drops, teams),
      });
    }
  });

  rows.sort((a, b) => (b.created || 0) - (a.created || 0));

  return {
    rows: rows.slice(0, limit),
    total: rows.length,
    weeksCovered: target,
    emptyMessage: rows.length === 0
      ? 'No completed transactions yet this season. Adds, drops and trades will appear here as managers make them.'
      : null,
  };
}

const TYPE_LABELS = {
  free_agent: 'Free agent pickup',
  waiver: 'Waiver claim',
  trade: 'Trade',
  commissioner: 'Commissioner move',
};

function summarise(t, adds, drops, teams) {
  const names = (list) => list.map((x) => x.player.name).join(', ');
  if (t.type === 'trade') {
    const who = teams.map((x) => x.name).join(' and ');
    return `${who} traded. ${adds.length ? `Moving: ${names(adds)}.` : ''}`.trim();
  }
  const team = teams[0]?.name || 'A manager';
  const bid = t.settings?.waiver_bid;
  const bits = [];
  if (adds.length) bits.push(`added ${names(adds)}`);
  if (drops.length) bits.push(`dropped ${names(drops)}`);
  const spent = bid ? ` for $${bid} of waiver budget` : '';
  return `${team} ${bits.join(' and ')}${spent}.`;
}
