import { load } from './store.js';
import { el, frag, emptyState, callout, renderAsync, warningsBlock, credibilityTag, safeHref } from './ui.js';

// ---------------------------------------------------------------- Community

export function communityView(root) {
  renderAsync(root, load('community'), (data) => {
    const r = data.report;
    const out = frag([warningsBlock()]);

    if (!r.available) {
      out.appendChild(emptyState('Reddit is rate-limiting us', r.emptyMessage));
      return out;
    }

    out.appendChild(callout(r.note, 'amber'));
    out.appendChild(el('p', { class: 'section-note', text: `Reading ${r.subreddits.join(' and ')}.` }));

    if (r.aboutMyRoster.length) {
      out.appendChild(el('h3', { class: 'sub-title', text: 'Posts about players you hold' }));
      for (const p of r.aboutMyRoster.slice(0, 15)) out.appendChild(post(p, true));
    }

    out.appendChild(el('h3', { class: 'sub-title', text: 'What else is being discussed' }));
    const rest = r.posts.filter((p) => p.mentionsMyPlayers.length === 0);
    if (!rest.length) {
      out.appendChild(emptyState('Nothing else right now', 'Every post in the feed already mentions one of your players.'));
    }
    for (const p of rest.slice(0, 30)) out.appendChild(post(p, false));
    return out;
  });
}

function post(p, mine) {
  const box = el('div', { class: 'story' });
  box.appendChild(el('div', { class: 'story-head' }, [
    p.url
      ? el('a', { class: 'story-title', href: safeHref(p.url), target: '_blank', rel: 'noopener noreferrer', text: p.title })
      : el('span', { class: 'story-title', text: p.title }),
  ]));

  if (mine && p.mentionsMyPlayers.length) {
    const tags = el('div', { style: 'margin:6px 0 2px' });
    for (const m of p.mentionsMyPlayers) {
      tags.appendChild(el('span', { class: 'tag pine', text: `${m.name} (${m.position})` }));
    }
    box.appendChild(tags);
  }
  if (p.excerpt) box.appendChild(el('p', { class: 'story-body', text: p.excerpt }));

  const cred = credibilityTag(p.credibility);
  if (cred) cred.style.marginLeft = '0';
  box.appendChild(el('div', { class: 'story-foot' }, [
    el('span', { class: 'story-source', text: `r/${p.subreddit}` }),
    el('span', { text: p.author || '' }),
    cred,
    el('span', { text: p.published ? new Date(p.published).toLocaleString() : '' }),
  ]));
  return box;
}

// ---------------------------------------------------------------- Sources

export function sourcesView(root, { embedded = false } = {}) {
  // Rendered synchronously: a self-titled view needs its heading up before
  // the data arrives, not only inside renderAsync's render function.
  // `embedded`: the Front office supplies its own heading for this block.
  root.textContent = '';
  if (!embedded) root.appendChild(el('h2', { class: 'section-title', text: 'Where the data comes from' }));
  const body = el('div');
  root.appendChild(body);

  renderAsync(body, load('sources'), (data) => {
    const r = data.report;
    const out = frag([]);
    out.appendChild(el('p', { class: 'section-note', text: r.note }));

    const t = el('table', { class: 'sheet' });
    t.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { class: 'l', scope: 'col', text: 'Source' }),
      el('th', { scope: 'col', text: 'Status' }),
      el('th', { class: 'l', scope: 'col', text: 'Why' }),
    ])]));
    const tb = el('tbody');
    for (const p of r.platforms) {
      const working = p.status === 'working';
      tb.appendChild(el('tr', {}, [
        el('th', { class: 'l', scope: 'row', text: p.name }),
        el('td', {}, [el('span', { class: `tag ${working ? 'pine' : 'brick'}`, style: 'margin-left:0', text: working ? 'connected' : 'not available' })]),
        el('td', { class: 'l wrap-cell' }, [
          p.reason,
          p.options.length ? el('ul', { style: 'margin:8px 0 0;padding-left:18px;color:var(--ink-soft);font-size:13.5px' },
            p.options.map((o) => el('li', { text: o }))) : null,
        ].filter(Boolean)),
      ]));
    }
    t.appendChild(tb);
    out.appendChild(el('div', { class: 'table-scroll' }, [t]));
    return out;
  });
}
