// Journal processing: the text is normalised in code (the model no longer
// echoes it back), and the embedding input stays under the model's token limit.

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

test("embeddingInput puts the summary first and caps the length in bytes", () => {
  assert.equal(p.embeddingInput({ summary: "S", clean_text: "body" }), "S\n\nbody");
  assert.equal(p.embeddingInput({ summary: "", clean_text: "body" }), "body");

  // Colloquial Cantonese runs at up to three bytes (and close to two
  // tokens) a character; the cap is in bytes, so it holds for any script.
  const long = "我諗住今日去搵佢傾吓嘢嘅".repeat(1000);
  const out = p.embeddingInput({ summary: "summary", clean_text: long });
  assert.ok(out.startsWith("summary\n\n"));
  assert.ok(Buffer.byteLength(out, "utf8") <= p.MAX_EMBEDDING_BYTES);
  assert.ok(Buffer.byteLength(out, "utf8") > p.MAX_EMBEDDING_BYTES - 4);

  // An emoji at the cut is dropped whole, never split into a lone surrogate.
  const ascii = "a".repeat(p.MAX_EMBEDDING_BYTES - 2);
  const cut = p.embeddingInput({ summary: "", clean_text: `${ascii}🙂tail` });
  assert.equal(cut, ascii);
  assert.ok(!/[\uD800-\uDFFF]$/.test(cut));
  const fits = p.embeddingInput({ summary: "", clean_text: `${"a".repeat(p.MAX_EMBEDDING_BYTES - 4)}🙂tail` });
  assert.ok(fits.endsWith("🙂"));

  // Short text passes through untouched.
  assert.equal(p.embeddingInput({ summary: "", clean_text: "經濟學筆記" }), "經濟學筆記");
});
