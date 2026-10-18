// Joining nflverse players (gsis ids) to Sleeper players. Tries, most
// reliable first: the gsis id Sleeper itself carries, the DynastyProcess
// crosswalk, the ESPN id both sides carry, then name + team + position and
// finally name + position, each only when exactly one Sleeper player fits.
// Anyone with snaps or touches who still has no match is reported, never
// guessed.

const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

/** "D.J. Moore Jr." -> "djmoore" so spellings and suffixes line up. */
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z]/g, '');
}

const posKey = (p) => (p === 'FB' ? 'RB' : p);

/**
 * @param {object} args
 * @param {object} args.sleeper   Sleeper players by id: { player_id, name, position, team, gsis_id, espn_id }
 * @param {Map}    args.crosswalk gsis -> sleeper id (DynastyProcess), may be empty
 * @param {Array}  args.nflPlayers rows of nflverse players.csv: { gsis_id, display_name, position, latest_team, espn_id, pfr_id }
 * @returns {{ gsisToSleeper: Map, pfrToGsis: Map, method: Map, counts: object, conflicts: Array }}
 */
export function matchPlayers({ sleeper, crosswalk = new Map(), nflPlayers = [] }) {
  const bySleeperGsis = new Map();
  const byEspn = new Map();
  const byNameTeamPos = new Map();
  const byNamePos = new Map();
  const push = (m, k, v) => { if (!k) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const p of Object.values(sleeper || {})) {
    if (!p || !SKILL.has(p.position)) continue;
    if (p.gsis_id) bySleeperGsis.set(String(p.gsis_id).trim(), p.player_id);
    if (p.espn_id) push(byEspn, String(p.espn_id), p.player_id);
    const nk = nameKey(p.name);
    push(byNameTeamPos, `${nk}|${p.team || ''}|${posKey(p.position)}`, p.player_id);
    push(byNamePos, `${nk}|${posKey(p.position)}`, p.player_id);
  }

  const gsisToSleeper = new Map();
  const pfrToGsis = new Map();
  const method = new Map();
  const counts = { gsis: 0, crosswalk: 0, espn: 0, name_team_pos: 0, name_pos: 0 };
  const claimedBy = new Map(); // sleeper id -> gsis
  const conflicts = [];

  const claim = (gsis, sid, how) => {
    const prior = claimedBy.get(sid);
    if (prior && prior !== gsis) {
      conflicts.push({ gsis, sleeperId: sid, otherGsis: prior, reason: 'another nflverse player claims the same sleeper player' });
      return false;
    }
    claimedBy.set(sid, gsis);
    gsisToSleeper.set(gsis, sid);
    method.set(gsis, how);
    counts[how]++;
    return true;
  };
  const only = (arr) => (arr && arr.length === 1 ? arr[0] : null);

  for (const r of nflPlayers) {
    const gsis = (r.gsis_id || '').trim();
    if (!gsis) continue;
    if (r.pfr_id) pfrToGsis.set(r.pfr_id.trim(), gsis);
    if (!SKILL.has(r.position)) continue;
    let sid = bySleeperGsis.get(gsis);
    if (sid && claim(gsis, sid, 'gsis')) continue;
    sid = crosswalk.get(gsis);
    if (sid && sleeper[sid] && claim(gsis, sid, 'crosswalk')) continue;
    sid = only(byEspn.get(String(r.espn_id || '').trim()));
    if (sid && claim(gsis, sid, 'espn')) continue;
    const nk = nameKey(r.display_name);
    sid = only(byNameTeamPos.get(`${nk}|${r.latest_team || ''}|${posKey(r.position)}`));
    if (sid && claim(gsis, sid, 'name_team_pos')) continue;
    sid = only(byNamePos.get(`${nk}|${posKey(r.position)}`));
    if (sid) claim(gsis, sid, 'name_pos');
  }
  return { gsisToSleeper, pfrToGsis, method, counts, conflicts };
}
