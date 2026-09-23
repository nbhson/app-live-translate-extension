import { describe, it, expect } from 'vitest';
import { computeSpectralCentroid } from '../src/utils/computeSpectralCentroid.js';

describe('computeSpectralCentroid', () => {
  it('returns 0 for empty/invalid', () => {
    expect(computeSpectralCentroid(null, 44100)).toBe(0);
    expect(computeSpectralCentroid(new Uint8Array(0), 44100)).toBe(0);
    expect(computeSpectralCentroid(new Uint8Array([10,20]), 0)).toBe(0);
    expect(computeSpectralCentroid(new Uint8Array([10]), NaN)).toBe(0);
  });

  it('ignores low amp <0.02', () => {
    // 10/255=0.039 >0.02 included, 3/255=0.011 <0.02 ignored
    const data = new Uint8Array([3, 3, 3]);
    expect(computeSpectralCentroid(data, 44100)).toBe(0); // all ignored => sumAmp 0 =>0
  });

  it('calculates centroid correctly', () => {
    // simple: freq bins 0..3, sampleRate 8000 => nyquist 4000, binHz 1000
    // data [0, 255, 0, 0] => only bin1 amp 1 => centroid = 1*1000 =1000
    const data = new Uint8Array([0, 255, 0, 0]);
    expect(computeSpectralCentroid(data, 8000)).toBeCloseTo(1000, 0);
  });

  it('weighted average', () => {
    // bins 0..3, binHz 1000, data [255,255,0,0] => amp 1,1 => weighted (0*1 +1000*1)/2=500
    const data = new Uint8Array([255, 255, 0, 0]);
    expect(computeSpectralCentroid(data, 8000)).toBeCloseTo(500, 0);
  });

  it('handles real 1024 fft typical', () => {
    const data = new Uint8Array(512);
    data[10] = 200;
    data[100] = 100;
    const c = computeSpectralCentroid(data, 48000);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(24000);
  });
});
