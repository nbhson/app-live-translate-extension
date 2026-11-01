/**
 * Transcript export — SRT / WebVTT subtitles from history entries.
 * Pure, testable, no chrome imports (same pattern as services/history).
 * Entry shape mirrors services/history: { id, ts, en, vi }.
 * Timecodes are relative to the first entry (t = 0), SRT standard
 * `00:00:00,000` / WebVTT `00:00:00.000`.
 * @module services/export-srt
 */

/** Minimum visible duration for a cue whose end would collide with the next start. */
export const MIN_CUE_MS = 1500;
/** Rough reading-speed estimate for the last cue's duration (ms per char). */
export const MS_PER_CHAR = 55;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** SRT timecode — `HH:MM:SS,mmm` (comma separator per SRT spec). */
export function formatSrtTime(ms) {
  const t = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor((t % 3600000) / 60000))}:${pad(Math.floor((t % 60000) / 1000))},${pad(t % 1000, 3)}`;
}

/** WebVTT timecode — `HH:MM:SS.mmm` (dot separator per WebVTT spec). */
export function formatVttTime(ms) {
  return formatSrtTime(ms).replace(',', '.');
}

/** Cue text: EN line + VI line (skip empty/duplicate translation). */
function cueText(entry) {
  const en = String(entry?.en || '').trim();
  const vi = String(entry?.vi || '').trim();
  const lines = [];
  if (en) lines.push(en);
  if (vi && vi !== en) lines.push(vi);
  return lines.join('\n');
}

/**
 * Build subtitle cues [{start, end, text}] with ms timecodes.
 * end = next entry's ts (never before start); last cue gets an estimated
 * duration from its text length. Never throws.
 * @param {Array<{ts:number, en?:string, vi?:string}>} entries
 * @returns {Array<{start:number, end:number, text:string}>}
 */
export function buildCues(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => cueText(e));
  const first = list[0];
  const baseline = first && Number.isFinite(first.ts) && first.ts > 0 ? first.ts : 0;
  return list.map((e, i) => {
    const ts = Number.isFinite(e.ts) && e.ts > 0 ? e.ts : baseline;
    const start = Math.max(0, ts - baseline);
    const next = list[i + 1];
    const nextTs = next && Number.isFinite(next.ts) && next.ts > 0 ? next.ts : null;
    const nextStart = nextTs != null ? Math.max(0, nextTs - baseline) : null;
    let end;
    if (i === list.length - 1) {
      end = start + Math.max(MIN_CUE_MS, cueText(e).length * MS_PER_CHAR);
    } else if (nextStart != null && nextStart > start) {
      end = nextStart;
    } else {
      end = start + MIN_CUE_MS;
    }
    return { start, end, text: cueText(e) };
  });
}

/**
 * Export history as SubRip (.srt) — standard numbered cues, blank-line separated.
 * @param {Array} entries
 * @returns {string}
 */
export function historyToSrt(entries) {
  const cues = buildCues(entries);
  if (!cues.length) return '';
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}`)
    .join('\n\n') + '\n';
}

/**
 * Export history as WebVTT (.vtt) — WEBVTT header, `.` timecode separator.
 * @param {Array} entries
 * @returns {string}
 */
export function historyToVtt(entries) {
  const cues = buildCues(entries);
  if (!cues.length) return 'WEBVTT\n';
  return 'WEBVTT\n\n' + cues
    .map((c) => `${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${c.text}`)
    .join('\n\n') + '\n';
}
