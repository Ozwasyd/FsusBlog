import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const {
    createEvidenceProducerReceipt,
    evidenceProjectionCatalogSchema,
    evidenceProjectionReceiptSchema,
    projectEvidence,
    sealProjectionDocument
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test-matrix/evidence-projection.mjs')).href);
const { validateEvidenceExecutionDeclaration } = await import(pathToFileURL(
    path.join(repositoryRoot, 'tools/test-matrix/projection-declaration.mjs')
).href);

const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
};

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-projection-'));
    const artifactPath = 'evidence/canonical.json';
    const absoluteArtifactPath = path.join(root, artifactPath);
    fs.mkdirSync(path.dirname(absoluteArtifactPath), { recursive: true });
    fs.writeFileSync(absoluteArtifactPath, '{"status":"Passed"}\n');
    const artifactDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absoluteArtifactPath)).digest('hex')}`;
    const producerReceipt = createEvidenceProducerReceipt({
        producerId: 'canonical-backend',
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        assertions: [
            { id: 'Backend.A', outcome: 'Passed', sourceTestIds: ['xunit:BackendTests.A'], coverageIds: ['coverage:a'], artifactIds: ['backend-trx'] },
            { id: 'Backend.B', outcome: 'Passed', sourceTestIds: ['xunit:BackendTests.B'], coverageIds: ['coverage:b'], artifactIds: ['backend-trx'] },
            { id: 'Backend.C', outcome: 'Passed', sourceTestIds: ['xunit:BackendTests.C'], coverageIds: ['coverage:c'], artifactIds: [] }
        ],
        artifacts: [{ id: 'backend-trx', path: artifactPath, digest: artifactDigest }],
        generatedAt: '2026-07-22T00:00:00.000Z'
    });
    const catalog = (tierId, requiredTestIds, requiredCoverageIds) => ({
        schema: evidenceProjectionCatalogSchema,
        tierId,
        executionOwner: 'canonical-backend',
        projectFrom: 'canonical-backend',
        requiredTestIds,
        requiredCoverageIds,
        requiredArtifactDeclarations: [{ id: 'backend-trx', path: artifactPath }]
    });
    return { root, artifactPath, absoluteArtifactPath, producerReceipt, catalog };
}

function project(values, catalog)
{
    return projectEvidence({
        catalog,
        producerReceipt: values.producerReceipt,
        producerReceiptPath: 'evidence/producer.json',
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        repositoryRoot: values.root,
        generatedAt: '2026-07-22T00:01:00.000Z'
    });
}

function reseal(value)
{
    return sealProjectionDocument(structuredClone(value));
}

test('one canonical producer projects two independent logical tier receipts without runner launches', () =>
{
    const values = fixture();
    const first = project(values, values.catalog('rights-v3', ['Backend.A'], ['coverage:a']));
    const second = project(values, values.catalog('integrity-proof', ['Backend.B'], ['coverage:b']));

    assert.equal(first.schema, evidenceProjectionReceiptSchema);
    assert.equal(second.schema, evidenceProjectionReceiptSchema);
    assert.notEqual(first.contentDigest, second.contentDigest);
    assert.deepEqual(first.executionBoundary, {
        childProcessCount: 0,
        dotnetTestLaunchCount: 0,
        vitestLaunchCount: 0,
        playwrightLaunchCount: 0,
        runtimeProbeLaunchCount: 0
    });
    assert.deepEqual(second.testIds, ['Backend.B']);
    assert.deepEqual(second.assertions[0].sourceTestIds, ['xunit:BackendTests.B']);
});

test('projection fails closed for missing and duplicate test IDs', () =>
{
    const values = fixture();
    assert.throws(() => project(values, values.catalog('missing', ['Backend.Z'], ['coverage:z'])), /missing required test ID/u);
    const duplicate = structuredClone(values.producerReceipt);
    duplicate.assertions.push(structuredClone(duplicate.assertions[0]));
    values.producerReceipt = reseal(duplicate);
    assert.throws(() => project(values, values.catalog('duplicate', ['Backend.A'], ['coverage:a'])), /duplicate IDs/u);
});

test('projection rejects failed outcomes and incomplete coverage', () =>
{
    const values = fixture();
    const failed = structuredClone(values.producerReceipt);
    failed.assertions[0].outcome = 'Failed';
    values.producerReceipt = reseal(failed);
    assert.throws(() => project(values, values.catalog('failed', ['Backend.A'], ['coverage:a'])), /did not pass/u);

    values.producerReceipt = fixture().producerReceipt;
    assert.throws(() => project(values, values.catalog('coverage', ['Backend.A'], ['coverage:a', 'coverage:missing'])), /do not exactly match/u);
});

test('projection rejects wrong source, run, namespace and stale receipt digest', () =>
{
    const values = fixture();
    const base = {
        catalog: values.catalog('identity', ['Backend.A'], ['coverage:a']),
        producerReceipt: values.producerReceipt,
        producerReceiptPath: 'evidence/producer.json',
        sourceState,
        runId: 'run-1',
        namespace: 'namespace-1',
        repositoryRoot: values.root
    };
    assert.throws(() => projectEvidence({ ...base, sourceState: { ...sourceState, commit: 'c'.repeat(40) } }), /commit/u);
    assert.throws(() => projectEvidence({ ...base, sourceState: { ...sourceState, worktreeFingerprint: 'd'.repeat(64) } }), /worktree fingerprint/u);
    assert.throws(() => projectEvidence({ ...base, runId: 'run-2' }), /another run/u);
    assert.throws(() => projectEvidence({ ...base, namespace: 'namespace-2' }), /another namespace/u);
    const stale = structuredClone(values.producerReceipt);
    stale.generatedAt = '2020-01-01T00:00:00.000Z';
    assert.throws(() => projectEvidence({ ...base, producerReceipt: stale }), /content digest mismatch/u);
});

test('projection rejects wrong artifact path and digest', () =>
{
    const values = fixture();
    const wrongPath = values.catalog('path', ['Backend.A'], ['coverage:a']);
    wrongPath.requiredArtifactDeclarations[0].path = 'evidence/other.json';
    assert.throws(() => project(values, wrongPath), /artifact path mismatch/u);

    fs.writeFileSync(values.absoluteArtifactPath, '{"status":"tampered"}\n');
    assert.throws(() => project(values, values.catalog('digest', ['Backend.A'], ['coverage:a'])), /artifact digest mismatch/u);
});

test('matrix declaration accepts a strict projector and rejects missing owner, source, IDs and artifacts', () =>
{
    const declaration = {
        id: 'logical-tier',
        executionMode: 'projection',
        executionOwner: 'canonical-backend',
        projectFrom: 'canonical-backend',
        projectionCatalog: 'tests/fixtures/evidence-projection/catalog.json',
        requiredTestIds: ['Backend.A'],
        requiredCoverageIds: ['coverage:a'],
        requiredArtifactDeclarations: [{ id: 'backend-trx', path: '.tmp/backend.trx' }],
        requiresEvidenceFrom: ['canonical-backend'],
        command: 'node tools/test/project-evidence.mjs --catalog catalog.json',
        dependsOn: ['canonical-backend'],
        services: [],
        exclusiveResources: [],
        requiresBootstrap: 'none',
        requiresDotnet: false,
        requiresNode: true,
        requiresPlaywright: 'none',
        cacheProfile: 'none',
        resourceClass: 'io',
        cost: 'low'
    };
    assert.deepEqual(validateEvidenceExecutionDeclaration(declaration), []);

    for (const field of ['executionOwner', 'projectFrom', 'requiredTestIds', 'requiredCoverageIds', 'requiredArtifactDeclarations'])
    {
        const invalid = structuredClone(declaration);
        delete invalid[field];
        assert.notDeepEqual(validateEvidenceExecutionDeclaration(invalid), [], `${field} must fail closed`);
    }
    assert.match(
        validateEvidenceExecutionDeclaration({ ...declaration, command: `${declaration.command} && dotnet test` }).join('\n'),
        /exclusively/u
    );
});
