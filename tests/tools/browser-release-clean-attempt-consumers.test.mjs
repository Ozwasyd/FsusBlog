import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
import {
    admitBrowserReleaseCleanAttempt,
    readCleanAttemptConsumerInventory,
    requireCleanAttemptConsumerAdmission
} from '../../tools/release/browser-release-clean-attempt-consumers.mjs';
import { createBrowserlessCorrectnessReceipt } from '../../tools/release/test-evidence-receipts.mjs';
import {
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication
} from '../../tools/test/current-run-evidence-publication.mjs';
import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';
import {
    extractCurrentRunEvidenceTransport,
    packCurrentRunEvidenceTransport
} from '../../tools/test/current-run-evidence-transport.mjs';
import { runProducerAttempts } from '../../tools/test/attempt-runner.mjs';
import { sha256 } from '../../tools/test/attempt-provenance.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtureCommand = path.join(root, 'tests/tools/fixtures/attempt-runner-command.mjs');
const sourceCommit = '1'.repeat(40);
const worktreeFingerprint = `sha256:${'2'.repeat(64)}`;
const authorityReferences = [
    ['execution-envelope', '3'],
    ['replay-plan', '4'],
    ['temporal-context', '5']
].map(([kind, digit]) => ({
    kind,
    artifactPath: `${kind}.json`,
    artifactDigest: `sha256:${digit.repeat(64)}`,
    verificationReceiptPath: `${kind}.verification.json`,
    verificationReceiptDigest: `sha256:${digit.repeat(64)}`
}));

function verifyAuthority(producerId, schedulerRunId)
{
    return (reference) => ({
        verified: true,
        authorityDigest: reference.artifactDigest,
        verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    });
}

async function evidence(directory, {
    producerId = 'shared-correctness',
    schedulerRunId = 'shared-clean-run',
    scenario = 'success',
    retryPolicyId = 'correctness-first-attempt'
} = {})
{
    directory = fs.realpathSync(directory);
    const result = await runProducerAttempts({
        evidenceRoot: directory,
        producerId,
        retryPolicyId,
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, fixtureCommand, scenario],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences,
        verifyAuthority: verifyAuthority(producerId, schedulerRunId),
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    return {
        evidenceRoot: directory,
        aggregateReference: {
            path: path.relative(directory, path.join(result.producerRoot, 'aggregate.json')),
            digest: result.aggregate.contentDigest,
            fileDigest: sha256(fs.readFileSync(path.join(result.producerRoot, 'aggregate.json')))
        },
        domainReceiptReference: {
            path: 'payload.json',
            digest: result.attempts[0].artifactDigests['payload.json']
        },
        aggregateReceipt: result.aggregate,
        loadAttempt: (reference) => result.attempts[reference.attemptNumber - 1],
        verifyAuthority: verifyAuthority(producerId, schedulerRunId),
        verifyArtifact: (relative, digest, receipt) => {
            const file = path.join(result.producerRoot, `attempt-${receipt.attemptNumber}`, relative);
            return fs.existsSync(file) && sha256(fs.readFileSync(file)) === digest;
        },
        expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    };
}

function walkFiles(directory)
{
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)))
    {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            files.push(...walkFiles(file));
        }
        else if (entry.isFile() && !entry.isSymbolicLink())
        {
            files.push(file);
        }
    }
    return files;
}

async function transportedEvidence(directory)
{
    directory = fs.realpathSync(directory);
    const producerId = 'transported-correctness';
    const schedulerRunId = 'transported-clean-run';
    const attemptId = 'transported-clean-attempt';
    const outputPath = 'artifacts/current-run/attempt-reference.json';
    const aggregatePath = `${schedulerRunId}/${producerId}/aggregate.json`;
    fs.mkdirSync(path.join(directory, 'artifacts/current-run'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(directory, aggregatePath)), { recursive: true });
    const digest = (digit) => `sha256:${digit.repeat(64)}`;
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId,
        attemptId,
        sourceCommit,
        worktreeFingerprint,
        candidateIdentity: { id: 'transported-candidate', digest: digest('6') },
        buildIdentity: { id: 'transported-build', digest: digest('7') },
        ownedRoots: ['artifacts/current-run', schedulerRunId]
    };
    const context = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const authority = verifyAuthority(producerId, schedulerRunId);
    const session = beginCurrentRunEvidencePublication({
        authorityId: 'attempt-evidence.current-run',
        context,
        outputPath,
        payloadPath: aggregatePath,
        producerId,
        repositoryRoot: directory
    });
    fs.rmSync(path.join(directory, schedulerRunId, producerId), { recursive: true, force: true });
    const result = await runProducerAttempts({
        evidenceRoot: directory,
        producerId,
        retryPolicyId: 'correctness-first-attempt',
        sourceCommit,
        worktreeFingerprint,
        schedulerRunId,
        command: [process.execPath, fixtureCommand, 'success'],
        cwd: root,
        env: { PATH: process.env.PATH },
        authorityReferences,
        verifyAuthority: authority,
        expectedTestIds: ['fixture:attempt-runner'],
        timeoutMs: 5_000
    });
    const published = finalizeCurrentRunEvidencePublication({
        authorityId: 'attempt-evidence.current-run',
        context,
        outputPath,
        payloadPath: aggregatePath,
        payloadSchema: 'fsusblog.test-attempt-aggregate-receipt.v1',
        producerId,
        repositoryRoot: directory,
        sessionId: session.sessionId,
        terminalStatus: 'success'
    });
    const producerRoot = path.join(directory, schedulerRunId, producerId);
    const files = [
        outputPath,
        ...walkFiles(producerRoot).map((file) => path.relative(directory, file).replaceAll(path.sep, '/'))
    ];
    const manifestPath = 'artifacts/current-run/attempt-transport-manifest.json';
    packCurrentRunEvidenceTransport({
        context,
        repositoryRoot: directory,
        archivePath: 'artifacts/current-run/attempt-transport-archive.json',
        manifestPath,
        transportRunId: 'attempt-transport-run',
        downloadRunId: 'attempt-download-run',
        objects: [{
            authorityId: 'attempt-evidence.current-run',
            producerId,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
            originalRef: {
                path: outputPath,
                contentDigest: published.receipt.contentDigest,
                producerReceiptDigest: published.receipt.producerReceiptDigest
            },
            files: files.map((file) => ({ path: file }))
        }]
    });
    fs.rmSync(path.join(directory, outputPath));
    fs.rmSync(path.join(directory, schedulerRunId), { recursive: true, force: true });
    extractCurrentRunEvidenceTransport({
        repositoryRoot: directory,
        manifestPath,
        extractRoot: 'downloaded-attempt-evidence'
    });
    const base = {
        evidenceRoot: directory,
        aggregateReference: null,
        domainReceiptReference: {
            path: 'payload.json',
            digest: result.attempts[0].artifactDigests['payload.json']
        },
        expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId },
        verifyAuthority: authority,
        transport: {
            repositoryRoot: directory,
            transportManifestPath: manifestPath,
            authorityId: 'attempt-evidence.current-run'
        }
    };
    return { ...base, transportRoot: path.join(directory, 'downloaded-attempt-evidence'), producerRoot };
}

const memberships = Object.freeze({
    'browser-contract': {
        browsers: ['chromium'],
        projects: ['public'],
        semanticArtifactIds: ['browser-contract-receipt', 'trace'],
        testIds: ['browser:public-reading']
    },
    'production-correctness': {
        selectedTierIds: ['backend-api-integration', 'frontend-tests'],
        testVectors: ['anonymous', 'binary', 'logged-in']
    },
    'release-reliability': {
        lifecyclePhases: ['measurement', 'postcondition', 'precondition', 'reset'],
        scenarioIds: [
            'release-data-scale-m',
            'release-load-burst',
            'release-load-peak',
            'release-memory-leak-budget',
            'release-mutation-critical-slice',
            'release-open-handle-budget',
            'release-soak-min'
        ]
    }
});

function admit(consumerId, attemptEvidence, membership = memberships[consumerId])
{
    return admitBrowserReleaseCleanAttempt({
        consumerId,
        attemptEvidence,
        membership,
        expected: memberships[consumerId]
    });
}

test('inventory covers the exact Browser, Reliability and Production consumers', () =>
{
    const inventory = readCleanAttemptConsumerInventory();
    assert.deepEqual(inventory.consumers.map((entry) => entry.id).sort(), [
        'browser-contract',
        'production-correctness',
        'release-reliability'
    ]);
    assert.equal(inventory.migrationState, 'migrated');
    assert.equal(inventory.qualificationEligible, true);
});

test('all three consumers admit the same clean attempt through one verifier', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-clean-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const consumerId of Object.keys(memberships))
    {
        const verdict = admit(consumerId, clean);
        assert.equal(verdict.eligible, true, consumerId);
        assert.equal(verdict.attemptVerdict.eligible, true, consumerId);
        assert.deepEqual(verdict.reasons, []);
    }
});

test('recovered diagnostic verdict and canonical reason are identical across consumers', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-recovered-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recovered = await evidence(directory, {
        producerId: 'browser-diagnostics',
        schedulerRunId: 'diagnostic-run',
        scenario: 'browser-crash-once',
        retryPolicyId: 'diagnostic-browser-process-crash'
    });
    const results = Object.keys(memberships).map((consumerId) => admit(consumerId, recovered));
    assert.ok(results.every((result) => result.eligible === false));
    assert.ok(results.every((result) => result.reasons === result.attemptVerdict.reasons));
    assert.deepEqual(
        results.map((result) => result.reasons),
        [results[0].reasons, results[0].reasons, results[0].reasons]
    );
    assert.equal(results[0].reasons[0].code, 'attempt.not-clean-first');
});

test('missing attempt provenance, cross-run authority and tampered artifacts fail closed', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-invalid-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    const invalid = [
        { ...clean, aggregateReference: null, aggregateReceipt: { status: 'ok', exitCode: 0 } },
        { ...clean, expectedIdentity: { ...clean.expectedIdentity, schedulerRunId: 'other-run' } },
        { ...clean, aggregateReference: { ...clean.aggregateReference, fileDigest: `sha256:${'0'.repeat(64)}` } }
    ];
    for (const attemptEvidence of invalid)
    {
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, attemptEvidence));
        assert.ok(results.every((result) => result.eligible === false));
        assert.deepEqual(
            results.map((result) => result.reasons),
            [results[0].reasons, results[0].reasons, results[0].reasons]
        );
    }
});

test('file tamper cannot be hidden by caller supplied receipt and artifact callbacks', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-consumer-file-tamper-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    const aggregateFile = path.join(clean.evidenceRoot, clean.aggregateReference.path);
    fs.chmodSync(aggregateFile, 0o600);
    fs.appendFileSync(aggregateFile, ' ');
    const results = Object.keys(memberships).map((consumerId) => admit(consumerId, {
        ...clean,
        verifyArtifact: () => true
    }));
    assert.ok(results.every((result) => result.eligible === false));
    assert.equal(results[0].reasons[0].code, 'attempt.content-tamper');
    for (const result of results) assert.deepEqual(result.reasons, results[0].reasons);
});

test('a clean attempt cannot qualify an unrelated or unbound domain receipt', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-consumer-domain-binding-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const domainReceiptReference of [
        null,
        { path: 'unrelated-receipt.json', digest: clean.domainReceiptReference.digest },
        { path: 'payload.json', digest: `sha256:${'8'.repeat(64)}` },
        { path: './payload.json', digest: clean.domainReceiptReference.digest }
    ])
    {
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, {
            ...clean, domainReceiptReference
        }));
        assert.ok(results.every((result) => result.eligible === false));
        assert.equal(results[0].reasons[0].code, 'attempt.consumer-artifact-mismatch');
        for (const result of results) assert.deepEqual(result.reasons, results[0].reasons);
    }
});

test('consumer identity expectations must bind source, worktree, run and producer', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-consumer-expected-identity-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId'])
    {
        const expectedIdentity = { ...clean.expectedIdentity };
        delete expectedIdentity[field];
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, {
            ...clean, expectedIdentity
        }));
        assert.ok(results.every((result) => result.eligible === false));
        assert.equal(results[0].reasons[0].code, 'attempt.consumer-identity-missing');
        assert.equal(results[0].reasons[0].field, field);
        for (const result of results) assert.deepEqual(result.reasons, results[0].reasons);
    }
});

test('domain membership remains exact and cannot be replaced by group status', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-membership-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const consumerId of Object.keys(memberships))
    {
        const fields = Object.keys(memberships[consumerId]);
        const missing = structuredClone(memberships[consumerId]);
        missing[fields[0]] = missing[fields[0]].slice(1);
        assert.equal(admit(consumerId, clean, missing).eligible, false);
        assert.equal(admitBrowserReleaseCleanAttempt({
            consumerId,
            attemptEvidence: clean,
            membership: { status: 'ok' },
            expected: memberships[consumerId]
        }).eligible, false);
    }
});

test('inventory entrypoints call the shared consumer admission helper', () =>
{
    const inventory = readCleanAttemptConsumerInventory();
    for (const consumer of inventory.consumers)
    {
        for (const entrypoint of consumer.entrypoints)
        {
            const source = fs.readFileSync(path.join(root, entrypoint), 'utf8');
            assert.match(source, /requireCleanAttemptConsumerAdmission\s*\(/u, entrypoint);
        }
    }
});

test('product failure and recovered restore are rejected identically across consumers', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-failed-consumers-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const [producerId, retryPolicyId, scenario] of [
        ['shared-correctness', 'correctness-first-attempt', 'product-failure'],
        ['dependency-restore', 'dependency-transfer-observed-recovery', 'restore-timeout-once']
    ])
    {
        const failed = await evidence(directory, { producerId, retryPolicyId, scenario, schedulerRunId: `${producerId}-run` });
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, failed));
        assert.ok(results.every((result) => result.eligible === false), producerId);
        assert.equal(results[0].reasons[0].code, 'attempt.not-clean-first', producerId);
        assert.deepEqual(
            results.map((result) => result.reasons),
            [results[0].reasons, results[0].reasons, results[0].reasons]
        );
    }
});

test('browserless correctness consumer rejects recovered evidence and admits a clean attempt', async (context) =>
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-correctness-consumer-')));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const repositoryRoot = path.join(directory, 'repo');
    const artifactRoot = path.join(directory, 'build');
    fs.mkdirSync(path.join(repositoryRoot, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(artifactRoot, 'frontend-dist'), { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, 'inputs', 'lock.json'), '{}\n');
    fs.writeFileSync(path.join(artifactRoot, 'frontend-dist', 'index.html'), '<!doctype html>\n');
    const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
    const buildReceipt = createProductionBuildReceipt({
        root: repositoryRoot,
        artifactRoot,
        sourceState,
        producer: { workflow: 'fixture', runId: '2648', runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: {
            node: 'v24.0.0', npm: '11.0.0', dotnet: '10.0.100', vite: '7.0.0',
            vitest: '3.0.0', playwright: '1.55.0', emsdk: '4.0.0'
        },
        inputPaths: ['inputs'],
        domains: [{ name: 'frontend-dist', path: 'frontend-dist' }],
        now: () => new Date('2026-07-18T00:00:00.000Z')
    });
    const receiptOptions = {
        matrix: {
            tiers: [
                { id: 'unit', dependsOn: [], requiresPlaywright: 'none' },
                { id: 'production-correctness', dependsOn: ['unit'], requiresPlaywright: 'none' }
            ]
        },
        buildReceipt,
        buildReceiptPath: 'build/receipt.json',
        jobSummaries: [{
            schema: 'fsusblog.ci.job-result.v1',
            jobId: 'fast-unit',
            status: 'success',
            evidenceClass: 'correctness',
            affectsCorrectness: true,
            commit: sourceState.commit,
            tierIds: ['unit', 'production-correctness'],
            testIds: ['node:unit.test.mjs#works'],
            schedulerRunId: 'run-2648'
        }],
        authority: { kind: 'scheduler-checkpoint', status: 'success', runId: 'run-2648', authoritative: true },
        now: () => new Date('2026-07-18T00:01:00.000Z')
    };
    const clean = await evidence(directory, { schedulerRunId: 'correctness-clean-run' });
    const admitted = createBrowserlessCorrectnessReceipt({
        ...receiptOptions,
        attemptEvidence: {
            ...clean,
            membership: memberships['production-correctness'],
            expected: memberships['production-correctness']
        }
    });
    assert.equal(admitted.status, 'success');
    const recovered = await evidence(directory, {
        producerId: 'browser-diagnostics',
        schedulerRunId: 'correctness-recovered-run',
        scenario: 'browser-crash-once',
        retryPolicyId: 'diagnostic-browser-process-crash'
    });
    assert.throws(
        () => createBrowserlessCorrectnessReceipt({
            ...receiptOptions,
            attemptEvidence: {
                ...recovered,
                membership: memberships['production-correctness'],
                expected: memberships['production-correctness']
            }
        }),
        /production-correctness clean-attempt admission failed: attempt\.not-clean-first/u
    );
});

test('shared admission helper keeps verdict and reason identity across consumers', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-shared-admission-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const recovered = await evidence(directory, {
        producerId: 'browser-diagnostics',
        schedulerRunId: 'shared-admission-run',
        scenario: 'browser-crash-once',
        retryPolicyId: 'diagnostic-browser-process-crash'
    });
    const failures = Object.keys(memberships).map((consumerId) => {
        try
        {
            requireCleanAttemptConsumerAdmission({
                consumerId,
                attemptEvidence: {
                    ...recovered,
                    membership: memberships[consumerId],
                    expected: memberships[consumerId]
                }
            });
            return null;
        }
        catch (error)
        {
            return error.message;
        }
    });
    assert.ok(failures.every((message) => typeof message === 'string'));
    assert.deepEqual(
        failures.map((message) => message.replace(/^[a-z-]+ /u, '')),
        [failures[0].replace(/^[a-z-]+ /u, ''), failures[0].replace(/^[a-z-]+ /u, ''), failures[0].replace(/^[a-z-]+ /u, '')]
    );
    assert.match(failures[0], /attempt\.not-clean-first/u);
});

test('downloaded clean-attempt evidence is bound to the transport manifest before consumer admission', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-transported-consumer-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const transported = await transportedEvidence(directory);
    const results = Object.keys(memberships).map((consumerId) => admit(consumerId, transported));
    assert.ok(results.every((result) => result.eligible === true));
    assert.deepEqual(results.map((result) => result.reasons), [[], [], []]);

    const attemptArtifact = path.join(
        transported.transportRoot,
        'transported-clean-run/transported-correctness/attempt-1/payload.json'
    );
    fs.appendFileSync(attemptArtifact, '\ntampered\n');
    const tampered = Object.keys(memberships).map((consumerId) => admit(consumerId, transported));
    assert.ok(tampered.every((result) => result.eligible === false));
    assert.ok(tampered.every((result) => result.reasons[0].code === 'attempt.transport-content-tamper'));
    assert.deepEqual(tampered.map((result) => result.reasons), [tampered[0].reasons, tampered[0].reasons, tampered[0].reasons]);
});
