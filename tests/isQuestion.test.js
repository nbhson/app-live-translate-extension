import { describe, it, expect, vi } from 'vitest';
import { isQuestion } from '../src/utils/isQuestion.js';

describe('isQuestion', () => {
  it('fast path: contains ?', () => {
    expect(isQuestion('Are you ok?')).toBe(true);
    expect(isQuestion('What is this ? with space')).toBe(true);
    expect(isQuestion('You know where is the station?')).toBe(true);
  });

  it('returns false for empty/short', () => {
    expect(isQuestion('')).toBe(false);
    expect(isQuestion('   ')).toBe(false);
    expect(isQuestion('Hi')).toBe(false);
    expect(isQuestion('a')).toBe(false);
    expect(isQuestion(null)).toBe(false);
    expect(isQuestion(undefined)).toBe(false);
  });

  it('WH-starter', () => {
    expect(isQuestion('What is your name')).toBe(true);
    expect(isQuestion('how are you doing today')).toBe(true);
    expect(isQuestion('Where are you from')).toBe(true);
    expect(isQuestion('who are you')).toBe(true);
    expect(isQuestion('why is this happening')).toBe(true);
    expect(isQuestion('which one do you prefer')).toBe(true);
    // 2-word WH still true
    expect(isQuestion('What time')).toBe(true);
    // exclamation exclusion
    expect(isQuestion('What a beautiful day!')).toBe(false);
    expect(isQuestion('How wonderful!')).toBe(false);
    expect(isQuestion('How terrible!')).toBe(false);
  });

  it('Aux inversion starter', () => {
    expect(isQuestion('Are you coming to the meeting')).toBe(true);
    expect(isQuestion('Is there anyone here')).toBe(true);
    expect(isQuestion('Do you know where the office is')).toBe(true);
    expect(isQuestion('Can you help me')).toBe(true);
    expect(isQuestion("Isn't it a lovely day?")).toBe(true); // also fast path
    expect(isQuestion("Don't you think we should go")).toBe(true);
    expect(isQuestion('Is this correct')).toBe(true);
    expect(isQuestion('This is correct')).toBe(false);
  });

  it('Tag question', () => {
    expect(isQuestion("You are right, aren't you?")).toBe(true);
    expect(isQuestion("It's a nice day, right?")).toBe(true);
    expect(isQuestion('You are coming, right')).toBe(true);
    expect(isQuestion('We should go, okay')).toBe(true);
  });

  it('Embedded inversion', () => {
    expect(isQuestion('Do you know where the office is')).toBe(true);
    expect(isQuestion('Can you please send me the report')).toBe(true);
    expect(isQuestion('Could you explain this code')).toBe(true);
    expect(isQuestion('Would you mind opening the window')).toBe(true);
    expect(isQuestion('Have you ever been to Japan')).toBe(true);
    expect(isQuestion('I think you are right')).toBe(false);
    expect(isQuestion('You are coming tomorrow')).toBe(false);
  });

  it('Indirect openers', () => {
    expect(isQuestion('Tell me about yourself')).toBe(true);
    expect(isQuestion('Any idea how to fix this')).toBe(true);
    expect(isQuestion('Anyone know where the office is')).toBe(true);
    expect(isQuestion('Anybody know the answer')).toBe(true);
  });

  it('Trailing or not', () => {
    expect(isQuestion('You are coming or not')).toBe(true);
    expect(isQuestion('Do you want tea or coffee or not')).toBe(true);
    expect(isQuestion('You are coming or something')).toBe(true);
  });

  it('Uses compromise when provided', () => {
    const fakeNlp = (text) => ({
      questions: () => ({ found: text.toLowerCase().includes('question'), length: 0 }),
    });
    expect(isQuestion('This is a question from nlp', { nlp: fakeNlp })).toBe(true);
    expect(isQuestion('This is declarative', { nlp: fakeNlp })).toBe(false);
    expect(isQuestion('What is your name', { nlp: () => ({ questions: () => ({ found: false, length: 0 }) }) })).toBe(true);
  });

  it('narrow: I think you are right should be false', () => {
    expect(isQuestion('I think you are right')).toBe(false);
  });

  it('real speech examples', () => {
    expect(isQuestion('how do you know Sam')).toBe(true);
    expect(isQuestion('what color do you like')).toBe(true);
    expect(isQuestion("how's the weather today")).toBe(true);
    expect(isQuestion('when will you be available')).toBe(true);
    expect(isQuestion('We need to discuss the budget')).toBe(false);
    expect(isQuestion("Let's start the daily meeting")).toBe(false);
  });

  it('STT noise: leading single-char prefix + fused suffix', () => {
    expect(isQuestion('s How are you')).toBe(true);
    expect(isQuestion('n How are you')).toBe(true);
    expect(isQuestion('s How are youestion')).toBe(true);
    expect(isQuestion('How are youestion')).toBe(true);
    expect(isQuestion('s What is your name')).toBe(true);
  });

  it('tag question without comma + fast-speech concat', () => {
    expect(isQuestion('You are coming right')).toBe(true);
    expect(isQuestion('You are right right')).toBe(true);
    expect(isQuestion('We should go yeah')).toBe(true);
    expect(isQuestion('How are you, Today I will go to the market')).toBe(true);
    expect(isQuestion('How are you Today I will explain')).toBe(true);
    expect(isQuestion('s How are you, Today I will go')).toBe(true);
  });

  it('comma-concat should still be question even with declarative suffix', () => {
    expect(isQuestion('What is your name, My name is John')).toBe(true);
    expect(isQuestion('Where are you from, I am from Vietnam')).toBe(true);
  });

  it('NEW: what/how about + casual wanna/gonna', () => {
    expect(isQuestion('What about tomorrow meeting')).toBe(true);
    expect(isQuestion('How about we go tomorrow')).toBe(true);
    expect(isQuestion('Wanna grab coffee')).toBe(true);
    expect(isQuestion('Lemme know your thoughts')).toBe(true);
    expect(isQuestion('Gimme a hand')).toBe(true);
    expect(isQuestion('wanna you come')).toBe(true);
    // gonna/gotta declarative should NOT be question without ?
    expect(isQuestion('Gonna go to the meeting tomorrow')).toBe(false);
    expect(isQuestion('Gotta leave now')).toBe(false);
  });

  it('NEW: wondering / polite requests', () => {
    expect(isQuestion('I was wondering if you are available tomorrow')).toBe(true);
    expect(isQuestion('Wondering if you could help me')).toBe(true);
    expect(isQuestion('I wonder if you can send the report')).toBe(true);
    expect(isQuestion('Could you maybe help me with this')).toBe(true);
    expect(isQuestion('Could you kindly explain this')).toBe(true);
    expect(isQuestion('Would you be able to join the call')).toBe(true);
    expect(isQuestion('Would you please send the file')).toBe(true);
    expect(isQuestion('Do you mind if I ask a question')).toBe(true);
    // not question if declarative wondering without if
    expect(isQuestion('I was wondering about the project')).toBe(false);
  });

  it('NEW: expanded indirect + declarative guard', () => {
    expect(isQuestion('Any chance you could help')).toBe(true);
    expect(isQuestion('Is there a chance we can meet tomorrow')).toBe(true);
    expect(isQuestion('This is correct right')).toBe(true); // tag overrides declarative false
    expect(isQuestion('This is correct')).toBe(false);
  });
});
