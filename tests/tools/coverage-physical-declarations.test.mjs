import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { compileCoveragePhysicalAccessDeclarations, compileCoveragePhysicalTerminalDeclarations, coveragePhysicalAccessDeclarationSchema } = await import(new URL('../../tools/test-matrix/coverage-physical-declarations.mjs', import.meta.url));
const { physicalProducerFilesystemCatalogSchema } = await import(new URL('../../tools/test-matrix/physical-producer-filesystem.mjs', import.meta.url));
const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { coverageCompilerFixture } = await import(new URL('./support/atomic-coverage-compiler-fixtures.mjs', import.meta.url));

function fixture(t)
{
    const coverageInput = coverageCompilerFixture(t);
    const declarations = compileCoveragePhysicalTerminalDeclarations(coverageInput);
    const ownerAccess = sealContentDigest({
        schema: coveragePhysicalAccessDeclarationSchema,
        identity: coverageInput.plan.identity,
        terminalDeclarationsDigest: declarations.contentDigest,
        producerClosureRefs: Object.fromEntries(declarations.terminalDeclarations
            .filter((item) => item.spawnEligibility).map((item) => [item.producerId, item.inputClosureRef])),
        // Deliberately conservative test-only footprint, not native collector declarations.
        catalog: {
            schema: physicalProducerFilesystemCatalogSchema,
            domains: [{ domainId: 'controlled-repository', rootIds: ['repository'],
                sourceOfDeclaration: 'controlled broad test-only owner footprint' }],
            producers: coverageInput.plan.producers.map((producer) => ({
                producerId: producer.id,
                ownerKind: 'executable',
                sourceOfDeclaration: 'controlled broad test-only owner footprint',
                accesses: [{ rootId: 'repository', domainId: 'controlled-repository', accessMode: 'write' }]
            }))
        },
        unknownAccess: false,
        ownerRef: { id: 'controlled-coverage-access-owner', contentDigest: `sha256:${'a'.repeat(64)}` }
    });
    return { coverageInput, ownerAccess,
        roots: [{ rootId: 'repository', path: fs.realpathSync.native(coverageInput.root),
            boundaryPath: fs.realpathSync.native(coverageInput.root), role: 'repository' }],
        context: { runId: coverageInput.plan.identity.runId, attemptId: 'controlled-access-attempt',
            sourceState: { commit: coverageInput.plan.identity.sourceCommit,
                worktreeFingerprint: coverageInput.plan.identity.sourceFingerprint } },
        verifyAccessOwner: (packet, expected) =>
        {
            assert.deepEqual(packet, ownerAccess);
            return expected;
        }
    };
}

test('physical and settled terminal declarations come from the actual coverage compiler attachment', (t) =>
{
    const input = coverageCompilerFixture(t);
    const result = compileCoveragePhysicalTerminalDeclarations(input);
    assert.deepEqual(result.physicalOwners.filter((owner) => owner.spawnEligibility).map((owner) => owner.producerId).sort(),
        input.plan.producers.map((producer) => producer.id).sort());
    assert.deepEqual(result.physicalOwners.filter((owner) => !owner.spawnEligibility).map((owner) => owner.producerId).sort(),
        input.plan.projections.map((projection) => projection.id).sort());
    for (const projection of input.plan.projections)
    {
        const declaration = result.terminalDeclarations.find((item) => item.producerId === projection.id);
        assert.deepEqual(declaration.settledDependsOn, [...projection.settledDependsOn].sort());
        assert.equal(declaration.spawnEligibility, false);
        assert.equal(Object.hasOwn(declaration, 'commandSourceRef'), false);
        assert.equal(Object.hasOwn(declaration, 'attemptPolicyId'), false);
    }
    assert.equal(result.completeProductionCatalog, false);
    assert.equal(result.qualificationEligible, false);
    assert.equal(result.executionEligible, false);
});

test('terminal declarations preserve physical command closure replay resources services and public output bindings', (t) =>
{
    const input = coverageCompilerFixture(t);
    const result = compileCoveragePhysicalTerminalDeclarations(input);
    for (const producer of input.plan.producers)
    {
        const original = input.matrix.atomicProducerDeclarations.nodes.find((node) => node.producerId === producer.id);
        const declaration = result.terminalDeclarations.find((item) => item.producerId === producer.id);
        for (const field of ['commandSourceRef', 'replayPlanRef', 'resourceContractRef', 'fixtureProfile',
            'stateAccessRef', 'serviceDependencies', 'attemptPolicyId', 'dependsOn'])
        {
            assert.deepEqual(declaration[field], original[field]);
        }
        assert.deepEqual(declaration.outputBindings, producer.outputs.map((output) => ({
            artifactId: `${producer.id}-${output.role}`, ...output
        })));
        assert.equal(declaration.receiptSchema, 'fsusblog.atomic-producer-terminal-receipt.v1');
        assert.equal(declaration.vectorSchema, 'fsusblog.atomic-producer-terminal-vector.v1');
        assert.equal(declaration.requiresCurrentAttempt, true);
        assert.equal(declaration.qualificationEligible, false);
    }
});

test('declaration compilation is stable and does not run producers or change requests and authorities', (t) =>
{
    const input = coverageCompilerFixture(t);
    const before = { plan: structuredClone(input.plan), matrix: structuredClone(input.matrix), authorities: structuredClone(input.authorities) };
    const requestBytes = input.requests.map((item) => fs.readFileSync(path.join(input.root, item.request.requestPath), 'utf8'));
    assert.deepEqual(compileCoveragePhysicalTerminalDeclarations(input), compileCoveragePhysicalTerminalDeclarations(input));
    assert.deepEqual({ plan: input.plan, matrix: input.matrix, authorities: input.authorities }, before);
    assert.deepEqual(input.requests.map((item) => fs.readFileSync(path.join(input.root, item.request.requestPath), 'utf8')), requestBytes);
    assert.equal(fs.existsSync(path.join(input.root, '.tmp/attempts')), false);
    assert.equal(fs.existsSync(path.join(input.root, '.tmp/coverage')), false);
});

test('explicit owner footprint creates a native filesystem fragment with exact executable ownership only', (t) =>
{
    const input = fixture(t);
    const result = compileCoveragePhysicalAccessDeclarations(input);
    assert.deepEqual(result.filesystemPlan.producers.map((producer) => producer.producerId).sort(),
        input.coverageInput.plan.producers.map((producer) => producer.id).sort());
    assert.ok(result.filesystemPlan.producers.every((producer) => producer.resolvedRoots.length === 1
        && producer.resolvedRoots[0].accessMode === 'write'));
    assert.deepEqual(result.filesystemPlan.context, input.context);
    assert.equal(result.ownerAccessDigest, input.ownerAccess.contentDigest);
    assert.equal(result.completeProductionCatalog, false);
    assert.equal(result.executionEligible, false);
    assert.equal(result.qualificationEligible, false);
    assert.equal(fs.existsSync(path.join(input.coverageInput.root, '.tmp/attempts')), false);
});

test('missing owner packet or independent owner verifier remains an explicit source capability gap', (t) =>
{
    const input = fixture(t);
    assert.throws(() => compileCoveragePhysicalAccessDeclarations({ ...input, ownerAccess: undefined }), /requires coverage owner access packet/u);
    assert.throws(() => compileCoveragePhysicalAccessDeclarations({ ...input, verifyAccessOwner: undefined }), /owner verifier unavailable/u);
});

test('unverified current owner cannot authorize access declarations', (t) =>
{
    const input = fixture(t);
    assert.throws(() => compileCoveragePhysicalAccessDeclarations({ ...input,
        verifyAccessOwner: () => ({ status: 'unavailable' }) }), /owner verification mismatch/u);
});
