import { describe, it, expect } from 'vitest';
import { sanitizePromptContext } from '../src/utils/sanitizePromptContext.js';

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
