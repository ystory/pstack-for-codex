import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree } from '../src/distribution/tree.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'pstack-package-test-'),
);

function run(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  // Preserve every declared source byte; npm pack omits nested .gitignore files.
  const staging = path.join(temporaryRoot, 'staging', 'package');
  await mkdir(staging, { recursive: true });
  const sourceMetadata = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  if (
    !Array.isArray(sourceMetadata.files) ||
    sourceMetadata.files.some(
      (file: unknown) =>
        typeof file !== 'string' ||
        path.isAbsolute(file) ||
        file.split('/').includes('..') ||
        /[*?]/.test(file),
    )
  )
    throw new Error(
      'Archive inputs must be explicit relative files or directories.',
    );
  for (const file of ['package.json', ...sourceMetadata.files]) {
    const source = path.join(projectRoot, file);
    const destination = path.join(staging, file);
    const stat = await lstat(source);
    if (stat.isDirectory()) await copyTree(source, destination);
    else if (stat.isFile() && !stat.isSymbolicLink()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else throw new Error(`Unsupported archive input: ${file}`);
  }
  run(
    'tar',
    [
      '-czf',
      path.join(temporaryRoot, 'pstack-for-codex.tgz'),
      '-C',
      path.dirname(staging),
      'package',
    ],
    temporaryRoot,
  );
  const archives = (await readdir(temporaryRoot)).filter((name) =>
    name.endsWith('.tgz'),
  );
  const archive = archives[0];
  if (archives.length !== 1 || !archive)
    throw new Error('Expected exactly one packed archive.');
  const packageRoot = path.join(
    temporaryRoot,
    'node_modules',
    'pstack-for-codex',
  );
  await mkdir(packageRoot, { recursive: true });
  run(
    'tar',
    [
      '-xzf',
      path.join(temporaryRoot, archive),
      '-C',
      packageRoot,
      '--strip-components',
      '1',
    ],
    temporaryRoot,
  );
  for (const forbidden of ['src', 'tests', 'node_modules']) {
    try {
      await access(path.join(packageRoot, forbidden));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        continue;
      throw error;
    }
    throw new Error(`Packed artifact unexpectedly includes ${forbidden}.`);
  }
  const metadata: unknown = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const bin =
    typeof metadata === 'object' && metadata !== null && 'bin' in metadata
      ? metadata.bin
      : undefined;
  const cliPath =
    typeof bin === 'object' && bin !== null && 'pstack-for-codex' in bin
      ? bin['pstack-for-codex']
      : undefined;
  if (cliPath !== 'dist/cli.js')
    throw new Error('Packed artifact must expose its built maintainer CLI.');
  const output = run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'verify-upstream'],
    temporaryRoot,
  );
  if (!output.includes('snapshot and manifest match upstream.lock.json')) {
    throw new Error(`Packed CLI did not confirm source integrity:\n${output}`);
  }
  run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'verify-patches'],
    temporaryRoot,
  );
  const artifactRoot = path.join(temporaryRoot, 'artifact');
  run(
    process.execPath,
    [path.join(packageRoot, cliPath), 'build-plugin', '--output', artifactRoot],
    temporaryRoot,
  );
  const verification = run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'verify-plugin',
      '--artifact',
      artifactRoot,
    ],
    temporaryRoot,
  );
  if (!verification.includes('attribution match artifact.json'))
    throw new Error('Packed CLI did not verify its distributable plugin.');
  const codexHome = path.join(temporaryRoot, 'isolated-codex-home');
  await mkdir(path.join(codexHome, 'agents'), { recursive: true });
  await mkdir(path.join(codexHome, 'pstack-for-codex'));
  const preservedSettings = '{"userChoice":"preserve"}\n';
  await writeFile(
    path.join(codexHome, 'config.toml'),
    'model = "user-model"\n',
  );
  await writeFile(
    path.join(codexHome, 'pstack-for-codex', 'models.json'),
    preservedSettings,
  );
  await writeFile(
    path.join(codexHome, 'agents', 'user-agent.toml'),
    'name = "user-agent"\n',
  );
  const registrar = path.join(
    artifactRoot,
    'plugin',
    'skills',
    'setup-pstack',
    'scripts',
    'register-agents.mjs',
  );
  const register = (extra: string[] = []) =>
    run(
      process.execPath,
      [registrar, '--codex-home', codexHome, ...extra],
      temporaryRoot,
    );
  register(['--dry-run']);
  register();
  const beforeRegistration = await readFile(
    path.join(codexHome, 'pstack-for-codex', 'agent-registration.json'),
  );
  register();
  if (
    !(
      await readFile(
        path.join(codexHome, 'pstack-for-codex', 'agent-registration.json'),
      )
    ).equals(beforeRegistration)
  )
    throw new Error('Repeated setup changed ownership metadata.');
  const manifestFile = path.join(artifactRoot, 'plugin', 'plugin.json');
  const originalManifest = await readFile(manifestFile);
  const originalAgentFile = path.join(
    artifactRoot,
    'plugin',
    'agents',
    'poteto-agent.toml',
  );
  const originalAgent = await readFile(originalAgentFile);
  const fixtureManifest = JSON.parse(originalManifest.toString('utf8'));
  fixtureManifest.version = '0.1.0-lifecycle-test';
  await writeFile(
    manifestFile,
    `${JSON.stringify(fixtureManifest, null, 2)}\n`,
  );
  await writeFile(
    originalAgentFile,
    Buffer.concat([originalAgent, Buffer.from('\n')]),
  );
  register();
  if (
    JSON.parse(
      await readFile(
        path.join(codexHome, 'pstack-for-codex', 'agent-registration.json'),
        'utf8',
      ),
    ).pluginVersion !== fixtureManifest.version
  )
    throw new Error('Packaged registrar did not record fixture update.');
  await writeFile(manifestFile, originalManifest);
  await writeFile(originalAgentFile, originalAgent);
  register();
  if (
    !(
      await readFile(path.join(codexHome, 'agents', 'poteto-agent.toml'))
    ).equals(originalAgent)
  )
    throw new Error('Prior bundle did not restore its registered agent.');
  register(['--unregister', '--dry-run']);
  register(['--unregister']);
  register(['--unregister']);
  if (
    (await readdir(path.join(codexHome, 'agents'))).join(',') !==
    'user-agent.toml'
  )
    throw new Error('Unregister did not preserve unowned agent files.');
  if (
    (await readFile(
      path.join(codexHome, 'pstack-for-codex', 'models.json'),
      'utf8',
    )) !== preservedSettings ||
    (await readFile(path.join(codexHome, 'config.toml'), 'utf8')) !==
      'model = "user-model"\n'
  )
    throw new Error('Packaged lifecycle changed user settings.');
  const isolatedModelsHome = path.join(temporaryRoot, 'mixed-model-home');
  const models = JSON.parse(
    run(
      process.execPath,
      [
        path.join(
          artifactRoot,
          'plugin/skills/setup-pstack/scripts/models.mjs',
        ),
        'read',
        '--codex-home',
        isolatedModelsHome,
      ],
      temporaryRoot,
    ),
  );
  if (
    models.config.schemaVersion !== 2 ||
    Object.keys(models.config.roles).length !== 17 ||
    models.config.roles['hardest tasks'][0].executor !== 'claude-code' ||
    models.config.roles['hardest tasks'][0].model !== 'claude-opus-5-5' ||
    models.config.roles['how explainer'][0].model !== 'gpt-6.1-sol' ||
    models.exists !== false ||
    models.sha256 !== null
  )
    throw new Error('Packaged model helper did not retain mixed defaults.');
  try {
    await access(isolatedModelsHome);
    throw new Error('Reading packaged defaults wrote a model configuration.');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const instruction = path.join(temporaryRoot, 'AGENTS.md');
  await writeFile(
    instruction,
    'Apply only the assigned package fixture task.\n',
  );
  const externalStub = path.join(temporaryRoot, 'existing-claude-stub');
  await writeFile(
    externalStub,
    `#!${process.execPath}\n` +
      `process.stdin.resume();\n` +
      `process.stdin.on('end', () => {\n` +
      `  console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-opus-5-5',session_id:'00000000-0000-4000-8000-000000000001'}));\n` +
      `  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'packaged external transport stub'}));\n` +
      `});\n`,
  );
  await chmod(externalStub, 0o755);
  const runner = JSON.parse(
    run(
      process.execPath,
      [
        path.join(
          artifactRoot,
          'plugin/skills/poteto-mode/scripts/run-claude.mjs',
        ),
        'run',
        '--cwd',
        temporaryRoot,
        '--run-dir',
        path.join(temporaryRoot, 'external-run-evidence'),
        '--effort',
        'xhigh',
        '--instruction',
        instruction,
        '--skill',
        path.join(artifactRoot, 'plugin/skills/how/SKILL.md'),
        '--executable',
        externalStub,
      ],
      temporaryRoot,
      'Check the packaged external transport fixture.\n',
    ),
  );
  if (
    runner.exitCode !== 0 ||
    runner.model !== 'claude-opus-5-5' ||
    runner.observedModel !== 'claude-opus-5-5' ||
    runner.result !== 'packaged external transport stub' ||
    !(await readFile(runner.promptPath, 'utf8')).includes(
      'Apply only the assigned package fixture task.',
    )
  )
    throw new Error('Packaged runner did not execute the external stub.');
  run(
    process.execPath,
    [
      path.join(packageRoot, cliPath),
      'verify-plugin',
      '--artifact',
      artifactRoot,
    ],
    temporaryRoot,
  );
  console.log(
    'Packed artifact verified: standalone plugin, native marketplace manifest, patch replay, isolated setup lifecycle, mixed model defaults, and external CLI stub transport without source files or development dependencies. User settings are preserved. The stub does not prove Claude authentication or model execution. Native global install was not run.',
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
