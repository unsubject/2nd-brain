import { describe, it, expect } from 'vitest';
import { parseCapturedAt, parseUtcOffset, splitDatedNotes } from '../src/ideas/parse';
import { escapeLike, normalizeTags, normalizeTitle, searchTerms, snippet, titlesLikelySame } from '../src/ideas/text';
import { canonicalPair, endpointError, isSymmetric, LINK_TYPES, LINK_TYPE_INFO } from '../src/ideas/linkTypes';

describe('parse: captured_at', () => {
  it('parses Notion export dates at a UTC offset', () => {
    expect(parseCapturedAt('March 8, 2026 12:26 PM', '+08:00')).toBe('2026-03-08T04:26:00.000Z');
    expect(parseCapturedAt('March 16, 2026 12:03 AM', '+00:00')).toBe('2026-03-16T00:03:00.000Z');
    expect(parseCapturedAt('March 31, 2026 10:19 PM', '-05:00')).toBe('2026-04-01T03:19:00.000Z');
    expect(parseCapturedAt('December 1, 2025', '+01:00')).toBe('2025-11-30T23:00:00.000Z');
  });

  it('handles 12 AM / 12 PM edges', () => {
    expect(parseCapturedAt('January 2, 2026 12:00 AM', 'Z')).toBe('2026-01-02T00:00:00.000Z');
    expect(parseCapturedAt('January 2, 2026 12:00 PM', 'Z')).toBe('2026-01-02T12:00:00.000Z');
  });

  it('passes ISO timestamps through and rejects garbage', () => {
    expect(parseCapturedAt('2026-03-08T12:26:00+08:00')).toBe('2026-03-08T04:26:00.000Z');
    expect(parseCapturedAt('2026-03-08T04:26:00Z')).toBe('2026-03-08T04:26:00.000Z');
    expect(parseCapturedAt('yesterday')).toBeNull();
    expect(parseCapturedAt('February 30, 2026')).toBeNull();
    expect(parseCapturedAt('March 8, 2026 13:00 PM')).toBeNull();
    expect(parseCapturedAt('March 8, 2026', 'bogus')).toBeNull();
  });

  it('parses offsets', () => {
    expect(parseUtcOffset('+08:00')).toBe(480);
    expect(parseUtcOffset('-0530')).toBe(-330);
    expect(parseUtcOffset('Z')).toBe(0);
    expect(parseUtcOffset('8')).toBeNull();
  });
});

describe('parse: dated notes', () => {
  const fallback = '2026-03-08T04:26:00.000Z';

  it('splits on [YYYY-MM-DD] markers, keeping an undated preamble', () => {
    const raw = 'Related Project: A series\n\n[2026-03-10] First step.\n[2026-03-11] CLUSTER NOTE: kept verbatim — 中文 too.';
    expect(splitDatedNotes(raw, fallback)).toEqual([
      { at: fallback, text: 'Related Project: A series' },
      { at: '2026-03-10T00:00:00.000Z', text: 'First step.' },
      { at: '2026-03-11T00:00:00.000Z', text: 'CLUSTER NOTE: kept verbatim — 中文 too.' },
    ]);
  });

  it('returns a single undated note when there are no markers', () => {
    expect(splitDatedNotes('just text', fallback)).toEqual([{ at: fallback, text: 'just text' }]);
    expect(splitDatedNotes('   ', fallback)).toEqual([]);
  });
});

describe('text helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('normalizes tags (trim, dedupe case-insensitively)', () => {
    expect(normalizeTags([' a ', 'A', 'b  c', '', '中文'])).toEqual(['a', 'b c', '中文']);
  });

  it('detects likely-duplicate titles across punctuation, width and case', () => {
    expect(normalizeTitle('Why Tides  Turn?')).toBe('whytidesturn');
    expect(titlesLikelySame('Why tides turn', 'why TIDES turn!')).toBe(true);
    expect(titlesLikelySame('潮汐點樣形成', '潮汐點樣形成：筆記')).toBe(true);
    expect(titlesLikelySame('ＡＢＣ', 'abc')).toBe(true);
    expect(titlesLikelySame('AI', 'Why AI writes poems')).toBe(false);
    expect(titlesLikelySame('Tidal locking', 'Locking mechanisms')).toBe(false);
  });

  it('snippets and search terms', () => {
    expect(snippet('a\n\nb', 10)).toBe('a b');
    expect(snippet('abcdefghijkl', 5)).toBe('abcd…');
    expect(snippet(null, 5)).toBeNull();
    expect(searchTerms('  one two  三四 ')).toEqual(['one', 'two', '三四']);
    expect(searchTerms('a b c d e f g')).toHaveLength(5);
  });
});

describe('link types', () => {
  it('covers the vocabulary with consistent info', () => {
    expect(LINK_TYPES).toHaveLength(9);
    for (const t of LINK_TYPES) expect(LINK_TYPE_INFO[t]).toBeDefined();
    expect(isSymmetric('tension_with')).toBe(true);
    expect(isSymmetric('builds_on')).toBe(false);
  });

  it('canonicalizes only symmetric pairs (smaller uuid first)', () => {
    const lo = '00000000-0000-0000-0000-00000000000a';
    const hi = 'f0000000-0000-0000-0000-000000000000';
    expect(canonicalPair('same_mechanism', hi, lo)).toEqual({ source: lo, target: hi, swapped: true });
    expect(canonicalPair('builds_on', hi, lo)).toEqual({ source: hi, target: lo, swapped: false });
    expect(canonicalPair('related', lo.toUpperCase(), hi).source).toBe(lo);
  });

  it('enforces endpoint shapes', () => {
    expect(endpointError('became', { target_idea_id: 'x' })).toMatch(/public_artifact/);
    expect(endpointError('builds_on', { target_artifact_id: 'x' })).toMatch(/idea/);
    expect(endpointError('builds_on', {})).toMatch(/exactly one/);
    expect(endpointError('builds_on', { target_idea_id: 'a', target_artifact_id: 'b' })).toMatch(/exactly one/);
    expect(endpointError('revisits', { target_artifact_id: 'x' })).toBeNull();
    expect(endpointError('part_of', { target_idea_id: 'x' })).toBeNull();
  });
});
