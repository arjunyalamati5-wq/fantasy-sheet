import { getTextSoft } from './http.js';
import { TTL } from './cache.js';

// Reddit's JSON API needs OAuth now (it answers 403 without it), but the RSS
// feeds still serve anonymously. They rate-limit hard — roughly two requests
// before a 429 — so this is cached for half an hour and leans on the cache
// layer's stale-on-failure behaviour when the limit bites.
//
// Everything here is user-written text from strangers. It is displayed as
// comment, never parsed for instructions, and never feeds a projection.

const FEED = (sub, sort, limit) =>
  `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.rss?limit=${limit}`;

// A browser user agent: Reddit 403s the default one.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export const SUBREDDITS = [
  { id: 'fantasyfootball', label: 'r/fantasyfootball' },
  { id: 'DynastyFF', label: 'r/DynastyFF' },
];

/** Fetch and parse one subreddit's feed. Returns [] rather than throwing. */
export async function getSubreddit(sub, { sort = 'hot', limit = 25 } = {}) {
  const xml = await getTextSoft(
    FEED(sub, sort, limit),
    { key: `reddit:${sub}:${sort}`, ttl: TTL.REDDIT, timeout: 25_000, headers: { 'user-agent': UA } },
    null
  );
  if (!xml || !xml.includes('<entry>')) return { available: false, posts: [] };
  return { available: true, posts: parseAtom(xml, sub) };
}

/** Minimal Atom reader — Reddit's feeds are Atom, and this needs five fields. */
export function parseAtom(xml, sub) {
  const out = [];
  for (const chunk of xml.split('<entry>').slice(1)) {
    const grab = (re) => {
      const m = chunk.match(re);
      return m ? decodeEntities(m[1].trim()) : '';
    };
    const title = grab(/<title>([\s\S]*?)<\/title>/);
    if (!title) continue;

    const html = grab(/<content type="html">([\s\S]*?)<\/content>/);
    out.push({
      title,
      author: grab(/<name>([\s\S]*?)<\/name>/),
      url: (chunk.match(/<link href="([^"]+)"/) || [])[1] || null,
      // A link post shares another site's article; its address sits in
      // Reddit's own "[link]" anchor, which always comes last, after the post
      // body. Take the last one, so a body link labelled [link] cannot stand
      // in for it. On a text post that anchor is the thread itself.
      linkUrl: [...html.matchAll(/<a href="([^"]+)">\[link\]<\/a>/g)].at(-1)?.[1] || null,
      published: grab(/<updated>([\s\S]*?)<\/updated>/) || grab(/<published>([\s\S]*?)<\/published>/),
      subreddit: (chunk.match(/<category term="([^"]*)"/) || [])[1] || sub,
      excerpt: textFromHtml(html).slice(0, 320),
    });
  }
  return out;
}

/** Strip markup and collapse whitespace; the feed body is HTML. */
function textFromHtml(html) {
  return decodeEntities(String(html || ''))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
};

function decodeEntities(s) {
  // Feeds double-encode, so decode twice.
  let out = String(s);
  for (let i = 0; i < 2; i++) {
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, code) => {
      if (NAMED[code] !== undefined) return NAMED[code];
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return whole;
    });
  }
  return out;
}

export { textFromHtml as _textFromHtml, decodeEntities as _decodeEntities };
