import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
    buildQualityGateEvidenceTransport,
    qualityGateTransportContext
} = await import(new URL('../../tools/ci/prepare-quality-gate-evidence-transport.mjs', import.meta.url));
const { collectionDocumentDigest } = await import(
    new URL('../../tools/ci/check-job-summaries.mjs', import.meta.url));
const { verifyQualityGateEvidenceTransport } = await import(
    new URL('../../tools/ci/verify-quality-gate-evidence-transport.mjs', import.meta.url));
const {
    extractCurrentRunEvidenceTransport,
    locateTransportedCurrentRunEvidence
} = await import(new URL('../../tools/test/current-run-evidence-transport.mjs', import.meta.url));
const { governanceContentDigest } = await import(
    new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const {
    beginCurrentRunEvidencePublication,
    finalizeCurrentRunEvidencePublication
} = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const { packCurrentRunEvidenceTransport } = await import(
    new URL('../../tools/test/current-run-evidence-transport.mjs', import.meta.url));

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

function digestFile(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
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
        artifacts: ['.tmp/release-evidence/flaky/fixture.json'],
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
        '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json'), jobSummary());
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/ci-build-consumer-required.json'),
    buildVerification());
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/.tmp/release-evidence/flaky/fixture.json'), flakyEvidence());
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/.tmp/release-evidence/flaky/registry.json'),
    { schema: 'fsusblog.ci.flaky-registry.v1' });
    write(path.join(root,
        '.tmp/downloaded-artifacts/required/.tmp/release-evidence/flaky/attempts/fixture-suite/run-1/attempt.json'),
    { schema: 'fsusblog.ci.flaky-attempt.v1' });
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

function synchronizeCollectionSources(f, collection, documentsField)
{
    for (const [index, document] of collection[documentsField].entries())
    {
        const source = collection.sources[index];
        const file = path.join(f.root, '.tmp/downloaded-artifacts', source.artifactName, source.path);
        write(file, document);
        source.inputDigest = digestFile(file);
        source.documentDigest = collectionDocumentDigest(document);
    }
}

function publishFixtureCollection({ authorityId, context, entry, f, payload, stem })
{
    const payloadPath = `artifacts/current-run/${stem}.payload.json`;
    const referencePath = `artifacts/current-run/${stem}.reference.json`;
    const session = beginCurrentRunEvidencePublication({ authorityId, context,
        outputPath: referencePath, payloadPath, producerId: entry.producerId, repositoryRoot: f.root });
    write(path.join(f.root, payloadPath), payload);
    const publication = finalizeCurrentRunEvidencePublication({ authorityId, context,
        outputPath: referencePath, payloadPath, payloadSchema: payload.schema,
        producerId: entry.producerId, repositoryRoot: f.root, sessionId: session.sessionId,
        terminalStatus: 'success' });
    return {
        authorityId,
        producerId: entry.producerId,
        receiptSchema: entry.receiptSchema,
        originalRef: {
            path: referencePath,
            contentDigest: publication.receipt.contentDigest,
            producerReceiptDigest: publication.receipt.producerReceiptDigest
        },
        files: [{ path: referencePath, role: 'reference-receipt' },
            { path: payloadPath, role: 'payload' }]
    };
}

function resealCollections(f, mutate = () => {})
{
    build(f);
    const jobCollection = JSON.parse(fs.readFileSync(path.join(f.root,
        'artifacts/current-run/job-summaries.payload.json'), 'utf8'));
    const flakyCollection = JSON.parse(fs.readFileSync(path.join(f.root,
        'artifacts/current-run/flaky-evidence.payload.json'), 'utf8'));
    fs.rmSync(path.join(f.root, 'artifacts/current-run'), { recursive: true });
    fs.mkdirSync(path.join(f.root, 'artifacts/current-run'), { recursive: true });
    mutate({ f, jobCollection, flakyCollection });
    synchronizeCollectionSources(f, jobCollection, 'summaries');
    synchronizeCollectionSources(f, flakyCollection, 'evidence');
    const context = qualityGateTransportContext(f.environment);
    const registry = JSON.parse(fs.readFileSync(path.join(f.root,
        'config/testing/evidence-locator-registry.json'), 'utf8'));
    const entry = (authorityId) => registry.entries.find((candidate) => candidate.authorityId === authorityId);
    const objects = [
        publishFixtureCollection({ authorityId: 'evidence-consumer.ci.check-job-summaries.current-run',
            context, entry: entry('evidence-consumer.ci.check-job-summaries.current-run'), f,
            payload: jobCollection, stem: 'job-summaries' }),
        publishFixtureCollection({ authorityId: 'evidence-consumer.ci.check-flaky-evidence.current-run',
            context, entry: entry('evidence-consumer.ci.check-flaky-evidence.current-run'), f,
            payload: flakyCollection, stem: 'flaky-evidence' })
    ];
    const packed = packCurrentRunEvidenceTransport({ context, objects, repositoryRoot: f.root,
        archivePath: 'artifacts/current-run/transport-archive.json',
        manifestPath: 'artifacts/current-run/transport-manifest.json',
        transportRunId: 'quality-gate-42-1', downloadRunId: 'production-summary-42-1' });
    removeTransportPayloadSources(f.root);
    extractCurrentRunEvidenceTransport({ repositoryRoot: f.root,
        manifestPath: 'artifacts/current-run/transport-manifest.json', extractRoot: '.',
        expectedManifestDigest: packed.manifest.contentDigest,
        expectedAuthorityIds: objects.map((object) => object.authorityId) });
    return packed;
}

function removeTransportPayloadSources(root)
{
    for (const suffix of ['job-summaries.reference.json', 'job-summaries.payload.json',
        'flaky-evidence.reference.json', 'flaky-evidence.payload.json'])
    {
        fs.rmSync(path.join(root, 'artifacts/current-run', suffix));
    }
}

function installProductionSummaryFixture(f)
{
    const copy = (relative) =>
    {
        const destination = path.join(f.root, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, relative), destination);
    };
    for (const relative of [
        'tools/ci/check-flaky-evidence.mjs',
        'tools/ci/check-job-summaries.mjs',
        'tools/ci/prepare-quality-gate-evidence-transport.mjs',
        'tools/ci/summarize-quality-gate.mjs',
        'tools/ci/verify-quality-gate-evidence-transport.mjs',
        'tools/test-matrix/parse-matrix.mjs',
        'tools/test/current-run-evidence-locator.mjs',
        'tools/test/current-run-evidence-publication.mjs',
        'tools/test/current-run-evidence-transport.mjs',
        'tools/test/evidence-location-contract.mjs',
        'tools/yaml/parse-document.mjs'
    ]) copy(relative);
    copy('tools/yaml/workflow-structure.mjs');
    write(path.join(f.root, '.github/workflows/quality-gate.yml'),
        'jobs:\n  required:\n    runs-on: ubuntu-latest\n');
    write(path.join(f.root, 'tools/operations/check-release-evidence-manifest.mjs'),
        'process.exit(0)\n');
    write(path.join(f.root, 'tools/release/test-evidence-receipts-cli.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
export function validatePrSmartGatePlan() {}
const output = path.resolve('.tmp/release-evidence/browserless-correctness-receipt.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schema: 'fixture.correctness', status: 'success' }) + '\\n');
`);
    write(path.join(f.root, '.tmp/release-evidence/manifest.json'), {
        status: 'collected-ok',
        evidenceSummary: { externalExposure: { blockers: [], request: { blockerSources: [] } } }
    });
}

function productionSummaryEnvironment(f, manifestDigest)
{
    return {
        ...process.env,
        ...f.environment,
        GITHUB_STEP_SUMMARY: '',
        FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: 'artifacts/current-run/transport-manifest.json',
        FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST: manifestDigest,
        FSUSBLOG_RELEASE_EVIDENCE_DIR: '',
        FSUSBLOG_RELEASE_EVIDENCE_MANIFEST: '.tmp/release-evidence/manifest.json'
    };
}

function executeVerifiedProductionSummary(f, manifestDigest, mutateEnvironment = () => {})
{
    const environment = productionSummaryEnvironment(f, manifestDigest);
    mutateEnvironment(environment);
    verifyQualityGateEvidenceTransport({ repositoryRoot: f.root, environment });
    return spawnSync(process.execPath, [path.join(f.root, 'tools/ci/summarize-quality-gate.mjs')], {
        cwd: f.root,
        encoding: 'utf8',
        env: environment
    });
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

test('production-summary executes only after canonical reference and payload verification', async (context) =>
{
    await context.test('positive', () =>
    {
        const f = fixture();
        try
        {
            installProductionSummaryFixture(f);
            const produced = build(f);
            removeTransportPayloadSources(f.root);
            extractCurrentRunEvidenceTransport({ repositoryRoot: f.root,
                manifestPath: 'artifacts/current-run/transport-manifest.json', extractRoot: '.' });
            const result = executeVerifiedProductionSummary(f, produced.manifest.contentDigest);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            assert.match(result.stdout, /production summary ok/u);
            const summary = JSON.parse(fs.readFileSync(path.join(f.root,
                '.tmp/release-evidence/jobs/production-summary.json'), 'utf8'));
            assert.equal(summary.status, 'success');
        }
        finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    });

    for (const scenario of [{
        name: 'missing payload',
        mutate: (f) => fs.rmSync(path.join(f.root, 'artifacts/current-run/job-summaries.payload.json')),
        expected: /is missing/u
    }, {
        name: 'tampered payload',
        mutate: (f) => fs.appendFileSync(path.join(f.root,
            'artifacts/current-run/job-summaries.payload.json'), 'tampered'),
        expected: /payload digest mismatch/u
    }, {
        name: 'stale run',
        mutate: () => {},
        mutateEnvironment: (environment) => { environment.GITHUB_RUN_ID = '43'; },
        expected: /origin schedulerRunId mismatch/u
    }])
    {
        await context.test(scenario.name, () =>
        {
            const f = fixture();
            try
            {
                installProductionSummaryFixture(f);
                const produced = build(f);
                removeTransportPayloadSources(f.root);
                extractCurrentRunEvidenceTransport({ repositoryRoot: f.root,
                    manifestPath: 'artifacts/current-run/transport-manifest.json', extractRoot: '.' });
                scenario.mutate(f);
                assert.throws(() => executeVerifiedProductionSummary(f, produced.manifest.contentDigest,
                    scenario.mutateEnvironment), scenario.expected);
                assert.equal(fs.existsSync(path.join(f.root,
                    '.tmp/release-evidence/jobs/production-summary.json')), false,
                'production-summary must not execute after canonical verification fails');
            }
            finally { fs.rmSync(f.root, { recursive: true, force: true }); }
        });
    }
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

test('coordinated resealing cannot admit foreign incomplete or cardinality-drifted members', async (context) =>
{
    const jobDocument = (collection) => collection.summaries.find((document) =>
        document.schema === 'fsusblog.ci.job-result.v1');
    const scenarios = [{
        name: 'foreign member run',
        mutate: ({ jobCollection }) => { jobDocument(jobCollection).runId = '43'; },
        expected: /stale job summary runId/u
    }, {
        name: 'foreign member attempt',
        mutate: ({ jobCollection }) => { jobDocument(jobCollection).attempt = '2'; },
        expected: /stale job summary attempt/u
    }, {
        name: 'foreign member job',
        mutate: ({ jobCollection }) => { jobDocument(jobCollection).ciJob = 'foreign'; },
        expected: /outside direct summary authority/u
    }, {
        name: 'incomplete flaky member',
        mutate: ({ flakyCollection }) => { delete flakyCollection.evidence[0].suite; },
        expected: /suite is required/u
    }, {
        name: 'missing job member',
        mutate: ({ jobCollection }) =>
        {
            const keep = jobCollection.summaries.findIndex((document) =>
                document.schema === 'fsusblog.ci.job-result.v1');
            jobCollection.summaries.splice(keep, 1);
            jobCollection.sources.splice(keep, 1);
        },
        expected: /must contain at least one job summary/u
    }, {
        name: 'extra member provenance',
        mutate: ({ jobCollection }) => { jobCollection.sources.push({ ...jobCollection.sources[0] }); },
        expected: /sources must have exact document cardinality/u
    }, {
        name: 'duplicate job member',
        mutate: ({ jobCollection }) =>
        {
            const index = jobCollection.summaries.findIndex((document) =>
                document.schema === 'fsusblog.ci.job-result.v1');
            jobCollection.summaries.push(structuredClone(jobCollection.summaries[index]));
            jobCollection.sources.push({ ...jobCollection.sources[index],
                path: '.tmp/release-evidence/jobs/duplicate.json' });
        },
        expected: /transport collection document cardinality mismatch/u
    }];
    for (const scenario of scenarios)
    {
        await context.test(scenario.name, () =>
        {
            const f = fixture();
            try
            {
                const produced = resealCollections(f, scenario.mutate);
                const environment = { ...f.environment,
                    FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST: 'artifacts/current-run/transport-manifest.json',
                    FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST_DIGEST: produced.manifest.contentDigest };
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
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json')),
        expected: /canonical job summary artifact cardinality mismatch/u
    }, {
        name: 'stale job summary',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json'),
        jobSummary({ commit: 'e'.repeat(40) })),
        expected: /stale job summary commit/u
    }, {
        name: 'stale production build verification',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/ci-build-consumer-required.json'),
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
            '.tmp/downloaded-artifacts/required-copy/.tmp/release-evidence/jobs/required.json'), jobSummary()),
        expected: /unbound prefix alias/u
    }, {
        name: 'foreign job summary artifact',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/foreign/.tmp/release-evidence/jobs/foreign.json'),
        jobSummary({ jobId: 'foreign', ciJob: 'foreign' })),
        expected: /outside exact plan authority/u
    }, {
        name: 'duplicate canonical job summary',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/duplicate.json'), jobSummary()),
        expected: /duplicate canonical job evidence/u
    }, {
        name: 'unselected job tier',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json'),
        jobSummary({ tierIds: ['foreign-tier'] })),
        expected: /claims an unselected tier/u
    }, {
        name: 'unreferenced flaky evidence',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json'),
        jobSummary({ artifacts: [] })),
        expected: /flaky evidence is not referenced/u
    }, {
        name: 'flaky registry companion with wrong schema',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/flaky/registry.json'),
        { schema: 'fsusblog.ci.flaky.v1' }),
        expected: /flaky registry schema mismatch/u
    }, {
        name: 'flaky attempt companion with wrong schema',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/flaky/attempts/fixture-suite/run-1/attempt.json'),
        { schema: 'fsusblog.ci.flaky.v1' }),
        expected: /flaky attempt schema mismatch/u
    }, {
        name: 'misplaced flaky attempt companion',
        mutate: (f) => write(path.join(f.root,
            '.tmp/downloaded-artifacts/required/.tmp/release-evidence/flaky/misplaced.json'),
        { schema: 'fsusblog.ci.flaky-attempt.v1' }),
        expected: /unknown or misplaced flaky artifact/u
    }, {
        name: 'symlinked producer input',
        mutate: (f) =>
        {
            const target = path.join(f.root,
                '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json');
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
                '.tmp/downloaded-artifacts/required/.tmp/release-evidence/jobs/required.json');
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
