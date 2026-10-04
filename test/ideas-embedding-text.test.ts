import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIdeaEmbeddingText,
  estimateTokens,
  truncateToTokenBudget,
  IDEA_EMBED_TOKEN_BUDGET,
} from "../src/ideas/embeddingText";

const base = {
  title: "Title",
  framing: null,
  why_interesting: null,
  thoughts: null,
  notes: null,
  source_title: null,
  source_excerpt: null,
  tags: null,
};

test("joins non-empty fields in a fixed order with the user's notes only", () => {
  const text = buildIdeaEmbeddingText({
    ...base,
    framing: "Framing",
    why_interesting: "  Why  ",
    thoughts: "我的想法",
    notes: [
      { by: "agent", text: "agent note" },
      { by: "simon", text: "user note" },
      { by: "import", text: "import note" },
      { by: "system", text: "status: parked → used" },
    ],
    source_title: "Source",
    source_excerpt: "Excerpt",
    tags: ["a", "b"],
  });
  assert.equal(text, "Title\n\nFraming\n\nWhy\n\n我的想法\n\nuser note\n\nSource\n\nExcerpt\n\ntags: a, b");
});

test("caps the excerpt by code points", () => {
  const text = buildIdeaEmbeddingText({ ...base, source_excerpt: "x".repeat(5000) });
  assert.equal(text, `Title\n\n${"x".repeat(1500)}`);
});

test("truncates by an estimated token budget that is safe for Chinese", () => {
  const zh = buildIdeaEmbeddingText({ ...base, thoughts: "粵".repeat(10_000) });
  assert.ok(estimateTokens(zh) <= IDEA_EMBED_TOKEN_BUDGET);
  // ~1.7 cl100k tokens per Han char measured; 8,191 is the model limit.
  assert.ok(Array.from(zh).length * 1.7 < 8191);
  const en = buildIdeaEmbeddingText({ ...base, thoughts: "word ".repeat(10_000) });
  assert.ok(en.length > 15_000); // English keeps far more characters
});

test("never splits a surrogate pair", () => {
  const out = truncateToTokenBudget("🙂".repeat(10), 3);
  assert.equal(out, "🙂🙂🙂");
  assert.ok(!/[\ud800-\udbff]$/.test(out));
});
