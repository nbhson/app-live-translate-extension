import { describe, it, expect, vi, afterEach } from 'vitest';
import { translateBatchConcurrent } from '../src/services/translate/batch.js';

function makeResp(body) {
  return { ok: true, status: 200, json: async () => body, headers: { get: () => null }, text: async () => '' };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('translateBatchConcurrent', () => {
  it('translates all tasks and writes results + finalizedViPhrases', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeResp([[['one']]]))
      .mockResolvedValueOnce(makeResp([[['two']]]))
      .mockResolvedValueOnce(makeResp([[['three']]])));
    const finalizedViPhrases = [];
    const setViText = vi.fn();
    const cache = { has: () => false, set: () => {}, get: () => undefined };
    const results = await translateBatchConcurrent(
      [
        { idx: 0, text: 'one', cache: { viText: {} } },
        { idx: 1, text: 'two', cache: { viText: {} } },
        { idx: 2, text: 'three', cache: { viText: {} } },
      ],
      { concurrency: 2, cache, finalizedViPhrases, setViText }
    );
    expect([...results]).toEqual(['one', 'two', 'three']);
    expect(results.failed).toBe(0);
    expect([...finalizedViPhrases]).toEqual(['one', 'two', 'three']);
    expect(setViText.mock.calls.length).toBe(3);
  });

  it('respects concurrency limit', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return makeResp([[['x']]]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const tasks = Array.from({ length: 6 }, (_, i) => ({ idx: i, text: 'w' + i, cache: { viText: {} } }));
    const cache = { has: () => false, set: () => {}, get: () => undefined };
    const results = await translateBatchConcurrent(tasks, { concurrency: 3, cache, finalizedViPhrases: [] });
    expect(results).toHaveLength(6);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it('skips tasks that already have a resolved translation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp([[['translated']]]));
    vi.stubGlobal('fetch', fetchMock);
    const finalizedViPhrases = ['done', '…'];
    const tasks = [
      { idx: 0, text: 'a', cache: { viText: {} } },
      { idx: 1, text: 'b', cache: { viText: {} } },
    ];
    const cache = { has: () => false, set: () => {}, get: () => undefined };
    const results = await translateBatchConcurrent(tasks, { concurrency: 2, cache, finalizedViPhrases });
    expect(results[0]).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts failures without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, headers: { get: () => null }, text: async () => '' }));
    const cache = { has: () => false, set: () => {}, get: () => undefined };
    const results = await translateBatchConcurrent(
      [{ idx: 0, text: 'a', cache: { viText: {} } }],
      { concurrency: 1, cache, finalizedViPhrases: [] }
    );
    expect(results[0]).toBe('[Translation failed]');
    expect(results.failed).toBeGreaterThanOrEqual(1);
  });

  it('aborts early when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn());
    const cache = { has: () => false, set: () => {}, get: () => undefined };
    const results = await translateBatchConcurrent(
      Array.from({ length: 4 }, (_, i) => ({ idx: i, text: 'w' + i, cache: { viText: {} } })),
      { concurrency: 2, cache, signal: ac.signal, finalizedViPhrases: [] }
    );
    expect(results).toBeDefined();
  });
});