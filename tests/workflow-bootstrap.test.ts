import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsSource = fileURLToPath(
  new URL('../plugin/skills/poteto-mode/scripts/', import.meta.url),
);
const bunAvailable = spawnSync('bun', ['--version']).status === 0;
const options = { skip: bunAvailable ? false : 'Bun is not installed' };

async function snapshot(directory: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const info = await stat(file);
    result.push({
      name,
      mode: info.mode,
      mtime: info.mtimeMs,
      content: info.isDirectory()
        ? await snapshot(file)
        : (await readFile(file)).toString('base64'),
    });
  }
  return result;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pstack-bootstrap-test-'));
  const bundle = path.join(root, 'read only bundle');
  const scripts = path.join(bundle, 'skills/poteto-mode/scripts');
  const consumer = path.join(root, 'consumer');
  const cache = path.join(root, 'dependency cache');
  await mkdir(scripts, { recursive: true });
  await mkdir(consumer);
  for (const file of ['bootstrap.ts', 'package.json', 'bun.lock']) {
    await copyFile(path.join(scriptsSource, file), path.join(scripts, file));
    await chmod(path.join(scripts, file), 0o444);
  }
  const bundleDirectories = [
    scripts,
    path.dirname(scripts),
    path.join(bundle, 'skills'),
    bundle,
  ];
  for (const directory of bundleDirectories) await chmod(directory, 0o555);
  t.after(async () => {
    for (const directory of bundleDirectories) await chmod(directory, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  const key = createHash('sha256')
    .update(await readFile(path.join(scripts, 'package.json')))
    .update('\0')
    .update(await readFile(path.join(scripts, 'bun.lock')))
    .digest('hex');
  const invoke = (code: string, cacheDirectory = cache) =>
    spawnSync('bun', ['--eval', code], {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        POTETO_MODE_CACHE_DIR: cacheDirectory,
        BUN_INSTALL_CACHE_DIR: path.join(root, 'bun download cache'),
        PSTACK_BOOTSTRAP_FILE: path.join(scripts, 'bootstrap.ts'),
      },
    });
  return { root, bundle, scripts, consumer, cache, key, invoke };
}

// Stub the install boundary; these tests use real Bun without package network.
const installStub = `
  const fs = await import('node:fs');
  const path = await import('node:path');
  const bootstrap = await import(process.env.PSTACK_BOOTSTRAP_FILE);
  const calls = [];
  Bun.spawnSync = (command, options) => {
    calls.push({ command, cwd: options.cwd, cache: options.env.BUN_INSTALL_CACHE_DIR });
    const moduleDirectory = path.join(options.cwd, 'node_modules', 'commander');
    fs.mkdirSync(moduleDirectory, { recursive: true });
    fs.writeFileSync(path.join(moduleDirectory, 'package.json'), '{"version":"14.0.0"}');
    fs.writeFileSync(path.join(moduleDirectory, 'esm.mjs'), 'export const cacheMarker = "loaded";');
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
`;

test(
  'read-only bundle loads dependencies externally and reuses its cache without writes',
  options,
  async (t) => {
    const f = await fixture(t);
    const before = await snapshot(f.bundle);
    const result = f.invoke(
      installStub +
        `
    const first = bootstrap.ensureDependenciesInstalled();
    const marker = path.join(path.dirname(first), '..', '.poteto-mode-tools-install-key');
    const installed = fs.statSync(marker).mtimeMs;
    const second = bootstrap.ensureDependenciesInstalled();
    const loaded = await bootstrap.loadCommander();
    console.log(JSON.stringify({ first, second, calls, loaded: loaded.cacheMarker,
      unchanged: installed === fs.statSync(marker).mtimeMs, cwd: process.cwd() }));
  `,
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const output = JSON.parse(result.stdout);
    const cacheDirectory = path.join(
      realpathSync(f.root),
      'dependency cache',
      f.key,
    );
    assert.equal(
      output.first,
      path.join(cacheDirectory, 'node_modules/commander/esm.mjs'),
    );
    assert.equal(output.second, output.first);
    assert.equal(output.loaded, 'loaded');
    assert.equal(output.unchanged, true);
    assert.equal(output.calls.length, 1);
    assert.deepEqual(output.calls[0].command.slice(1), [
      'install',
      '--frozen-lockfile',
      '--production',
      '--ignore-scripts',
    ]);
    assert.equal(output.calls[0].cwd, cacheDirectory);
    assert.equal(
      output.calls[0].cache,
      path.join(f.root, 'bun download cache'),
    );
    assert.equal(output.cwd, realpathSync(f.consumer));
    const cacheBefore = await snapshot(f.cache);
    const warm = f.invoke(
      installStub +
        `
      const loaded = await bootstrap.loadCommander();
      console.log(JSON.stringify({ loaded: loaded.cacheMarker, calls }));
    `,
    );
    assert.equal(warm.status, 0, warm.stderr || warm.error?.message);
    assert.deepEqual(JSON.parse(warm.stdout), { loaded: 'loaded', calls: [] });
    assert.deepEqual(await snapshot(f.cache), cacheBefore);
    for (const file of ['package.json', 'bun.lock']) {
      assert.deepEqual(
        await readFile(path.join(cacheDirectory, file)),
        await readFile(path.join(f.scripts, file)),
      );
      assert.ok((await stat(path.join(cacheDirectory, file))).mode & 0o200);
    }
    assert.deepEqual(await snapshot(f.bundle), before);
  },
);

test(
  'failed dependency install leaves no ready marker and can be retried',
  options,
  async (t) => {
    const f = await fixture(t);
    const before = await snapshot(f.bundle);
    const result = f.invoke(
      installStub +
        `
    const install = Bun.spawnSync;
    Bun.spawnSync = () => ({ exitCode: 11, stdout: Buffer.alloc(0), stderr: Buffer.from('test install failed') });
    let failure;
    try { bootstrap.ensureDependenciesInstalled(); } catch (error) { failure = error.message; }
    const cache = bootstrap.dependencyCacheDirectory();
    const marked = fs.existsSync(path.join(cache, 'node_modules/.poteto-mode-tools-install-key'));
    Bun.spawnSync = install;
    const loaded = await bootstrap.loadCommander();
    console.log(JSON.stringify({ failure, marked, loaded: loaded.cacheMarker, calls }));
  `,
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const output = JSON.parse(result.stdout);
    assert.match(output.failure, /exited with status 11/);
    assert.equal(output.marked, false);
    assert.equal(output.loaded, 'loaded');
    assert.equal(output.calls.length, 1);
    assert.deepEqual(await snapshot(f.bundle), before);
  },
);

test(
  'cache rejects installed bundle paths, symlink aliases, and relative overrides',
  options,
  async (t) => {
    const f = await fixture(t);
    const before = await snapshot(f.bundle);
    const code = `
    const { ensureDependenciesInstalled } = await import(process.env.PSTACK_BOOTSTRAP_FILE);
    ensureDependenciesInstalled();
  `;
    for (const target of [
      path.join(f.bundle, 'cache'),
      path.join(f.bundle, '..cache'),
      'relative-cache',
    ]) {
      const result = f.invoke(code, target);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /must be outside the plugin bundle|must be an absolute writable directory/,
      );
    }
    const alias = path.join(f.root, 'bundle-alias');
    await symlink(f.bundle, alias, 'dir');
    const result = f.invoke(code, path.join(alias, 'cache'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be outside the plugin bundle/);
    assert.deepEqual(await snapshot(f.bundle), before);
  },
);

test('Node reports the Bun prerequisite before creating a cache', async (t) => {
  const f = await fixture(t);
  const code =
    'const { ensureDependenciesInstalled } = await import(' +
    JSON.stringify(path.join(f.scripts, 'bootstrap.ts')) +
    '); ensureDependenciesInstalled();';
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', code],
    {
      cwd: f.consumer,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, POTETO_MODE_CACHE_DIR: f.cache },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /require Bun 1\.2 or newer; run with bun/);
  await assert.rejects(stat(f.cache), { code: 'ENOENT' });
});
