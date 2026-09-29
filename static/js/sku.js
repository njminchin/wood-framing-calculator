// SKU generation from a format pattern, e.g. "{PREFIX}-{YYYY}-{SEQ:4}" -> "FF-2026-0042".
//
// Codes: {PREFIX} {YYYY} {YY} {MM} {ARTIST} (initials) {SIZE} (width x height) {SEQ} or {SEQ:n}.
// Anything else is kept as typed. The running number ({SEQ}) is one more than the
// highest already used by a saved SKU that matches the same pattern with the same
// other parts - so with {YYYY} in the format it restarts every year, and with
// {ARTIST} it counts separately for each artist.

export const DEFAULT_SKU_FORMAT = '{PREFIX}-{YYYY}-{SEQ:4}';

const CODE = /(\{[A-Za-z]+(?::\d+)?\})/;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad = (n, width) => String(n).padStart(width, '0');

export function artistInitials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, '').charAt(0))
    .join('')
    .toUpperCase();
}

/**
 * @param {string} format   e.g. "{PREFIX}-{YYYY}-{SEQ:4}"
 * @param {object} info     { prefix, artist, width, height, date }
 * @param {string[]} existing  SKUs already saved
 * @returns {{ sku: string, missing: string[], hasSeq: boolean }}
 *   `missing` lists what's needed but empty (e.g. "artist"), in which case `sku` is incomplete.
 */
export function nextSku(format, { prefix = '', artist = '', width, height, date = new Date() } = {}, existing = []) {
  const year = String(date.getFullYear());
  const missing = [];
  const values = {
    PREFIX: String(prefix || '').trim(),
    YYYY: year,
    YY: year.slice(-2),
    MM: pad(date.getMonth() + 1, 2),
    ARTIST: artistInitials(artist),
    SIZE: width > 0 && height > 0 ? `${Math.round(width)}x${Math.round(height)}` : '',
  };
  const needs = { ARTIST: 'artist', SIZE: 'painting size' };

  let pattern = '^';
  let seqWidth = null;
  const pieces = [];
  for (const part of String(format || DEFAULT_SKU_FORMAT).split(CODE)) {
    const m = part.match(/^\{([A-Za-z]+)(?::(\d+))?\}$/);
    const key = m && m[1].toUpperCase();
    if (key === 'SEQ') {
      if (seqWidth === null) {
        seqWidth = Number(m[2] || 0);
        pattern += '(\\d+)';
      } else {
        pattern += '\\d+';
      }
      pieces.push(null); // filled in once the number is known
    } else if (key && key in values) {
      if (!values[key] && needs[key]) missing.push(needs[key]);
      pattern += escapeRegExp(values[key]);
      pieces.push(values[key]);
    } else {
      pattern += escapeRegExp(part); // plain text, or an unknown code kept literally
      pieces.push(part);
    }
  }
  pattern += '$';

  let seq = 1;
  if (seqWidth !== null) {
    const matcher = new RegExp(pattern, 'i');
    for (const sku of existing) {
      const found = String(sku || '').trim().match(matcher);
      if (found) seq = Math.max(seq, parseInt(found[1], 10) + 1);
    }
  }
  const sku = pieces.map((p) => (p === null ? pad(seq, seqWidth || 0) : p)).join('');
  return { sku, missing: [...new Set(missing)], hasSeq: seqWidth !== null };
}
