import { defineConfig } from 'vitest/config';

// Markdown docs are bundled by wrangler's Text rule at build time
// (see wrangler.jsonc), so the production import
//   import doc from '../../docs/foo.md';
// resolves to a string. In tests we mirror that with a vite transform
// plugin so we don't need the full @cloudflare/vitest-pool-workers
// miniflare stack just to read the dispatcher.
export default defineConfig({
  plugins: [
    {
      name: 'md-as-string',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.md')) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return undefined;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // DB-backed suites (test/db) share one database; setup resets it and
    // applies every migration when TEST_DATABASE_URL is set (else no-op).
    globalSetup: ['test/setup/test-db.ts'],
    fileParallelism: false,
  },
});
