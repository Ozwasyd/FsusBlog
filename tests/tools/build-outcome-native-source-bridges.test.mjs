import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { heldBuildOutcomeInputs } from './support/build-outcome-held-input-fixture.mjs';

const { adaptImmutableBuildSemanticOutcome, mapVerifiedProductionBuildOutcomeInputs } = await import(new URL('../../tools/test-matrix/outcomes/immutable-build-adapter.mjs', import.meta.url));
const { adaptReleaseProjectionSemanticOutcome, mapVerifiedReleaseDomainProjectionOutcomeInputs } = await import(new URL('../../tools/test-matrix/outcomes/release-projection-adapter.mjs', import.meta.url));
const { mapCanonicalReleaseFinalizerOutcomePlan } = await import(new URL('../../tools/test-matrix/outcomes/release-finalizer-adapter.mjs', import.meta.url));
const { createProductionBuildReceipt, productionBuildVerificationSchema } = await import(new URL('../../tools/ci/production-build-artifacts.mjs', import.meta.url));
const { createAssertionReport } = await import(new URL('../../tools/test-matrix/release-domain-report.mjs', import.meta.url));
const { evidenceSelectorDigest, sha256File, validateCatalogAgainstLedger } = await import(new URL('../../tools/test-matrix/release-domain-ledger.mjs', import.meta.url));
const { createEvidenceProducerReceipt, projectEvidence, sealProjectionDocument } = await import(new URL('../../tools/test-matrix/evidence-projection.mjs', import.meta.url));
const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const root = path.resolve(import.meta.dirname, '../..');
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const producer = { workflow: 'fixture', runId: 'native-run', runAttempt: 1, job: 'production-build-artifacts' };
const toolchain = { node: '24.16.0', npm: '11', dotnet: '10.0.401', vite: '7',
    vitest: '4', playwright: '1.58', emsdk: '4' };
const digest = (digit) => `sha256:${digit.repeat(64)}`;

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function buildFixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-outcome-native-build-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const artifactRoot = path.join(directory, 'artifacts');
    fs.mkdirSync(path.join(artifactRoot, 'payload'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'input.txt'), 'source');
    fs.writeFileSync(path.join(artifactRoot, 'payload/server.dll'), 'controlled content');
    writeJson(path.join(artifactRoot, 'payload/manifest.json'), { files: ['server.dll'] });
    writeJson(path.join(artifactRoot, 'payload/provenance.json'), { producer: 'controlled' });
    const receipt = createProductionBuildReceipt({ root: directory, artifactRoot, sourceState, producer,
        toolchain, inputPaths: ['input.txt'], domains: [{ name: 'server', path: 'payload' }] });
    return {
        directory, artifactRoot,
        plan: { artifactIds: ['server'], verificationAssertionIds: [productionBuildVerificationSchema] },
        artifactBindings: [{ id: 'server', contentPath: 'payload/server.dll', manifestPath: 'payload/manifest.json',
            provenancePath: 'payload/provenance.json' }],
        verification: { artifactRoot, expectedInputRoot: directory, expectedSourceState: sourceState,
            expectedProducer: producer, expectedToolchain: toolchain, expectedReceiptDigest: receipt.contentDigest }
    };
}

function inputs(mapped, producerId)
{
    return {
        ...mapped,
        identity: { buildIdentity: digest('1'), executionEnvelopeDigest: digest('2'), producerId,
            replayPlanDigest: digest('3'), schedulerRunId: 'native-run', sourceCommit: sourceState.commit,
            temporalContextDigest: digest('5'), toolchainDigest: digest('6'),
            worktreeFingerprint: `sha256:${sourceState.worktreeFingerprint}` },
        inputAuthorityRefs: [{ kind: 'native-source', path: 'receipt.json', digest: digest('8') }],
        attemptEligibility: { aggregateDigest: digest('9'), attemptDigest: digest('c'), attemptNumber: 1,
            cleanFirstAttempt: true, firstFailure: false, qualificationEligible: true }
    };
}

test('build bridge consumes real receipt byte verification and cannot bypass held inputs', (context) =>
{
    const fixture = buildFixture(context);
    const mapped = mapVerifiedProductionBuildOutcomeInputs(fixture);
    assert.equal(mapped.evidence.artifacts[0].contentDigest,
        sha256File(path.join(fixture.artifactRoot, 'payload/server.dll')));
    assert.equal(mapped.evidence.artifacts[0].manifestDigest,
        sha256File(path.join(fixture.artifactRoot, 'payload/manifest.json')));
    assert.equal(mapped.evidence.artifacts[0].provenanceDigest,
        sha256File(path.join(fixture.artifactRoot, 'payload/provenance.json')));
    const value = inputs(mapped, 'immutable-build-semantic-outcome');
    assert.equal(adaptImmutableBuildSemanticOutcome(value).outcome.status, 'failed');
    assert.equal(adaptImmutableBuildSemanticOutcome({ ...value, verifyInputs: heldBuildOutcomeInputs(value) })
        .outcome.status, 'success');
});

test('build bridge refuses changed bytes and does not restore a missing read-only seal', (context) =>
{
    const fixture = buildFixture(context);
    const file = path.join(fixture.artifactRoot, 'payload/server.dll');
    fs.chmodSync(file, 0o644);
    assert.throws(() => mapVerifiedProductionBuildOutcomeInputs(fixture), /read-only seal/u);
    assert.notEqual(fs.statSync(file).mode & 0o222, 0);
    fs.writeFileSync(file, 'controlled changed content');
    fs.chmodSync(file, 0o444);
    assert.throws(() => mapVerifiedProductionBuildOutcomeInputs(fixture), /digest|size/u);
});

test('build bridge requires independent full native expectations and refuses unverified image claims', (context) =>
{
    const fixture = buildFixture(context);
    for (const field of ['expectedInputRoot', 'expectedReceiptDigest', 'expectedSourceState',
        'expectedProducer', 'expectedToolchain'])
    {
        const verification = { ...fixture.verification };
        delete verification[field];
        assert.throws(() => mapVerifiedProductionBuildOutcomeInputs({ ...fixture, verification }), /independent/u);
    }
    assert.throws(() => mapVerifiedProductionBuildOutcomeInputs({ ...fixture,
        artifactBindings: [{ ...fixture.artifactBindings[0], imageDigest: digest('0') }] }), /image-verification owner/u);
    assert.throws(() => mapVerifiedProductionBuildOutcomeInputs({ ...fixture,
        artifactBindings: [{ ...fixture.artifactBindings[0], manifestPath: 'unverified.json' }] }), /verified build receipt/u);
    assert.throws(() => mapVerifiedProductionBuildOutcomeInputs({ ...fixture,
        verification: { ...fixture.verification, expectedSourceState: { ...sourceState, commit: '0'.repeat(40) } } }), /commit/u);
});

function projectionFixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-outcome-native-projection-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const catalog = JSON.parse(fs.readFileSync(path.join(root,
        'tests/fixtures/evidence-projection/release-aot-generation.json'), 'utf8'));
    const ledger = JSON.parse(fs.readFileSync(path.join(root,
        'config/testing/release-domain-assertion-dispositions.json'), 'utf8'));
    writeJson(path.join(directory, catalog.dispositionLedger), ledger);
    const policyIdentity = sha256File(path.join(directory, catalog.dispositionLedger));
    const artifacts = catalog.requiredArtifactDeclarations.map((entry) =>
    {
        writeJson(path.join(directory, entry.path), { controlled: entry.id });
        return { ...entry, digest: sha256File(path.join(directory, entry.path)) };
    });
    const buildIdentity = artifacts.find((entry) => entry.id === catalog.buildIdentityArtifactId).digest;
    const entries = ledger.entries.filter((entry) => entry.canonicalProducer === catalog.projectFrom);
    const lanes = [...new Set(entries.map((entry) => entry.producerEvidence.lane))];
    const sourceArtifacts = lanes.map((lane, index) =>
    {
        const relative = `native/lane-${index}.json`;
        writeJson(path.join(directory, relative), { schema: 'fsusblog.live-grant-execution.v1',
            lane, schedulerRunId: producer.runId, status: 'success',
            children: entries.filter((entry) => entry.producerEvidence.lane === lane)
                .map((entry) => ({ id: entry.producerEvidence.childId, status: 'success' })) });
        return { lane, path: relative, digest: sha256File(path.join(directory, relative)) };
    });
    const assertionReport = createAssertionReport({ producerId: catalog.projectFrom, sourceState,
        runId: producer.runId, namespace: 'native-namespace', buildIdentity, policyIdentity, status: 'success',
        assertions: entries.map((entry) => ({ id: entry.requiredTestId, outcome: 'Passed', executed: true,
            sourceTestIds: entry.sourceTestIds, producerEvidenceDigest: evidenceSelectorDigest(entry.producerEvidence),
            sourceArtifactPaths: [sourceArtifacts.find((artifact) => artifact.lane === entry.producerEvidence.lane).path] })),
        sourceArtifacts: sourceArtifacts.map(({ path: artifactPath, digest: artifactDigest }) => ({ path: artifactPath, digest: artifactDigest })) });
    const assertionPath = 'native/assertions.json';
    writeJson(path.join(directory, assertionPath), assertionReport);
    const domainEntries = validateCatalogAgainstLedger(catalog, ledger);
    const producerReceipt = createEvidenceProducerReceipt({ producerId: catalog.projectFrom,
        logicalTierId: catalog.tierId, sourceState, runId: producer.runId, namespace: 'native-namespace',
        buildIdentity, policyIdentity, assertionReport: { path: assertionPath,
            digest: sha256File(path.join(directory, assertionPath)) },
        assertions: domainEntries.map((entry) => ({ id: entry.requiredTestId, outcome: 'Passed',
            sourceTestIds: entry.sourceTestIds, coverageIds: catalog.requiredCoverageIds,
            artifactIds: entry.requiredArtifactIds })), artifacts });
    const producerReceiptPath = 'native/producer.json';
    writeJson(path.join(directory, producerReceiptPath), producerReceipt);
    const receipt = projectEvidence({ catalog, producerReceipt, producerReceiptPath,
        sourceState, runId: producer.runId, namespace: 'native-namespace', buildIdentity, policyIdentity,
        repositoryRoot: directory });
    const receiptPath = domainEntries[0].outputReceiptPath;
    writeJson(path.join(directory, receiptPath), receipt);
    return { catalog, ledger, repositoryRoot: directory, sourceState, runId: producer.runId,
        namespace: 'native-namespace', buildIdentity, policyIdentity, receiptPath, receipt, sourceArtifacts };
}

test('projection bridge validates canonical catalog, executed report, producer refs and actual output bytes', (context) =>
{
    const fixture = projectionFixture(context);
    const mapped = mapVerifiedReleaseDomainProjectionOutcomeInputs(fixture);
    assert.deepEqual(mapped.plan.projectionIds, [fixture.catalog.tierId]);
    const value = inputs(mapped, 'release-projection-semantic-outcome');
    assert.equal(adaptReleaseProjectionSemanticOutcome(value).outcome.status, 'failed');
    assert.equal(adaptReleaseProjectionSemanticOutcome({ ...value, verifyInputs: heldBuildOutcomeInputs(value) })
        .outcome.status, 'success');
    const changedMetadata = sealProjectionDocument({ ...fixture.receipt, generatedAt: 'metadata only' });
    writeJson(path.join(fixture.repositoryRoot, fixture.receiptPath), changedMetadata);
    const relocated = mapVerifiedReleaseDomainProjectionOutcomeInputs(fixture);
    assert.deepEqual(relocated.evidence.semanticDigests, mapped.evidence.semanticDigests);
    assert.notEqual(relocated.evidence.nativeReceiptDigest, mapped.evidence.nativeReceiptDigest);
});

test('projection bridge refuses physical artifact tamper and incomplete native execution assertions', (context) =>
{
    const fixture = projectionFixture(context);
    const artifact = fixture.catalog.requiredArtifactDeclarations[0];
    const file = path.join(fixture.repositoryRoot, artifact.path);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, 'tampered');
    assert.throws(() => mapVerifiedReleaseDomainProjectionOutcomeInputs(fixture), /digest/u);
    fs.writeFileSync(file, original);
    const nativeFile = path.join(fixture.repositoryRoot, fixture.sourceArtifacts[0].path);
    const actual = JSON.parse(fs.readFileSync(nativeFile, 'utf8'));
    actual.children[0].status = 'failed';
    writeJson(nativeFile, actual);
    assert.throws(() => mapVerifiedReleaseDomainProjectionOutcomeInputs(fixture), /digest|unsuccessful/u);
});

test('projection bridge refuses different native source, build and run identities', (context) =>
{
    const fixture = projectionFixture(context);
    for (const override of [{ runId: 'foreign' }, { buildIdentity: digest('0') },
        { sourceState: { ...sourceState, commit: '0'.repeat(40) } }])
    {
        assert.throws(() => mapVerifiedReleaseDomainProjectionOutcomeInputs({ ...fixture, ...override }), /identity|mismatch/u);
    }
});

test('finalizer outcome plan derives all22 input IDs and output schema from the canonical owner', () =>
{
    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const canonical = JSON.parse(fs.readFileSync(path.join(root,
        'tests/fixtures/test-matrix/release-final-evidence-inputs.json'), 'utf8'));
    const mapped = mapCanonicalReleaseFinalizerOutcomePlan(matrix);
    assert.deepEqual(mapped.inputIds, canonical.inputs);
    assert.equal(mapped.inputIds.length, 22);
    assert.deepEqual(mapped.outputIds, ['fsusblog.release-final-test-evidence-binding.v1']);
    const altered = structuredClone(matrix);
    altered.tiers.find((entry) => entry.id === 'release-final').summaryInputs = [];
    assert.throws(() => mapCanonicalReleaseFinalizerOutcomePlan(altered), /canonical/u);
});
