import { describe, it, expect } from 'vitest';
import { stripSttCarryRepeat } from '../src/utils/stripSttCarryRepeat.js';

describe('stripSttCarryRepeat (STT carry-repeat guard)', () => {
  it('strips stray char from reported cases', () => {
    expect(stripSttCarryRepeat(
      "d I haven't actually asked that question before",
      'Lucy who chose your name I think my mum did'
    )).toBe("I haven't actually asked that question before");
    expect(stripSttCarryRepeat(
      's how is your first name spelled',
      'my full name is Lucy Bella Simkins'
    )).toBe('how is your first name spelled');
    expect(stripSttCarryRepeat('d is it', 'I was born in Milton Keynes in England')).toBe('is it');
  });

  it('handles punctuation tail + case-insensitive', () => {
    expect(stripSttCarryRepeat('D Is it working', 'born in England.')).toBe('Is it working');
    expect(stripSttCarryRepeat('d', 'did')).toBe('');
  });

  it('never strips valid words or mismatches', () => {
    expect(stripSttCarryRepeat('a apple a day', 'eat an')).toBe('a apple a day');
    expect(stripSttCarryRepeat('I think so', 'they did')).toBe('I think so');
    expect(stripSttCarryRepeat('hello world', 'goodbye')).toBe('hello world');
    expect(stripSttCarryRepeat('donald duck arrived', 'he nodded')).toBe('donald duck arrived');
    expect(stripSttCarryRepeat('is it', '')).toBe('is it');
    expect(stripSttCarryRepeat('', 'did')).toBe('');
  });
});
