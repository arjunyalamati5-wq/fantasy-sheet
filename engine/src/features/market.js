import { round2 } from '../scoring.js';
import { describe } from './lineup.js';

// Buy low / sell high, from the gap between how much a player is USED and how
// much he has SCORED. Heavy usage with thin production usually corrects upward;
// light usage with fat production usually corrects downward.

const MIN_GAMES = 2;             // one game is a coincidence, not a trend
const DIVERGENCE_THRESHOLD = 0.2; // how far apart the two percentiles must be

const USAGE_POSITIONS = new Set(['RB', 'WR', 'TE']);

export function marketReport(ctx) {
  const rows = [];

  // Percentile ranks within each position, so a WR is judged against WRs.
  const byPos = new Map();
  for (const v of ctx.valuations.rows) {
    if (!USAGE_POSITIONS.has(v.position)) continue;
    if (v.gamesPlayed < MIN_GAMES) continue;
    const usage = ctx.usageByPlayer.get(v.player_id);
    if (!usage) continue;
    const usageIndex = combinedUsage(usage);
    if (usageIndex === null) continue;
    if (!byPos.has(v.position)) byPos.set(v.position, []);
    byPos.get(v.position).push({ v, usage, usageIndex, scoring: v.rawMean ?? 0 });
  }

  for (const [position, list] of byPos) {
    if (list.length < 4) continue; // too few comparables to rank against
    const usagePct = percentiles(list.map((x) => x.usageIndex));
    const scorePct = percentiles(list.map((x) => x.scoring));

    list.forEach((x, i) => {
      const u = usagePct[i];
      const s = scorePct[i];
      const divergence = u - s;
      if (Math.abs(divergence) < DIVERGENCE_THRESHOLD) return;

      const p = ctx.playerOf(x.v.player_id);
      if (!p) return;
      const owner = ctx.ownerOf.get(x.v.player_id);
      const ownerRoster = owner ? ctx.rosterOf(owner) : null;

      rows.push({
        ...describe(ctx, p),
        position,
        kind: divergence > 0 ? 'buy' : 'sell',
        divergence: round2(divergence),
        usagePercentile: round2(u),
        scoringPercentile: round2(s),
        ownedBy: ownerRoster ? ctx.teamName(ownerRoster) : 'Free agent',
        ownerRosterId: owner || null,
        isMine: String(owner) === String(ctx.myRoster?.roster_id),
        explanation: explain(divergence > 0 ? 'buy' : 'sell', p, x.usage, x.v),
      });
    });
  }

  rows.sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence));

  const buys = rows.filter((r) => r.kind === 'buy');
  const sells = rows.filter((r) => r.kind === 'sell');

  return {
    buys,
    sells,
    // The ones that matter most: buy someone else's, sell your own.
    buyTargets: buys.filter((r) => !r.isMine),
    sellCandidates: sells.filter((r) => r.isMine),
    minGames: MIN_GAMES,
    emptyMessage: rows.length === 0
      ? `Not enough games played yet to compare usage against scoring. This view needs at least ${MIN_GAMES} games from each player.`
      : null,
  };
}

/** Snap share and target share, averaged into one 0-1 usage index. */
function combinedUsage(usage) {
  const parts = [];
  if (usage.snapShare != null) parts.push(Math.min(1, usage.snapShare));
  if (usage.targetShare != null) parts.push(Math.min(1, usage.targetShare / 0.3));
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** Percentile rank of each element within its own array (0 = lowest). */
function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    const below = sorted.filter((s) => s < v).length;
    const equal = sorted.filter((s) => s === v).length;
    return sorted.length <= 1 ? 0.5 : (below + equal / 2) / sorted.length;
  });
}

function explain(kind, player, usage, val) {
  const snap = usage.snapShare != null ? `${(usage.snapShare * 100).toFixed(0)}% of snaps` : null;
  const tgt = usage.targetShare != null ? `${(usage.targetShare * 100).toFixed(0)}% of targets` : null;
  const use = [snap, tgt].filter(Boolean).join(' and ');
  const avg = (val.rawMean ?? 0).toFixed(1);

  if (kind === 'buy') {
    return `${player.name} is playing ${use} but only averaging ${avg} points. The work is there; the scoring has not followed yet. His manager may sell cheap.`;
  }
  return `${player.name} is averaging ${avg} points on only ${use}. That is more production than his role usually supports. Sell while the number looks good.`;
}
