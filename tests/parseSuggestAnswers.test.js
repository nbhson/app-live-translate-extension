import { describe, it, expect } from 'vitest';
import { parseSuggestAnswers, synthesizeStructures } from '../src/utils/parseSuggestAnswers.js';

describe('parseSuggestAnswers', () => {
  it('parses {structures, answers} object', () => {
    const raw = '{"structures":["Hint 1","Hint 2"],"answers":["Ans 1","Ans 2"]}';
    const { structures, answers } = parseSuggestAnswers(raw);
    expect(structures).toEqual(['Hint 1', 'Hint 2']);
    expect(answers).toEqual(['Ans 1', 'Ans 2']);
  });

  it('parses with markdown code block wrapper', () => {
    const raw = '```json\n{"structures":["H1"],"answers":["A1","A2"]}\n```';
    const { answers } = parseSuggestAnswers(raw);
    expect(answers).toEqual(['A1', 'A2']);
  });

  it('parses bare array', () => {
    const raw = '["Answer one","Answer two"]';
    const { answers } = parseSuggestAnswers(raw);
    expect(answers).toEqual(['Answer one', 'Answer two']);
  });

  it('fallback to bullet lines', () => {
    const raw = '- First answer\n* Second answer\n1. Third';
    const { answers } = parseSuggestAnswers(raw);
    expect(answers).toEqual(['First answer', 'Second answer', 'Third']);
  });

  it('limits to 5', () => {
    const raw = JSON.stringify({ answers: ['1','2','3','4','5','6','7'] });
    const { answers } = parseSuggestAnswers(raw);
    expect(answers.length).toBe(5);
  });

  it('empty/invalid returns empty', () => {
    expect(parseSuggestAnswers('')).toEqual({ structures: [], answers: [] });
    expect(parseSuggestAnswers(null)).toEqual({ structures: [], answers: [] });
    expect(parseSuggestAnswers('no json here')).toEqual({ structures: [], answers: ['no json here'] });
  });

  it('trims and filters empty', () => {
    const raw = '{"answers":["  a  ", " ", "b"] }';
    const { answers } = parseSuggestAnswers(raw);
    expect(answers).toEqual(['a', 'b']);
  });
});

describe('synthesizeStructures', () => {
  it('takes first 6 words', () => {
    expect(synthesizeStructures(['This is a very long answer that should be truncated correctly'])).toEqual([
      'This is a very long answer',
    ]);
  });
  it('truncates when >40 chars', () => {
    const res = synthesizeStructures(['Supercalifragilisticexpialidocious pneumonoultramicroscopicsilicovolcanoconiosis extraordinary phenomenon example test case'])[0];
    expect(res.endsWith('…')).toBe(true);
    expect(res.length).toBe(41);
  });

  it('short answers unchanged', () => {
    expect(synthesizeStructures(['Short answer'])).toEqual(['Short answer']);
  });

  it('handles non-array', () => {
    expect(synthesizeStructures(null)).toEqual([]);
    expect(synthesizeStructures(undefined)).toEqual([]);
  });
});
