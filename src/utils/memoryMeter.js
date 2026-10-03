/** Memory-meter math ported from React ContextManagerView.
 * Mirror of sidepanel.js updateMemoryMeter (pure part).
 * @param {{used:number,budget?:number,utterances?:number,questions?:number}} args
 */
export function computeMemoryMeta({ used = 0, budget = 6000, utterances = 0, questions = 0 } = {}) {
  const b = Math.max(1, Number(budget) || 6000);
  const u = Math.max(0, Number(used) || 0);
  const pct = Math.min(100, Math.round((u / b) * 100));
  const level = pct > 80 ? 'danger' : pct > 50 ? 'warn' : 'ok';
  const meta = `${u.toLocaleString('en-US')} / ${b.toLocaleString('en-US')} ký tự • ${utterances} câu • ${questions} câu hỏi`;
  return { pct, level, meta };
}
