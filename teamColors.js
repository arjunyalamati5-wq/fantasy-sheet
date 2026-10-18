// The 32 clubs' primary colours, for a 4px stripe only — never text (see
// prime-time-spec.md §3). A handful of teams' literal primary is near-black
// navy or true black, which would vanish as a 1-3px accent against this
// app's own navy panels; those use the team's own brighter secondary instead,
// so the stripe still reads as that team's colour rather than as nothing.
// Keyed by the Sleeper-style abbreviation `displayTeam()` returns.

export const TEAM_COLORS = {
  ARI: '#97233F', ATL: '#A71930', BAL: '#241773', BUF: '#00338D',
  CAR: '#0085CA', CHI: '#C83803', CIN: '#FB4F14', CLE: '#FF3C00',
  DAL: '#B0B7BC', DEN: '#FB4F14', DET: '#0076B6', GB: '#2E5339',
  HOU: '#A71930', IND: '#1B4B91', JAX: '#006778', KC: '#E31837',
  LAC: '#0080C6', LAR: '#003594', LV: '#A5ACAF', MIA: '#008E97',
  MIN: '#4F2683', NE: '#C60C30', NO: '#B99C67', NYG: '#A71930',
  NYJ: '#1F7A57', PHI: '#0B6E77', PIT: '#FFB612', SEA: '#69BE28',
  SF: '#AA0000', TB: '#D50A0A', TEN: '#C8102E', WAS: '#8C2434',
};

/** A team's stripe colour, or a neutral rule colour for a free agent / DST
 * with no club (never invisible, never guessed). */
export function teamColor(team) {
  return TEAM_COLORS[team] || 'var(--rule-strong)';
}
