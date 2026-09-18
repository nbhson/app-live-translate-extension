/**
 * Pure: compute spectral centroid
 * @param {Uint8Array|number[]} freqData
 * @param {number} sampleRate
 * @returns {number}
 */
export function computeSpectralCentroid(freqData, sampleRate) {
  if (!freqData || !freqData.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  const nyquist = sampleRate / 2;
  const binHz = nyquist / freqData.length;
  let sumAmp = 0;
  let sumWeighted = 0;
  for (let i = 0; i < freqData.length; i++) {
    const amp = freqData[i] / 255;
    if (amp < 0.02) continue;
    sumAmp += amp;
    sumWeighted += amp * (i * binHz);
  }
  return sumAmp > 0 ? sumWeighted / sumAmp : 0;
}
