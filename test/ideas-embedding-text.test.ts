import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdeaEmbeddingText, IDEA_EMBED_MAX_CHARS } from "../src/ideas/embeddingText";

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

test("caps the excerpt and the total length", () => {
  const text = buildIdeaEmbeddingText({ ...base, source_excerpt: "x".repeat(5000) });
  assert.equal(text, `Title\n\n${"x".repeat(1500)}`);
  const long = buildIdeaEmbeddingText({ ...base, thoughts: "y".repeat(10_000) });
  assert.equal(long.length, IDEA_EMBED_MAX_CHARS);
});
