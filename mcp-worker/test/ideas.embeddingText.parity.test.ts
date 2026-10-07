// The Worker's copy of the idea embedding text (park_idea's candidate
// query) must match the Node sweeper's (what idea rows are embedded with),
// or capture-time similarities drift from the stored vectors. Both
// builders run side by side on the same synthetic fixtures.

import { describe, it, expect } from 'vitest';
import * as node from '../../src/ideas/embeddingText';
import * as worker from '../src/ideas/embeddingText';

const base: worker.IdeaEmbeddingFields = {
  title: 'Title',
  framing: null,
  why_interesting: null,
  thoughts: null,
  notes: null,
  source_title: null,
  source_excerpt: null,
  tags: null,
};

const fixtures: Array<[string, worker.IdeaEmbeddingFields]> = [
  ['title only', base],
  [
    'every field, notes by simon vs agent, import and system',
    {
      title: '  Why tides have two bulges ',
      framing: 'Framing by the agent',
      why_interesting: '  Gravity gradients  ',
      thoughts: 'raw  thought,\n\nsecond paragraph 🙂  ',
      notes: [
        { by: 'agent', text: 'agent note' },
        { by: 'simon', text: 'my own note' },
        { by: 'import', text: 'imported note' },
        { by: 'system', text: 'status: parked → used' },
        { by: 'simon', text: '  second note of mine  ' },
        { by: 'simon' },
      ],
      source_title: 'An article',
      source_excerpt: 'The passage.',
      tags: ['physics', 'oceans'],
    },
  ],
  [
    'Cantonese and mixed CJK punctuation',
    {
      ...base,
      title: '潮汐點樣形成？',
      thoughts: '月球引力係關鍵，「離心力」唔係。',
      why_interesting: '全形　空格 and ｆｕｌｌ ｗｉｄｔｈ',
      tags: ['物理', '海洋'],
    },
  ],
  ['long excerpt (cut at 1,500 code points)', { ...base, source_excerpt: '🙂x'.repeat(2000) }],
  ['blank fields and empty tags are dropped', { ...base, framing: '   ', thoughts: '', tags: [] }],
  ['over the token budget (Chinese)', { ...base, thoughts: '粵'.repeat(10_000) }],
  ['over the token budget (English)', { ...base, thoughts: 'word '.repeat(10_000), tags: ['a', 'b'] }],
];

describe('idea embedding text: Worker port matches the Node sweeper', () => {
  it('uses the same token budget', () => {
    expect(worker.IDEA_EMBED_TOKEN_BUDGET).toBe(node.IDEA_EMBED_TOKEN_BUDGET);
  });

  for (const [name, f] of fixtures) {
    it(name, () => {
      const w = worker.buildIdeaEmbeddingText(f);
      expect(w).toBe(node.buildIdeaEmbeddingText(f));
      expect(worker.estimateTokens(w)).toBe(node.estimateTokens(w));
      expect(worker.estimateTokens(w)).toBeLessThanOrEqual(worker.IDEA_EMBED_TOKEN_BUDGET);
    });
  }

  it('keeps the field order and only the user’s own notes', () => {
    const [, every] = fixtures[1];
    expect(worker.buildIdeaEmbeddingText(every)).toBe(
      'Why tides have two bulges\n\nFraming by the agent\n\nGravity gradients\n\nraw  thought,\n\nsecond paragraph 🙂' +
        '\n\nmy own note\n\nsecond note of mine\n\nAn article\n\nThe passage.\n\ntags: physics, oceans',
    );
  });

  it('truncates the same way for any budget', () => {
    const text = '潮汐 tides 🙂 '.repeat(500);
    for (const budget of [1, 3, 100, 2500]) {
      expect(worker.truncateToTokenBudget(text, budget)).toBe(node.truncateToTokenBudget(text, budget));
    }
  });
});
