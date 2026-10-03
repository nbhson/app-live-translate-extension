/** Tone taxonomy ported from React SuggestedAnswersView (getToneBadge).
 * Maps an answer tone label to a CSS class suffix.
 * Mirror of the inline `toneClass()` in sidepanel.js renderDockBody.
 * @param {string} tone
 * @returns {'tone-confident'|'tone-pro'|'tone-concise'}
 */
export function toneClass(tone) {
  const t = String(tone || '');
  if (t.includes('Tự tin')) return 'tone-confident';
  if (t.includes('Chuyên nghiệp')) return 'tone-pro';
  return 'tone-concise';
}

/** Cyclic tone assignment for N complete answers. */
export function assignTones(count) {
  const TONES = ['Tự tin & Năng động', 'Chuyên nghiệp & Điềm tĩnh', 'Ngắn gọn & Trọng tâm'];
  const n = Math.max(0, Number(count) || 0);
  return Array.from({ length: n }, (_, i) => TONES[i % TONES.length]);
}
