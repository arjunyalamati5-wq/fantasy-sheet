import { describe } from './lineup.js';
import { displayTeam } from '../teams.js';

/** Search every player in the league's catalogue by name, position or team. */
export function searchPlayers(ctx, query, { limit = 40, position = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2 && !position) {
    return { rows: [], query: q, emptyMessage: 'Type at least two letters to search.' };
  }

  const rows = [];
  for (const id of ctx.candidateIds) {
    const p = ctx.playerOf(id);
    if (!p) continue;
    if (position && p.position !== position) continue;

    let score = 0;
    if (q) {
      const name = p.name.toLowerCase();
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.split(' ').some((w) => w.startsWith(q))) score = 60;
      else if (name.includes(q)) score = 40;
      else if ((displayTeam(p.team) || '').toLowerCase() === q) score = 30;
      else if (p.position.toLowerCase() === q) score = 20;
      if (score === 0) continue;
    }

    const owner = ctx.ownerOf.get(id);
    const ownerRoster = owner ? ctx.rosterOf(owner) : null;
    rows.push({
      ...describe(ctx, p),
      score,
      ownedBy: ownerRoster ? ctx.teamName(ownerRoster) : null,
      isFreeAgent: !owner,
      isMine: String(owner) === String(ctx.myRoster?.roster_id),
    });
  }

  rows.sort((a, b) => b.score - a.score || b.value - a.value);
  return {
    query: q,
    rows: rows.slice(0, limit),
    total: rows.length,
    emptyMessage: rows.length === 0
      ? `Nobody matches "${query}". Try a surname, a position (RB), or a team (KC).`
      : null,
  };
}
