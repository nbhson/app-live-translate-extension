import { describe, it, expect } from 'vitest';
import { createTranslateCache } from '../src/services/translate/cache.js';

describe('createTranslateCache', () => {
  it('evicts oldest beyond limit (LRU)', () => {
    const c = createTranslateCache(2);
    c.set('a', '1');
    c.set('b', '2');
    c.set('c', '3');
    expect(c.size()).toBe(2);
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
  });

  it('re-inserting bumps recency', () => {
    const c = createTranslateCache(2);
    c.set('a', '1');
    c.set('b', '2');
    c.get('a'); // touch a
    c.set('c', '3'); // should evict b, not a
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
  });

  it('get returns undefined for missing / non-string', () => {
    const c = createTranslateCache();
    expect(c.get('nope')).toBeUndefined();
    expect(c.get(42)).toBeUndefined();
  });

  it('set coerces non-string values and ignores empty keys', () => {
    const c = createTranslateCache();
    c.set('n', 5);
    expect(c.get('n')).toBe('5');
    c.set('', 'x');
    expect(c.has('')).toBe(false);
  });

  it('delete / clear / keys / size', () => {
    const c = createTranslateCache(10);
    c.set('a', '1');
    c.set('b', '2');
    expect(c.keys().sort()).toEqual(['a', 'b']);
    expect(c.delete('a')).toBe(true);
    expect(c.has('a')).toBe(false);
    expect(c.size()).toBe(1);
    c.clear();
    expect(c.size()).toBe(0);
  });

  it('clamps unsafe limits', () => {
    expect(createTranslateCache(0).size()).toBe(0);
    expect(createTranslateCache(-5).size()).toBe(0);
    const big = createTranslateCache(99999);
    for (let i = 0; i < 2100; i++) big.set('k' + i, String(i));
    expect(big.size()).toBeLessThanOrEqual(2000);
  });
});