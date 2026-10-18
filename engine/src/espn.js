import { getJsonSoft } from './http.js';
import { TTL } from './cache.js';
import { normTeam } from './teams.js';

// ESPN's public site API. Keyless and undocumented, so every call is soft:
// if it disappears the news feed empties rather than taking a page down.
const NEWS = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news';
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export async function getNews({ limit = 40 } = {}) {
  const data = await getJsonSoft(`${NEWS}?limit=${limit}`, { key: `espn:news:${limit}`, ttl: TTL.NEWS }, null);
  if (!data || !Array.isArray(data.articles)) return { available: false, articles: [] };

  const articles = data.articles.map((a) => ({
    headline: a.headline || '',
    description: a.description || '',
    published: a.published || null,
    // Prefer the plain web link; ESPN nests several.
    link: a.links?.web?.href || a.links?.mobile?.href || null,
    image: a.images?.[0]?.url || null,
    type: a.type || null,
    // Players/teams ESPN tagged on the story, used to match it to a roster.
    tags: (a.categories || [])
      .map((c) => c.description || c.athlete?.displayName || c.team?.displayName)
      .filter(Boolean),
  }));
  return { available: true, articles };
}

/**
 * Live and recent scores with the game clock. With a season and week it asks
 * for that regular-season week explicitly: ESPN's default "current" week lags
 * Sleeper's by a couple of days every Tuesday. `fetchJson` is injectable for tests.
 */
export async function getScoreboard({ season = null, week = null, timeout = 8_000, fetchJson = getJsonSoft } = {}) {
  const url = season && week ? `${SCOREBOARD}?seasontype=2&week=${Number(week)}&dates=${Number(season)}` : SCOREBOARD;
  const key = season && week ? `espn:scoreboard:${season}:${week}` : 'espn:scoreboard';
  // No stale copy on failure: an old clock is worse than none, since the live
  // view falls back to estimating each game from its kickoff time.
  const data = await fetchJson(url, { key, ttl: TTL.SCOREBOARD, timeout, serveStale: false }, null);
  return parseScoreboard(data);
}

/** ESPN's scoreboard JSON, slimmed to what the score bug needs. */
export function parseScoreboard(data) {
  if (!data || !Array.isArray(data.events)) return { available: false, week: null, season: null, games: [] };
  const games = data.events.map((e) => {
    const comp = e.competitions?.[0];
    const status = comp?.status || e.status || {};
    const teams = (comp?.competitors || []).map((c) => ({
      abbr: c.team?.abbreviation,
      code: normTeam(c.team?.abbreviation),   // ESPN spells Washington WSH and the Rams LAR
      name: c.team?.displayName,
      score: c.score == null || c.score === '' ? null : Number(c.score),
      home: c.homeAway === 'home',
    }));
    const home = teams.find((t) => t.home) || null;
    const away = teams.find((t) => !t.home) || null;
    return {
      id: e.id || null,
      name: e.shortName,
      date: e.date || null,
      state: status.type?.state || null,        // pre | in | post
      statusName: status.type?.name || null,    // STATUS_HALFTIME, STATUS_FINAL, ...
      completed: Boolean(status.type?.completed),
      detail: status.type?.shortDetail || null,
      period: Number.isFinite(Number(status.period)) ? Number(status.period) : null,
      clock: status.displayClock || null,
      home: home?.code || null,
      away: away?.code || null,
      homeScore: home?.score ?? null,
      awayScore: away?.score ?? null,
      teams,
    };
  });
  return {
    available: true,
    week: Number(data.week?.number) || null,
    season: Number(data.season?.year) || null,
    games,
  };
}
