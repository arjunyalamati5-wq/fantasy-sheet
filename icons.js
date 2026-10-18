// Inline SVG icons for the home tiles. Stroke-based line icons at 24x24,
// inheriting currentColor so each pastel disc tints its own glyph.

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  lineup: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/>'),
  startsit: svg('<path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7"/>'),
  exposure: svg('<path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/>'),
  matchup: svg('<path d="M6 4v7a6 6 0 0 0 12 0V4M9 20h6M12 17v3"/><path d="M6 6H4a2 2 0 0 0 2 4M18 6h2a2 2 0 0 1-2 4"/>'),
  betting: svg('<path d="M3 17l5-6 4 4 4-6 5 5"/><path d="M3 21h18"/>'),
  props: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 16v-4M12 16V8M16 16v-6"/>'),
  trades: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  market: svg('<path d="M3 12l4-4 4 4 5-6 5 5"/><path d="M16 7h5v5"/>'),
  waivers: svg('<path d="M12 5v14M5 12h14"/><circle cx="12" cy="12" r="9"/>'),
  transactions: svg('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  rankings: svg('<path d="M4 6h4M4 12h4M4 18h4"/><path d="M12 6h8M12 12h8M12 18h8"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  league: svg('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  season: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>'),
  draft: svg('<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>'),
  mock: svg('<path d="M4 5h16v12H4z"/><path d="M9 21h6M12 17v4M8 9l2 2 4-4"/>'),
  dfs: svg('<path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
  news: svg('<path d="M4 5h12v14H4z"/><path d="M16 9h4v8a2 2 0 0 1-4 0z"/><path d="M7 9h6M7 13h6"/>'),
  community: svg('<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>'),
  advisor: svg('<path d="M12 3a7 7 0 0 1 4 12.7V18a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3A7 7 0 0 1 12 3z"/><path d="M10 22h4"/>'),
  sources: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'disc';
  span.innerHTML = ICONS[name] || ICONS.lineup;
  return span;
}

export function rawIcon(name) {
  return ICONS[name] || ICONS.lineup;
}
