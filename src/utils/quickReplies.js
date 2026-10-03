/** Quick replies = câu trả lời thẳng, ngắn gọn (mirror of sidepanel.js).
 * Lấy câu đầu của mỗi complete answer (tối đa ~140 ký tự).
 * Fallback về structures khi chưa có answers.
 * @param {string} text
 * @returns {string}
 */
export function firstSentenceDirect(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^[^.!?]+[.!?]/);
  const s = (m ? m[0] : t).trim();
  return s.length > 140 ? s.slice(0, 140).trimEnd() + '…' : s;
}

/**
 * @param {string[]} answers
 * @param {string[]} structures
 * @returns {string[]}
 */
export function makeQuickReplies(answers, structures) {
  const out = (Array.isArray(answers) ? answers : [])
    .map(firstSentenceDirect)
    .filter((s) => s && s.length >= 8);
  if (out.length > 0) return out.slice(0, 3);
  return (Array.isArray(structures) ? structures : []).slice(0, 3);
}
