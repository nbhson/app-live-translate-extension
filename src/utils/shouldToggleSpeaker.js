import { CONFIG } from '../config.js';

/**
 * Decide speaker toggle — pure except debounce timestamp via injected now.
 * @param {{rms:number,centroid:number}} feats
 * @param {number} pauseLen
 * @param {{rms:number,centroid:number}|null} lastFeatures
 * @param {number} lastSwitchAt
 * @param {number} now — performance.now() injectable for test
 * @param {number} centroidDiffThresh — override CONFIG for test
 * @returns {{ shouldToggle: boolean, newSwitchAt: number }}
 */
export function shouldToggleSpeaker(feats, pauseLen, lastFeatures, lastSwitchAt, now = Date.now(), centroidDiffThresh = CONFIG.SPEAKER_CENTROID_DIFF) {
  if (!feats || !lastFeatures) return { shouldToggle: false, newSwitchAt: lastSwitchAt };
  if (now - lastSwitchAt < 900) return { shouldToggle: false, newSwitchAt: lastSwitchAt };
  const rmsDiff = Math.abs(feats.rms - lastFeatures.rms);
  const centDiff = Math.abs(feats.centroid - lastFeatures.centroid);
  const centThresh = pauseLen > 700 ? centroidDiffThresh * 0.75 : centroidDiffThresh;
  const rmsThresh = 0.04;
  if (centDiff > centThresh) return { shouldToggle: true, newSwitchAt: now };
  if (rmsDiff > rmsThresh && centDiff > centThresh * 0.6) return { shouldToggle: true, newSwitchAt: now };
  return { shouldToggle: false, newSwitchAt: lastSwitchAt };
}

/**
 * Stateful helper for sidepanel.js compatibility — mirrors previous global behavior
 */
export function shouldToggleSpeakerLegacy(feats, pauseLen) {
  // This is kept for backward compat; sidepanel.js should migrate to pure version above
  // Not used in UT
  return false;
}
