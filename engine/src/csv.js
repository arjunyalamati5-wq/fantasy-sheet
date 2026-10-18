// A real CSV parser. nflverse files contain quoted fields with embedded commas
// (player names, stadium names) and escaped quotes. split(',') corrupts those rows.

/**
 * Parse CSV text into an array of row-arrays.
 * Handles: quoted fields, embedded commas, embedded newlines, "" escaped quotes,
 * CRLF and LF line endings, and a trailing newline.
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;

  // Strip a UTF-8 BOM so the first header name isn't corrupted.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => {
    row.push(field);
    field = '';
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    // Skip blank lines produced by a trailing newline.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"' && field === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // Flush the final field/row when the file has no trailing newline.
  if (field !== '' || fieldWasQuoted || row.length > 0) endRow();
  return rows;
}

/**
 * Parse CSV text into objects keyed by the header row.
 * `wanted` (a Set or array of column names) keeps only those columns, which
 * matters for the multi-megabyte nflverse files.
 */
export function parseCsv(text, wanted = null) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const want = wanted ? new Set(wanted) : null;
  const keep = header.map((h) => (want ? want.has(h) : true));

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      if (!keep[c]) continue;
      obj[header[c]] = cells[c] === undefined ? '' : cells[c];
    }
    out.push(obj);
  }
  return out;
}

/** Numeric coercion for CSV cells. Empty strings and "NA" become null, not 0. */
export function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'NA' || s === 'NaN' || s === 'null') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Numeric coercion that treats missing as 0, for accumulating stats. */
export function num0(v) {
  const n = num(v);
  return n === null ? 0 : n;
}

/**
 * Read a column by any of several names, first match wins.
 * nflverse renames columns between seasons; this keeps old names as fallbacks.
 */
export function col(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== '') return row[n];
  }
  return undefined;
}
