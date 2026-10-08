import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createProductionBuildReceipt } = await import(new URL('../../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const { snapshotGitWorktree } = await import(new URL('../../../tools/test-matrix/scheduler.mjs', import.meta.url));

export async function mutationAttemptFixture(t)
{
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-mutation-root-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const repositoryRoot = path.join(parent, 'source');
    fs.mkdirSync(repositoryRoot);
    fs.writeFileSync(path.join(repositoryRoot, 'input.txt'), 'current source input\n');
    fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), '.tmp/\n');
    const git = (...args) =>
    {
        const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    const sourceState = { commit: git('rev-parse', 'HEAD'),
        worktreeFingerprint: (await snapshotGitWorktree(repositoryRoot)).fingerprint };
    const artifactRoot = path.join(parent, 'immutable-build-fixture');
    fs.mkdirSync(path.join(artifactRoot, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'backend', 'fixture.dll'), 'controlled fixture, not a runtime receipt');
    const receipt = createProductionBuildReceipt({
        root: repositoryRoot, artifactRoot, sourceState,
        producer: { workflow: 'controlled-fixture', runId: 'run-1951', runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: { node: 'fixture', npm: 'fixture', dotnet: 'fixture', vite: 'fixture',
            vitest: 'fixture', playwright: 'fixture', emsdk: 'fixture' },
        inputPaths: ['input.txt'], domains: [{ name: 'backend-runtime', path: 'backend' }]
    });
    const options = {
        repositoryRoot, outputRoot: path.join(parent, 'owned'),
        runId: 'run-1951', invocationId: 'invocation-1', attemptId: 'attempt-1', sourceState,
        buildReceiptPath: path.join(artifactRoot, 'receipt.json'), buildReceiptDigest: receipt.contentDigest
    };
    return { parent, options, artifactRoot };
}
