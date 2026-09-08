import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    happyBundle,
    join,
    RUN_ID
} from './support/behavior-evidence-pre-runtime-fixture.mjs';

import {
    digestValue,
    resolveWorktreeFingerprint
} from '../../tools/fact-extractors/identity.mjs';
import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs';
import {
    publishBehaviorEvidenceReadyAuthority,
    readBehaviorEvidenceReadyAuthority
} from '../../tools/test-runtime/behavior-evidence-ready-authority.mjs';
import {
    productionFileArtifactEvidence,
    publishBackendBuildReadyAuthority,
    publishFrontendBuildReadyAuthority
} from '../../tools/test-runtime/production-build-ready-authority.mjs';

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: `sha256:${'b'.repeat(64)}`
};
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

test('BehaviorDoc and replay producers share the canonical clean-worktree fingerprint', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-source-identity-'));
    try
    {
        const commands = [
            ['init', '--quiet'],
            ['config', 'user.name', 'FsusBlog Test'],
            ['config', 'user.email', 'test@example.invalid']
        ];
        for (const args of commands)
        {
            assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
        }
        fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked\n');
        assert.equal(spawnSync('git', ['add', 'tracked.txt'], { cwd: root }).status, 0);
        assert.equal(spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root }).status, 0);
        assert.equal(resolveWorktreeFingerprint(root), digestCanonical({ diff: '', untracked: [] }).slice('sha256:'.length));
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-run-authority-'));
    const runId = 'authority-test';
    const runRoot = path.join(root, '.tmp', 'build', runId);
    const manifestFile = path.join(runRoot, 'layout.json');
    const serverDll = path.join(runRoot, 'dotnet', 'server', 'FsusBlog.Server.dll');
    fs.mkdirSync(path.dirname(serverDll), { recursive: true });
    fs.writeFileSync(serverDll, 'server-binary');
    fs.writeFileSync(manifestFile, `${JSON.stringify({
        schema: 'fsusblog.production-build-layout.v2',
        status: 'success',
        runId,
        sourceState,
        paths: { runRoot: `.tmp/build/${runId}` },
        projects: {}
    })}\n`);
    return {
        root,
        layout: {
            runId,
            runRoot,
            manifestFile,
            artifacts: { serverDll },
            generatedRoot: path.join(runRoot, 'generated')
        },
        serverDll
    };
}

test('backend build authority binds the exact current layout and artifact identity', () =>
{
    const value = fixture();
    try
    {
        const published = publishBackendBuildReadyAuthority({
            root: value.root,
            layout: value.layout,
            sourceState
        });
        const marker = JSON.parse(fs.readFileSync(published.file, 'utf8'));
        assert.equal(marker.status, 'success');
        assert.equal(marker.schedulerRunId, value.layout.runId);
        assert.equal(marker.buildLayout.sourceCommit, sourceState.commit);
        assert.equal(marker.serverDll.path, path.relative(value.root, value.serverDll).replaceAll(path.sep, '/'));
        assert.match(marker.serverDll.digest, /^sha256:[a-f0-9]{64}$/u);
        assert.match(marker.serverDll.artifactRef, /^artifact:[a-f0-9]{64}$/u);
    }
    finally
    {
        fs.rmSync(value.root, { recursive: true, force: true });
    }
});

test('artifact evidence rejects paths outside the repository and symlinks', () =>
{
    const value = fixture();
    try
    {
        assert.throws(
            () => productionFileArtifactEvidence(value.root, path.join(os.tmpdir(), 'outside.dll')),
            /escapes repository/u
        );
        const link = path.join(value.layout.runRoot, 'server-link.dll');
        fs.symlinkSync(value.serverDll, link);
        assert.throws(
            () => productionFileArtifactEvidence(value.root, link),
            /regular file/u
        );
    }
    finally
    {
        fs.rmSync(value.root, { recursive: true, force: true });
    }
});

test('frontend authority rejects a stage receipt from another source', () =>
{
    const value = fixture();
    try
    {
        const stageReceiptFile = path.join(value.layout.generatedRoot, 'frontend-build-stages.json');
        fs.mkdirSync(path.dirname(stageReceiptFile), { recursive: true });
        fs.writeFileSync(stageReceiptFile, `${JSON.stringify({
            schema: 'fsusblog.frontend-build-stage-receipt.v1',
            status: 'success',
            schedulerRunId: value.layout.runId,
            sourceState: { ...sourceState, commit: 'c'.repeat(40) }
        })}\n`);
        assert.throws(() => publishFrontendBuildReadyAuthority({
            root: value.root,
            layout: value.layout,
            sourceState,
            expectedStages: [{ id: 'vite-build', command: [], ownedOutputs: [] }],
            criticalOutputPaths: [],
            stageReceiptFile
        }), /source identity mismatch/u);
    }
    finally
    {
        fs.rmSync(value.root, { recursive: true, force: true });
    }
});

function behaviorEvidenceReceipt({ runId, registryDigest, source = sourceState })
{
    const receipt = join(happyBundle());
    // Reseal identity mutations so negative cases reach the authority checks.
    receipt.runIdentity = runId;
    receipt.sourceIdentity = {
        commit: source.commit,
        worktreeFingerprint: source.worktreeFingerprint
    };
    receipt.registryDigest = registryDigest;
    receipt.contentDigest = `sha256:${digestValue(
        Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'contentDigest'))
    )}`;
    return receipt;
}

test('behavior readiness authority requires a qualified exact-run source-bound receipt', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-behavior-ready-'));
    try
    {
        const runId = RUN_ID;
        const registry = happyBundle().factExtractorRegistry;
        const registryFile = path.join(root, 'config', 'contracts', 'behavior-fact-extractors.json');
        fs.mkdirSync(path.dirname(registryFile), { recursive: true });
        fs.writeFileSync(registryFile, `${JSON.stringify(registry)}\n`);
        const registryDigest = `sha256:${digestValue(registry)}`;
        const receiptFile = path.join(root, '.tmp', 'behavior-evidence-pre-runtime', 'receipt.json');
        fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
        fs.writeFileSync(receiptFile, `${JSON.stringify(behaviorEvidenceReceipt({ runId, registryDigest }))}\n`);
        const published = publishBehaviorEvidenceReadyAuthority({
            root,
            receiptFile,
            runId,
            sourceState
        });
        assert.equal(published.receipt.status, 'ok');
        assert.equal(readBehaviorEvidenceReadyAuthority({
            root,
            receiptFile,
            markerFile: published.markerFile,
            runId,
            sourceState
        }).marker.digest, published.marker.digest);

        fs.writeFileSync(receiptFile, `${JSON.stringify(behaviorEvidenceReceipt({
            runId: 'cross-run', registryDigest
        }))}\n`);
        assert.throws(() => readBehaviorEvidenceReadyAuthority({
            root,
            receiptFile,
            markerFile: published.markerFile,
            runId,
            sourceState
        }), /another run/u);

        fs.writeFileSync(receiptFile, `${JSON.stringify(behaviorEvidenceReceipt({
            runId,
            registryDigest: `sha256:${'c'.repeat(64)}`
        }))}\n`);
        assert.throws(() => publishBehaviorEvidenceReadyAuthority({
            root,
            receiptFile,
            runId,
            sourceState
        }), /registryDigest does not match/u);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('current-run authority producer rejects path-like run and attempt identities before build work', () =>
{
    for (const args of [
        ['--run-id', '../escape', '--attempt-id', 'attempt-1'],
        ['--run-id', 'run-1', '--attempt-id', '../escape']
    ])
    {
        const result = spawnSync(process.execPath, [
            'tools/test-runtime/produce-current-run-authorities.mjs',
            ...args
        ], {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
            },
            encoding: 'utf8'
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /must be a safe path segment/u);
        assert.doesNotMatch(result.stdout, /Determining projects to restore|build receipt=/u);
    }
});

test('current-run authority producer preserves an existing attempt output', () =>
{
    const runId = `authority-output-${process.pid}`;
    const outputRoot = path.join(
        repositoryRoot,
        '.tmp',
        'runtime-order-authorities',
        runId,
        'attempt-1'
    );
    const sentinel = path.join(outputRoot, 'first-failure.json');
    try
    {
        fs.mkdirSync(outputRoot, { recursive: true });
        fs.writeFileSync(sentinel, 'retained\n');
        const result = spawnSync(process.execPath, [
            'tools/test-runtime/produce-current-run-authorities.mjs',
            '--run-id', runId,
            '--attempt-id', 'attempt-1'
        ], {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
                FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
            },
            encoding: 'utf8'
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /authority output already exists/u);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'retained\n');
        assert.doesNotMatch(result.stdout, /Determining projects to restore|build receipt=/u);
    }
    finally
    {
        fs.rmSync(path.join(repositoryRoot, '.tmp', 'runtime-order-authorities', runId), {
            recursive: true,
            force: true
        });
    }
});
