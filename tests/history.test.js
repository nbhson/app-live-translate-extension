import { describe, it, expect } from 'vitest';
import {
  createHistoryEntry,
  appendHistoryEntries,
  searchHistory,
  historyToText,
  historyToJson,
  parseHistory,
  HISTORY_MAX_ENTRIES,
} from '../src/services/history.js';

describe('history service', () => {
  it('createHistoryEntry validates and trims; empty -> null', () => {
    expect(createHistoryEntry('', '  ')).toBeNull();
    const e = createHistoryEntry(' Hello ', 'Xin chào ', 1700000000000);
    expect(e.en).toBe('Hello');
    expect(e.vi).toBe('Xin chào');
    expect(e.ts).toBe(1700000000000);
    expect(e.id).toMatch(/^h/);
  });

  it('appendHistoryEntries prepends + caps', () => {
    let list = [];
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 10; i++) {
      list = appendHistoryEntries(list, createHistoryEntry(`e${i}`, `v${i}`, i), HISTORY_MAX_ENTRIES);
    }
    expect(list).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(list[0].en).toBe(`e${HISTORY_MAX_ENTRIES + 9}`);
  });

  it('searchHistory matches EN + VI case-insensitively', () => {
    const list = [
      createHistoryEntry('How are you today', 'Hôm nay bạn thế nào', 1),
      createHistoryEntry('The budget is approved', 'Ngân sách đã được duyệt', 2),
    ];
    expect(searchHistory(list, 'budget')).toHaveLength(1);
    expect(searchHistory(list, 'DUYỆT')).toHaveLength(1);
    expect(searchHistory(list, '')).toHaveLength(2);
    expect(searchHistory(list, 'zzz')).toHaveLength(0);
    expect(searchHistory(null, 'x')).toEqual([]);
  });

  it('historyToText/historyToJson stable export shapes', () => {
    const list = [createHistoryEntry('a', 'b', 1700000000000)];
    const txt = historyToText(list);
    expect(txt).toContain('[1 •');
    expect(txt).toContain('a\nb');
    const json = JSON.parse(historyToJson(list));
    expect(json.format).toBe('live-translate-history');
    expect(json.count).toBe(1);
    expect(json.entries[0].en).toBe('a');
  });

  it('parseHistory validates + caps, never throws', () => {
    expect(parseHistory(null)).toEqual([]);
    expect(parseHistory('nope')).toEqual([]);
    expect(parseHistory({ entries: [{ en: 'x', vi: 'y', ts: 5 }] })[0]).toMatchObject({ ts: 5, en: 'x', vi: 'y' });
    const big = Array.from({ length: 700 }, (_, i) => ({ en: `e${i}`, vi: '', ts: i }));
    expect(parseHistory(big)).toHaveLength(HISTORY_MAX_ENTRIES);
  });
});
