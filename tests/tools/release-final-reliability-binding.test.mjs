import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/* eslint-disable import-x/no-relative-parent-imports */
import {
    locateReleaseReliabilityQualifiedReceipt,
    releaseReliabilityScenarioIds
} from '../../tools/release/release-reliability-qualified-receipt.mjs';
import {
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication
} from '../../tools/test/current-run-evidence-publication.mjs';
import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';
import { packCurrentRunEvidenceTransport } from '../../tools/test/current-run-evidence-transport.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const commit = 'a'.repeat(40);
const worktreeFingerprint = `sha256:${'b'.repeat(64)}`;
const buildContentDigest = `sha256:${'c'.repeat(64)}`;
const imageDigest = `sha256:${'d'.repeat(64)}`;
const lifecyclePhases = [
    'precondition',
    'reset',
    'measurement',
    'postcondition'
];

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
}

function sealDocument(document)
{
    const sealed = { ...document, contentDigest: null };
    const content = { ...sealed };
    delete content.contentDigest;
    sealed.contentDigest = `sha256:${createHash('sha256')
        .update(JSON.stringify(canonicalize(content)))
        .digest('hex')}`;
    return sealed;
}

function digestFile(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function writeJson(file, document)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

function writeText(root, relative, content)
{
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return {
        path: relative,
        fileDigest: digestFile(file)
    };
}

function updateQualifiedCandidateBinding(fixture)
{
    fixture.candidate = sealDocument(fixture.candidate);
    writeJson(fixture.candidateFile, fixture.candidate);
    fixture.qualified.candidate.contentDigest = fixture.candidate.contentDigest;
    fixture.qualified.candidate.fileDigest = digestFile(fixture.candidateFile);
    fixture.qualified = sealDocument(fixture.qualified);
    writeJson(fixture.qualifiedFile, fixture.qualified);
}

function updateQualifiedIdentityBinding(fixture)
{
    fixture.identity = sealDocument(fixture.identity);
    writeJson(fixture.identityFile, fixture.identity);
    fixture.candidate.identity.contentDigest = fixture.identity.contentDigest;
    updateQualifiedCandidateBinding(fixture);
}

function createFixture(context, invocationId = 'qualified-fixture')
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-final-reliability-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runId = `${invocationId}-run`;
    const invocationRoot = `.tmp/release-reliability/${invocationId}`;
    const bindings = {
        build: writeText(root, 'authority/build-receipt.json', '{"status":"complete"}\n'),
        fixtureConfig: writeText(root, 'authority/fixture.env', 'FIXTURE=qualified\n'),
        fixtureSchema: writeText(root, 'authority/schema.sql', 'CREATE TABLE qualified(id int);\n'),
        fixtureSeed: writeText(root, 'authority/seed.json', '{"seed":[1]}\n'),
        auditPolicy: writeText(root, 'authority/AuditRetentionCatalog.cs', 'sealed policy\n'),
        topology: writeText(root, 'authority/topology.json', '{"topology":"qualified"}\n'),
        schedulerPolicy: writeText(root, 'authority/scheduler-policy.json', '{"cpu":1}\n'),
        catalog: writeText(root, 'authority/catalog.json', '{"scenarios":7}\n'),
        threshold: writeText(root, 'authority/threshold.yml', 'max: qualified\n'),
        mutationSubset: writeText(root, 'authority/mutation.json', '{"subset":"fixed"}\n'),
        releaseResource: writeText(root, 'authority/resource.json', '{"rss":67108864}\n')
    };
    const identity = sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState: {
            commit,
            worktreeFingerprint,
            dirtyPathCount: 0,
            hashedPathCount: 1
        },
        build: {
            status: 'complete',
            ...bindings.build,
            contentDigest: buildContentDigest,
            imageDigest,
            image: {
                imageDigest,
                revision: commit,
                fsusuiSource: 'published-package',
                fsusuiCommit: 'e'.repeat(40)
            },
            sourceState: { commit, worktreeFingerprint },
            producerRunId: runId,
            toolchain: { node: process.version }
        },
        fixture: {
            status: 'complete',
            root: 'authority',
            namespace: 'qualified-fixture',
            config: { status: 'complete', ...bindings.fixtureConfig },
            schema: { status: 'complete', ...bindings.fixtureSchema },
            seed: { status: 'complete', ...bindings.fixtureSeed },
            auditRetentionPolicy: { status: 'complete', ...bindings.auditPolicy },
            topology: {
                status: 'complete',
                ...bindings.topology,
                content: {
                    contentDigest: `sha256:${'f'.repeat(64)}`
                }
            }
        },
        machine: {
            status: 'complete',
            os: 'fixture',
            architecture: 'x64',
            cpuModels: ['fixture'],
            cpuCount: 1,
            memoryBytes: 1024,
            cgroup: { status: 'complete' },
            schedulerPolicy: {
                status: 'complete',
                ...bindings.schedulerPolicy
            }
        },
        policy: {
            catalog: { status: 'complete', ...bindings.catalog },
            threshold: { status: 'complete', ...bindings.threshold },
            mutationSubset: { status: 'complete', ...bindings.mutationSubset },
            releaseResource: { status: 'complete', ...bindings.releaseResource },
            childEnvironment: {
                status: 'complete',
                contentDigest: `sha256:${'1'.repeat(64)}`
            },
            executorSchema: 'fsusblog.release-reliability-scenario-result.v2',
            lifecycleSchema: 'fsusblog.release-reliability-lifecycle-action.v1'
        },
        tools: [{
            id: 'node',
            status: 'complete',
            executable: process.execPath,
            version: process.version
        }],
        collectedAt: '2026-07-30T00:00:00.000Z',
        collectionErrors: []
    });
    const identityPath = `${invocationRoot}/identity.json`;
    const identityFile = path.join(root, identityPath);
    writeJson(identityFile, identity);
    const scenarios = [];
    const resultFiles = new Map();
    const evidenceFiles = new Map();
    for (const [index, scenarioId] of releaseReliabilityScenarioIds.entries())
    {
        const evidencePath = `${invocationRoot}/evidence/${scenarioId}.json`;
        const evidenceFile = path.join(root, evidencePath);
        writeJson(evidenceFile, { scenarioId, metrics: { observed: index + 1 } });
        const resultPath = `${invocationRoot}/scenario-results/${scenarioId}.json`;
        const resultFile = path.join(root, resultPath);
        writeJson(resultFile, {
            schema: 'fsusblog.release-reliability-scenario-result.v2',
            status: 'passed',
            scenarioId,
            evidenceClass: 'correctness',
            qualificationEligible: true,
            lifecycle: Object.fromEntries(lifecyclePhases.map((phase) => [
                phase,
                { status: 'complete', isolationObserved: true }
            ]))
        });
        scenarios.push({
            scenarioId,
            resultPath,
            resultContentDigest: `sha256:${String(index + 2).repeat(64)}`,
            evidencePath,
            evidenceDigest: digestFile(evidenceFile)
        });
        resultFiles.set(scenarioId, resultFile);
        evidenceFiles.set(scenarioId, evidenceFile);
    }
    const candidate = sealDocument({
        schema: 'fsusblog.release-reliability-candidate-receipt.v1',
        invocationId,
        runId,
        status: 'candidate',
        identity: {
            path: identityPath,
            contentDigest: identity.contentDigest
        },
        timeline: {
            path: `${invocationRoot}/timeline.json`,
            contentDigest: `sha256:${'2'.repeat(64)}`
        },
        scenarios,
        createdAt: '2026-07-30T00:00:20.000Z',
        failure: null
    });
    const candidatePath = `${invocationRoot}/candidate-receipt.json`;
    const candidateFile = path.join(root, candidatePath);
    writeJson(candidateFile, candidate);
    const attestation = sealDocument({
        schema: 'fsusblog.release-reliability-verified-attestation.v1',
        status: 'verified',
        invocationId,
        runId,
        candidate: {
            path: candidatePath,
            contentDigest: candidate.contentDigest,
            fileDigest: digestFile(candidateFile)
        },
        verifier: {
            path: 'tools/test/verify-release-reliability-receipt.mjs',
            fileDigest: `sha256:${'3'.repeat(64)}`
        },
        files: [],
        verifiedAt: '2026-07-30T00:00:21.000Z'
    });
    const attestationPath = `${invocationRoot}/verified-attestation.json`;
    const attestationFile = path.join(root, attestationPath);
    writeJson(attestationFile, attestation);
    const qualified = sealDocument({
        schema: 'fsusblog.release-reliability-qualified-receipt.v3',
        invocationId,
        runId,
        status: 'qualified',
        candidate: {
            path: candidatePath,
            contentDigest: candidate.contentDigest,
            fileDigest: digestFile(candidateFile)
        },
        attestation: {
            path: attestationPath,
            contentDigest: attestation.contentDigest,
            fileDigest: digestFile(attestationFile)
        },
        buildIdentity: {
            imageDigest,
            revision: commit,
            fsusuiSource: 'published-package',
            fsusuiCommit: 'e'.repeat(40)
        },
        finalizedAt: '2026-07-30T00:00:22.000Z',
        failure: null
    });
    const qualifiedFile = path.join(root, invocationRoot, 'qualified-receipt.json');
    writeJson(qualifiedFile, qualified);
    return {
        root,
        invocationId,
        invocationRoot,
        bindings,
        identity,
        identityFile,
        candidate,
        candidateFile,
        attestation,
        attestationFile,
        qualified,
        qualifiedFile,
        resultFiles,
        evidenceFiles
    };
}

function syntheticIndependentVerifier(callCounter)
{
    return ({ repositoryRoot: root, receiptPath }) =>
    {
        callCounter.count += 1;
        const qualified = JSON.parse(fs.readFileSync(path.join(root, receiptPath), 'utf8'));
        if (qualified.schema !== 'fsusblog.release-reliability-qualified-receipt.v3'
            || qualified.status !== 'qualified')
        {
            throw new Error('terminal qualified receipt schema/status is invalid');
        }
        const candidate = JSON.parse(
            fs.readFileSync(path.join(root, qualified.candidate.path), 'utf8')
        );
        const identity = JSON.parse(
            fs.readFileSync(path.join(root, candidate.identity.path), 'utf8')
        );
        const verifyBinding = (binding, label) =>
        {
            const file = path.join(root, binding.path);
            if (!fs.existsSync(file) || digestFile(file) !== binding.fileDigest)
            {
                throw new Error(`${label} changed`);
            }
        };
        verifyBinding(identity.build, 'build receipt');
        for (const field of [
            'config',
            'schema',
            'seed',
            'auditRetentionPolicy',
            'topology'
        ])
        {
            verifyBinding(identity.fixture[field], `fixture.${field}`);
        }
        if (identity.machine?.status !== 'complete'
            || identity.machine.cgroup?.status !== 'complete')
        {
            throw new Error('machine identity mismatch');
        }
        verifyBinding(identity.machine.schedulerPolicy, 'machine.schedulerPolicy');
        for (const field of [
            'catalog',
            'threshold',
            'mutationSubset',
            'releaseResource'
        ])
        {
            verifyBinding(identity.policy[field], `policy.${field}`);
        }
        for (const scenario of candidate.scenarios)
        {
            const result = JSON.parse(
                fs.readFileSync(path.join(root, scenario.resultPath), 'utf8')
            );
            if (result.status !== 'passed'
                || result.evidenceClass !== 'correctness'
                || result.qualificationEligible !== true)
            {
                throw new Error(`scenario ${scenario.scenarioId} is not qualification eligible`);
            }
            for (const phase of lifecyclePhases)
            {
                if (result.lifecycle?.[phase]?.status !== 'complete'
                    || result.lifecycle[phase].isolationObserved !== true)
                {
                    throw new Error(
                        `scenario ${scenario.scenarioId} ${phase} isolation is incomplete`
                    );
                }
            }
            if (digestFile(path.join(root, scenario.evidencePath))
                !== scenario.evidenceDigest)
            {
                throw new Error(`scenario ${scenario.scenarioId} evidence changed`);
            }
        }
    };
}

function locate(fixture, callCounter, overrides = {})
{
    return locateReleaseReliabilityQualifiedReceipt({
        repositoryRoot: fixture.root,
        expectedCommit: commit,
        expectedWorktreeFingerprint: worktreeFingerprint,
        expectedBuildReceiptContentDigest: buildContentDigest,
        expectedImageDigest: imageDigest,
        verifyQualifiedReceipt: syntheticIndependentVerifier(callCounter),
        ...overrides
    });
}

test('locator fails closed for zero or ambiguous canonical receipts before verifier spawn', async (context) =>
{
    await context.test('zero receipt and summary-only substitutes', (subtest) =>
    {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-final-missing-'));
        subtest.after(() => fs.rmSync(root, { recursive: true, force: true }));
        writeJson(path.join(root, '.tmp/release-evidence/jobs/release-final.json'), {
            schema: 'fsusblog.ci.job-result.v1',
            status: 'success',
            tierIds: ['release-reliability-fresh']
        });
        writeJson(path.join(root, '.tmp/release-evidence/memory-leak-summary.json'), {
            status: 'ok',
            metrics: [{ status: 'ok' }]
        });
        writeJson(path.join(root, '.tmp/release-evidence/open-handle-summary.json'), {
            status: 'ok',
            metrics: [{ status: 'ok' }]
        });
        const calls = { count: 0 };
        assert.throws(
            () => locateReleaseReliabilityQualifiedReceipt({
                repositoryRoot: root,
                verifyQualifiedReceipt: syntheticIndependentVerifier(calls)
            }),
            /qualified receipt is missing.*ci-tier release-reliability-fresh/su
        );
        assert.equal(calls.count, 0);
    });

    await context.test('two receipts are deterministic ambiguity', (subtest) =>
    {
        const first = createFixture(subtest, 'z-qualified');
        const secondSource = createFixture(subtest, 'a-qualified');
        const secondDirectory = path.join(
            first.root,
            '.tmp/release-reliability/a-qualified'
        );
        fs.cpSync(
            path.join(secondSource.root, '.tmp/release-reliability/a-qualified'),
            secondDirectory,
            { recursive: true }
        );
        const calls = { count: 0 };
        assert.throws(
            () => locateReleaseReliabilityQualifiedReceipt({
                repositoryRoot: first.root,
                verifyQualifiedReceipt: syntheticIndependentVerifier(calls)
            }),
            /a-qualified\/qualified-receipt\.json, .*z-qualified\/qualified-receipt\.json/u
        );
        assert.equal(calls.count, 0);
    });
});

test('locator verifies one order-independent receipt and projects exactly seven audit fields', (context) =>
{
    const fixture = createFixture(context, 'z-qualified');
    fs.mkdirSync(path.join(fixture.root, '.tmp/release-reliability/a-no-receipt'));
    const calls = { count: 0 };
    const binding = locate(fixture, calls);
    assert.equal(calls.count, 1);
    assert.deepEqual(Object.keys(binding).sort(), [
        'authorityId',
        'buildIdentity',
        'contentDigest',
        'receiptPath',
        'scenarioIds',
        'sourceIdentity',
        'verificationStatus'
    ]);
    assert.equal(binding.authorityId, 'release-reliability-fresh');
    assert.equal(
        binding.receiptPath,
        '.tmp/release-reliability/z-qualified/qualified-receipt.json'
    );
    assert.equal(binding.verificationStatus, 'verified');
    assert.deepEqual(binding.scenarioIds, releaseReliabilityScenarioIds);
    assert.deepEqual(
        binding.buildIdentity.evidence.map((entry) => entry.scenarioId),
        releaseReliabilityScenarioIds
    );
    assert.ok(binding.buildIdentity.evidence.every(
        (entry) => /^sha256:[a-f0-9]{64}$/u.test(entry.evidenceDigest)
    ));
    assert.equal(
        binding.buildIdentity.policy.catalog.fileDigest,
        fixture.bindings.catalog.fileDigest
    );
    assert.equal(
        binding.buildIdentity.policy.threshold.fileDigest,
        fixture.bindings.threshold.fileDigest
    );
});

test('locator rejects non-qualified and non-exact seven scenario envelopes', async (context) =>
{
    const cases = [
        {
            name: 'non-qualified',
            mutate(fixture)
            {
                fixture.qualified.status = 'failed';
                fixture.qualified.failure = 'scenario failed';
                fixture.qualified = sealDocument(fixture.qualified);
                writeJson(fixture.qualifiedFile, fixture.qualified);
            },
            expected: /schema\/status|schema\/status\/failure/u
        },
        {
            name: 'six scenarios',
            mutate(fixture)
            {
                fixture.candidate.scenarios.pop();
                updateQualifiedCandidateBinding(fixture);
            },
            expected: /exact seven canonical scenario IDs/u
        },
        {
            name: 'duplicate scenario',
            mutate(fixture)
            {
                fixture.candidate.scenarios[1].scenarioId =
                    fixture.candidate.scenarios[0].scenarioId;
                updateQualifiedCandidateBinding(fixture);
            },
            expected: /exact seven canonical scenario IDs/u
        },
        {
            name: 'unknown scenario',
            mutate(fixture)
            {
                fixture.candidate.scenarios[0].scenarioId = 'release-unknown';
                updateQualifiedCandidateBinding(fixture);
            },
            expected: /exact seven canonical scenario IDs/u
        }
    ];
    for (const entry of cases)
    {
        await context.test(entry.name, (subtest) =>
        {
            const fixture = createFixture(subtest);
            entry.mutate(fixture);
            const calls = { count: 0 };
            assert.throws(() => locate(fixture, calls), entry.expected);
            assert.equal(calls.count, 1);
        });
    }
});

test('independent verifier failures for scenario, reset isolation, and evidence tamper block binding', async (context) =>
{
    const cases = [
        {
            name: 'failed scenario',
            mutate(fixture)
            {
                const file = fixture.resultFiles.get(releaseReliabilityScenarioIds[0]);
                const result = JSON.parse(fs.readFileSync(file, 'utf8'));
                result.status = 'failed';
                writeJson(file, result);
            },
            expected: /not qualification eligible/u
        },
        {
            name: 'diagnostic scenario',
            mutate(fixture)
            {
                const file = fixture.resultFiles.get(releaseReliabilityScenarioIds[0]);
                const result = JSON.parse(fs.readFileSync(file, 'utf8'));
                result.evidenceClass = 'diagnostic';
                result.qualificationEligible = false;
                writeJson(file, result);
            },
            expected: /not qualification eligible/u
        },
        {
            name: 'reset isolation missing',
            mutate(fixture)
            {
                const file = fixture.resultFiles.get(releaseReliabilityScenarioIds[0]);
                const result = JSON.parse(fs.readFileSync(file, 'utf8'));
                delete result.lifecycle.reset;
                writeJson(file, result);
            },
            expected: /reset isolation is incomplete/u
        },
        {
            name: 'authoritative evidence tamper',
            mutate(fixture)
            {
                fs.appendFileSync(
                    fixture.evidenceFiles.get(releaseReliabilityScenarioIds[0]),
                    '\ntampered\n'
                );
            },
            expected: /evidence changed/u
        }
    ];
    for (const entry of cases)
    {
        await context.test(entry.name, (subtest) =>
        {
            const fixture = createFixture(subtest);
            entry.mutate(fixture);
            const calls = { count: 0 };
            assert.throws(() => locate(fixture, calls), entry.expected);
            assert.equal(calls.count, 1);
        });
    }
});

test('source, worktree, build, image, fixture, machine, topology, and policy identity drift fails closed', async (context) =>
{
    const cases = [
        {
            name: 'source commit',
            locateOverrides: { expectedCommit: '0'.repeat(40) },
            expected: /source commit mismatch/u
        },
        {
            name: 'worktree fingerprint',
            locateOverrides: {
                expectedWorktreeFingerprint: `sha256:${'0'.repeat(64)}`
            },
            expected: /worktree fingerprint mismatch/u
        },
        {
            name: 'build receipt',
            locateOverrides: {
                expectedBuildReceiptContentDigest: `sha256:${'0'.repeat(64)}`
            },
            expected: /build receipt contentDigest mismatch/u
        },
        {
            name: 'image',
            locateOverrides: { expectedImageDigest: `sha256:${'0'.repeat(64)}` },
            expected: /image digest mismatch/u
        },
        {
            name: 'fixture',
            mutate(fixture)
            {
                fs.appendFileSync(
                    path.join(fixture.root, fixture.bindings.fixtureConfig.path),
                    'tampered\n'
                );
            },
            expected: /fixture\.config changed/u
        },
        {
            name: 'machine',
            mutate(fixture)
            {
                fixture.identity.machine.status = 'unavailable';
                updateQualifiedIdentityBinding(fixture);
            },
            expected: /machine identity mismatch/u
        },
        {
            name: 'topology',
            mutate(fixture)
            {
                fs.appendFileSync(
                    path.join(fixture.root, fixture.bindings.topology.path),
                    'tampered\n'
                );
            },
            expected: /fixture\.topology changed/u
        },
        {
            name: 'catalog',
            mutate(fixture)
            {
                fs.appendFileSync(
                    path.join(fixture.root, fixture.bindings.catalog.path),
                    'tampered\n'
                );
            },
            expected: /policy\.catalog changed/u
        },
        {
            name: 'threshold',
            mutate(fixture)
            {
                fs.appendFileSync(
                    path.join(fixture.root, fixture.bindings.threshold.path),
                    'tampered\n'
                );
            },
            expected: /policy\.threshold changed/u
        },
        {
            name: 'release resource policy',
            mutate(fixture)
            {
                fs.appendFileSync(
                    path.join(fixture.root, fixture.bindings.releaseResource.path),
                    'tampered\n'
                );
            },
            expected: /policy\.releaseResource changed/u
        }
    ];
    for (const entry of cases)
    {
        await context.test(entry.name, (subtest) =>
        {
            const fixture = createFixture(subtest);
            entry.mutate?.(fixture);
            const calls = { count: 0 };
            assert.throws(
                () => locate(fixture, calls, entry.locateOverrides),
                entry.expected
            );
            assert.equal(calls.count, 1);
        });
    }
});

test('downloaded qualified receipt artifacts restore into the canonical locator tree', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-reliability-restore-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const downloaded = path.join(root, 'downloaded');
    const restored = path.join(root, 'restored');
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'release-reliability/restored-run'), { recursive: true });
    const digest = (value) => `sha256:${value.repeat(64)}`;
    const contextBody = {
        schema: 'fsusblog.current-run-evidence-context.v1',
        schedulerRunId: 'run-1',
        attemptId: 'attempt-1',
        sourceCommit: commit,
        worktreeFingerprint,
        candidateIdentity: { id: 'candidate', digest: digest('c') },
        buildIdentity: { id: 'build', digest: digest('d') },
        ownedRoots: ['artifacts/current-run', 'release-reliability']
    };
    const evidenceContext = { ...contextBody, contentDigest: governanceContentDigest(contextBody) };
    const outputPath = 'artifacts/current-run/reference.json';
    const payloadPath = 'release-reliability/restored-run/qualified-receipt.json';
    const authorityId = 'release-reliability-fresh.current-run';
    const producerId = 'release-reliability-fresh.producer';
    const session = beginCurrentRunEvidencePublication({
        authorityId,
        context: evidenceContext,
        outputPath,
        payloadPath,
        producerId,
        repositoryRoot: root
    });
    writeJson(path.join(root, payloadPath), { schema: 'fixture.downloaded-qualified-receipt' });
    const published = finalizeCurrentRunEvidencePublication({
        authorityId,
        context: evidenceContext,
        outputPath,
        payloadPath,
        payloadSchema: 'fixture.downloaded-qualified-receipt',
        producerId,
        repositoryRoot: root,
        sessionId: session.sessionId,
        terminalStatus: 'success'
    });
    const manifestPath = 'artifacts/current-run/transport-manifest.json';
    packCurrentRunEvidenceTransport({
        context: evidenceContext,
        repositoryRoot: root,
        archivePath: 'artifacts/current-run/transport-archive.json',
        manifestPath,
        transportRunId: 'transport-1',
        downloadRunId: 'download-1',
        objects: [{
            authorityId,
            producerId,
            receiptSchema: 'fsusblog.current-run-evidence-reference.v1',
            originalRef: {
                path: outputPath,
                contentDigest: published.receipt.contentDigest,
                producerReceiptDigest: published.receipt.producerReceiptDigest
            },
            files: [{ path: outputPath }, { path: payloadPath }]
        }]
    });
    fs.rmSync(path.join(root, outputPath));
    fs.rmSync(path.join(root, payloadPath));
    const result = spawnSync('bash', [
        path.join(repositoryRoot, 'tools/operations/restore-downloaded-artifacts.sh'),
        downloaded,
        restored
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_REPOSITORY_ROOT: root,
            FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: path.join(root, manifestPath)
        }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(restored, payloadPath), 'utf8')),
        { schema: 'fixture.downloaded-qualified-receipt' }
    );
});

test('production locator delegates terminal verification to the independent v3 verifier', () =>
{
    const source = fs.readFileSync(
        path.join(
            repositoryRoot,
            'tools/release/release-reliability-qualified-receipt.mjs'
        ),
        'utf8'
    );
    assert.match(
        source,
        /tools\/test\/verify-release-reliability-receipt\.mjs/u
    );
    assert.match(source, /'--receipt'/u);
    assert.doesNotMatch(source, /\bmtime\b|latest|first-match/u);
});
