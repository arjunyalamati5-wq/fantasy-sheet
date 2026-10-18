// Tiny SVG charts. The *Markup functions are pure (string in, string out) so
// they run in tests; lineChart/barRange wrap them in a DOM node. Colours come
// from currentColor and CSS custom properties, so both themes work, and every
// chart carries a visually hidden data table with the same numbers.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const W = 360;
const H = 160;
const PAD = { l: 38, r: 12, t: 12, b: 26 };
let uid = 0;

const fmtDefault = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function scale(lo, hi) {
  const span = hi - lo || 1;
  return {
    x: (i, n) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r)),
    y: (v) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b),
  };
}

function niceRange(values, floorZero) {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (floorZero) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  return [floorZero && lo === 0 ? 0 : lo - pad, hi + pad];
}

function dataTable(caption, heads, rows) {
  return `<div class="visually-hidden"><table><caption>${esc(caption)}</caption><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr><th scope="row">${esc(r[0])}</th>${r.slice(1).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/**
 * points: [{x: label or number, y: number|null}], yFormat(v) => string,
 * label: what is plotted, avg: optional reference value (a position average).
 */
export function lineChartMarkup({ points = [], yFormat = fmtDefault, label = 'Value', avg = null, xLabel = 'Week' } = {}) {
  const pts = points.filter((p) => typeof p.y === 'number' && Number.isFinite(p.y));
  const id = `ch${++uid}`;
  if (!pts.length) return `<div class="ch-empty">No ${esc(label.toLowerCase())} to chart yet.</div>`;
  const ys = pts.map((p) => p.y).concat(typeof avg === 'number' ? [avg] : []);
  const [lo, hi] = niceRange(ys, true);
  const sc = scale(lo, hi);
  const n = pts.length;
  const xy = pts.map((p, i) => [sc.x(i, n), sc.y(p.y)]);
  const first = pts[0];
  const last = pts[n - 1];
  const hiPt = pts.reduce((a, b) => (b.y > a.y ? b : a));
  const loPt = pts.reduce((a, b) => (b.y < a.y ? b : a));
  const summary = `${label} by ${xLabel.toLowerCase()}, ${n} point${n === 1 ? '' : 's'}: `
    + `${xLabel.toLowerCase()} ${first.x} ${yFormat(first.y)}, latest ${xLabel.toLowerCase()} ${last.x} ${yFormat(last.y)}, `
    + `high ${yFormat(hiPt.y)} in ${xLabel.toLowerCase()} ${hiPt.x}, low ${yFormat(loPt.y)} in ${xLabel.toLowerCase()} ${loPt.x}`
    + `${typeof avg === 'number' ? `, position average ${yFormat(avg)}` : ''}.`;
  const grid = [0, 0.5, 1].map((f) => {
    const v = lo + (hi - lo) * f;
    return `<line class="ch-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sc.y(v).toFixed(1)}" y2="${sc.y(v).toFixed(1)}"/>`
      + `<text class="ch-t" x="${PAD.l - 6}" y="${(sc.y(v) + 4).toFixed(1)}" text-anchor="end">${esc(yFormat(v))}</text>`;
  }).join('');
  const avgLine = typeof avg === 'number'
    ? `<line class="ch-avg" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sc.y(avg).toFixed(1)}" y2="${sc.y(avg).toFixed(1)}"/>`
      + `<text class="ch-t ch-avg-t" x="${W - PAD.r}" y="${(sc.y(avg) - 4).toFixed(1)}" text-anchor="end">position average ${esc(yFormat(avg))}</text>` : '';
  const step = Math.max(1, Math.ceil(n / 9));
  const xs = pts.map((p, i) => (i % step === 0 || i === n - 1
    ? `<text class="ch-t" x="${xy[i][0].toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(p.x)}</text>` : '')).join('');
  const path = xy.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join(' ');
  const dots = xy.map((c, i) => `<circle class="ch-dot${i === n - 1 ? ' ch-last' : ''}" cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="${i === n - 1 ? 4.5 : 3}"><title>${esc(`${xLabel} ${pts[i].x}: ${yFormat(pts[i].y)}`)}</title></circle>`).join('');
  const tag = `<text class="ch-t ch-val" x="${Math.min(xy[n - 1][0], W - PAD.r - 14).toFixed(1)}" y="${(xy[n - 1][1] - 9).toFixed(1)}" text-anchor="middle">${esc(yFormat(last.y))}</text>`;
  return `<figure class="ch"><svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t" class="ch-svg" preserveAspectRatio="xMidYMid meet">`
    + `<title id="${id}-t">${esc(summary)}</title>${grid}${avgLine}<path class="ch-line" d="${path}" fill="none"/>${dots}${tag}${xs}</svg>`
    + dataTable(`${label} by ${xLabel.toLowerCase()}`, [xLabel, label], pts.map((p) => [p.x, yFormat(p.y)]))
    + '</figure>';
}

/**
 * items: [{x, lo, mid, hi, note}] — lo/hi are floor and ceiling, mid the projection.
 * An item with lo == null is drawn as a gap labelled by its note (a bye).
 */
export function barRangeMarkup({ items = [], yFormat = fmtDefault, label = 'Projection range', xLabel = 'Week' } = {}) {
  const real = items.filter((i) => typeof i.hi === 'number');
  const id = `ch${++uid}`;
  if (!real.length) return `<div class="ch-empty">No ${esc(label.toLowerCase())} to chart yet.</div>`;
  const [lo, hi] = niceRange(real.flatMap((i) => [i.lo, i.hi]), true);
  const sc = scale(lo, hi);
  const n = items.length;
  const slot = (W - PAD.l - PAD.r) / n;
  const bw = Math.min(34, slot * 0.5);
  const cx = (i) => PAD.l + slot * (i + 0.5);
  const grid = [0, 0.5, 1].map((f) => {
    const v = lo + (hi - lo) * f;
    return `<line class="ch-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sc.y(v).toFixed(1)}" y2="${sc.y(v).toFixed(1)}"/>`
      + `<text class="ch-t" x="${PAD.l - 6}" y="${(sc.y(v) + 4).toFixed(1)}" text-anchor="end">${esc(yFormat(v))}</text>`;
  }).join('');
  const bars = items.map((it, i) => {
    const x = cx(i).toFixed(1);
    const axis = `<text class="ch-t" x="${x}" y="${H - 8}" text-anchor="middle">${esc(it.x)}</text>`;
    if (typeof it.hi !== 'number') {
      return `<text class="ch-t" x="${x}" y="${(sc.y(lo) - 8).toFixed(1)}" text-anchor="middle">${esc(it.note || 'none')}</text>${axis}`;
    }
    const y1 = sc.y(it.hi);
    const y2 = sc.y(it.lo);
    return `<rect class="ch-bar" x="${(cx(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, y2 - y1).toFixed(1)}" rx="3">`
      + `<title>${esc(`${xLabel} ${it.x}: floor ${yFormat(it.lo)}, projected ${yFormat(it.mid)}, ceiling ${yFormat(it.hi)}`)}</title></rect>`
      + `<line class="ch-mid" x1="${(cx(i) - bw / 2 - 3).toFixed(1)}" x2="${(cx(i) + bw / 2 + 3).toFixed(1)}" y1="${sc.y(it.mid).toFixed(1)}" y2="${sc.y(it.mid).toFixed(1)}"/>`
      + `<text class="ch-t ch-val" x="${x}" y="${(y1 - 5).toFixed(1)}" text-anchor="middle">${esc(yFormat(it.mid))}</text>${axis}`;
  }).join('');
  const summary = `${label} for ${n} ${xLabel.toLowerCase()}${n === 1 ? '' : 's'}: `
    + items.map((i) => (typeof i.hi === 'number' ? `${xLabel.toLowerCase()} ${i.x} ${yFormat(i.lo)} to ${yFormat(i.hi)}, projected ${yFormat(i.mid)}` : `${xLabel.toLowerCase()} ${i.x} ${i.note || 'none'}`)).join('; ') + '.';
  return `<figure class="ch"><svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t" class="ch-svg" preserveAspectRatio="xMidYMid meet">`
    + `<title id="${id}-t">${esc(summary)}</title>${grid}${bars}</svg>`
    + dataTable(label, [xLabel, 'Floor', 'Projected', 'Ceiling'], items.map((i) => (typeof i.hi === 'number'
      ? [i.x, yFormat(i.lo), yFormat(i.mid), yFormat(i.hi)] : [i.x, i.note || 'none', '', ''])))
    + '</figure>';
}

function toNode(markup) {
  const d = document.createElement('div');
  d.className = 'ch-wrap';
  d.innerHTML = markup;
  return d;
}
export const lineChart = (opts) => toNode(lineChartMarkup(opts));
export const barRange = (opts) => toNode(barRangeMarkup(opts));
