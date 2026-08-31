import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    buildQualityGateEvidenceTransport,
    qualityGateTransportContext
} = await import(new URL('../../tools/ci/prepare-quality-gate-evidence-transport.mjs', import.meta.url));
const { verifyQualityGateEvidenceTransport } = await import(
    new URL('../../tools/ci/verify-quality-gate-evidence-transport.mjs', import.meta.url));
const {
    extractCurrentRunEvidenceTransport,
    locateTransportedCurrentRunEvidence
} = await import(new URL('../../tools/test/current-run-evidence-transport.mjs', import.meta.url));
const { governanceContentDigest } = await import(
    new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));

const sourceRoot = path.resolve(import.meta.dirname, '../..');
const sha = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);
const buildReceiptBody = {
    schema: 'fsusblog.ci-production-build-receipt.v1',
    status: 'complete',
    sourceState: { commit: sha, worktreeFingerprint: fingerprint },
    producer: { workflow: 'Quality Gate', runId: '42', runAttempt: 1,
        job: 'production-build-artifacts' }
};
const buildDigest = governanceContentDigest(buildReceiptBody);

function write(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function jobSummary(overrides = {})
{
    return {
        schema: 'fsusblog.ci.job-result.v1',
        jobId: 'required',
        ciJob: 'required',
        tierIds: ['fixture-tier'],
        status: 'success',
        failureStage: null,
        rootCause: null,
        durationMs: 1,
        stageDurationsMs: { setup: 0, restore: 0, install: 0, bootstrap: 0,
            test: 1, artifact: 0, summary: 0 },
        artifacts: ['release-evidence/flaky/fixture.json'],
        localReproduction: './tools/test.sh fixture',
        commit: sha,
        runId: '42',
        attempt: '1',
        ...overrides
    };
}

function flakyEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.ci.flaky.v1',
        policyVersion: 'fsusblog-flaky-execution-v2',
        suite: 'fixture-suite',
        test: 'fixture-test',
        testIds: ['fixture-test'],
        declaredTestIds: ['fixture-test'],
        classification: 'known-flaky',
        evidenceClass: 'correctness',
        sourceEvidenceClass: 'correctness',
        affectsCorrectness: true,
        failureClass: null,
        failureKind: null,
        issue: 3120,
        retryPolicy: { allowedRetries: 0, retryOn: 'never' },
        retryCount: 0,
        finalStatus: 'success',
        attempts: [{ attempt: 1, status: 'success', testIds: ['fixture-test'],
            failureClass: null, failureKind: null, artifacts: ['fixture.json'],
            exitCode: 0, signal: null, durationMs: 1 }],
        generatedAt: '2026-08-30T00:00:00.000Z',
        ...overrides
    };
}

function buildVerification(overrides = {})
{
    return {
        schema: 'fsusblog.ci-production-build-verification.v1',
        status: 'success',
        receipt: 'receipt.json',
        receiptContentDigest: buildDigest,
        sourceState: { commit: sha, worktreeFingerprint: fingerprint },
        producer: {
            workflow: 'Quality Gate',
            runId: '42',
            runAttempt: 1,
            job: 'production-build-artifacts'
        },
        ...overrides
    };
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-quality-gate-transport-'));
    const planBody = {
        schema: 'fsusblog.pr-smart-gate.v1',
        generatedAt: '2026-08-30T00:00:00.000Z',
        sourceState: { commit: sha, worktreeFingerprint: `sha256:${fingerprint}` },
        runId: '42',
        runAttempt: '1',
        selectedTierIds: ['fixture-tier', 'production-correctness'],
        skippedTierIds: [],
        selectedJobIds: ['production-summary', 'required'],
        skippedJobIds: [],
        summaryAuthorityJobIds: ['required']
    };
    const plan = { ...planBody, contentDigest: governanceContentDigest(planBody) };
    write(path.join(root, '.tmp/quality-gate-plan/pr-plan.json'), plan);
    write(path.join(root, 'tests/matrix.yml'),
        'tiers:\n  - id: fixture-tier\n    ciJob: required\n    executionDependsOn: []\n'
        + '  - id: production-correctness\n    ciJob: production-summary\n    executionDependsOn: []\n');
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json'), jobSummary());
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/release-evidence/jobs/ci-build-consumer-required.json'),
    buildVerification());
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/release-evidence/flaky/fixture.json'), flakyEvidence());
    write(path.join(root,
        '.tmp/downloaded-artifacts/production-build-artifacts/.tmp/ci-production-build/receipt.json'),
    { ...buildReceiptBody, contentDigest: buildDigest });
    write(path.join(root, 'config/testing/evidence-locator-registry.json'),
        JSON.parse(fs.readFileSync(path.join(sourceRoot,
            'config/testing/evidence-locator-registry.json'), 'utf8')));
    const environment = {
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SHA: sha,
        FSUSBLOG_CI_PR_SMART_GATE_PLAN: '.tmp/quality-gate-plan/pr-plan.json',
        FSUSBLOG_CI_PR_PLAN_DIGEST: plan.contentDigest,
        FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT: fingerprint,
        FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST: buildDigest,
        FSUSBLOG_QUALITY_GATE_ARTIFACT_DOWNLOAD_ROOT: '.tmp/downloaded-artifacts',
        FSUSBLOG_RELEASE_EVIDENCE_DIR: '.tmp/release-evidence',
        QUALITY_GATE_NEEDS_JSON: JSON.stringify({ required: { result: 'success' } })
    };
    return { environment, plan, root };
}

function build(fixtureRoot)
{
    return buildQualityGateEvidenceTransport({
        repositoryRoot: fixtureRoot.root,
        environment: fixtureRoot.environment
    });
}

function removeTransportPayloadSources(root)
{
    for (const suffix of ['job-summaries.reference.json', 'job-summaries.payload.json',
        'flaky-evidence.reference.json', 'flaky-evidence.payload.json'])
    {
        fs.rmSync(path.join(root, 'artifacts/current-run', suffix));
    }
}

test('quality-gate workflow uploads downloads and exports one canonical transport identity', () =>
{
    const workflow = fs.readFileSync(path.join(sourceRoot, '.github/workflows/quality-gate.yml'), 'utf8');
    const producer = workflow.slice(workflow.indexOf('    release-evidence:'),
        workflow.indexOf('    production-summary:'));
    const consumer = workflow.slice(workflow.indexOf('    production-summary:'));
    assert.match(producer, /name:\s+quality-gate-evidence-transport[\s\S]*?retention-days:\s+14[\s\S]*?artifacts\/current-run\/transport-manifest\.json[\s\S]*?artifacts\/current-run\/transport-archive\.json/u);
    assert.match(consumer, /name:\s+quality-gate-evidence-transport[\s\S]*?path:\s+artifacts\/current-run/u);
    assert.match(consumer, /FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST:\s+artifacts\/current-run\/transport-manifest\.json/u);
    for (const locator of ['FSUSBLOG_CI_PR_SMART_GATE_PLAN', 'FSUSBLOG_RELEASE_EVIDENCE_DIR',
        'FSUSBLOG_RELEASE_EVIDENCE_MANIFEST'])
    {
        assert.match(consumer, new RegExp(`${locator}:`, 'u'));
    }
    assert.doesNotMatch(consumer,
        /FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST:[^\n]*(?:downloaded-artifacts|\*\*)/u);
});

test('workflow producer seals exact reference and collection payload pairs', (context) =>
{
    const f = fixture();
    context.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const produced = build(f);
    assert.equal(produced.jobs, 2);
    assert.equal(produced.flaky, 1);
    assert.deepEqual(produced.manifest.objects.map((object) => object.authorityId).sort(), [
        'evidence-consumer.ci.check-flaky-evidence.current-run',
        'evidence-consumer.ci.check-job-summaries.current-run'
    ]);
    assert.ok(produced.manifest.objects.every((object) => object.archiveEntries.length === 2));
    assert.ok(produced.manifest.objects.every((object) =>
        object.archiveEntries.some((entry) => entry.path.endsWith('.reference.json'))
        && object.archiveEntries.some((entry) => entry.path.endsWith('.payload.json'))));

    removeTransportPayloadSources(f.root);
    const extracted = extractCurrentRunEvidenceTransport({
        repositoryRoot: f.root,
        manifestPath: 'artifacts/current-run/transport-manifest.json',
        extractRoot: '.'
    });
    assert.equal(extracted.objects.length, 2);
    const verified = verifyQualityGateEvidenceTransport({
        repositoryRoot: f.root,
        environment: {
            ...f.environment,
            FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: 'artifacts/current-run/transport-manifest.json',
            FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST: produced.manifest.contentDigest
        }
    });
    assert.equal(verified.manifestDigest, produced.manifest.contentDigest);
    assert.equal(Object.keys(verified.resolved).length, 2);
    const registry = JSON.parse(fs.readFileSync(path.join(f.root,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    const entry = registry.entries.find((candidate) =>
        candidate.authorityId === 'evidence-consumer.ci.check-job-summaries.current-run');
    const located = locateTransportedCurrentRunEvidence({
        context: qualityGateTransportContext(f.environment),
        registry,
        registryEntry: entry,
        repositoryRoot: f.root,
        transportManifestPath: 'artifacts/current-run/transport-manifest.json'
    });
    const payload = JSON.parse(fs.readFileSync(path.join(f.root, located.receipt.payload.path), 'utf8'));
    assert.equal(payload.schema, 'fsusblog.ci.job-summary-collection.v1');
    assert.deepEqual(payload.summaries.filter((summary) => summary.jobId).map((summary) => summary.jobId),
        ['required']);
    assert.ok(payload.summaries.some((summary) =>
        summary.schema === 'fsusblog.ci-production-build-verification.v1'));
});

test('live transport verifier rejects stale run source plan build and manifest identities', async (context) =>
{
    const scenarios = [{ name: 'run', mutate: (environment) => { environment.GITHUB_RUN_ID = '43'; },
        expected: /origin schedulerRunId mismatch/u },
    { name: 'attempt', mutate: (environment) => { environment.GITHUB_RUN_ATTEMPT = '2'; },
        expected: /origin attemptId mismatch/u },
    { name: 'source', mutate: (environment) => { environment.GITHUB_SHA = 'e'.repeat(40); },
        expected: /origin sourceCommit mismatch/u },
    { name: 'worktree', mutate: (environment) => {
        environment.FSUSBLOG_CI_PRODUCTION_SOURCE_FINGERPRINT = 'e'.repeat(64);
    }, expected: /origin worktreeFingerprint mismatch/u },
    { name: 'plan', mutate: (environment) => {
        environment.FSUSBLOG_CI_PR_PLAN_DIGEST = `sha256:${'e'.repeat(64)}`;
    }, expected: /origin candidateIdentity mismatch/u },
    { name: 'build', mutate: (environment) => {
        environment.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST = `sha256:${'e'.repeat(64)}`;
    }, expected: /origin buildIdentity mismatch/u },
    { name: 'manifest', mutate: (environment) => {
        environment.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST = `sha256:${'e'.repeat(64)}`;
    }, expected: /transport manifest digest mismatch/u }];
    for (const scenario of scenarios)
    {
        await context.test(scenario.name, () =>
        {
            const f = fixture();
            try
            {
                const produced = build(f);
                removeTransportPayloadSources(f.root);
                extractCurrentRunEvidenceTransport({ repositoryRoot: f.root,
                    manifestPath: 'artifacts/current-run/transport-manifest.json', extractRoot: '.' });
                const environment = { ...f.environment,
                    FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: 'artifacts/current-run/transport-manifest.json',
                    FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST: produced.manifest.contentDigest };
                scenario.mutate(environment);
                assert.throws(() => verifyQualityGateEvidenceTransport({ repositoryRoot: f.root, environment }),
                    scenario.expected);
            }
            finally { fs.rmSync(f.root, { recursive: true, force: true }); }
        });
    }
});

test('producer rejects missing stale duplicate and symlinked inputs', async (context) =>
{
    const scenarios = [{
        name: 'missing canonical job summary',
        mutate: (f) => fs.rmSync(path.join(f.root,
            '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json')),
        expected: /canonical job summary artifact cardinality mismatch/u
    }, {
        name: 'stale job summary',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json'),
        jobSummary({ commit: 'e'.repeat(40) })),
        expected: /stale job summary commit/u
    }, {
        name: 'stale production build verification',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/release-evidence/jobs/ci-build-consumer-required.json'),
        buildVerification({ receiptContentDigest: `sha256:${'e'.repeat(64)}` })),
        expected: /stale production build receipt digest/u
    }, {
        name: 'tampered production build receipt',
        mutate: (f) =>
        {
            const receipt = path.join(f.root,
                '.tmp/downloaded-artifacts/production-build-artifacts/.tmp/ci-production-build/receipt.json');
            const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
            value.producer.workflow = 'forged';
            write(receipt, value);
        },
        expected: /production build receipt content digest mismatch/u
    }, {
        name: 'prefix alias job summary',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required-copy/release-evidence/jobs/required.json'), jobSummary()),
        expected: /unbound prefix alias/u
    }, {
        name: 'foreign job summary artifact',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/foreign/release-evidence/jobs/foreign.json'),
        jobSummary({ jobId: 'foreign', ciJob: 'foreign' })),
        expected: /outside exact plan authority/u
    }, {
        name: 'duplicate canonical job summary',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/release-evidence/jobs/duplicate.json'), jobSummary()),
        expected: /duplicate canonical job evidence/u
    }, {
        name: 'unselected job tier',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json'),
        jobSummary({ tierIds: ['foreign-tier'] })),
        expected: /claims an unselected tier/u
    }, {
        name: 'unreferenced flaky evidence',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json'),
        jobSummary({ artifacts: [] })),
        expected: /flaky evidence is not referenced/u
    }, {
        name: 'symlinked producer input',
        mutate: (f) =>
        {
            const target = path.join(f.root,
                '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json');
            const outside = path.join(f.root, '.tmp/outside.json');
            fs.renameSync(target, outside);
            fs.symlinkSync(outside, target);
        },
        expected: /must not traverse a symlink/u
    }, {
        name: 'hardlinked producer input',
        mutate: (f) =>
        {
            const target = path.join(f.root,
                '.tmp/downloaded-artifacts/required/release-evidence/jobs/required.json');
            fs.linkSync(target, path.join(path.dirname(target), 'alias.json'));
        },
        expected: /must not be hard-linked/u
    }];
    for (const scenario of scenarios)
    {
        await context.test(scenario.name, () =>
        {
            const f = fixture();
            try
            {
                scenario.mutate(f);
                assert.throws(() => build(f), scenario.expected);
            }
            finally
            {
                fs.rmSync(f.root, { recursive: true, force: true });
            }
        });
    }
});

test('download verifier rejects tampered duplicate missing and unsafe manifest mappings', async (context) =>
{
    const scenarios = [{
        name: 'tampered archive',
        mutate: (f) => fs.appendFileSync(path.join(f.root,
            'artifacts/current-run/transport-archive.json'), 'tampered'),
        expected: /archive digest mismatch/u
    }, {
        name: 'duplicate authority mapping',
        mutate: (f) => rewriteManifest(f.root, (manifest) => manifest.objects.push(manifest.objects[0])),
        expected: /duplicate transport mapping/u
    }, {
        name: 'missing authority mapping',
        mutate: (f) => rewriteManifest(f.root, (manifest) =>
        {
            manifest.objects = [];
        }),
        expected: /transport objects are required/u
    }, {
        name: 'unsafe extracted path',
        mutate: (f) => rewriteManifest(f.root, (manifest) =>
        {
            manifest.objects[0].archiveEntries[0].extractedPath = '../escape.json';
        }),
        expected: /safe repository-relative path/u
    }];
    for (const scenario of scenarios)
    {
        await context.test(scenario.name, () =>
        {
            const f = fixture();
            try
            {
                build(f);
                scenario.mutate(f);
                assert.throws(() => extractCurrentRunEvidenceTransport({
                    repositoryRoot: f.root,
                    manifestPath: 'artifacts/current-run/transport-manifest.json',
                    extractRoot: '.'
                }), scenario.expected);
            }
            finally
            {
                fs.rmSync(f.root, { recursive: true, force: true });
            }
        });
    }
});

function rewriteManifest(root, mutate)
{
    const file = path.join(root, 'artifacts/current-run/transport-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(manifest);
    delete manifest.contentDigest;
    manifest.contentDigest = governanceContentDigest(manifest);
    write(file, manifest);
}
