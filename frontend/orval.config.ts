import { defineConfig } from 'orval';

export default defineConfig({
  board: {
    input: '../_docs/api/openapi.json',
    output: {
      target: './src/services/generated/board.ts',
      client: 'fetch',
      mode: 'single',
      baseUrl: '',
      urlEncodeParameters: true,
      override: {
        mutator: { path: './src/services/transport.ts', name: 'apiFetch' },
        fetch: { includeHttpResponseReturnType: false, forceSuccessResponse: true },
      },
    },
  },
});
