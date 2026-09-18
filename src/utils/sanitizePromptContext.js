/**
 * Sanitize prompt context — trim + slice 600 + neutralize triple quotes & injection
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
