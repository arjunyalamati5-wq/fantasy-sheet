import { getDrafts, getDraftPicks, getDraft } from '../sleeper.js';
import { getSeasonProjections, adpKeyFor, readAdp } from '../adp.js';
import { scoreStats, round2 } from '../scoring.js';
import { describe } from './lineup.js';

/**
 * Draft recap. Every pick, graded against where the player was actually being
 * drafted (ADP) and against what he has been worth since, in this league's
 * scoring. Reaches and steals are the difference between the two.
 */
export async function draftReport(ctx) {
  const drafts = await getDrafts(ctx.league.league_id);
  if (!drafts.length) {
    return { available: false, emptyMessage: 'This league has no draft on record with Sleeper.' };
  }
  const meta = drafts[0];
  const [picks, detail, season] = await Promise.all([
    getDraftPicks(meta.draft_id),
    getDraft(meta.draft_id),
    getSeasonProjections(ctx.season),
  ]);

  if (!picks.length) {
    return { available: false, emptyMessage: 'The draft has not started yet, so there is nothing to grade.' };
  }

  const adpKeys = adpKeyFor({ slots: ctx.slots, scoring: ctx.scoring });
  const teams = meta.settings?.teams || ctx.numTeams;

  const rows = picks.map((pick) => {
    const p = ctx.playerOf(pick.player_id);
    const sp = season.byPlayer[pick.player_id];
    const adp = readAdp(sp?.stats, adpKeys);
    const roster = ctx.rosterOf(pick.roster_id);

    // Value: where he went versus where the field had him.
    const reach = adp != null ? round2(pick.pick_no - adp) : null;

    // Return: full-season projected points in THIS league's scoring.
    const seasonPoints = sp?.stats ? round2(scoreStats(sp.stats, ctx.scoring)) : null;

    return {
      round: pick.round,
      pickNo: pick.pick_no,
      draftSlot: pick.draft_slot,
      rosterId: pick.roster_id,
      teamName: roster ? ctx.teamName(roster) : `Roster ${pick.roster_id}`,
      isMine: String(pick.roster_id) === String(ctx.myRoster?.roster_id),
      isKeeper: Boolean(pick.is_keeper),
      player: p ? describe(ctx, p) : {
        player_id: pick.player_id,
        name: [pick.metadata?.first_name, pick.metadata?.last_name].filter(Boolean).join(' ') || `Player ${pick.player_id}`,
        position: pick.metadata?.position || '?', team: pick.metadata?.team || 'FA', value: 0,
      },
      adp,
      reach,                       // positive = got him later than the field did
      seasonPoints,
      valueNow: p ? ctx.valueOf(p.player_id) : 0,
      stillRostered: ctx.ownerOf.get(pick.player_id) != null,
      stillOnDrafter: String(ctx.ownerOf.get(pick.player_id)) === String(pick.roster_id),
      label: pickLabel(reach),
    };
  });

  // Team grades: how much value each manager's picks are worth now.
  const byTeam = new Map();
  for (const r of rows) {
    if (!byTeam.has(r.rosterId)) {
      byTeam.set(r.rosterId, {
        rosterId: r.rosterId, teamName: r.teamName, isMine: r.isMine,
        picks: [], valueNow: 0, kept: 0,
      });
    }
    const t = byTeam.get(r.rosterId);
    t.picks.push(r);
    t.valueNow += r.valueNow;
    if (r.stillOnDrafter) t.kept += 1;
  }

  const grades = [...byTeam.values()].map((t) => ({
    ...t,
    valueNow: round2(t.valueNow),
    keptPct: t.picks.length ? t.kept / t.picks.length : 0,
    best: [...t.picks].sort((a, b) => b.valueNow - a.valueNow)[0] || null,
    worst: [...t.picks].sort((a, b) => a.valueNow - b.valueNow)[0] || null,
  })).sort((a, b) => b.valueNow - a.valueNow);
  grades.forEach((g, i) => { g.rank = i + 1; });

  const steals = rows.filter((r) => r.reach != null && r.reach >= 12)
    .sort((a, b) => b.valueNow - a.valueNow).slice(0, 10);
  const reaches = rows.filter((r) => r.reach != null && r.reach <= -12)
    .sort((a, b) => a.valueNow - b.valueNow).slice(0, 10);

  return {
    available: true,
    draftId: meta.draft_id,
    type: meta.type,
    status: meta.status,
    rounds: meta.settings?.rounds ?? detail?.settings?.rounds ?? null,
    teams,
    adpAvailable: season.available && rows.some((r) => r.adp != null),
    rows,
    grades,
    steals,
    reaches,
    note: 'A pick is graded two ways: where he went against the average draft position the field was using, and what he is worth now in your scoring. "Value now" is points per week above nothing, added up across the picks that team made.',
  };
}

function pickLabel(reach) {
  if (reach == null) return null;
  if (reach >= 24) return { level: 'steal', text: 'Big steal' };
  if (reach >= 12) return { level: 'steal', text: 'Good value' };
  if (reach <= -24) return { level: 'reach', text: 'Big reach' };
  if (reach <= -12) return { level: 'reach', text: 'Slight reach' };
  return { level: 'fair', text: 'Around market' };
}
