import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {createProductionBuildReceipt} = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const {admitBrowserReleaseCleanAttempt, readCleanAttemptConsumerInventory, requireCleanAttemptConsumerAdmission} = await import(new URL('../../tools/release/browser-release-clean-attempt-consumers.mjs', import.meta.url));
const {createBrowserlessCorrectnessReceipt} = await import(new URL('../../tools/release/test-evidence-receipts.mjs', import.meta.url));
const {beginCurrentRunEvidencePublication, finalizeCurrentRunEvidencePublication} = await import(new URL('../../tools/test/current-run-evidence-publication.mjs', import.meta.url));
const {evidenceContentDigest, evidenceProducerReceiptDigest} = await import(new URL('../../tools/test/current-run-evidence-locator.mjs', import.meta.url));
const {governanceContentDigest} = await import(new URL('../../tools/test/evidence-location-contract.mjs', import.meta.url));
const {extractCurrentRunEvidenceTransport, packCurrentRunEvidenceTransport} = await import(new URL('../../tools/test/current-run-evidence-transport.mjs', import.meta.url));
const {runProducerAttempts} = await import(new URL('../../tools/test/attempt-runner.mjs', import.meta.url));
const {sha256} = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const {cleanAttemptIdentityMismatchReason, CleanFirstAttemptAdmissionError} = await import(new URL('../../tools/release/clean-first-attempt-verifier.mjs', import.meta.url));
const {fileBackedCleanAttemptEvidence} = await import(new URL('../../tools/release/clean-first-attempt-verifier.mjs', import.meta.url));
const {resolveTransportedCleanAttemptEvidence} = await import(new URL('../../tools/release/clean-attempt-evidence-transport.mjs', import.meta.url));
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
        buildIdentity: `sha256:${'9'.repeat(64)}`,
        externalCandidate: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId,
            buildIdentity: `sha256:${'9'.repeat(64)}`,
            executionEnvelopeDigest: `sha256:${'3'.repeat(64)}`, replayPlanDigest: `sha256:${'4'.repeat(64)}`,
            temporalContextDigest: `sha256:${'5'.repeat(64)}`,
            domainReceiptReference: { path: 'payload.json', digest: result.attempts[0].artifactDigests['payload.json'] } },
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
        verifyArtifact: (relative, digest, receipt) =>
        {
            const file = path.join(result.producerRoot, `attempt-${receipt.attemptNumber}`, relative);
            return fs.existsSync(file) && sha256(fs.readFileSync(file)) === digest;
        },
        expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId }
    };
}

async function transportedEvidence(directory, { includeUnrelated = false } = {})
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
    const objects = [{ authorityId: 'attempt-evidence.current-run', producerId,
        receiptSchema: published.receipt.schema,
        originalRef: { path: outputPath, contentDigest: published.receipt.contentDigest,
            producerReceiptDigest: published.receipt.producerReceiptDigest } }];
    // Transport the real producer's explicitly referenced graph, not a directory
    // scan or an overfull object. Attachment references are fixture adapters for
    // raw bytes, sealed with the existing reference owner's digest functions.
    const graphFiles = result.aggregate.attempts.flatMap((attemptReference, index) => [
        path.posix.join(path.posix.dirname(aggregatePath), attemptReference.path),
        ...result.attempts[index].artifactPaths.map((artifact) =>
            path.posix.join(path.posix.dirname(aggregatePath), `attempt-${attemptReference.attemptNumber}`, artifact))
    ]);
    if (includeUnrelated)
    {
        const unrelatedPath = `${schedulerRunId}/${producerId}/attempt-1/unrelated.json`;
        fs.writeFileSync(path.join(directory, unrelatedPath), '{"unrelated":true}\n', { flag: 'wx' });
        graphFiles.push(unrelatedPath);
    }
    for (const [index, payloadPath] of graphFiles.entries())
    {
        const authorityId = `attempt-evidence.current-run.member-${index}`;
        const body = { schema: 'fsusblog.current-run-evidence-reference.v1', schedulerRunId, attemptId,
            sourceCommit, worktreeFingerprint, candidateIdentity: context.candidateIdentity,
            buildIdentity: context.buildIdentity, authorityId, producerId,
            payload: { path: payloadPath, digest: sha256(fs.readFileSync(path.join(directory, payloadPath))) } };
        const sealed = { ...body, contentDigest: evidenceContentDigest(body) };
        const receipt = { ...sealed, producerReceiptDigest: evidenceProducerReceiptDigest(sealed) };
        const referencePath = `artifacts/current-run/attempt-member-${index}.json`;
        fs.writeFileSync(path.join(directory, referencePath), JSON.stringify(receipt), { flag: 'wx' });
        objects.push({ authorityId, producerId, receiptSchema: receipt.schema,
            originalRef: { path: referencePath, contentDigest: receipt.contentDigest,
                producerReceiptDigest: receipt.producerReceiptDigest } });
    }
    const manifestPath = 'artifacts/current-run/attempt-transport-manifest.json';
    const packed = packCurrentRunEvidenceTransport({
        context,
        repositoryRoot: directory,
        archivePath: 'artifacts/current-run/attempt-transport-archive.json',
        manifestPath,
        transportRunId: 'attempt-transport-run',
        downloadRunId: 'attempt-download-run',
        objects
    });
    for (const object of objects)
    {
        fs.rmSync(path.join(directory, object.originalRef.path));
    }
    fs.rmSync(path.join(directory, schedulerRunId), { recursive: true, force: true });
    const transportRoot = path.join(directory, 'downloaded-attempt-evidence');
    for (const entry of packed.manifest.archive.entries)
    {
        fs.mkdirSync(path.dirname(path.join(transportRoot, entry.path)), { recursive: true });
    }
    extractCurrentRunEvidenceTransport({
        repositoryRoot: directory,
        manifestPath,
        extractRoot: 'downloaded-attempt-evidence'
    });
    fs.copyFileSync(path.join(directory, manifestPath), path.join(transportRoot, manifestPath));
    const base = {
        evidenceRoot: transportRoot,
        buildIdentity: context.buildIdentity.digest,
        externalCandidate: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId,
            buildIdentity: context.buildIdentity.digest, executionEnvelopeDigest: digest('3'),
            replayPlanDigest: digest('4'), temporalContextDigest: digest('5'),
            domainReceiptReference: { path: 'payload.json', digest: result.attempts[0].artifactDigests['payload.json'] } },
        aggregateReference: null,
        domainReceiptReference: {
            path: 'payload.json',
            digest: result.attempts[0].artifactDigests['payload.json']
        },
        expectedIdentity: { sourceCommit, worktreeFingerprint, schedulerRunId, producerId },
        verifyAuthority: authority,
        transport: {
            repositoryRoot: transportRoot,
            transportManifestPath: manifestPath,
            authorityId: 'attempt-evidence.current-run'
        }
    };
    return { ...base, transportRoot, producerRoot, manifest: packed.manifest };
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
        expectedCandidate: { ...attemptEvidence?.externalCandidate, membership: memberships[consumerId] },
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
        { ...clean, externalCandidate: { ...clean.externalCandidate, schedulerRunId: 'other-run' } },
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

test('unconfigured attempt evidence fails closed identically across all consumers', () =>
{
    const messages = Object.keys(memberships).map((consumerId) =>
    {
        assert.equal(admit(consumerId, null).eligible, false);
        assert.equal(admit(consumerId, null).reasons[0].code, 'attempt.provenance-missing');
        assert.throws(() => requireCleanAttemptConsumerAdmission({
            consumerId,
            environment: {}
        }), (error) =>
        {
            assert.match(error.message, /attempt\.provenance-missing/u);
            return true;
        });
        try
        {
            requireCleanAttemptConsumerAdmission({ consumerId, environment: {} });
        }
        catch (error)
        {
            return error.message.replace(`${consumerId} `, '');
        }
        return null;
    });
    assert.deepEqual(messages, [messages[0], messages[0], messages[0]]);
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
    for (const result of results)
    {
        assert.deepEqual(result.reasons, results[0].reasons);
    }
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
        for (const result of results)
        {
            assert.deepEqual(result.reasons, results[0].reasons);
        }
    }
});

test('consumer identity expectations must bind source, worktree, run and producer', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-consumer-expected-identity-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId',
        'buildIdentity', 'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        const expectedIdentity = { ...clean.externalCandidate };
        delete expectedIdentity[field];
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, {
            ...clean, externalCandidate: expectedIdentity
        }));
        assert.ok(results.every((result) => result.eligible === false));
        assert.equal(results[0].reasons[0].code, 'attempt.consumer-identity-missing');
        assert.equal(results[0].reasons[0].field, field);
        for (const result of results)
        {
            assert.deepEqual(result.reasons, results[0].reasons);
        }
    }
});

test('independent candidate drift uses the exact owning-verifier reason vector across consumers', async (context) =>
{
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-candidate-parity-')));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const clean = await evidence(directory);
    const actualAttempt = clean.loadAttempt({ attemptNumber: 1 });
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId',
        'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest', 'buildIdentity'])
    {
        const expected = field === 'sourceCommit' ? 'a'.repeat(40)
            : ['schedulerRunId', 'producerId'].includes(field) ? 'different-current-identity' : `sha256:${'a'.repeat(64)}`;
        const candidate = { ...clean.externalCandidate, [field]: expected };
        const canonical = cleanAttemptIdentityMismatchReason(actualAttempt, field, expected,
            field === 'buildIdentity' ? clean.buildIdentity : actualAttempt[field]);
        for (const consumerId of Object.keys(memberships))
        {
            const result = admit(consumerId, { ...clean, externalCandidate: candidate });
            assert.equal(result.eligible, false);
            assert.deepEqual(result.reasons, [canonical]);
            assert.equal(result.attemptVerdict.eligible, false);
            assert.deepEqual(result.attemptVerdict.reasons, result.reasons);
            assert.equal(result.reasons[0].sourceCommit, sourceCommit);
            const attemptedSelfCertification = { ...clean, expectedIdentity: candidate };
            const unchanged = admit(consumerId, attemptedSelfCertification);
            assert.equal(unchanged.eligible, true, 'evidence expectedIdentity is not the external candidate authority');
        }
    }
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'buildIdentity'])
    {
        const candidateBinding = { sourceCommit, worktreeFingerprint,
            schedulerRunId: clean.externalCandidate.schedulerRunId, buildIdentity: clean.buildIdentity,
            [field]: field === 'sourceCommit' ? 'a'.repeat(40)
                : field === 'schedulerRunId' ? 'another-current-run' : `sha256:${'a'.repeat(64)}` };
        assert.throws(() => requireCleanAttemptConsumerAdmission({ consumerId: 'production-correctness',
            attemptEvidence: { ...clean, membership: memberships['production-correctness'] },
            expectedCandidate: { ...clean.externalCandidate, membership: memberships['production-correctness'] },
            candidateBinding, environment: {} }), (error) =>
        {
            assert.ok(error instanceof CleanFirstAttemptAdmissionError);
            assert.equal(error.verdict.attemptVerdict.eligible, false);
            assert.deepEqual(error.verdict.attemptVerdict.reasons, error.reasons);
            assert.deepEqual(error.reasons, [cleanAttemptIdentityMismatchReason(actualAttempt, field,
                clean.externalCandidate[field], candidateBinding[field])]);
            return true;
        });
    }
    assert.throws(() => requireCleanAttemptConsumerAdmission({ consumerId: 'production-correctness',
        attemptEvidence: { ...clean, membership: memberships['production-correctness'] },
        expectedCandidate: { ...clean.externalCandidate, membership: memberships['production-correctness'] },
        candidateBinding: {}, environment: {} }), (error) =>
    {
        assert.ok(error instanceof CleanFirstAttemptAdmissionError);
        assert.equal(error.verdict.attemptVerdict.eligible, false);
        assert.deepEqual(error.reasons, [cleanAttemptIdentityMismatchReason(actualAttempt, 'sourceCommit', sourceCommit, null)]);
        return true;
    });
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

test('browserless correctness rejects recovered and cross-candidate clean evidence', async (context) =>
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
    assert.throws(() => createBrowserlessCorrectnessReceipt({
        ...receiptOptions,
        attemptEvidence: {
            ...clean,
            membership: memberships['production-correctness'],
            expected: memberships['production-correctness']
        },
        expectedCandidate: { ...clean.externalCandidate, membership: memberships['production-correctness'] }
    }), /attempt.consumer-identity-mismatch/u);
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
        /attempt\.not-clean-first/u
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
    const failures = Object.keys(memberships).map((consumerId) =>
    {
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
    assert.equal(fs.existsSync(transported.producerRoot), false, 'positive cannot use original producer files');
    assert.ok(transported.manifest.objects.length > 1);
    assert.ok(transported.manifest.objects.every((object) => object.archiveEntries.length === 2
        && object.archiveEntries.some((entry) => entry.role === 'reference-receipt')
        && object.archiveEntries.some((entry) => entry.role === 'payload')));
    assert.ok(results.every((result) => result.eligible === true), JSON.stringify(results.map((result) => result.reasons)));
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

test('downloaded graph rejects missing attempt or artifact mappings despite existing local bytes', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-transport-unbound-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const transported = await transportedEvidence(directory);
    const manifestFile = path.join(transported.transportRoot, transported.transport.transportManifestPath);
    for (const index of [1, 2])
    {
        const manifest = structuredClone(transported.manifest);
        const [missing] = manifest.objects.splice(index, 1);
        const paths = missing.archiveEntries.map((entry) => entry.path);
        assert.ok(paths.every((relative) => fs.existsSync(path.join(transported.transportRoot, relative))));
        manifest.archive.entries = manifest.archive.entries.filter((entry) => !paths.includes(entry.path));
        manifest.contentDigest = governanceContentDigest(manifest);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, transported));
        assert.ok(results.every((result) => result.eligible === false && result.reasons[0].code === 'attempt.transport-unbound'));
        assert.deepEqual(results.map((result) => result.reasons), [results[0].reasons, results[0].reasons, results[0].reasons]);
    }
});

test('downloaded graph rejects coherently rehashed attachment source run and build drift', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-transport-identity-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const transported = await transportedEvidence(directory);
    const manifestFile = path.join(transported.transportRoot, transported.transport.transportManifestPath);
    const attachment = transported.manifest.objects[1];
    const referenceEntry = attachment.archiveEntries.find((entry) => entry.role === 'reference-receipt');
    const referenceFile = path.join(transported.transportRoot, referenceEntry.extractedPath);
    const original = JSON.parse(fs.readFileSync(referenceFile));
    for (const field of ['sourceCommit', 'schedulerRunId', 'buildIdentity'])
    {
        const manifest = structuredClone(transported.manifest);
        const linked = { ...original, [field]: field === 'sourceCommit' ? 'a'.repeat(40)
            : field === 'schedulerRunId' ? 'different-run' : { ...original.buildIdentity, digest: `sha256:${'a'.repeat(64)}` } };
        linked.contentDigest = evidenceContentDigest(linked);
        linked.producerReceiptDigest = evidenceProducerReceiptDigest(linked);
        fs.writeFileSync(referenceFile, JSON.stringify(linked));
        const fileDigest = sha256(fs.readFileSync(referenceFile));
        const object = manifest.objects[1];
        object[field === 'schedulerRunId' ? 'originRunId' : field] = linked[field];
        object.objectDigest = fileDigest;
        object.contentDigest = linked.contentDigest;
        object.producerDigest = linked.producerReceiptDigest;
        Object.assign(object.originalRef, { inputDigest: fileDigest, contentDigest: linked.contentDigest,
            producerReceiptDigest: linked.producerReceiptDigest });
        object.archiveEntries.find((entry) => entry.role === 'reference-receipt').digest = fileDigest;
        manifest.archive.entries.find((entry) => entry.path === referenceEntry.path).digest = fileDigest;
        manifest.contentDigest = governanceContentDigest(manifest);
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        const results = Object.keys(memberships).map((consumerId) => admit(consumerId, transported));
        assert.ok(results.every((result) => result.eligible === false && result.reasons[0].code === 'attempt.transport-manifest-invalid'));
        assert.match(results[0].reasons[0].message, new RegExp(`${field} mismatch`, 'u'));
        assert.deepEqual(results.map((result) => result.reasons), [results[0].reasons, results[0].reasons, results[0].reasons]);
    }
});

test('unrelated valid transport objects cannot broaden the attempt file allowlist', async (context) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-transport-extra-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const transported = await transportedEvidence(directory, { includeUnrelated: true });
    assert.ok(Object.keys(memberships).every((consumerId) => admit(consumerId, transported).eligible));
    const resolved = resolveTransportedCleanAttemptEvidence({ ...transported.transport,
        expectedIdentity: transported.expectedIdentity });
    const unrelated = transported.manifest.objects.at(-1).archiveEntries.find((entry) => entry.role === 'payload');
    assert.equal(resolved.transportEntries.some((entry) => entry.path === unrelated.path), false);
    assert.equal(fs.existsSync(path.join(transported.transportRoot, unrelated.path)), true);
    const files = fileBackedCleanAttemptEvidence(resolved);
    files.loadAggregate();
    assert.throws(() => files.verifyArtifact('unrelated.json', unrelated.digest, { attemptNumber: 1 }),
        /attempt.transport-unbound/u);
});
