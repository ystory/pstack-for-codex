import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyDistributionPolicy,
  readDistributionPolicy,
  verifyDistributionPolicy,
} from '../src/distribution/policy.ts';
import { copyPristinePlugin } from '../src/upstream/dependencies.ts';
import { inspectTree } from '../src/distribution/tree.ts';

test('approved exclusion removes only Benny, preserves source bytes and other workflows, and rejects new entrypoints', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-policy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'upstream', 'pstack');
  await mkdir(path.join(source, 'automations', 'benny'), { recursive: true });
  await writeFile(
    path.join(source, 'automations', 'benny', 'FOR_AGENTS.md'),
    'Original excluded automation\n',
  );
  await mkdir(path.join(source, 'automations', 'other'));
  await writeFile(
    path.join(source, 'automations', 'other', 'README.md'),
    'Other automation\n',
  );
  await mkdir(path.join(source, 'skills', 'why', 'references'), {
    recursive: true,
  });
  await writeFile(
    path.join(source, 'skills', 'why', 'references', 'slack.md'),
    'Read Slack evidence\n',
  );
  await assert.rejects(
    readDistributionPolicy(root),
    /explicit distribution exclusion/,
  );
  const policy = {
    schemaVersion: 1 as const,
    excludedDirectories: ['automations/benny'] as ['automations/benny'],
  };
  await writeFile(
    path.join(root, 'distribution-policy.json'),
    JSON.stringify(policy),
  );
  const plugin = path.join(root, 'plugin');
  await copyPristinePlugin(root, plugin);
  const files = await inspectTree(plugin);
  assert.ok(
    files.some((entry) => entry.path === 'automations/other/README.md'),
  );
  assert.ok(
    files.some((entry) => entry.path === 'skills/why/references/slack.md'),
  );
  assert.ok(!files.some((entry) => /benny/.test(entry.path)));
  assert.equal(
    await readFile(
      path.join(source, 'automations', 'benny', 'FOR_AGENTS.md'),
      'utf8',
    ),
    'Original excluded automation\n',
  );
  await verifyDistributionPolicy(plugin, policy);
  await writeFile(path.join(plugin, 'README.md'), 'Invoke Benny\n');
  await assert.rejects(
    verifyDistributionPolicy(plugin, policy),
    /reference returned/,
  );
  await mkdir(path.join(plugin, 'skills', 'setup-benny'), { recursive: true });
  await writeFile(
    path.join(plugin, 'skills', 'setup-benny', 'SKILL.md'),
    'A newly moved entrypoint\n',
  );
  await assert.rejects(
    applyDistributionPolicy(root, plugin),
    /New Benny source surface/,
  );
});
