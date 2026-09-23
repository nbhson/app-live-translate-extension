import { describe, it, expect } from 'vitest';
import { buildSuggestPrompt } from '../src/utils/buildSuggestPrompt.js';

describe('buildSuggestPrompt', () => {
  const question = 'What did you do yesterday?';
  const ctx4 = ['Hello', 'We had daily meeting', 'John reported API done', 'Any blockers?'];

  it('default mode uses ALL history (compress OFF, 6000c)', () => {
    const p = buildSuggestPrompt(question, ctx4);
    expect(p).toContain('Conversation history (all utterances');
    expect(p).toContain('Question: """What did you do yesterday?"""');
    expect(p).toContain('Hello | We had daily meeting');
    expect(p).not.toContain('Compressed history');
  });

  it('default mode sends ALL when history long (truncates 6000c)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `utterance ${i} with some text to fill`);
    const p = buildSuggestPrompt(question, many);
    expect(p).toContain('Conversation history (all utterances');
    expect(p).toContain('utterance 19');
    expect(p).toContain('utterance 0'); // all retained unless >6000c
  });

  it('injects user context when provided', () => {
    const p = buildSuggestPrompt(question, ctx4, { suggestContextPrompt: 'daily meeting với team dev' });
    expect(p).toContain('User-provided context');
    expect(p).toContain('daily meeting với team dev');
    expect(p).toContain('Tailor answers to the user-provided context');
  });

  it('does not inject when empty', () => {
    const p = buildSuggestPrompt(question, ctx4, { suggestContextPrompt: '   ' });
    expect(p).not.toContain('User-provided context');
  });

  it('sanitizes triple quotes', () => {
    const p = buildSuggestPrompt(question, ctx4, { suggestContextPrompt: 'a """ b' });
    // should escape to \"\"\" not break prompt
    expect(p).toContain('"""');
    // count triple quotes - should not have unescaped break
    expect(p.split('"""').length).toBeGreaterThan(2);
  });

  it('compress mode uses recent 10 + compressed', () => {
    const longHistory = 'Summary bullet 1\nBullet 2';
    const manyCtx = Array.from({ length: 20 }, (_, i) => `utterance ${i}`);
    const p = buildSuggestPrompt(question, manyCtx, { compressEnabled: true, compressedSummary: longHistory });
    expect(p).toContain('Compressed history');
    expect(p).toContain('Recent conversation (latest 10 utterances)');
    expect(p).toContain('utterance 19');
    expect(p).toContain(longHistory);
  });

  it('compress mode truncates to 3000 chars', () => {
    const huge = 'a'.repeat(5000);
    const p = buildSuggestPrompt(question, ['hi'], { compressEnabled: true, compressedSummary: huge });
    // compressed part should be last 3000
    const after = p.split('Compressed history')[1];
    expect(after.length).toBeLessThan(4000); // not full 5000
  });

  it('handles null/undefined inputs', () => {
    expect(() => buildSuggestPrompt(null, null)).not.toThrow();
    expect(() => buildSuggestPrompt('', [])).not.toThrow();
  });

  it('output format hint', () => {
    const p = buildSuggestPrompt(question, ctx4);
    expect(p).toContain('{"structures":["Hint 1","Hint 2","Hint 3"],"answers":["Answer 1 paragraph');
    expect(p).toContain('Output ONLY JSON');
    expect(p).toContain('3-5 sentences');
  });
});
