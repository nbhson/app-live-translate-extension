import { describe, it, expect } from 'vitest';
import {
  createSessionSnapshot,
  appendSession,
  parseSessions,
  sessionToText,
  SESSIONS_MAX,
  SESSION_PAIRS_MAX,
} from '../src/services/sessions.js';

describe('session snapshots service', () => {
  it('createSessionSnapshot zips EN/VI, drops empties, caps pairs', () => {
    expect(createSessionSnapshot({ en: [], vi: [] })).toBeNull();
    const s = createSessionSnapshot({
      en: ['Hello', '', 'How are you'],
      vi: ['Xin chào', '', 'Bạn thế nào'],
      summary: 'bullets',
      ts: 1700000000000,
    });
    expect(s.pairs).toEqual([
      { en: 'Hello', vi: 'Xin chào' },
      { en: 'How are you', vi: 'Bạn thế nào' },
    ]);
    expect(s.summary).toBe('bullets');
    expect(s.pairs).toHaveLength(2);
  });

  it('appendSession prepends + caps at SESSIONS_MAX', () => {
    let list = [];
    for (let i = 0; i < SESSIONS_MAX + 5; i++) {
      const snap = createSessionSnapshot({ en: [`e${i}`], vi: [`v${i}`], ts: i });
      list = appendSession(list, snap, SESSIONS_MAX);
    }
    expect(list).toHaveLength(SESSIONS_MAX);
    expect(list[0].pairs[0].en).toBe(`e${SESSIONS_MAX + 4}`);
  });

  it('parseSessions validates, never throws', () => {
    expect(parseSessions(null)).toEqual([]);
    expect(parseSessions([{ pairs: [] }])).toEqual([]);
    const parsed = parseSessions([{ id: 's1', ts: 42, pairs: [{ en: 'a', vi: 'b' }, null], summary: 's' }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pairs).toEqual([{ en: 'a', vi: 'b' }]);
    expect(parsed[0].ts).toBe(42);
  });

  it('sessionToText renders pairs + summary', () => {
    const s = createSessionSnapshot({ en: ['a'], vi: ['b'], summary: 'S', ts: 1700000000000 });
    const txt = sessionToText(s);
    expect(txt).toContain('a\nb');
    expect(txt).toContain('---\nS');
    expect(txt).toMatch(/^\[/);
  });
});
