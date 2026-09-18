import { describe, it, expect } from 'vitest';
import { shouldToggleSpeaker } from '../src/utils/shouldToggleSpeaker.js';
import { CONFIG } from '../src/config.js';

describe('shouldToggleSpeaker', () => {
  it('returns false if no lastFeatures', () => {
    expect(shouldToggleSpeaker({ rms: 0.1, centroid: 1000 }, 400, null, 0, 1000).shouldToggle).toBe(false);
    expect(shouldToggleSpeaker(null, 400, { rms: 0.1, centroid: 900 }, 0, 1000).shouldToggle).toBe(false);
  });

  it('debounces within 900ms', () => {
    const last = { rms: 0.05, centroid: 800 };
    const cur = { rms: 0.1, centroid: 1500 };
    const res = shouldToggleSpeaker(cur, 500, last, 500, 1000); // now 1000 - last 500 =500 <900
    expect(res.shouldToggle).toBe(false);
    expect(res.newSwitchAt).toBe(500);
  });

  it('toggles on centroid diff > thresh', () => {
    const last = { rms: 0.05, centroid: 800 };
    const cur = { rms: 0.05, centroid: 1500 }; // diff 700 >320
    const res = shouldToggleSpeaker(cur, 400, last, 0, 1000);
    expect(res.shouldToggle).toBe(true);
    expect(res.newSwitchAt).toBe(1000);
  });

  it('long pause lowers threshold', () => {
    const last = { rms: 0.05, centroid: 800 };
    const cur = { rms: 0.05, centroid: 800 + 320 * 0.76 }; // diff ~243, thresh 240 (320*0.75)
    const resShort = shouldToggleSpeaker(cur, 400, last, 0, 1000);
    // short pause thresh 320 => 243 <320 => false
    expect(resShort.shouldToggle).toBe(false);
    const resLong = shouldToggleSpeaker(cur, 800, last, 0, 1000);
    expect(resLong.shouldToggle).toBe(true);
  });

  it('toggles on rms+centroid combined', () => {
    const last = { rms: 0.05, centroid: 800 };
    const cur = { rms: 0.1, centroid: 1000 }; // rmsDiff 0.05 >0.04, centDiff 200 > 320*0.6=192
    const res = shouldToggleSpeaker(cur, 400, last, 0, 1000);
    expect(res.shouldToggle).toBe(true);
  });

  it('no toggle if diffs too small', () => {
    const last = { rms: 0.05, centroid: 800 };
    const cur = { rms: 0.051, centroid: 810 };
    expect(shouldToggleSpeaker(cur, 400, last, 0, 1000).shouldToggle).toBe(false);
  });
});
