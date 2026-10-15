import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
const { listHistory, readHistory } = await import(
  new URL('../plugin/skills/recall/scripts/codex-history.mjs', import.meta.url)
    .href
);

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
] as const;
const lines = (id: string, cwd: string, content: string, extra = {}) =>
  `${JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-15T00:00:00Z', source: 'cli', ...extra } })}\n${JSON.stringify({ ordinal: 1, type: 'response_item', payload: { type: 'message', content } })}\n`;

test('Codex history scopes metadata before content search and reads archived compressed transcripts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pstack-history-'));
  try {
    const project = join(scratch, 'project with spaces');
    const other = join(scratch, 'project with spaces-other');
    const codexHome = join(scratch, 'codex');
    await Promise.all([
      mkdir(project),
      mkdir(other),
      mkdir(join(codexHome, 'sessions'), { recursive: true }),
      mkdir(join(codexHome, 'archived_sessions'), { recursive: true }),
    ]);
    const scoped = join(codexHome, 'sessions', `rollout-${ids[0]}.jsonl`);
    const archived = join(
      codexHome,
      'archived_sessions',
      `rollout-${ids[1]}.jsonl.zst`,
    );
    const unrelated = join(codexHome, 'sessions', `rollout-${ids[2]}.jsonl`);
    await writeFile(scoped, lines(ids[0], project, 'own tool proof'));
    await writeFile(
      archived,
      zstdCompressSync(
        Buffer.from(lines(ids[1], project, 'archived tool proof')),
      ),
    );
    await writeFile(
      unrelated,
      lines(ids[2], other, `unrelated secret referring to ${project}`),
    );
    await utimes(scoped, new Date('2026-10-14'), new Date('2026-10-14'));
    await utimes(archived, new Date('2026-10-15'), new Date('2026-10-15'));
    await symlink(unrelated, join(codexHome, 'sessions', 'linked.jsonl'));
    const result = await listHistory({ project, codexHome });
    assert.deepEqual(
      result.map((item: { id: string }) => item.id),
      [ids[1], ids[0]],
    );
    assert.equal(
      (await listHistory({ project, codexHome, query: 'unrelated secret' }))
        .length,
      0,
    );
    assert.equal(
      (await listHistory({ project, codexHome, since: '2026-10-15' })).length,
      1,
    );
    assert.match(
      (await readHistory({ project, codexHome, id: ids[1] })).toString(),
      /archived tool proof/,
    );
    await assert.rejects(
      readHistory({ project, codexHome, id: ids[2] }),
      /scoped history/,
    );
    await assert.rejects(
      readHistory({ project, codexHome, id: '../secret' }),
      /exact chat UUID/,
    );
    assert.equal(
      await readFile(unrelated, 'utf8'),
      lines(ids[2], other, `unrelated secret referring to ${project}`),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('Codex history includes repository worktrees and reconstructs only available in-scope fork prefixes', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pstack-history-fork-'));
  try {
    const project = join(scratch, 'repo');
    const worktree = join(scratch, 'other worktree');
    const codexHome = join(scratch, 'codex');
    await mkdir(project);
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', [
      '-C',
      project,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    ]);
    execFileSync('git', [
      '-C',
      project,
      'worktree',
      'add',
      '-qb',
      'topic',
      worktree,
    ]);
    const prefix = lines(ids[0], project, 'inherited tool call');
    await writeFile(
      join(codexHome, 'sessions', `rollout-${ids[0]}.jsonl`),
      prefix,
    );
    const child = lines(ids[1], worktree, 'child tool result', {
      history_base: {
        thread_id: ids[0],
        end_ordinal_exclusive: 2,
        end_byte_offset: Buffer.byteLength(prefix),
      },
    });
    await writeFile(
      join(codexHome, 'sessions', `rollout-${ids[1]}.jsonl`),
      child,
    );
    assert.equal((await listHistory({ project, codexHome })).length, 2);
    assert.equal(
      (await readHistory({ project, codexHome, id: ids[1] })).toString(),
      prefix + child,
    );
    await rm(join(codexHome, 'sessions', `rollout-${ids[0]}.jsonl`));
    await assert.rejects(
      readHistory({ project, codexHome, id: ids[1] }),
      /Inherited rollout is unavailable/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('recent fork searches the inherited conversation even when its parent is outside the time window', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pstack-history-query-'));
  try {
    const project = join(scratch, 'project');
    const codexHome = join(scratch, 'codex');
    await mkdir(project);
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    const parentPath = join(codexHome, 'sessions', `rollout-${ids[0]}.jsonl`);
    const childPath = join(codexHome, 'sessions', `rollout-${ids[1]}.jsonl`);
    const prefix = lines(ids[0], project, 'prior deployment decision');
    const child = lines(ids[1], project, 'continue implementation', {
      history_base: {
        thread_id: ids[0],
        end_ordinal_exclusive: 2,
        end_byte_offset: Buffer.byteLength(prefix),
      },
    });
    await writeFile(parentPath, prefix);
    await writeFile(childPath, child);
    await utimes(parentPath, new Date('2026-09-01'), new Date('2026-09-01'));
    await utimes(childPath, new Date('2026-10-15'), new Date('2026-10-15'));
    const matches = await listHistory({
      project,
      codexHome,
      since: '2026-10-14',
      query: 'prior deployment decision',
    });
    assert.deepEqual(
      matches.map((item: { id: string }) => item.id),
      [ids[1]],
    );
    assert.equal(
      (await readHistory({ project, codexHome, id: matches[0].id })).toString(),
      prefix + child,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('reverted chat lists and searches only its current rollout while retaining its inherited prefix', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pstack-history-revert-'));
  try {
    const project = join(scratch, 'project');
    const codexHome = join(scratch, 'codex');
    await mkdir(project);
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    const originalPath = join(
      codexHome,
      'sessions',
      `rollout-2026-10-14T00-00-00-${ids[0]}.jsonl`,
    );
    const replacementPath = join(
      codexHome,
      'sessions',
      `rollout-2026-10-15T00-00-00-${ids[0]}_${ids[1]}.jsonl`,
    );
    const prefix = lines(ids[0], project, 'kept decision');
    const discarded = `${JSON.stringify({ ordinal: 2, type: 'response_item', payload: { type: 'message', content: 'reverted-only-topic' } })}\n`;
    const replacement = lines(ids[0], project, 'current continuation', {
      history_base: {
        thread_id: ids[0],
        end_ordinal_exclusive: 2,
        end_byte_offset: Buffer.byteLength(prefix),
      },
    });
    await writeFile(originalPath, prefix + discarded);
    await writeFile(replacementPath, replacement);
    // A later filesystem touch of a superseded file cannot make it current again.
    await utimes(originalPath, new Date('2026-10-16'), new Date('2026-10-16'));
    await utimes(
      replacementPath,
      new Date('2026-10-15'),
      new Date('2026-10-15'),
    );
    const current = await listHistory({ project, codexHome });
    assert.equal(current.length, 1);
    assert.equal(current[0].id, ids[0]);
    assert.equal(current[0].path, await realpath(replacementPath));
    assert.equal(
      (await listHistory({ project, codexHome, query: 'reverted-only-topic' }))
        .length,
      0,
    );
    const matches = await listHistory({
      project,
      codexHome,
      query: 'kept decision',
    });
    assert.deepEqual(matches, current);
    assert.equal(
      (await readHistory({ project, codexHome, id: matches[0].id })).toString(),
      prefix + replacement,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('history CLI discovers only scoped Claude runner receipts and reads exact runs beside a matching Codex UUID', async () => {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), 'pstack-history-claude-')),
  );
  try {
    const project = join(scratch, 'project');
    const unrelated = join(scratch, 'unrelated');
    const codexHome = join(scratch, 'codex');
    const firstRoot = join(project, '.local', 'review-runs');
    const secondRoot = join(project, '.local', 'continuation-runs');
    await Promise.all([
      mkdir(project),
      mkdir(unrelated),
      mkdir(join(codexHome, 'sessions'), { recursive: true }),
    ]);
    await writeFile(
      join(codexHome, 'sessions', `rollout-${ids[0]}.jsonl`),
      lines(ids[0], project, 'native conversation'),
    );
    async function receipt(
      root: string,
      cwd: string,
      sessionId: string,
      startedAt: string,
      stdout: string,
    ) {
      await mkdir(root, { recursive: true });
      const paths = {
        requestPath: join(root, 'request.json'),
        resultPath: join(root, 'result.json'),
        promptPath: join(root, 'prompt.txt'),
        stdoutPath: join(root, 'stdout.jsonl'),
        stderrPath: join(root, 'stderr.log'),
      };
      const request = {
        executor: 'claude-code',
        cwd,
        model: 'claude-opus-5-5',
        reasoningEffort: 'xhigh',
        startedAt,
        resumeSessionId: null,
        context: [],
      };
      const result = {
        ...request,
        ...paths,
        sessionId,
        completedAt: startedAt,
        exitCode: 0,
        signal: null,
        result: 'completed review',
        resultEvent: { type: 'result', session_id: sessionId },
      };
      await Promise.all([
        writeFile(paths.requestPath, JSON.stringify(request)),
        writeFile(paths.resultPath, JSON.stringify(result)),
        writeFile(paths.promptPath, 'review assigned source'),
        writeFile(paths.stdoutPath, stdout),
        writeFile(paths.stderrPath, ''),
      ]);
      return result;
    }
    const original = await receipt(
      join(firstRoot, 'first'),
      project,
      ids[0],
      '2026-10-14T00:00:00Z',
      'failed attempt before corrected review\n',
    );
    const resumed = await receipt(
      join(secondRoot, 'resumed'),
      project,
      ids[0],
      '2026-10-15T00:00:00Z',
      'resumed review transcript\n',
    );
    await receipt(
      join(firstRoot, 'foreign'),
      unrelated,
      ids[2],
      '2026-10-15T00:00:00Z',
      'foreign private transcript\n',
    );
    await writeFile(join(firstRoot, '.env'), 'fictional environment sentinel');
    const script = new URL(
      '../plugin/skills/recall/scripts/codex-history.mjs',
      import.meta.url,
    ).pathname;
    const scope = [
      '--project',
      project,
      '--codex-home',
      codexHome,
      '--claude-runs',
      firstRoot,
      '--claude-runs',
      secondRoot,
    ];
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [script, ...args, ...scope], {
        encoding: 'utf8',
      });
    const inventory = run('list', '--source', 'claude-code')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      inventory.map((item) => item.path),
      [resumed.resultPath, original.resultPath],
    );
    assert.ok(
      inventory.every(
        (item) =>
          item.executor === 'claude-code' &&
          item.id === ids[0] &&
          item.cwd === project,
      ),
    );
    assert.equal(inventory[1].stdoutPath, original.stdoutPath);
    assert.equal(inventory[1].timestamp, '2026-10-14T00:00:00Z');
    const matches = run(
      'list',
      '--query',
      'failed attempt before corrected review',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].path, original.resultPath);
    assert.equal(run('list', '--query', 'foreign private transcript'), '');
    assert.equal(run('list', '--query', 'fictional environment sentinel'), '');
    assert.equal(
      run('read', '--source', 'claude-code', '--receipt', original.resultPath),
      await readFile(original.resultPath, 'utf8'),
    );
    assert.match(run('read', '--id', ids[0]), /native conversation/);
    await assert.rejects(
      readHistory({
        project,
        codexHome,
        claudeRuns: [firstRoot, secondRoot],
        source: 'claude-code',
        id: ids[0],
      }),
      /exact receipt/,
    );
    await assert.rejects(
      readHistory({
        project,
        claudeRuns: [firstRoot],
        source: 'claude-code',
        receipt: join(firstRoot, '.env'),
      }),
      /exact.*result\.json/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('installed worktree audit handles spaced paths and Codex history without changing checkout files', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pstack-worktree-audit-'));
  try {
    const project = join(scratch, 'repo with spaces');
    const worktree = join(scratch, 'topic with spaces');
    const codexHome = join(scratch, 'codex');
    const bin = join(scratch, 'bin');
    await Promise.all([
      mkdir(project),
      mkdir(bin),
      mkdir(join(codexHome, 'sessions'), { recursive: true }),
    ]);
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', [
      '-C',
      project,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'initial',
    ]);
    execFileSync('git', [
      '-C',
      project,
      'worktree',
      'add',
      '-qb',
      'topic',
      worktree,
    ]);
    for (const forge of ['origin', 'gh']) {
      const path = join(bin, forge);
      await writeFile(path, "#!/bin/sh\nprintf '[]\\n'\n");
      await chmod(path, 0o755);
    }
    await writeFile(
      join(codexHome, 'sessions', `rollout-${ids[0]}.jsonl`),
      lines(ids[0], worktree, 'tool ran here'),
    );
    const script = new URL(
      '../plugin/skills/poteto-mode/scripts/worktree-audit.sh',
      import.meta.url,
    ).pathname;
    const output = execFileSync(
      'bash',
      [script, '-b', 'HEAD', '--codex-home', codexHome, project],
      {
        cwd: scratch,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.match(output, /verify-recent-chat/);
    assert.ok(output.includes(worktree));
    assert.match(output, /\d{4}-\d{2}-\d{2}\tverify-recent-chat/);
    assert.equal(
      execFileSync('git', ['-C', project, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
      '',
    );
    assert.equal(
      execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
        encoding: 'utf8',
      }),
      '',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
