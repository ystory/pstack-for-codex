import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function computeSnapshotDigest(root: string): Promise<string> {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(
      `Snapshot root must be a directory, not a symlink: ${root}`,
    );
  }

  const files: { relativePath: string; absolutePath: string }[] = [];
  async function visit(
    directory: string,
    relativeDirectory = '',
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Snapshot symlinks are not allowed: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({ relativePath, absolutePath });
      } else {
        throw new Error(
          `Snapshot contains an unsupported file type: ${relativePath}`,
        );
      }
    }
  }
  await visit(root);

  const snapshotHash = createHash('sha256');
  files.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  for (const { relativePath, absolutePath } of files) {
    const fileHash = createHash('sha256')
      .update(await readFile(absolutePath))
      .digest('hex');
    snapshotHash.update(`${relativePath}\0${fileHash}\n`);
  }
  return snapshotHash.digest('hex');
}
