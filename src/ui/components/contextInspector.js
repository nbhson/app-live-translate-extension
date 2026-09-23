/**
 * Context Inspector — pure helper to compute what AI actually sees.
 * Used by both sidepanel.js and src/main.js (ESM). No DOM, no chrome.
 * @module ui/components/contextInspector
 */
import { CONFIG } from '../../config.js';
import { isQuestion } from '../../utils/isQuestion.js';

function truncateForInspect(arr, maxChars) {
  const j = arr.join(' | ');
  return j.length > maxChars ? j.slice(-maxChars) : j;
}

/**
 * Compute snapshot for UI inspector.
 * @param {object} s - store state snapshot (finalizedEnPhrases, compressedSummary, etc.)
 * @returns {object} { mode, liveCtx, compressedPreview, pendingSegment, stats }
 */
export function getContextSnapshot(s) {
  const en = Array.isArray(s.finalizedEnPhrases) ? s.finalizedEnPhrases : [];
  const comp = String(s.compressedSummary || '');
  const enabled = !!s.compressEnabled;
  const lastIdx = Number(s.lastCompressedIdx) || 0;
  const pending = en.slice(lastIdx);
  const pendingStr = pending.join('\n');
  // all questions ever detected — pending tab should show all, not just pending segment
  const allQuestions = en
    .map((text, idx) => ({ text, idx }))
    .filter(({ text }) => isQuestion(text))
    .map(({ text, idx }) => ({ text, idx }));
  const stats = {
    total: en.length,
    compressedChars: comp.length,
    lastCompressedIdx: lastIdx,
    pendingCount: pending.length,
    pendingChars: pendingStr.length,
    allQuestionsCount: allQuestions.length,
    mode: enabled && comp ? 'compressed' : 'live',
  };
  let liveCtx, liveCount;
  if (enabled && comp) {
    const recent = en.slice(-CONFIG.COMPRESS_RECENT_KEEP);
    liveCount = recent.length;
    const recentCtx = truncateForInspect(recent, 1500);
    const compPreview = comp.length > CONFIG.COMPRESS_MAX_CHARS ? comp.slice(-CONFIG.COMPRESS_MAX_CHARS) : comp;
    liveCtx = `Compressed history (${compPreview.length} chars, ${compPreview.split('\n').filter(Boolean).length} bullets):\n${compPreview}\n\nRecent ${liveCount} utterances (1500 chars):\n${recentCtx}`;
  } else {
    const recent = en;
    liveCount = recent.length;
    const ctx = truncateForInspect(recent, 6000);
    liveCtx = `Conversation history (all ${liveCount} utterances, budget 6000 chars):\n${ctx || '(empty — speak to fill context)'}`;
  }
  return {
    stats,
    liveCtx,
    compressedPreview: comp || '(no compressed history yet)',
    pendingSegment: pendingStr || '(nothing pending)',
    pendingList: pending,
    allQuestions,
    recentForPrompt: enabled && comp ? en.slice(-CONFIG.COMPRESS_RECENT_KEEP) : en,
    truncatedRecent: enabled && comp ? truncateForInspect(en.slice(-CONFIG.COMPRESS_RECENT_KEEP), 1500) : truncateForInspect(en, 6000),
  };
}

export function formatInspectorMeta(snap) {
  const { stats } = snap;
  const q = stats.allQuestionsCount ?? 0;
  if (stats.mode === 'compressed') {
    return `🗜️ ${stats.compressedChars} chars history • ${stats.pendingCount} pending • ${q} questions • live ${snap.recentForPrompt.length} ctx`;
  }
  return `📝 ${stats.total} utterances • ${q} questions • live ${snap.recentForPrompt.length} ctx`;
}
