import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { applyPatchSeries, runGit } from '../src/distribution/patches.ts';

async function fixture(t: TestContext, value: string) {
  const project = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-patch-location-'),
  );
  t.after(() => rm(project, { recursive: true, force: true }));
  runGit(project, ['init', '--quiet']);
  await writeFile(path.join(project, '.gitignore'), '.local/\n');
  const destination = path.join(project, '.local', 'candidate', 'plugin');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'value.txt'), value);
  await mkdir(path.join(project, 'patches'));
  await writeFile(
    path.join(project, 'patches', 'series'),
    '0001-change-value.patch\n',
  );
  await writeFile(
    path.join(project, 'patches', '0001-change-value.patch'),
    'diff --git a/value.txt b/value.txt\nindex 3367afd..3e75765 100644\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-old\n+new\n',
  );
  return { project, destination };
}

test('patch replay updates files inside an ignored directory of a parent repository', async (t) => {
  const { project, destination } = await fixture(t, 'old\n');
  await applyPatchSeries(project, destination);
  assert.equal(
    await readFile(path.join(destination, 'value.txt'), 'utf8'),
    'new\n',
  );
});

test('patch replay rejects conflicting context inside an ignored directory of a parent repository', async (t) => {
  const { project, destination } = await fixture(t, 'different\n');
  await assert.rejects(
    applyPatchSeries(project, destination),
    /Patch conflict in 0001-change-value\.patch/,
  );
  assert.equal(
    await readFile(path.join(destination, 'value.txt'), 'utf8'),
    'different\n',
  );
});
