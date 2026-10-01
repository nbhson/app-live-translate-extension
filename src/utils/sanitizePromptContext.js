/**
 * Sanitize prompt context — trim + slice 600 + neutralize triple quotes & injection
 * For SHORT fields only (user hint, questions). Do NOT use for transcript
 * segments — it would silently cut a 5-minute window (~5000 chars) to 600 chars
 * (~40s of speech) and the rest would be marked "compressed" without coverage.
 * Use sanitizePromptSegment() for large segments.
 * @param {unknown} s
 * @returns {string}
 */
export function sanitizePromptContext(s) {
  return String(s || '')
    .trim()
    .slice(0, 600)
    // break triple quotes to prevent closing the """ block
    .replace(/"""/g, '"\'"')
    // strip control chars and limit newlines
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // collapse excessive whitespace but keep single newlines
    .replace(/[ \t]{3,}/g, ' ')
    .trim();
}

/**
 * Sanitize a LARGE transcript segment for prompt embedding.
 * Same injection protection as sanitizePromptContext but WITHOUT the 600-char
 * cap — keeps up to maxChars (tail) so compression/summary cover whole windows.
 * @param {unknown} s
 * @param {number} [maxChars]
 * @returns {string}
 */
export function sanitizePromptSegment(s, maxChars = 12000) {
  const cap = Math.max(1000, Number(maxChars) || 12000);
  let t = String(s || '').trim();
  if (t.length > cap) t = t.slice(-cap);
  return t
    .replace(/"""/g, '"\'"')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[ \t]{3,}/g, ' ')
    .trim();
}
