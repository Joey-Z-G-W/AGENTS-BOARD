import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const target = new URL('../src/services/generated/board.ts', import.meta.url);
const original = await readFile(target);
try {
  const result = spawnSync(process.execPath, ['node_modules/orval/dist/bin/orval.mjs', '--config', 'orval.config.ts'], {
    cwd: new URL('../', import.meta.url), stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('API generation failed.');
  if (!original.equals(await readFile(target))) throw new Error('Generated API is out of date. Run npm run generate:api.');
  console.log('Generated API matches the OpenAPI contract.');
} finally {
  await writeFile(target, original);
}
