/**
 * Text tokenizer for the essay reader.
 *
 * Splits essay text into safe HTML in which EVERY alphabetic word is a
 * clickable token. Punctuation, numbers and whitespace pass through escaped
 * and untouched, so the essay keeps its original typography.
 */

/** Escape a string for safe insertion into HTML text content. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Normalized dictionary lookup key for a raw token. */
export function lemmaKey(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^[^a-z']+|[^a-z']+$/g, '');
}

/**
 * Render one paragraph of plain text to HTML with clickable word spans.
 *
 * @param {string} paragraph
 * @param {{ seenKeys?: Set<string> }} [options] words already looked up,
 *        rendered with a subtle "seen" style.
 * @returns {string}
 */
export function tokenizeParagraph(paragraph, options = {}) {
  const { seenKeys = new Set() } = options;
  const pattern = /[A-Za-z][A-Za-z’'-]*[A-Za-z’']|[A-Za-z]+/g;
  let out = '';
  let cursor = 0;
  let match;

  while ((match = pattern.exec(paragraph)) !== null) {
    const raw = match[0];
    out += escapeHtml(paragraph.slice(cursor, match.index));
    const key = lemmaKey(raw);
    const seen = seenKeys.has(key) ? ' w--seen' : '';
    out +=
      `<span class="w${seen}" data-w="${escapeHtml(key)}" data-raw="${escapeHtml(raw)}" ` +
      `tabindex="0" role="button" aria-label="Look up ${escapeHtml(raw)}">` +
      escapeHtml(raw) +
      '</span>';
    cursor = match.index + raw.length;
  }
  out += escapeHtml(paragraph.slice(cursor));
  return out;
}

/**
 * Split an essay body into a heading and paragraphs. Blank lines separate
 * blocks; a short single-line first block without terminal punctuation is
 * treated as the essay heading.
 *
 * @param {string} text
 * @returns {{ heading: string|null, paragraphs: string[] }}
 */
export function splitParas(text) {
  const blocks = String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const paragraphs = [];
  let heading = null;

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (heading === null && lines.length === 1 && lines[0].length <= 70 && !/[.!?，。]$/.test(lines[0])) {
      heading = lines[0];
      continue;
    }
    paragraphs.push(lines.join(' '));
  }
  return { heading, paragraphs };
}

/** Count words in plain text. */
export function countWords(text) {
  const matches = String(text).match(/[A-Za-z][A-Za-z’'-]*/g);
  return matches ? matches.length : 0;
}

/** First ~140 characters of the body, for the home page excerpt. */
export function excerpt(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140).replace(/\S+$/, '')}…` : flat;
}
