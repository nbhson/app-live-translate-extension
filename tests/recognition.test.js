import { describe, it, expect } from 'vitest';
import { parseRecognitionEvent } from '../src/services/speech/recognition.js';

function mkResult(transcript, isFinal, confidence = 0.9) {
  const r = [{ transcript, confidence }];
  r.isFinal = isFinal;
  return r;
}

describe('parseRecognitionEvent', () => {
  it('guards malformed event', () => {
    expect(parseRecognitionEvent(null, { lastFinalIndex: -1, finalizedOffset: 0 })).toEqual(
      expect.objectContaining({ interimEn: '', finals: [] })
    );
    expect(parseRecognitionEvent({}, { lastFinalIndex: -1, finalizedOffset: 0 }).finals).toEqual([]);
    expect(parseRecognitionEvent({ results: [], resultIndex: 0 }, { lastFinalIndex: -1, finalizedOffset: 0 }).finals).toEqual([]);
  });

  it('extracts interim from non-final', () => {
    const event = { resultIndex: 0, results: [mkResult('hello world', false)] };
    const { interimEn, finals } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(interimEn).toBe('hello world');
    expect(finals).toEqual([]);
  });

  it('extracts final and updates nextLastFinalIndex', () => {
    const event = { resultIndex: 0, results: [mkResult('hello world', true, 0.9)] };
    const { finals, nextLastFinalIndex, nextOffset } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(finals).toEqual(['hello world']);
    expect(nextLastFinalIndex).toBe(0);
    expect(nextOffset).toBe(0);
  });

  it('ignores low confidence finals (<0.25)', () => {
    const event = { resultIndex: 0, results: [mkResult('hallucination', true, 0.1)] };
    const { finals } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(finals).toEqual([]);
  });

  it('skips punctuation-only finals', () => {
    const event = { resultIndex: 0, results: [mkResult('...', true, 0.9)] };
    const { finals } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(finals).toEqual([]);
  });

  it('deduplicates adjacent identical finals', () => {
    const event = {
      resultIndex: 0,
      results: [mkResult('hello', true, 0.9), mkResult('hello', true, 0.9)],
    };
    // First call: ctx -1, will push first 'hello', second has same text -> dedup within same event? Check: finals[finals.length-1] !== remaining
    // But second has i=1 > nextLastFinalIndex (now 0) so it would try to push again, but remaining same -> filtered
    const { finals } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(finals).toEqual(['hello']);
  });

  it('does not push same final twice across calls (using lastFinalIndex)', () => {
    const event = { resultIndex: 0, results: [mkResult('hello', true, 0.9)] };
    const r1 = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(r1.finals).toEqual(['hello']);
    const r2 = parseRecognitionEvent(event, { lastFinalIndex: r1.nextLastFinalIndex, finalizedOffset: r1.nextOffset });
    expect(r2.finals).toEqual([]);
  });

  it('caps interim at 200 chars', () => {
    const long = 'a'.repeat(300);
    const event = { resultIndex: 0, results: [mkResult(long, false)] };
    const { interimEn } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 0 });
    expect(interimEn.length).toBe(200);
  });

  it('handles finalizedOffset slicing', () => {
    const event = { resultIndex: 0, results: [mkResult('hello world', false)] };
    const { interimEn } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 6 });
    expect(interimEn).toBe('world');
  });

  it('clamps finalizedOffset when larger than raw length', () => {
    const event = { resultIndex: 0, results: [mkResult('hi', false)] };
    const { interimEn, nextOffset } = parseRecognitionEvent(event, { lastFinalIndex: -1, finalizedOffset: 100 });
    expect(interimEn).toBe('');
    expect(nextOffset).toBe(2);
  });
});
