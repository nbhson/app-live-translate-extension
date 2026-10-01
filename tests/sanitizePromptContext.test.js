import { describe, it, expect } from 'vitest';
import { sanitizePromptContext, sanitizePromptSegment } from '../src/utils/sanitizePromptContext.js';

describe('sanitizePromptContext', () => {
  it('trim and slice', () => {
    expect(sanitizePromptContext('  hello  ')).toBe('hello');
    expect(sanitizePromptContext('a'.repeat(700)).length).toBe(600);
  });

  it('handles null/undefined', () => {
    expect(sanitizePromptContext(null)).toBe('');
    expect(sanitizePromptContext(undefined)).toBe('');
    expect(sanitizePromptContext(123)).toBe('123');
  });

  it('escapes triple quotes', () => {
    // should break triple quotes to prevent prompt injection
    expect(sanitizePromptContext('a """ b')).toBe('a "\'" b');
    expect(sanitizePromptContext('a """ b').includes('"""')).toBe(false);
  });
});

describe('sanitizePromptSegment', () => {
  it('keeps a full 5-minute window (~2700 chars), not just 600', () => {
    const seg = Array.from({ length: 60 }, (_, i) => `sentence ${i} about launch decisions and owners`).join(' ');
    expect(seg.length).toBeGreaterThan(2000);
    const out = sanitizePromptSegment(seg);
    expect(out.length).toBeGreaterThan(2000);
    expect(out).toContain('sentence 0');
    expect(out).toContain('sentence 59');
  });

  it('still neutralizes triple quotes and caps tail', () => {
    expect(sanitizePromptSegment('a """ b').includes('"""')).toBe(false);
    expect(sanitizePromptSegment('x'.repeat(20000), 12000).length).toBeLessThanOrEqual(12000);
  });
});
