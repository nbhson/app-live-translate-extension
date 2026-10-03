/**
 * Strip STT carry-repeat: Chrome Speech often re-emits the last char of the
 * previous final at the start of the next final:
 *   "...my mum did" -> "d I haven't..." / "...Simkins" -> "s how is..."
 * Only strips a single consonant (never "a"/"I") matching the previous tail.
 * Mirror of stripSttCarryRepeat() in sidepanel.js.
 * @param {string} text
 * @param {string} prevText
 * @returns {string}
 */
export function stripSttCarryRepeat(text, prevText) {
  const clean = String(text || '').trim();
  if (!clean) return clean;
  const prevTail = String(prevText || '').trim().replace(/[.!?…\s]+$/g, '');
  if (!prevTail) return clean;
  const m = clean.match(/^([A-Za-z])(?:(\s+)|(?=[A-Z]))(.*)$/s);
  if (!m) return clean;
  const ch = m[1].toLowerCase();
  if (ch === 'a' || ch === 'i') return clean; // valid English words
  if (!/[b-z]/.test(ch)) return clean;
  // Glued lowercase ("donald...") is a real word, not a fragment — only the
  // spaced form ("d ...") or glued-UPPERCASE ("dI ...") can be carry-repeat.
  if (!m[2] && m[3] && /^[a-z]/.test(m[3])) return clean;
  const rest = (m[3] || '').trim();
  const lastWord = prevTail.split(/\s+/).pop() || '';
  if (lastWord.slice(-1).toLowerCase() === ch) return rest;
  return clean;
}
