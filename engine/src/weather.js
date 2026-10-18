import { getJsonSoft } from './http.js';

// Game-time weather from Open-Meteo: free for non-commercial use, no key,
// CC-BY 4.0 (credited on the Data sources page). Display only — like news,
// it never changes a projection. It only says when conditions are bad enough
// that a manager should look twice at a kicker or a passing game.
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const TTL = 60 * 60_000;
const HORIZON = 7 * 24 * 60 * 60_000; // forecasts past a week are noise

// Open-air stadiums by nflverse stadium_id. Domes and retractable roofs are
// deliberately absent: weather does not reach the field there.
const OPEN_AIR = {
  BAL00: [39.278, -76.623], BOS00: [42.091, -71.264], BUF00: [42.774, -78.787],
  CAR00: [35.226, -80.853], CHI98: [41.862, -87.617], CIN00: [39.095, -84.516],
  CLE00: [41.506, -81.700], DEN00: [39.744, -105.020], GNB00: [44.501, -88.062],
  JAX00: [30.324, -81.637], KAN00: [39.049, -94.484], MIA00: [25.958, -80.239],
  NAS00: [36.166, -86.771], NYC01: [40.814, -74.074], PHI00: [39.901, -75.168],
  PIT00: [40.447, -80.016], SEA00: [47.595, -122.332], SFO01: [37.403, -121.970],
  TAM00: [27.976, -82.503], WAS00: [38.908, -76.865],
  LON00: [51.556, -0.280], LON02: [51.604, -0.066], MEX00: [19.303, -99.151],
};
// International games sometimes carry the host club's id; the stadium name wins.
const BY_NAME = {
  'Tottenham Hotspur Stadium': OPEN_AIR.LON02,
  'Wembley Stadium': OPEN_AIR.LON00,
};
const OPEN_ROOFS = new Set(['outdoors', 'open']);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

/** [lat, lon] for a game played in the open air, or null when weather cannot matter. */
export function stadiumLocation(game) {
  if (!OPEN_ROOFS.has(game?.roof)) return null;
  return BY_NAME[game.stadium] || OPEN_AIR[game.stadiumId] || null;
}

/**
 * One forecast hour in plain terms. Thresholds are the usual rules of thumb:
 * sustained wind of 15 mph starts to cost passing and kicking; rain needs a
 * real chance AND a real amount; 25°F and below is a cold game.
 */
export function summarizeHour(h) {
  const tempF = Math.round(h.temperature_2m);
  const windMph = h.wind_speed_10m;
  const chance = h.precipitation_probability ?? 0;
  const amount = h.precipitation ?? 0;
  const snowy = SNOW_CODES.has(h.weather_code);
  const snow = snowy && chance >= 50;

  const flags = [];
  if (windMph >= 15) flags.push(`Wind ${Math.round(windMph)} mph`);
  if (snow) flags.push('Snow likely');
  else if (chance >= 50 && amount >= 0.02) flags.push('Rain likely');
  if (tempF <= 25) flags.push(`Cold ${tempF}°F`);

  return {
    tempF,
    windMph: Math.round(windMph),
    gustMph: Math.round(h.wind_gusts_10m ?? windMph),
    precipChance: chance,
    flags,
    summary: `${tempF}°F, wind ${Math.round(windMph)} mph, ${chance}% chance of ${snowy ? 'snow' : 'rain'}`,
  };
}

/** Kickoff-hour forecast for one game, or null (indoors, finished, too far out, or the feed is down). */
export async function getGameWeather(game, now = Date.now(), { fetchJson = getJsonSoft } = {}) {
  const where = stadiumLocation(game);
  if (!where || !game.kickoff) return null;
  if (game.homeScore != null) return null;
  if (game.kickoff - now > HORIZON || now - game.kickoff > 4 * 3_600_000) return null;

  const iso = new Date(Math.floor(game.kickoff / 3_600_000) * 3_600_000).toISOString();
  const day = iso.slice(0, 10);
  const hourKey = iso.slice(0, 13) + ':00';
  const url = `${FORECAST}?latitude=${where[0]}&longitude=${where[1]}`
    + '&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
    + `&timezone=UTC&start_date=${day}&end_date=${day}`;

  const data = await fetchJson(url, { key: `weather:${game.gameId}:${hourKey}`, ttl: TTL, timeout: 10_000 }, null);
  const hourly = data?.hourly;
  const i = hourly?.time?.indexOf(hourKey) ?? -1;
  if (i < 0) return null;
  const pick = (k) => hourly[k]?.[i];
  if (pick('temperature_2m') == null || pick('wind_speed_10m') == null) return null;
  return summarizeHour({
    temperature_2m: pick('temperature_2m'), wind_speed_10m: pick('wind_speed_10m'),
    wind_gusts_10m: pick('wind_gusts_10m'), precipitation_probability: pick('precipitation_probability'),
    precipitation: pick('precipitation'), weather_code: pick('weather_code'),
  });
}

/**
 * Forecasts for every open-air game in a week, keyed by game id. Weather is
 * display-only, so a slow forecast service never holds up a page: after
 * `deadline` ms this returns whatever has arrived, and forecasts that land
 * later still fill the same map for the next request that reads it.
 */
export async function loadWeekWeather(schedule, week, now = Date.now(), { deadline = 3_000, fetchGame = getGameWeather } = {}) {
  const byGame = new Map();
  const games = (schedule.games || []).filter((g) => g.week === week);
  // One game's failure must cost only that game's forecast: an uncaught
  // rejection here would reject Promise.all and take the page down with it.
  const work = games.map(async (g) => {
    const w = await Promise.resolve().then(() => fetchGame(g, now)).catch(() => null);
    if (w) byGame.set(g.gameId, w);
  });
  let timer;
  await Promise.race([
    Promise.all(work),
    new Promise((resolve) => { timer = setTimeout(resolve, deadline); }),
  ]);
  clearTimeout(timer);
  return byGame;
}
