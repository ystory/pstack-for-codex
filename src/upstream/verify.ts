import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readLock } from './lock.ts';
import { computeSnapshotDigest } from './snapshot.ts';
import { verifyDependencies } from './dependencies.ts';

export interface SnapshotVerification {
  version: string;
  digest: string;
}

export async function verifySnapshot(
  projectRoot: string,
): Promise<SnapshotVerification> {
  const lock = await readLock(projectRoot);
  const snapshotRoot = path.join(projectRoot, 'upstream', 'pstack');
  const digest = await computeSnapshotDigest(snapshotRoot);
  if (digest !== lock.pstack.snapshotSha256) {
    throw new Error(
      `pstack snapshot integrity mismatch: a file was added, removed, or changed.\nPinned: ${lock.pstack.snapshotSha256}\nActual: ${digest}`,
    );
  }
  const manifest: unknown = JSON.parse(
    await readFile(
      path.join(snapshotRoot, '.cursor-plugin', 'plugin.json'),
      'utf8',
    ),
  );
  const name =
    typeof manifest === 'object' && manifest !== null && 'name' in manifest
      ? manifest.name
      : undefined;
  const version =
    typeof manifest === 'object' && manifest !== null && 'version' in manifest
      ? manifest.version
      : undefined;
  if (name !== 'pstack' || version !== lock.pstack.version) {
    throw new Error(
      `pstack manifest mismatch: expected pstack ${lock.pstack.version}, found ${String(name)} ${String(version)}`,
    );
  }
  await verifyDependencies(projectRoot);
  return { version: lock.pstack.version, digest };
}
