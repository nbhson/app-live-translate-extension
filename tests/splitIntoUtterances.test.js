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

  it('STT noise: strips leading single-char prefix + fused suffix', () => {
    expect(splitIntoUtterances('s How are you')).toEqual(['How are you']);
    expect(splitIntoUtterances('n How are you')).toEqual(['How are you']);
    expect(splitIntoUtterances('s How are youestion')).toEqual(['How are you']);
    expect(splitIntoUtterances('How are youestion')).toEqual(['How are you']);
  });

  it('fast-speech comma-concat: splits question + declarative', () => {
    expect(splitIntoUtterances('How are you, Today I will go to the market')).toEqual([
      'How are you',
      'Today I will go to the market',
    ]);
    expect(splitIntoUtterances('s How are you, Today I will go to the market')).toEqual([
      'How are you',
      'Today I will go to the market',
    ]);
    expect(splitIntoUtterances('What is your name, My name is John')).toEqual([
      'What is your name',
      'My name is John',
    ]);
  });

  it('fast-speech no-punctuation concat: splits WH question + declarative', () => {
    expect(splitIntoUtterances('How are you Today I will go to school')).toEqual([
      'How are you',
      'Today I will go to school',
    ]);
  });

  it('tag question without comma still intact (isQuestion responsibility)', () => {
    expect(splitIntoUtterances('You are coming right')).toEqual(['You are coming right']);
  });

  it('multi Q+A concat from image: splits correctly', () => {
    expect(splitIntoUtterances("where are you from I'm from the US where were you born I was born in Chicago where ?")).toEqual([
      'where are you from',
      "I'm from the US",
      'where were you born',
      'I was born in Chicago where?',
    ]);
    expect(splitIntoUtterances("I'm doing well what's your name my name is Esther how old are you I'm 33 years old ?")).toEqual([
      "I'm doing well",
      "what's your name",
      'my name is Esther',
      'how old are you',
      "I'm 33 years old?",
    ]);
  });

  it('filters noise single-char utterances', () => {
    expect(splitIntoUtterances('S')).toEqual([]);
    expect(splitIntoUtterances('e okay here we go')).toEqual(['okay here we go']);
    expect(splitIntoUtterances('S S')).toEqual([]);
    expect(splitIntoUtterances('with one sentence')).toEqual(['with one sentence']);
  });

  it('fixes h-prefix duplication (with -> h one sentence)', () => {
    expect(splitIntoUtterances('h one sentence okay ?')).toEqual(['one sentence okay?']);
    expect(splitIntoUtterances('with one sentence okay ?')).toEqual(['with one sentence okay?']);
  });
});
