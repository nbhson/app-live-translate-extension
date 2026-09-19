function stripCodeFence(s) {
  // robust: extract content inside ```json ... ``` if present, else strip stray fences
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return s.replace(/```/g, '').trim();
}

function tryParseJson(s) {
  // handle trailing commas: {"a":1,} -> {"a":1}
  const cleaned = s.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(cleaned);
}

function extractLenientArrays(s) {
  // last resort when JSON is broken (e.g. literal newlines inside strings): extract "structures"/"answers" via bracket scan
  function extractArray(key) {
    const idx = s.search(new RegExp(`"${key}"\\s*:`, 'i'));
    if (idx === -1) return [];
    const bracketStart = s.indexOf('[', idx);
    if (bracketStart === -1) return [];
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    let end = -1;
    for (let i = bracketStart; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') { if (depth === 0) start = i; depth++; }
      else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (start === -1 || end === -1) return [];
    const content = s.slice(start, end + 1);
    const re = /"((?:\\.|[^"\\])*)"/g;
    let m;
    const arr = [];
    while ((m = re.exec(content)) !== null) {
      let v = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
      if (v) arr.push(v);
      if (arr.length >= 5) break;
    }
    return arr;
  }
  return { structures: extractArray('structures'), answers: extractArray('answers') };
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
        let structures = Array.isArray(obj.structures)
          ? obj.structures.slice(0, 5).map((s) => String(s).trim()).filter(Boolean)
          : [];
        let answers = Array.isArray(obj.answers)
          ? obj.answers.slice(0, 5).map((s) => String(s).trim()).filter(Boolean)
          : [];
        // filter answers that are actually structures (contain " + " and short)
        const isStructureLike = (s) => s.includes(' + ') && s.split(/\s+/).length < 12;
        answers = answers.filter((a) => !isStructureLike(a));
        structures = structures.filter((s) => s.length >= 3);
        // if answers were filtered out but structures remain, don't copy structures to answers
        if (answers.length || structures.length) return { structures, answers };
      }
      if (Array.isArray(obj)) {
        let arr = obj.slice(0, 5).map((s) => String(s).trim()).filter(Boolean);
        arr = arr.filter((a) => !(a.includes(' + ') && a.split(/\s+/).length < 12));
        return { structures: [], answers: arr };
      }
    }
  } catch (_) {
    // lenient fallback for broken JSON (unescaped newlines etc.)
    try {
      const { structures: ls, answers: la } = extractLenientArrays(noFence);
      const isStructureLike = (s) => s.includes(' + ') && s.split(/\s+/).length < 12;
      let answers = la.filter((a) => !isStructureLike(a)).filter(Boolean).slice(0, 5);
      let structures = ls.filter((s) => s.length >= 3).slice(0, 5);
      if (answers.length || structures.length) return { structures, answers };
    } catch {}
  }
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
  // guard: never return raw JSON as an answer — treat as parse failure
  if (lines.length === 1 && /^\{[\s\S]*\}$/.test(lines[0]) && /"structures"|"answers"/.test(lines[0])) {
    return { structures: [], answers: [] };
  }
  if (lines.length > 0 && lines.every(l => /^\{|\["/.test(l) && /"structures"|"answers"/.test(l))) {
    return { structures: [], answers: [] };
  }
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
