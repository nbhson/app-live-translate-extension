/** Summary language map — VI/EN + JA/ZH ported from React AISummaryView.
 * Mirror of LANG_NAME in sidepanel.js buildSummaryPromptSide/Merge.
 * @param {string} lang
 * @returns {string}
 */
export function summaryLangName(lang) {
  const map = { vi: 'Vietnamese', en: 'English', ja: 'Japanese', zh: 'Simplified Chinese' };
  return map[String(lang || '').toLowerCase()] || 'Vietnamese';
}
