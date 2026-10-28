import { describe, it, expect } from 'vitest';
import { toneClass, assignTones } from '../src/utils/toneBadge.js';
import { computeMemoryMeta } from '../src/utils/memoryMeter.js';
import { summaryLangName } from '../src/utils/summaryLang.js';
import { firstSentenceDirect, makeQuickReplies } from '../src/utils/quickReplies.js';

describe('ported React features (mirror of sidepanel.js)', () => {
  it('toneClass maps 3 tones', () => {
    expect(toneClass('Tự tin & Năng động')).toBe('tone-confident');
    expect(toneClass('Chuyên nghiệp & Điềm tĩnh')).toBe('tone-pro');
    expect(toneClass('Ngắn gọn & Trọng tâm')).toBe('tone-concise');
    expect(toneClass('unknown')).toBe('tone-concise');
  });

  it('assignTones cycles', () => {
    expect(assignTones(0)).toEqual([]);
    expect(assignTones(4)).toEqual([
      'Tự tin & Năng động',
      'Chuyên nghiệp & Điềm tĩnh',
      'Ngắn gọn & Trọng tâm',
      'Tự tin & Năng động',
    ]);
  });

  it('computeMemoryMeta thresholds (budget 30000 — % based)', () => {
    expect(computeMemoryMeta({ used: 0 }).pct).toBe(0);
    // explicit budget 6000: 1500 = 25% ok, 3600 = 60% warn, 5400 = 90% danger
    expect(computeMemoryMeta({ used: 1500, budget: 6000 }).level).toBe('ok');
    expect(computeMemoryMeta({ used: 3600, budget: 6000 }).level).toBe('warn');
    expect(computeMemoryMeta({ used: 5400, budget: 6000 }).level).toBe('danger');
    // default budget is 30000: 3600 chars = 12% -> still ok
    expect(computeMemoryMeta({ used: 3600 }).level).toBe('ok');
    expect(computeMemoryMeta({ used: 18000 }).level).toBe('warn');
    expect(computeMemoryMeta({ used: 27000 }).level).toBe('danger');
    const m = computeMemoryMeta({ used: 7500, utterances: 10, questions: 2 });
    expect(m.pct).toBe(25);
    expect(m.meta).toContain('10 câu');
  });

  it('summaryLangName supports ja/zh + fallback', () => {
    expect(summaryLangName('vi')).toBe('Vietnamese');
    expect(summaryLangName('en')).toBe('English');
    expect(summaryLangName('ja')).toBe('Japanese');
    expect(summaryLangName('zh')).toBe('Simplified Chinese');
    expect(summaryLangName('fr')).toBe('Vietnamese');
  });

  it('quick replies are direct short answers, not keyword ideas', () => {
    const answers = [
      'I chose my current home because we simply fell in love with it the moment we saw it. It had a special feeling.',
      'We actually fell in love with the place! It was not about layout.',
    ];
    const quicks = makeQuickReplies(answers, ['fell in love with it', 'reason for choosing home']);
    expect(quicks).toHaveLength(2);
    expect(quicks[0]).toBe('I chose my current home because we simply fell in love with it the moment we saw it.');
    expect(quicks[1]).toBe('We actually fell in love with the place!');
    // fallback to structures when no answers
    expect(makeQuickReplies([], ['kw one', 'kw two'])).toEqual(['kw one', 'kw two']);
    expect(firstSentenceDirect('')).toBe('');
    expect(firstSentenceDirect('No punctuation here at all just a long statement')).toBe(
      'No punctuation here at all just a long statement'
    );
  });
});
