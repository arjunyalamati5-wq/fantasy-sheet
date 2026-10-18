// Motion: things rise into place as they arrive, numbers count up to their
// value, and nothing moves at all for someone who has asked for less motion.
// Every effect here is an entrance or an answer to an action; nothing loops
// except the score ticker.

export const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Split a heading's text into words that rise out of a mask one after
 * another. Element children (an image pill inside a sentence) ride along as
 * their own "word". The accessible name is the original sentence.
 */
export function riseWords(node, { delay = 0, step = 55 } = {}) {
  if (!node) return node;
  const label = node.textContent.replace(/\s+/g, ' ').trim();
  const parts = [];
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      for (const word of child.textContent.split(/(\s+)/)) {
        if (!word) continue;
        parts.push(/^\s+$/.test(word) ? document.createTextNode(word) : wordSpan(document.createTextNode(word)));
      }
    } else {
      parts.push(wordSpan(child));
    }
  }
  node.replaceChildren(...parts);
  let i = 0;
  for (const w of node.querySelectorAll(':scope > .w')) w.style.setProperty('--d', `${delay + i++ * step}ms`);
  if (label && !node.hasAttribute('aria-label')) {
    node.setAttribute('aria-label', label);
    for (const w of node.querySelectorAll(':scope > .w')) w.setAttribute('aria-hidden', 'true');
  }
  node.classList.add('rise-words');
  return node;
}

function wordSpan(content) {
  const inner = document.createElement('span');
  inner.className = 'wi';
  inner.appendChild(content);
  const outer = document.createElement('span');
  outer.className = 'w';
  outer.appendChild(inner);
  return outer;
}

/**
 * The wordmark: one line of heavy, wide capitals that spans the page, letter
 * by letter rising on first paint. Sized by measurement, so any team name
 * fills the width exactly.
 */
export function wordmark(text) {
  const h = document.createElement('h1');
  h.className = 'wordmark';
  h.setAttribute('aria-label', text);
  const line = document.createElement('span');
  line.className = 'wm-line';
  line.setAttribute('aria-hidden', 'true');
  [...text].forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = 'wm-ch';
    s.style.setProperty('--d', `${120 + i * 38}ms`);
    s.textContent = ch === ' ' ? ' ' : ch;
    line.appendChild(s);
  });
  h.appendChild(line);
  requestAnimationFrame(() => fitWordmark(h));
  return h;
}

export function fitWordmark(h) {
  const line = h?.querySelector('.wm-line');
  if (!line || !h.isConnected) return;
  line.style.fontSize = '100px';
  const natural = line.scrollWidth;
  const room = h.clientWidth;
  if (!natural || !room) return;
  // Cap it: a two-letter team name should not be a screen tall. The theme
  // can lower the cap (--wm-cap, a share of the width) for a calmer masthead.
  const cap = parseFloat(getComputedStyle(h).getPropertyValue('--wm-cap')) || 0.17;
  const size = Math.min(room / natural * 100, room * cap, 260);
  line.style.fontSize = `${Math.floor(size * 100) / 100}px`;
}
window.addEventListener('resize', () => fitWordmark(document.querySelector('.wordmark')));
document.fonts?.ready.then(() => fitWordmark(document.querySelector('.wordmark')));

// ---------------------------------------------------------------- reveals

// What rises into place when it scrolls into view. Top-level pieces only, so a
// table arrives as one sheet rather than forty rows each doing a little dance.
const REVEAL = [
  '#main .panel > *:not(h2.visually-hidden)',
  '#main .stack-block', '#main .plan-phase', '#main .table-scroll', '#main .figures',
  '#main .moves', '#main .onfield', '#main .card', '#main .callout', '#main .checks',
].join(',');

const seen = new WeakSet();
const io = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
      countUpWithin(e.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 })
  : null;

/** Tag new pieces of the page for their entrance. Called on every DOM change in #main. */
export function armReveals(root = document) {
  const fresh = [...root.querySelectorAll(REVEAL)].filter((n) => !seen.has(n));
  if (!fresh.length) return;
  // Siblings that arrive together are staggered, a few at most.
  const groups = new Map();
  for (const n of fresh) {
    seen.add(n);
    if (reduceMotion() || !io) { n.classList.add('is-in'); continue; }
    const k = n.parentElement;
    const i = groups.get(k) || 0;
    groups.set(k, i + 1);
    n.style.setProperty('--rd', `${Math.min(i, 5) * 70}ms`);
    n.classList.add('reveal');
    io.observe(n);
  }
}

// ---------------------------------------------------------------- numbers

const NUM = /^([+\-−$]?)(\d[\d,]*(?:\.\d+)?)(%|st|nd|rd|th)?$/;

/** Count every plain figure inside `root` up from zero to what it says. */
export function countUpWithin(root) {
  if (reduceMotion()) return;
  for (const n of root.querySelectorAll('.figure .value, .count-up')) countUp(n);
}

export function countUp(node, ms = 900) {
  if (!node || node.dataset.counted || node.children.length) return;
  const m = NUM.exec(node.textContent.trim());
  if (!m) return;
  node.dataset.counted = '1';
  const [, pre, num, suf = ''] = m;
  const target = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(target) || target === 0) return;
  const decimals = (num.split('.')[1] || '').length;
  const final = node.textContent;
  const t0 = performance.now();
  const frame = (t) => {
    const p = Math.min(1, (t - t0) / ms);
    const eased = 1 - (1 - p) ** 4;
    // A live update that lands mid-count wins: stop and leave its number.
    if (p >= 1 || !node.isConnected || node.dataset.counted !== '1') { if (p >= 1) node.textContent = final; return; }
    const v = (target * eased).toFixed(decimals);
    node.textContent = `${pre}${decimals ? v : Number(v).toLocaleString('en-US')}${suf}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The circle-arrow mark used on every link-like row and call to action. */
export function goArrow({ dir = 'right' } = {}) {
  const span = document.createElement('span');
  span.className = `go go-${dir}`;
  span.setAttribute('aria-hidden', 'true');
  const path = dir === 'down' ? 'M12 5v14M6 13l6 6 6-6' : 'M5 12h14M13 6l6 6-6 6';
  span.innerHTML = `<svg viewBox="0 0 24 24"><path d="${path}"/></svg><svg viewBox="0 0 24 24"><path d="${path}"/></svg>`;
  return span;
}
