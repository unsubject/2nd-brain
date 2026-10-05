// Journal processing: the text is normalised in code (the model no longer
// echoes it back), and the embedding input stays under the model's limit.

import { test, before } from "node:test";
import assert from "node:assert/strict";

type Processor = typeof import("../src/processor");
let p: Processor;

before(async () => {
  // The OpenAI client is built at import time; nothing here calls it.
  process.env.OPENAI_API_KEY ||= "sk-test-unused";
  p = await import("../src/processor");
});

test("cleanText normalises whitespace and control characters, not wording", () => {
  assert.equal(p.cleanText("  Hello\r\nworld\t \n\n\n\nnext\u0000 line  "), "Hello\nworld\n\nnext line");
  assert.equal(p.cleanText("經濟學\n\n\n筆記"), "經濟學\n\n筆記");
  assert.equal(p.cleanText(""), "");
});

test("embeddingInput puts the summary first and caps the length", () => {
  assert.equal(p.embeddingInput({ summary: "S", clean_text: "body" }), "S\n\nbody");
  assert.equal(p.embeddingInput({ summary: "", clean_text: "body" }), "body");
  const long = "字".repeat(p.MAX_EMBEDDING_CHARS * 3);
  const out = p.embeddingInput({ summary: "summary", clean_text: long });
  assert.equal(out.length, p.MAX_EMBEDDING_CHARS);
  assert.ok(out.startsWith("summary\n\n"));
});
