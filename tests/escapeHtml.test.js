import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../src/utils/escapeHtml.js';

describe('escapeHtml', () => {
  it('empty', () => {
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(0)).toBe('');
  });

  it('escapes & < > " \' `', () => {
    expect(escapeHtml('&<>"\'`')).toBe('&amp;&lt;&gt;&quot;&#39;&#96;');
  });

  it('leaves safe text', () => {
    expect(escapeHtml('Hello world 123')).toBe('Hello world 123');
  });

  it('escapes XSS', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('handles numbers', () => {
    expect(escapeHtml(123)).toBe('123');
  });
});
