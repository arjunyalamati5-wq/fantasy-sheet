/**
 * Short-form video (TikTok and the like) is deliberately not wired in.
 *
 * TikTok publishes no keyless API: the search endpoint answers 200 with an
 * empty bot-challenge body, and the oEmbed endpoint only resolves a video URL
 * you already hold, so there is no way to discover content. Their Research and
 * Content APIs both need an approved key, and scraping the site breaks their
 * terms. Rather than ship something that quietly returns nothing, this explains
 * the gap and points at what does work.
 */
export function socialReport() {
  return {
    available: false,
    platforms: [
      {
        name: 'TikTok',
        status: 'unavailable',
        reason: 'TikTok has no public API that works without an approved key. Its search endpoint returns an empty bot-challenge response, and the embed endpoint can only expand a video link you already have — it cannot find videos. The Research API requires an application and a key.',
        options: [
          'Apply for a TikTok Research or Display API key, then this can be wired in properly.',
          'Paste specific video links and they can be expanded into titles and creators through the public embed endpoint, which does work without a key.',
        ],
      },
      {
        name: 'Reddit',
        status: 'working',
        reason: 'Reddit\'s JSON API needs OAuth now, but the RSS feeds still answer anonymously. They rate-limit after a couple of requests, so the Community tab caches for thirty minutes and falls back to the last good copy when it gets refused.',
        options: [],
      },
      {
        name: 'ESPN',
        status: 'working',
        reason: 'ESPN\'s public feed needs no key and carries the day\'s NFL stories. It powers the News tab. Every story and Reddit post is labelled by how far its source can be trusted: Official, Reporter, Analysis, Community, or Unrated for a site this app does not know.',
        options: [],
      },
      {
        name: 'Open-Meteo',
        status: 'working',
        reason: 'Kickoff-hour weather for open-air stadiums, free for non-commercial use with no key. Weather data by Open-Meteo.com, licensed CC BY 4.0. Wind, rain, snow and cold are flagged next to players; they never change a projection.',
        options: [],
      },
    ],
    note: 'Where a source cannot be read without a key, this app says so rather than showing an empty panel.',
  };
}
