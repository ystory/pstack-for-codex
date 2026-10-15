import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './errors.ts';

export interface UpstreamLock {
  schemaVersion: 1;
  pstack: {
    repository: 'https://github.com/cursor/plugins';
    ref: 'main';
    path: 'pstack';
    revision: string;
    pathRevision: string;
    version: string;
    snapshotSha256: string;
  };
  codex: {
    repository: 'https://github.com/openai/codex';
    ref: 'main';
    sourceRevision: string;
    testedVersions: string[];
  };
}

const revisionPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isVersionArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonemptyString);
}

function requireField(condition: unknown, field: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid upstream.lock.json field: ${field}`);
  }
}

export function validateLock(value: unknown): UpstreamLock {
  requireField(
    isRecord(value) && value.schemaVersion === 1,
    'schemaVersion (expected 1)',
  );
  const pstack = value.pstack;
  requireField(isRecord(pstack), 'pstack');
  requireField(
    pstack.repository === 'https://github.com/cursor/plugins',
    'pstack.repository',
  );
  requireField(pstack.ref === 'main', 'pstack.ref');
  requireField(pstack.path === 'pstack', 'pstack.path');
  requireField(matches(pstack.revision, revisionPattern), 'pstack.revision');
  requireField(
    matches(pstack.pathRevision, revisionPattern),
    'pstack.pathRevision',
  );
  requireField(isNonemptyString(pstack.version), 'pstack.version');
  requireField(
    matches(pstack.snapshotSha256, digestPattern),
    'pstack.snapshotSha256',
  );
  const codex = value.codex;
  requireField(isRecord(codex), 'codex');
  requireField(
    codex.repository === 'https://github.com/openai/codex',
    'codex.repository',
  );
  requireField(codex.ref === 'main', 'codex.ref');
  requireField(
    matches(codex.sourceRevision, revisionPattern),
    'codex.sourceRevision',
  );
  requireField(isVersionArray(codex.testedVersions), 'codex.testedVersions');
  return {
    schemaVersion: 1,
    pstack: {
      repository: pstack.repository,
      ref: pstack.ref,
      path: pstack.path,
      revision: pstack.revision,
      pathRevision: pstack.pathRevision,
      version: pstack.version,
      snapshotSha256: pstack.snapshotSha256,
    },
    codex: {
      repository: codex.repository,
      ref: codex.ref,
      sourceRevision: codex.sourceRevision,
      testedVersions: codex.testedVersions,
    },
  };
}

export async function readLock(projectRoot: string): Promise<UpstreamLock> {
  const lockPath = path.join(projectRoot, 'upstream.lock.json');
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read upstream.lock.json: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return validateLock(lock);
}
