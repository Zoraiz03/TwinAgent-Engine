import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a tiny fake target project in a temp dir; returns its path. */
export async function makeTarget() {
  const dir = await mkdtemp(join(tmpdir(), 'twin-target-'));
  await writeFile(join(dir, 'index.js'), 'export const x = 1;\n');
  return dir;
}
