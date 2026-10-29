import { describe, it, expect } from 'vitest';
import { normalizeSitePattern, isSiteDisabled } from '../src/utils/siteMatch.js';

describe('per-site pattern matching', () => {
  it('normalizeSitePattern strips scheme/www/trailing slash, rejects invalid', () => {
    expect(normalizeSitePattern('https://Example.com/')).toBe('example.com');
    expect(normalizeSitePattern('*.Example.com/meetings/')).toBe('example.com/meetings');
    expect(normalizeSitePattern('http://user:pass@docs.example.com:8080/x')).toBe('docs.example.com/x');
    expect(normalizeSitePattern('')).toBeNull();
    expect(normalizeSitePattern('no-dot')).toBeNull();
    expect(normalizeSitePattern('has space.com')).toBeNull();
  });

  it('isSiteDisabled matches host + subdomains, exact host only', () => {
    expect(isSiteDisabled('https://meet.example.com/x', ['example.com'])).toBe(true);
    expect(isSiteDisabled('https://example.com/', ['example.com'])).toBe(true);
    expect(isSiteDisabled('https://notexample.com/', ['example.com'])).toBe(false);
    expect(isSiteDisabled('https://evil.example.com.evil.net/', ['example.com'])).toBe(false);
  });

  it('isSiteDisabled honors path prefixes and segment boundaries', () => {
    expect(isSiteDisabled('https://docs.example.com/meetings/room', ['docs.example.com/meetings'])).toBe(true);
    expect(isSiteDisabled('https://docs.example.com/meetings-extra', ['docs.example.com/meetings'])).toBe(false);
    expect(isSiteDisabled('https://docs.example.com/other', ['docs.example.com/meetings'])).toBe(false);
  });

  it('patterns with query strings still match by path (query stripped)', () => {
    expect(normalizeSitePattern('example.com/meet?id=1')).toBe('example.com/meet');
    expect(isSiteDisabled('https://example.com/meet?id=99', ['example.com/meet?id=1'])).toBe(true);
    expect(isSiteDisabled('https://example.com/meeting', ['example.com/meet?id=1'])).toBe(false);
  });

  it('isSiteDisabled is safe on garbage input', () => {
    expect(isSiteDisabled('not a url', ['example.com'])).toBe(false);
    expect(isSiteDisabled('https://a.com', [null, '', 'bad pattern'])).toBe(false);
    expect(isSiteDisabled('https://a.com', [])).toBe(false);
  });
});
