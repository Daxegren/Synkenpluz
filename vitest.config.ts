import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite startar en hel Postgres i WebAssembly per test. Det går långsamt när många
    // testfiler körs parallellt, så standardtimeouten på 5 s räcker inte.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
