function stripCodeFence(s) {
  // remove ```json ... ``` wrappers
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function tryParseJson(s) {
  // handle trailing commas: {"a":1,} -> {"a":1}
  const cleaned = s.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

/**
 * Parse LLM JSON output for suggested answers.
 * Handles {structures, answers} object, bare array, or bullet lines.
 * @param {unknown} raw
 * @returns {{structures: string[], answers: string[]}}
 */
export function parseSuggestAnswers(raw) {
  if (!raw || typeof raw !== 'string') return { structures: [], answers: [] };
  const noFence = stripCodeFence(raw.trim());
  // try JSON object {structures, answers}
  try {
    const objMatch = noFence.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const obj = tryParseJson(objMatch[0]);
      if (obj && (obj.answers || obj.structures)) {
        const structures = Array.isArray(obj.structures)
          ? obj.structures.slice(0, 5).map((s) => String(s).trim()).filter(Boolean)
          : [];
        const answers = Array.isArray(obj.answers)
          ? obj.answers.slice(0, 5).map((s) => String(s).trim()).filter(Boolean)
          : [];
        if (answers.length || structures.length) return { structures, answers };
      }
      if (Array.isArray(obj)) return { structures: [], answers: obj.slice(0, 5).map((s) => String(s).trim()).filter(Boolean) };
    }
  } catch (_) {}
  try {
    const m = noFence.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = tryParseJson(m[0]);
      if (Array.isArray(arr)) return { structures: [], answers: arr.slice(0, 5).map((s) => String(s).trim()).filter(Boolean) };
    }
  } catch (_) {}
  // fallback: also support numbered "1. answer" inside object-like text
  const lines = noFence
    .split(/\n/)
    .map((s) => s.replace(/^[\s\-\*\d\.\u2022]+/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .filter(s => s.length >= 3)
    .slice(0, 5);
  return { structures: [], answers: lines };
}

/**
 * Fallback: generate short hint from answer prefix
 * @param {string[]} answers
 * @returns {string[]}
 */
export function synthesizeStructures(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.map((a) => {
    const words = String(a).split(/\s+/).slice(0, 6).join(' ');
    return words.length > 40 ? words.slice(0, 40) + '…' : words;
  });
}
