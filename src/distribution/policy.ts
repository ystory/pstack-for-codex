import { lstat, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { inspectTree } from './tree.ts';

export interface DistributionPolicy {
  schemaVersion: 1;
  excludedDirectories: ['automations/benny'];
}

export class DistributionPolicyConflict extends Error {}

export function validateDistributionPolicy(value: unknown): DistributionPolicy {
  const policy = value as DistributionPolicy | undefined;
  if (
    policy?.schemaVersion !== 1 ||
    JSON.stringify(policy.excludedDirectories) !== '["automations/benny"]'
  )
    throw new Error('Invalid distribution-policy.json.');
  return policy;
}

export async function readDistributionPolicy(
  projectRoot: string,
): Promise<DistributionPolicy | undefined> {
  let bytes: string;
  try {
    bytes = await readFile(
      path.join(projectRoot, 'distribution-policy.json'),
      'utf8',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    try {
      await lstat(
        path.join(projectRoot, 'upstream', 'pstack', 'automations', 'benny'),
      );
    } catch (sourceError) {
      if (
        sourceError instanceof Error &&
        'code' in sourceError &&
        sourceError.code === 'ENOENT'
      )
        return undefined;
      throw sourceError;
    }
    throw new Error(
      'Benny source requires an explicit distribution exclusion policy.',
    );
  }
  return validateDistributionPolicy(JSON.parse(bytes));
}

export async function applyDistributionPolicy(
  projectRoot: string,
  pluginRoot: string,
): Promise<void> {
  const policy = await readDistributionPolicy(projectRoot);
  if (!policy) return;
  for (const excluded of policy.excludedDirectories)
    await rm(path.join(pluginRoot, excluded), { recursive: true, force: true });
  if (
    (await inspectTree(pluginRoot)).some((entry) => /benny/i.test(entry.path))
  )
    throw new DistributionPolicyConflict(
      'New Benny source surface requires distribution-policy review.',
    );
  await rmdir(path.join(pluginRoot, 'automations')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    },
  );
}

export async function verifyDistributionPolicy(
  pluginRoot: string,
  policy?: DistributionPolicy,
): Promise<void> {
  if (!policy) return;
  validateDistributionPolicy(policy);
  for (const entry of await inspectTree(pluginRoot)) {
    if (/benny/i.test(entry.path))
      throw new Error(`Excluded Benny workflow returned: ${entry.path}`);
    if (
      entry.kind === 'file' &&
      /\.(md|json|toml|ya?ml)$/.test(entry.path) &&
      /\bbenny\b/i.test(
        await readFile(path.join(pluginRoot, entry.path), 'utf8'),
      )
    )
      throw new Error(
        `Excluded Benny workflow reference returned: ${entry.path}`,
      );
  }
}
