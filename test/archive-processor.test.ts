// Archive processing: the model's JSON is saved as text, which can't hold
// NUL characters.

import { test, before } from "node:test";
import assert from "node:assert/strict";

type Processor = typeof import("../src/archive/processor");
let p: Processor;

before(async () => {
  // The OpenAI client is built at import time; nothing here calls it.
  process.env.OPENAI_API_KEY ||= "sk-test-unused";
  p = await import("../src/archive/processor");
});

test("the model's JSON loses its NUL characters, in every string, and nothing else", () => {
  const content = JSON.stringify({
    summary: "摘要",
    excerpt: "精英\u0000小圈子\u0000",
    tags: ["政治\u0000", "經濟"],
    language: "zh",
    entities: [{ entity_type: "person", display_name: "利\u0000世民", aliases: ["Simon\u0000"], salience: 0.9 }],
  });
  assert.ok(content.includes("\\u0000"));
  assert.deepEqual(p.parseModelJson(content), {
    summary: "摘要",
    excerpt: "精英小圈子",
    tags: ["政治", "經濟"],
    language: "zh",
    entities: [{ entity_type: "person", display_name: "利世民", aliases: ["Simon"], salience: 0.9 }],
  });
  // An escaped backslash before "u0000" is text, not a NUL.
  assert.equal(p.parseModelJson<{ s: string }>(JSON.stringify({ s: "a\\u0000b" })).s, "a\\u0000b");
});
