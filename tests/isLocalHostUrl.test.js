import { describe, it, expect } from 'vitest';
import { isLocalHostUrl, isGeminiHostUrl } from '../src/utils/isLocalHostUrl.js';

describe('isLocalHostUrl (hostname-exact security check)', () => {
  it('accepts loopback hosts with any port/path', () => {
    expect(isLocalHostUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalHostUrl('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLocalHostUrl('http://[::1]:11434/v1')).toBe(true);
  });

  it('rejects remote hosts even when the string contains "localhost"', () => {
    expect(isLocalHostUrl('https://evil.com/?x=localhost')).toBe(false);
    expect(isLocalHostUrl('https://localhost.evil.com')).toBe(false);
    expect(isLocalHostUrl('https://api.example.com/localhost')).toBe(false);
  });

  it('treats unparseable input as remote (strict)', () => {
    expect(isLocalHostUrl('')).toBe(false);
    expect(isLocalHostUrl('not a url')).toBe(false);
  });

  it('isGeminiHostUrl matches hostname exactly', () => {
    expect(isGeminiHostUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(true);
    expect(isGeminiHostUrl('https://generativelanguage.googleapis.com.evil.com/v1beta')).toBe(false);
    expect(isGeminiHostUrl('https://api.openai.com/v1')).toBe(false);
    expect(isGeminiHostUrl('not a url')).toBe(false);
  });
});
