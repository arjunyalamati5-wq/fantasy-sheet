// Sleeper and nflverse disagree on team abbreviations. The Rams are the one that
// bites: "LAR" in Sleeper, "LA" in nflverse. Without normalising, every Rams
// player matches zero games and silently values at zero rather than erroring.

/** Everything normalises to the nflverse spelling, which is what the CSV joins use. */
const ALIASES = {
  LAR: 'LA',
  STL: 'LA',
  SD: 'LAC',
  SDG: 'LAC',
  OAK: 'LV',
  LVR: 'LV',
  WSH: 'WAS',
  WFT: 'WAS',
  JAC: 'JAX',
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
  NWE: 'NE',
  NOR: 'NO',
  GNB: 'GB',
  KAN: 'KC',
  SFO: 'SF',
  TAM: 'TB',
};

/** How each canonical team is spelled back to the user (Sleeper's spelling). */
const DISPLAY = { LA: 'LAR' };

/** Normalise any team abbreviation to the canonical (nflverse) code. */
export function normTeam(t) {
  if (!t) return null;
  const up = String(t).trim().toUpperCase();
  if (up === '' || up === 'FA' || up === 'NA') return null;
  return ALIASES[up] || up;
}

/** Spell a canonical code the way fantasy managers expect to read it. */
export function displayTeam(t) {
  const n = normTeam(t);
  if (!n) return 'FA';
  return DISPLAY[n] || n;
}

/** True when two abbreviations refer to the same franchise. */
export function sameTeam(a, b) {
  const na = normTeam(a);
  const nb = normTeam(b);
  return na !== null && na === nb;
}
