/* eslint-disable import-x/no-relative-parent-imports */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    RunEvidenceObjectStore,
    evidenceLogicalReceiptSchema,
    readEvidenceDocument,
    validateObjectReferenceGraph
} from '../../tools/test-matrix/content-addressed-evidence-store.mjs';
import {
    createEvidenceProducerReceipt
} from '../../tools/test-matrix/evidence-projection.mjs';
import { runDag } from '../../tools/test-matrix/scheduler.mjs';

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};

function tempDirectory(name)
{
    return fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-${name}-`));
}

function storeAt(root, runId = 'production-fresh')
{
    return new RunEvidenceObjectStore({
        root,
        runId,
        sourceState
    });
}

function objectFiles(root)
{
    return fs.readdirSync(path.join(root, 'objects')).sort();
}

function mutateJson(file, mutate)
{
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(value);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('large producer evidence is stored once and shared by semantic logical receipts', () =>
{
    const root = tempDirectory('evidence-deduplication');
    const store = storeAt(root);
    const document = {
        schema: 'fixture.producer.v1',
        sourceTable: Array.from({ length: 2_000 }, (_, index) => ({ id: index, status: 'Passed' })),
        artifactTable: Array.from({ length: 500 }, (_, index) => ({ id: `artifact-${index}`, digest: 'c'.repeat(64) }))
    };

    const first = store.publishLogicalReceipt({
        logicalOwner: 'release-admin-console',
        requiredIds: ['admin-navigation', 'admin-session'],
        decision: 'Passed',
        document
    });
    const second = store.publishLogicalReceipt({
        logicalOwner: 'release-auth-flow',
        requiredIds: ['auth-session'],
        decision: 'Passed',
        document
    });

    assert.equal(first.reusedObject, false);
    assert.equal(second.reusedObject, true);
    assert.equal(first.documentDigest, second.documentDigest);
    assert.equal(objectFiles(root).length, 1);
    assert.equal(store.readLogicalReceipt('release-admin-console').document.sourceTable.length, 2_000);
    assert.equal(store.readLogicalReceipt('release-auth-flow').document.artifactTable.length, 500);
    assert.equal(store.metrics().objectReuseCount, 1);
    assert.equal(store.metrics().rewriteCount, 0);
});

test('object reads fail closed for missing, tampered, symlinked, and cross-run references', () =>
{
    const root = tempDirectory('evidence-object-negative');
    const store = storeAt(root);
    const published = store.publishObject({ result: 'Passed' });
    const objectFile = store.objectFile(published.digest);

    fs.appendFileSync(objectFile, 'tampered');
    assert.throws(() => store.readObject(published.digest), /digest mismatch/u);

    fs.rmSync(objectFile);
    assert.throws(() => store.readObject(published.digest), /is missing/u);

    fs.symlinkSync('/dev/null', objectFile);
    assert.throws(() => store.readObject(published.digest), /regular file, not a symlink/u);

    assert.throws(() => store.publishObject({}, {
        references: [{
            name: 'foreign',
            runId: 'another-run',
            digest: `sha256:${'d'.repeat(64)}`
        }]
    }), /crosses run boundary/u);
});

test('logical receipt validation rejects content tampering, escaping identity, and wrong source binding', () =>
{
    const root = tempDirectory('evidence-receipt-negative');
    const store = storeAt(root);
    const published = store.publishLogicalReceipt({
        logicalOwner: 'release-domain',
        requiredIds: ['assertion-a'],
        decision: 'Passed',
        document: { result: 'Passed' }
    });
    mutateJson(published.file, (receipt) =>
    {
        receipt.decision = 'Failed';
    });
    assert.throws(() => store.readLogicalReceipt('release-domain'), /content digest mismatch/u);
    assert.throws(() => store.publishLogicalReceipt({
        logicalOwner: '../escape',
        requiredIds: [],
        decision: 'Passed',
        document: {}
    }), /semantic identifier/u);
    assert.throws(() => store.publishLogicalReceipt({
        logicalOwner: 'issue-1423-receipt',
        requiredIds: [],
        decision: 'Passed',
        document: {}
    }), /without an issue or PR number/u);

    const wrongSource = new RunEvidenceObjectStore({
        root,
        runId: 'production-fresh',
        sourceState: {
            ...sourceState,
            worktreeFingerprint: 'e'.repeat(64)
        }
    });
    assert.throws(() => wrongSource.readObject(published.documentDigest), /source binding mismatch/u);
});

test('reference graph detects cycles before recursive materialization', () =>
{
    const first = `sha256:${'1'.repeat(64)}`;
    const second = `sha256:${'2'.repeat(64)}`;
    const graph = new Map([
        [first, {
            references: [{ name: 'second', runId: 'production-fresh', digest: second }]
        }],
        [second, {
            references: [{ name: 'first', runId: 'production-fresh', digest: first }]
        }]
    ]);
    assert.throws(() => validateObjectReferenceGraph(
        [{ name: 'root', runId: 'production-fresh', digest: first }],
        (reference) => graph.get(reference.digest)
    ), /reference cycle/u);
});

test('concurrent immutable publishes converge on one verified object', async () =>
{
    const root = tempDirectory('evidence-concurrent-publish');
    const moduleUrl = pathToFileURL(path.resolve(
        import.meta.dirname,
        '../../tools/test-matrix/content-addressed-evidence-store.mjs'
    )).href;
    const program = `
        import { RunEvidenceObjectStore } from ${JSON.stringify(moduleUrl)};
        const store = new RunEvidenceObjectStore({
            root: process.argv[1],
            runId: 'production-fresh',
            sourceState: {
                commit: '${sourceState.commit}',
                worktreeFingerprint: '${sourceState.worktreeFingerprint}'
            }
        });
        store.publishObject({ rows: Array.from({ length: 10000 }, (_, index) => ({ index, value: 'same' })) });
    `;
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', program, root], {
        stdio: ['ignore', 'pipe', 'pipe']
    }));
    const results = await Promise.all(children.map((child) => new Promise((resolve) =>
    {
        let stderr = '';
        child.stderr.on('data', (chunk) =>
        {
            stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stderr }));
    })));
    assert.deepEqual(results.map((result) => result.code), [0, 0, 0, 0, 0, 0], results.map((result) => result.stderr).join('\n'));
    assert.equal(objectFiles(root).length, 1);
    const store = storeAt(root);
    const digest = `sha256:${objectFiles(root)[0]}`;
    assert.equal(store.readObject(digest).value.rows.length, 10_000);
    assert.equal(fs.readdirSync(path.join(root, 'objects')).some((name) => name.endsWith('.tmp')), false);
});

test('store construction and GC reject symlink traversal', () =>
{
    const parent = tempDirectory('evidence-symlink-root');
    const target = path.join(parent, 'target');
    const linked = path.join(parent, 'linked');
    fs.mkdirSync(target);
    fs.symlinkSync(target, linked);
    assert.throws(() => storeAt(linked), /root must be a real directory, not a symlink/u);
    assert.throws(() => storeAt(path.join(linked, 'nested')), /root must not traverse a symlink/u);

    const root = path.join(parent, 'safe');
    const store = storeAt(root);
    fs.rmSync(path.join(root, 'objects'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'objects'));
    assert.throws(() => storeAt(root), /objects directory must be a real directory, not a symlink/u);
    assert.equal(store.runId, 'production-fresh');
});

test('journal and compact checkpoint recover failure and cancellation without using wall clock validity', () =>
{
    const root = tempDirectory('evidence-recovery');
    const store = storeAt(root);
    const reduce = (state, _event, payload) => ({
        ...(state ?? { tiers: {} }),
        tiers: {
            ...(state?.tiers ?? {}),
            [payload.tier]: payload.result
        }
    });
    store.appendJournalEvent({
        eventType: 'tier-completed',
        tier: 'unit',
        step: 'execute',
        status: 'success',
        payload: { tier: 'unit', result: { status: 'success' } }
    });
    store.writeCompactCheckpoint({
        stage: 'correctness-boundary',
        state: {
            tiers: {
                unit: { status: 'success' }
            }
        },
        retention: { activeRun: true }
    });
    store.appendJournalEvent({
        eventType: 'tier-failed',
        tier: 'integration',
        step: 'execute',
        status: 'failure',
        payload: {
            tier: 'integration',
            result: {
                status: 'failure',
                reason: 'assertion mismatch'
            }
        }
    });
    store.appendJournalEvent({
        eventType: 'tier-cancelled',
        tier: 'browserless-summary',
        step: 'execute',
        status: 'cancelled',
        payload: {
            tier: 'browserless-summary',
            result: {
                status: 'cancelled',
                reason: 'cancelled after sibling failure'
            }
        }
    });

    const recovered = store.recover(reduce);
    assert.equal(recovered.checkpointSequence, 1);
    assert.equal(recovered.replayedEvents, 2);
    assert.equal(recovered.state.tiers.integration.status, 'failure');
    assert.equal(recovered.state.tiers.integration.reason, 'assertion mismatch');
    assert.equal(recovered.state.tiers['browserless-summary'].status, 'cancelled');
    assert.equal(store.metrics().recovery.journalEvents, 2);
    assert.equal(Object.hasOwn(store.readCompactCheckpoint().checkpoint, 'expiresAt'), false);
});

test('journal sequence gaps, truncated events, and checkpoint corruption fail closed', () =>
{
    const root = tempDirectory('evidence-recovery-negative');
    const store = storeAt(root);
    store.appendJournalEvent({
        eventType: 'tier-completed',
        tier: 'unit',
        status: 'success',
        payload: { status: 'success' }
    });
    store.writeCompactCheckpoint({
        stage: 'correctness-boundary',
        state: { status: 'running' }
    });
    const journal = path.join(root, 'journals/production-fresh.jsonl');
    mutateJsonLine(journal, (event) =>
    {
        event.sequence = 3;
    });
    assert.throws(() => store.readJournal(), /sequence gap/u);

    const secondRoot = tempDirectory('evidence-truncated-journal');
    const second = storeAt(secondRoot);
    second.appendJournalEvent({
        eventType: 'run-started',
        status: 'running',
        payload: {}
    });
    fs.appendFileSync(path.join(secondRoot, 'journals/production-fresh.jsonl'), '{');
    assert.throws(() => second.readJournal(), /truncated final record/u);

    const checkpoint = path.join(root, 'checkpoints/production-fresh.json');
    mutateJson(checkpoint, (value) =>
    {
        value.lastSequence = 99;
    });
    assert.throws(() => store.readCompactCheckpoint(), /content digest mismatch/u);
});

function mutateJsonLine(file, mutate)
{
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    const value = JSON.parse(lines[0]);
    mutate(value);
    lines[0] = JSON.stringify(value);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

test('GC preserves receipt, active-run, and release-bound objects while collecting only stale unreferenced objects', () =>
{
    const root = tempDirectory('evidence-gc');
    const store = storeAt(root);
    const receipt = store.publishLogicalReceipt({
        logicalOwner: 'release-final',
        requiredIds: ['release-final'],
        decision: 'Passed',
        document: { evidence: 'release' },
        retention: { releaseBinding: true }
    });
    const activePayload = store.publishObject({ evidence: 'active' });
    const releaseOnly = store.publishObject({ evidence: 'release-binding-only' });
    store.appendJournalEvent({
        eventType: 'run-started',
        status: 'running',
        payload: { evidence: 'active' }
    });
    const stale = store.publishObject({ evidence: 'stale' });

    const result = store.garbageCollect({
        activeRunIds: ['production-fresh'],
        releaseBindings: [receipt.receipt.contentDigest, releaseOnly.digest]
    });
    assert.equal(result.protected.includes(receipt.documentDigest), true);
    assert.equal(result.protected.includes(activePayload.digest), true);
    assert.equal(result.protected.includes(releaseOnly.digest), true);
    assert.equal(result.deleted.includes(stale.digest), true);
    assert.equal(store.readLogicalReceipt('release-final').document.evidence, 'release');
    assert.equal(store.readJournal().length, 1);
});

test('transparent document reader materializes object-backed receipts for existing validators', () =>
{
    const root = tempDirectory('evidence-transparent-reader');
    const store = storeAt(root);
    const published = store.publishLogicalReceipt({
        logicalOwner: 'canonical-producer',
        requiredIds: ['test-a'],
        decision: 'Passed',
        document: {
            schema: 'fsusblog.evidence-producer-receipt.v1',
            status: 'success',
            assertions: [{ id: 'test-a', outcome: 'Passed' }]
        }
    });
    const envelope = JSON.parse(fs.readFileSync(published.file, 'utf8'));
    assert.equal(envelope.schema, evidenceLogicalReceiptSchema);
    assert.deepEqual(readEvidenceDocument(published.file), {
        schema: 'fsusblog.evidence-producer-receipt.v1',
        status: 'success',
        assertions: [{ id: 'test-a', outcome: 'Passed' }]
    });
});

test('projection CLI transparently validates an object-backed producer receipt', () =>
{
    const fixture = tempDirectory('evidence-projection-cli');
    const storeRoot = path.join(fixture, 'store');
    const store = storeAt(storeRoot);
    const artifact = path.join(fixture, 'result.json');
    fs.writeFileSync(artifact, '{"status":"Passed"}\n');
    const artifactDigest = `sha256:${cryptoDigest(fs.readFileSync(artifact))}`;
    const producer = createEvidenceProducerReceipt({
        producerId: 'canonical-owner',
        sourceState,
        runId: 'production-fresh',
        namespace: 'default',
        assertions: [{
            id: 'test-a',
            outcome: 'Passed',
            sourceTestIds: ['source-a'],
            coverageIds: ['coverage-a'],
            artifactIds: ['artifact-a']
        }],
        artifacts: [{
            id: 'artifact-a',
            path: 'result.json',
            digest: artifactDigest
        }],
        generatedAt: '2026-07-24T00:00:00.000Z'
    });
    const logical = store.publishLogicalReceipt({
        logicalOwner: 'canonical-owner',
        requiredIds: ['test-a'],
        decision: 'Passed',
        document: producer
    });
    const catalog = path.join(fixture, 'catalog.json');
    const output = path.join(fixture, 'projection.json');
    fs.writeFileSync(catalog, `${JSON.stringify({
        schema: 'fsusblog.evidence-projection-catalog.v1',
        tierId: 'release-domain',
        executionOwner: 'canonical-owner',
        projectFrom: 'canonical-owner',
        requiredTestIds: ['test-a'],
        requiredCoverageIds: ['coverage-a'],
        requiredArtifactDeclarations: [{
            id: 'artifact-a',
            path: 'result.json'
        }]
    }, null, 2)}\n`);
    const command = spawnSync(process.execPath, [
        path.resolve(import.meta.dirname, '../../tools/test/project-evidence.mjs'),
        '--catalog', catalog,
        '--producer', logical.file,
        '--output', output,
        '--root', fixture,
        '--commit', sourceState.commit,
        '--worktree-fingerprint', sourceState.worktreeFingerprint,
        '--run-id', 'production-fresh',
        '--namespace', 'default'
    ], { encoding: 'utf8' });

    assert.equal(command.status, 0, command.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).status, 'success');
});

function cryptoDigest(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

test('scheduler persists incremental journal events and only two compact stage checkpoints', async () =>
{
    const root = tempDirectory('scheduler-evidence-store');
    const runsRoot = path.join(root, 'runs');
    const tiers = ['first', 'second', 'summary'].map((id, index) => ({
        id,
        command: `${process.execPath} -e ""`,
        dependsOn: index === 0 ? [] : [tiersId(index - 1)],
        services: [],
        parallelizable: true,
        exclusiveResources: [],
        phase: index,
        resourceClass: 'cpu',
        maxParallel: 1,
        cpuUnits: 1,
        memoryGiB: 0.1,
        cacheInputs: [],
        requiresPlaywright: 'none',
        artifacts: [],
        evidence: []
    }));
    const result = await runDag({
        tiers,
        root,
        runsRoot,
        runId: 'production-fresh',
        targetTierId: 'summary',
        maxParallel: 1,
        systemResources: { cpuCount: 2, availableMemoryGiB: 2, load1: 0 },
        snapshotWorktree: async () => ({ fingerprint: sourceState.worktreeFingerprint, entries: {} }),
        executeTier: async () => ({ code: 0, signal: null })
    });
    const runRoot = path.join(runsRoot, 'production-fresh');
    const metrics = JSON.parse(fs.readFileSync(path.join(runRoot, 'evidence-storage-metrics.json'), 'utf8'));
    const journal = fs.readFileSync(
        path.join(runRoot, 'evidence-store/journals/production-fresh.jsonl'),
        'utf8'
    ).trimEnd().split('\n').map((line) => JSON.parse(line));

    assert.equal(result.status, 'success');
    assert.equal(metrics.compactCheckpointCount, 2);
    assert.equal(metrics.schedulerCompatibilityCheckpointWrites, 2);
    assert.equal(journal.filter((event) => event.eventType === 'tier-completed').length, 3);
    assert.equal(journal.at(0).eventType, 'run-started');
    assert.equal(journal.at(-1).eventType, 'run-completed');
    assert.equal(journal.filter((event) => event.eventType === 'tier-admitted').length, 3);
    assert.deepEqual(journal.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
});

function tiersId(index)
{
    return ['first', 'second', 'summary'][index];
}

test('optimization metrics report bytes, rewrites, serialization CPU, and recovery cost without affecting correctness', () =>
{
    const root = tempDirectory('evidence-metrics');
    const store = storeAt(root);
    store.publishObject({ rows: Array.from({ length: 100 }, (_, index) => index) });
    store.publishObject({ rows: Array.from({ length: 100 }, (_, index) => index) });
    store.appendJournalEvent({
        eventType: 'run-started',
        status: 'running',
        payload: { status: 'running' }
    });
    store.recover((state, _event, payload) => ({ ...state, ...payload }));
    const metrics = store.metrics();

    assert.equal(metrics.evidenceClass, 'optimization');
    assert.equal(metrics.affectsCorrectness, false);
    assert.ok(metrics.jsonBytesWritten > 0);
    assert.equal(metrics.rewriteCount, 0);
    assert.equal(metrics.objectReuseCount, 1);
    assert.ok(metrics.serializationCpuNanoseconds >= 0);
    assert.ok(metrics.recovery.cpuNanoseconds >= 0);
    assert.equal(metrics.recovery.journalEvents, 1);
});
