import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { buildAggregatePlan } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/aggregate-plan.mjs')).href
);
const { validateEvidenceExecutionDeclaration } = await import(
    pathToFileURL(path.join(root, 'tools/test-matrix/projection-declaration.mjs')).href
);

function fixtureMatrix({ manualOnly = false } = {})
{
    return {
        aggregateAuthorities: {
            'release-summary': {
                id: 'release-summary',
                commandKind: 'aggregate',
                ciJob: 'release-summary',
                summaryTierIds: ['release-summary-tier'],
                inputReceiptSchemas: ['fsusblog.ci.job-result.v1'],
                outputReceiptSchema: 'fsusblog.ci.job-result.v1'
            }
        },
        tiers: [
            {
                id: 'canonical-producer',
                ciJob: 'canonical-producer',
                executionMode: 'execute',
                artifacts: ['.tmp/canonical/receipt.json'],
                evidence: ['.tmp/canonical/receipt.json']
            },
            {
                id: 'release-summary-tier',
                ciJob: 'release-summary',
                executionMode: 'summary',
                commandKind: 'aggregate',
                summaryAuthority: 'release-summary',
                summaryInputs: ['fsusblog.ci.job-result.v1'],
                outputReceiptSchema: 'fsusblog.ci.job-result.v1',
                command: 'node tools/run-test-matrix.mjs aggregate release-summary',
                dependsOn: ['canonical-producer'],
                localOnly: false,
                nightlyOnly: false,
                manualOnly
            }
        ]
    };
}

test('aggregate planner resolves a declared artifact-only authority without spawning producers', () => {
    const plan = buildAggregatePlan(fixtureMatrix(), 'release-summary');
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.selectedTierIds, ['release-summary-tier']);
    assert.deepEqual(plan.dependencyJobs, ['canonical-producer']);
    assert.deepEqual(plan.requiredReceiptInputs, ['.tmp/canonical/receipt.json']);
    assert.equal(plan.executesTestCommands, false);
});

test('aggregate planner rejects unknown, tier-id, and filter-empty targets', () => {
    assert.deepEqual(buildAggregatePlan(fixtureMatrix(), 'release-admin-console').errors, [
        'unknown aggregate authority: release-admin-console'
    ]);
    assert.deepEqual(buildAggregatePlan(fixtureMatrix({ manualOnly: true }), 'release-summary').errors, [
        'release-summary selects no non-excluded tiers for ciJob release-summary',
        'release-summary.summaryTierIds must exactly match its non-excluded selected tiers',
        'release-summary must resolve at least one dependency job',
        'release-summary must resolve declared receipt or artifact inputs'
    ]);
});

test('summary declarations reject missing inputs, producer modes, invalid targets, and output mismatches', () => {
    const matrix = fixtureMatrix();
    const valid = matrix.tiers[1];
    assert.deepEqual(validateEvidenceExecutionDeclaration(valid, matrix), []);

    const missingInputs = { ...valid, summaryInputs: [] };
    assert.ok(validateEvidenceExecutionDeclaration(missingInputs, matrix).some((error) => error.includes('summaryInputs')));

    const producerKind = { ...valid, commandKind: 'producer' };
    assert.ok(validateEvidenceExecutionDeclaration(producerKind, matrix).some((error) => error.includes('commandKind')));

    const invalidTarget = {
        ...valid,
        summaryAuthority: 'release-admin-console',
        command: 'node tools/run-test-matrix.mjs aggregate release-admin-console'
    };
    assert.ok(validateEvidenceExecutionDeclaration(invalidTarget, matrix).some((error) => error.includes('unknown aggregate authority')));

    const wrongSchema = { ...valid, outputReceiptSchema: 'fsusblog.other-receipt.v1' };
    assert.ok(validateEvidenceExecutionDeclaration(wrongSchema, matrix).some((error) => error.includes('outputReceiptSchema')));
});

test('projection declarations require a catalog, exact IDs, artifact declarations, and projection command kind', () => {
    const invalidProjection = {
        id: 'release-projection',
        executionMode: 'projection',
        commandKind: 'aggregate',
        outputReceiptSchema: 'fsusblog.evidence-projection-receipt.v1',
        command: 'node tools/run-test-matrix.mjs aggregate release-summary',
        dependsOn: [],
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
    const errors = validateEvidenceExecutionDeclaration(invalidProjection, fixtureMatrix());
    assert.ok(errors.some((error) => error.includes('projectionCatalog')));
    assert.ok(errors.some((error) => error.includes('requiredTestIds')));
    assert.ok(errors.some((error) => error.includes('commandKind')));
});
