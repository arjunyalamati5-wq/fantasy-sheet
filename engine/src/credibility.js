// How much a story's source deserves to be believed, as a tier rather than a
// score. Feeds are display-only either way: a tier helps the reader weigh a
// headline, and never changes a projection, ranking or recommendation.
//
//   1 Official   the league, the clubs, official injury reports
//   2 Reporter   established newsrooms and their NFL reporters
//   3 Analysis   fantasy analysis sites and aggregators
//   4 Community  forums and social posts (or Unrated: a site we don't know)

const CLUBS = [
  'azcardinals.com', 'atlantafalcons.com', 'baltimoreravens.com', 'buffalobills.com',
  'panthers.com', 'chicagobears.com', 'bengals.com', 'clevelandbrowns.com',
  'dallascowboys.com', 'denverbroncos.com', 'detroitlions.com', 'packers.com',
  'houstontexans.com', 'colts.com', 'jaguars.com', 'chiefs.com',
  'raiders.com', 'chargers.com', 'therams.com', 'miamidolphins.com',
  'vikings.com', 'patriots.com', 'neworleanssaints.com', 'giants.com',
  'newyorkjets.com', 'philadelphiaeagles.com', 'steelers.com', '49ers.com',
  'seahawks.com', 'buccaneers.com', 'tennesseetitans.com', 'commanders.com',
];

const TIERS = [
  [1, 'Official', ['nfl.com', 'nflcommunications.com', ...CLUBS]],
  [2, 'Reporter', ['espn.com', 'theathletic.com', 'nytimes.com', 'apnews.com', 'si.com',
    'usatoday.com', 'washingtonpost.com', 'latimes.com', 'bostonglobe.com']],
  [3, 'Analysis', ['rotowire.com', 'nbcsports.com', 'fantasypros.com', 'cbssports.com',
    'yahoo.com', 'pff.com', 'fantasylife.com', '4for4.com', 'footballguys.com',
    'rotoballer.com', 'theringer.com', 'sleeper.com', 'underdognetwork.com']],
  [4, 'Community', ['reddit.com', 'redd.it', 'x.com', 'twitter.com', 'youtube.com', 'youtu.be',
    'tiktok.com', 'instagram.com', 'facebook.com', 'threads.net', 'bsky.app',
    'streamable.com', 'imgur.com']],
];

const DOMAIN_TIER = new Map();
for (const [tier, label, domains] of TIERS) {
  for (const d of domains) DOMAIN_TIER.set(d, { tier, label, domain: d });
}

/** Tier for a web link, or null when there is no http(s) link to judge. */
export function sourceTier(url) {
  const host = hostOf(url);
  if (!host) return null;
  // Walk up the labels so profootballtalk.nbcsports.com finds nbcsports.com,
  // but notespn.com never matches espn.com.
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const hit = DOMAIN_TIER.get(labels.slice(i).join('.'));
    if (hit) return { ...hit };
  }
  return { tier: 4, label: 'Unrated', domain: host.replace(/^www\./, '') };
}

/**
 * A Reddit post is community talk. When it shares a link to another site,
 * it carries that site's tier instead, marked as arriving via Reddit.
 */
export function redditTier(permalink, linkUrl) {
  const community = { tier: 4, label: 'Community', domain: 'reddit.com' };
  const linked = sourceTier(linkUrl);
  if (!linked || linked.domain === 'reddit.com' || linked.domain === 'redd.it') return community;
  return { ...linked, via: 'Reddit' };
}

function hostOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
