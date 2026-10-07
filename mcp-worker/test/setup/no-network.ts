// Vitest setup file (runs before every test file): tests never reach the
// network. fetch is replaced by a stub that fails at once, so a tool that
// embeds text (park_idea's link candidates, search_ideas, search_brain)
// takes its no-embedding path instead of calling OpenAI.
//
// A test that needs embeddings stubs fetch itself with vi.stubGlobal.
// The stub below is assigned directly, NOT through vi.stubGlobal, so
// vi.unstubAllGlobals() restores this stub rather than the real fetch.

// Every URL the stub refused, for tests that assert the default path ran.
export const blockedFetches: string[] = [];

export async function noNetworkFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  blockedFetches.push(url);
  throw new Error(`Network access is disabled in tests (fetch ${url}); stub fetch in the test that needs it`);
}

Object.defineProperty(globalThis, 'fetch', {
  value: noNetworkFetch,
  writable: true,
  configurable: true,
  enumerable: true,
});
