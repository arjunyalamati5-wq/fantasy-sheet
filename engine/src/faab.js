// FAAB bid guidance priced from this league's own history. What other
// managers here actually paid for similar players is a better guide than any
// national rule, because every league's economy is different. When the league
// has too few claims to go on, a plainly labelled rule of thumb stands in.

const BAND = 0.4;          // "similar" = within 40% of his value
const MIN_COMPARABLES = 3; // fewer than this and a median is just noise

/** Every completed waiver claim that had a price: position, winning bid, value of the player. */
export function claimHistory(batches, { positionOf, valueOf }) {
  const out = [];
  for (const t of batches.flat()) {
    if (!t || t.type !== 'waiver' || t.status !== 'complete') continue;
    // A missing bid is not a $0 bid: Number(null) is 0, which would drag
    // every median toward free.
    const raw = t.settings?.waiver_bid;
    if (raw == null || raw === '') continue;
    const bid = Number(raw);
    if (!Number.isFinite(bid)) continue;
    for (const pid of Object.keys(t.adds || {})) {
      const position = positionOf(pid);
      if (!position) continue;
      out.push({ playerId: pid, position, bid, value: Number(valueOf(pid)) || 0 });
    }
  }
  return out;
}

/**
 * A bid for one free agent. A bench stash gets the typical price; a player who
 * would start gets the 75th percentile, which wins most contested claims.
 * Never more than the budget left.
 */
export function suggestBid(player, history, { budget, remaining, minBid = 0 }) {
  if (remaining < minBid) {
    return {
      basis: 'none', comparables: 0, suggested: null, typical: null, low: null, high: null, budget, remaining,
      text: `You have ${money(remaining)} left, under the ${money(minBid)} minimum bid, so you cannot claim anyone.`,
    };
  }
  const same = history.filter((c) => c.position === player.position);
  const band = BAND * Math.max(player.value, 1);
  const similar = same.filter((c) => Math.abs(c.value - player.value) <= band);
  // Narrowest comparison that has enough claims: similar players at his
  // position, then his position, then the whole league's prices.
  const pool = [similar, same, history].find((p) => p.length >= MIN_COMPARABLES) || null;
  // Never more than the budget left; never less than the league minimum.
  const cap = (n) => Math.min(remaining, Math.max(minBid, Math.round(n)));
  const allLeft = (n) => Math.round(n) > remaining;

  if (!pool) {
    const share = !player.wouldStart ? 0.01
      : player.lineupGain >= 3 ? 0.08
        : player.lineupGain >= 1.5 ? 0.04 : 0.02;
    const suggested = cap(budget * share);
    return {
      basis: 'rule', comparables: 0, suggested, typical: null, low: null, high: null, budget, remaining,
      text: `Your league has too few ${player.position} claims to price him from. As a rule of thumb, `
        + ruleAdvice(suggested, budget * share, { budget, remaining, minBid }),
    };
  }

  const bids = pool.map((c) => c.bid).sort((a, b) => a - b);
  const typical = Math.round(quantile(bids, 0.5));
  const high = Math.round(quantile(bids, 0.75));
  const low = bids[0];
  const target = player.wouldStart ? high : typical;
  const suggested = cap(target);
  const kind = pool === similar ? `Similar ${player.position} claims`
    : pool === same ? `${player.position} claims`
      : same.length
        ? `Your league has only ${same.length} ${player.position} claim${same.length === 1 ? '' : 's'} so far. Claims at every position`
        : `Your league has no ${player.position} claims yet. Claims at every position`;
  return {
    basis: 'league', comparables: pool.length, suggested, typical, low, high, budget, remaining,
    text: `${kind} in your league ${priceRange(bids, typical)}. `
      + (allLeft(target)
        ? `Bid ${money(suggested)}, all you have left.`
        : (player.wouldStart
          ? `He would start for you, so bid about ${money(suggested)} to win a contested claim.`
          : `Bid about ${money(suggested)}.`)
          + ` You have ${money(remaining)} left.`),
  };
}

/**
 * The rule-of-thumb sentence, worded from the amount actually suggested: when
 * the budget left or the league minimum moved it, the sentence says that, and
 * any share of the budget is the suggestion's share, not the rule's.
 */
function ruleAdvice(suggested, ruleAmount, { budget, remaining, minBid }) {
  const rounded = Math.round(ruleAmount);
  if (rounded > remaining) return `bid ${money(suggested)}, all you have left.`;
  const left = ` You have ${money(remaining)} left.`;
  if (rounded < minBid) return `bid ${money(suggested)}, the league minimum.${left}`;
  if (!(budget > 0) || suggested <= 0) return `bid ${money(suggested)}.${left}`;
  const pct = (suggested / budget) * 100;
  const share = pct < 1 ? 'under 1%' : `${Math.round(pct)}%`;
  return `bid about ${money(suggested)} (${share} of the budget).${left}`;
}

/** "went for $0 to $10, typically $3", or "all went for $0" when every price matched. */
function priceRange(bids, typical) {
  const low = bids[0];
  const top = bids[bids.length - 1];
  return low === top
    ? `all went for ${money(low)}`
    : `went for ${money(low)} to ${money(top)}, typically ${money(typical)}`;
}

/** Linear-interpolated quantile of an ascending list. */
function quantile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
