import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLock } from '../upstream/lock.ts';
import { verifySnapshot } from '../upstream/verify.ts';
import { readDependencyLock } from '../upstream/dependencies.ts';
import { readDistributionPolicy } from './policy.ts';
import { generatePatch, readPatchSeries, verifyPatches } from './patches.ts';
import { copyTree, createOutputDirectory } from './tree.ts';

export async function regenerateCandidatePatches(
  candidate: string,
  output: string,
): Promise<{ files: number; digest: string }> {
  if (!path.isAbsolute(candidate))
    throw new Error('Candidate must be an absolute path.');
  await verifySnapshot(candidate);
  const originalReport = JSON.parse(
    await readFile(path.join(candidate, 'candidate-report.json'), 'utf8'),
  );
  const originalPatches = await readPatchSeries(candidate);
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'pstack-candidate-regenerate-'),
  );
  try {
    for (const directory of ['upstream', 'plugin'])
      await copyTree(
        path.join(candidate, directory),
        path.join(temporary, directory),
      );
    await copyFile(
      path.join(candidate, 'upstream.lock.json'),
      path.join(temporary, 'upstream.lock.json'),
    );
    if (await readDependencyLock(candidate))
      await copyFile(
        path.join(candidate, 'dependencies.lock.json'),
        path.join(temporary, 'dependencies.lock.json'),
      );
    if (await readDistributionPolicy(candidate))
      await copyFile(
        path.join(candidate, 'distribution-policy.json'),
        path.join(temporary, 'distribution-policy.json'),
      );
    await mkdir(path.join(temporary, 'patches'));
    await writeFile(path.join(temporary, 'patches', 'series'), '');
    const groups: {
      name: string;
      status: 'generated' | 'no-remaining-changes';
    }[] = [];
    for (const patch of originalPatches) {
      if (patch.name === '9999-candidate-remainder.patch') continue;
      const bytes = await readFile(
        path.join(candidate, 'patches', patch.name),
        'utf8',
      );
      const files = [
        ...new Set(
          [
            ...bytes.matchAll(/^\+\+\+ b\/(.+)$/gm),
            ...bytes.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm),
          ].map((match) => match[1]!),
        ),
      ];
      if (!files.length) {
        groups.push({ name: patch.name, status: 'no-remaining-changes' });
        continue;
      }
      try {
        await generatePatch(temporary, patch.name, files);
        groups.push({ name: patch.name, status: 'generated' });
      } catch (error) {
        if (!(
          error instanceof Error &&
          error.message === 'No new plugin changes to record.'
        ))
          throw error;
        groups.push({ name: patch.name, status: 'no-remaining-changes' });
      }
    }
    try {
      await generatePatch(temporary, '9999-candidate-remainder.patch');
      groups.push({
        name: '9999-candidate-remainder.patch',
        status: 'generated',
      });
    } catch (error) {
      if (!(
        error instanceof Error &&
        error.message === 'No new plugin changes to record.'
      ))
        throw error;
    }
    const verified = await verifyPatches(temporary);
    await createOutputDirectory(output);
    await copyTree(
      path.join(temporary, 'patches'),
      path.join(output, 'patches'),
    );
    await writeFile(
      path.join(output, 'regeneration-report.json'),
      `${JSON.stringify({ schemaVersion: 1, source: await readLock(candidate), originalCandidateStatus: originalReport.status, originalConflict: originalReport.conflict ?? null, originalUnappliedPatches: originalReport.unappliedPatches ?? [], originalPatches, regeneratedPatches: verified.patches, groups, pluginTreeSha256: verified.digest, verification: 'Full byte and mode replay equality only; original failed patches are not evidence of semantic preservation or runtime compatibility. Review the complete target tree and run its workflows before integration.' }, null, 2)}\n`,
    );
    return { files: verified.files, digest: verified.digest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
