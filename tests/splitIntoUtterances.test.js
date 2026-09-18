import { describe, it, expect } from 'vitest';
import { splitIntoUtterances } from '../src/utils/splitIntoUtterances.js';

describe('splitIntoUtterances', () => {
  it('empty / whitespace', () => {
    expect(splitIntoUtterances('')).toEqual([]);
    expect(splitIntoUtterances('   ')).toEqual([]);
    expect(splitIntoUtterances(null)).toEqual([]);
    expect(splitIntoUtterances(undefined)).toEqual([]);
  });

  it('single sentence', () => {
    expect(splitIntoUtterances('Hello world.')).toEqual(['Hello world.']);
    expect(splitIntoUtterances('How are you doing today?')).toEqual(['How are you doing today?']);
  });

  it('splits on punctuation', () => {
    expect(splitIntoUtterances('Hello. How are you? I am fine.')).toEqual([
      'Hello.',
      'How are you?',
      'I am fine.',
    ]);
  });

  it('keeps WH at start intact', () => {
    expect(splitIntoUtterances('How are you doing today?')).toEqual(['How are you doing today?']);
    expect(splitIntoUtterances('What is your name? My name is John.')).toEqual([
      'What is your name?',
      'My name is John.',
    ]);
  });

  it('splits mid-sentence strong words with enough prefix', () => {
    // prefix >=3 words => split
    expect(splitIntoUtterances("You've been busy how do you know Sam?")).toEqual([
      "You've been busy",
      'how do you know Sam?',
    ]);
    expect(splitIntoUtterances('We discussed budget what do you think about it?')).toEqual([
      'We discussed budget',
      'what do you think about it?',
    ]);
  });

  it('does not split if prefix <3 words', () => {
    // "Hi how are you" -> prefix "Hi" =1 word, should not split? Actually seg is "Hi how are you" prefixWords=1 <3 so not split
    expect(splitIntoUtterances('Hi how are you?')).toEqual(['Hi how are you?']);
  });

  it('handles multiple sentences with embedded how', () => {
    expect(splitIntoUtterances('The meeting was long. We talked about roadmap how will we deliver?')).toEqual([
      'The meeting was long.',
      'We talked about roadmap',
      'how will we deliver?',
    ]);
  });

  it('Safari fallback still works (no lookbehind)', () => {
    // Should not throw
    expect(() => splitIntoUtterances('Hello! Are you there? Yes.')).not.toThrow();
  });
});
