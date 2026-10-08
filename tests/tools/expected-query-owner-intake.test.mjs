import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { expectedQueryKinds, inspectExpectedQueryOwnerInventory } = await import(new URL('../../tools/data-scale/expected-query-case-catalog.mjs', import.meta.url));
const { buildQueryCaseInventory, buildQuerySemanticOwnerInventory, queryCaseIds } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));
const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Valid synthetic identity invokes source inventory only; no seed, actual query, or receipt is exercised. */
function syntheticInventoryBinding()
{
    return {
        sourceCommit: 'a'.repeat(40),
        dataScaleRunId: 'synthetic-owner-inventory-control',
        fixtureGeneration: 'synthetic-owner-inventory-control',
        seedReceiptDigest: computeSha256('synthetic-owner-seed'),
        expectedModelDigest: computeSha256('synthetic-owner-model'),
        businessEpochUtc: '2024-02-29T23:59:59.000Z'
    };
}

function missingKindsFor(inventory)
{
    return Object.entries(expectedQueryKinds()).flatMap(([domain, kinds]) => kinds
        .filter((kind) => !inventory.cases.some((entry) => entry.domain === domain && entry.kind === kind))
        .map((kind) => ({ domain, kind })));
}

test('owner intake preserves the exact canonical inventory and all native blockers', () =>
{
    const binding = syntheticInventoryBinding();
    const before = structuredClone(binding);
    const native = buildQueryCaseInventory(binding);
    const nativeSemanticOwners = buildQuerySemanticOwnerInventory({ binding, kinds: expectedQueryKinds() });
    const result = inspectExpectedQueryOwnerInventory(binding);
    assert.deepEqual(result.inventory, native);
    assert.deepEqual(result.semanticOwners, nativeSemanticOwners);
    assert.equal(result.semanticOwners.queryInventoryDigest, native.contentDigest);
    assert.deepEqual(binding, before);
    assert.equal(result.status, 'blocked');
    assert.equal(result.qualification, false);
    assert.equal(result.releaseEvidenceEligible, false);
    assert.deepEqual(result.inventory.cases.map((entry) => entry.id), queryCaseIds);
    assert.equal(result.inventory.cases.length, 16);
    assert.equal(result.inventory.qualification, 'not-performed');
    assert.equal(result.inventory.releaseEvidenceEligible, false);
    assert.deepEqual(result.missingKinds, missingKindsFor(native));
    const nativeBlockers = native.cases.flatMap((entry) => entry.blockers.map((blocker) => `query:${entry.id}:${blocker}`));
    const coverageBlockers = result.missingKinds.map(({ domain, kind }) => `coverage:${domain}:${kind}:canonical_query_missing`);
    const ownerBlockers = nativeSemanticOwners.requirements.flatMap((entry) => entry.blockers
        .map((blocker) => `owner:${entry.domain}:${entry.kind}:${blocker}`));
    assert.deepEqual(result.blockers, [...new Set([...nativeBlockers, ...coverageBlockers, ...ownerBlockers])]);
    assert.equal(new Set(result.blockers).size, result.blockers.length);
});

test('only seven declared kinds are consumed and seventeen schema kinds remain missing', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    const declared = new Set(result.inventory.cases.map((entry) => `${entry.domain}:${entry.kind}`));
    assert.equal(declared.size, 7);
    assert.equal(result.missingKinds.length, 17);
    assert.ok(result.missingKinds.some((entry) => entry.domain === 'comment' && entry.kind === 'public-thread'));
    assert.ok(!result.missingKinds.some((entry) => entry.domain === 'comment' && entry.kind === 'pagination-order'));
    const nested = result.inventory.cases.find((entry) => entry.blockers.includes('child_expansion_is_not_full_public_thread'));
    assert.ok(nested);
    assert.equal(nested.kind, 'pagination-order');
    assert.ok(result.blockers.includes(`query:${nested.id}:child_expansion_is_not_full_public_thread`));
    assert.ok(result.blockers.includes('coverage:comment:public-thread:canonical_query_missing'));
});

test('source inventory preserves anonymous actors and missing canonical role/scenario contracts', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    for (const entry of result.inventory.cases)
    {
        assert.equal(entry.actorClass, 'anonymous');
        assert.equal(entry.canonicalRoleBindings, null);
        assert.equal(entry.scenarioApplicability, null);
        assert.ok(result.blockers.includes(`query:${entry.id}:canonical_input_role_bindings_missing`));
        assert.ok(result.blockers.includes(`query:${entry.id}:query_owner_scenario_receipt_intake_missing`));
        for (const field of ['inputs', 'semantics', 'scenarioIds', 'expectedSchema', 'expected', 'actual'])
        {
            assert.equal(Object.hasOwn(entry, field), false, `${entry.id}:${field}`);
        }
    }
});

test('query owner digests are bound to current production source bytes without running production queries', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    for (const entry of result.inventory.cases)
    {
        const source = fs.readFileSync(path.join(repositoryRoot, entry.queryOwner.path));
        assert.equal(entry.queryOwner.contentDigest, computeSha256(source), entry.id);
        assert.equal(entry.queryOwner.version, `source-${entry.queryOwner.contentDigest.slice('sha256:'.length)}`);
    }
    const { contentDigest, ...inventoryContent } = result.inventory;
    assert.equal(contentDigest, computeSha256(inventoryContent));
});

test('native inventory rows cannot become normalized closed query-owner projections', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/schemas/expected-query-case-catalog.schema.json'), 'utf8'));
    const errors = validateJsonSchema(result.inventory.cases, {
        $schema: schema.$schema,
        $defs: schema.$defs,
        $ref: '#/$defs/currentInputs/properties/queryOwners'
    });
    assert.ok(errors.length > 0);
    for (const field of ['inputs', 'semantics', 'scenarioIds', 'expectedSchema'])
    {
        assert.ok(errors.some((error) => error.includes(`required property '${field}'`)), field);
    }
});

test('all twenty-four original semantic declarations retain unresolved contracts without adding cases', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    const vocabulary = expectedQueryKinds();
    const expectedKinds = Object.entries(vocabulary).flatMap(([domain, kinds]) => kinds.map((kind) => ({ domain, kind })));
    assert.deepEqual(result.semanticOwners.requirements.map(({ domain, kind }) => ({ domain, kind })), expectedKinds);
    assert.equal(result.semanticOwners.requirements.length, 24);
    assert.equal(result.semanticOwners.vocabularyDigest, computeSha256(vocabulary));
    assert.equal(result.semanticOwners.qualification, false);
    assert.equal(result.semanticOwners.releaseEvidenceEligible, false);
    assert.equal(Object.hasOwn(result.semanticOwners, 'cases'), false);
    const mappedIds = [];
    for (const requirement of result.semanticOwners.requirements)
    {
        assert.equal(requirement.inputs, null);
        assert.equal(requirement.canonicalRoleBindings, null);
        assert.equal(requirement.scenarioApplicability, null);
        assert.equal(requirement.qualification, false);
        assert.equal(requirement.releaseEvidenceEligible, false);
        assert.deepEqual(requirement.existingCaseIds, result.inventory.cases
            .filter((entry) => entry.domain === requirement.domain && entry.kind === requirement.kind)
            .map((entry) => entry.id));
        mappedIds.push(...requirement.existingCaseIds);
    }
    assert.deepEqual([...mappedIds].sort(), [...queryCaseIds].sort());
    assert.equal(new Set(mappedIds).size, queryCaseIds.length);
    const ownerOnlyKinds = result.semanticOwners.requirements
        .filter((entry) => entry.status === 'owner-declaration-only')
        .map(({ domain, kind }) => ({ domain, kind }));
    assert.deepEqual(ownerOnlyKinds, result.missingKinds);
    assert.equal(result.missingKinds.length, 17);
});

test('all fifty-three business source references preserve current exact bytes and declaration identity', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    const original = buildQuerySemanticOwnerInventory({ binding: syntheticInventoryBinding(), kinds: expectedQueryKinds() });
    const references = result.semanticOwners.requirements.flatMap((entry) => entry.businessOwners);
    assert.equal(references.length, 53);
    assert.deepEqual(result.semanticOwners, original);
    for (const reference of references)
    {
        const bytes = fs.readFileSync(path.join(repositoryRoot, reference.path));
        assert.equal(reference.contentDigest, computeSha256(bytes), reference.entrypoint);
        assert.equal(reference.version, `source-${reference.contentDigest.slice('sha256:'.length)}`);
    }
    const { contentDigest, ...declarationContent } = result.semanticOwners;
    assert.equal(contentDigest, computeSha256(declarationContent));
    // These are source declarations; methods and consistency verifiers are not executed here.
});

test('three consistency declarations preserve the original verifier signature and same-run receipt blocker', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    const consistencyKinds = ['cache-consistency', 'aot-consistency', 'hot-read-consistency'];
    const original = buildQuerySemanticOwnerInventory({ binding: syntheticInventoryBinding(), kinds: expectedQueryKinds() });
    for (const kind of consistencyKinds)
    {
        const requirement = result.semanticOwners.requirements.find((entry) => entry.domain === 'article' && entry.kind === kind);
        const originalRequirement = original.requirements.find((entry) => entry.domain === 'article' && entry.kind === kind);
        assert.deepEqual(requirement, originalRequirement);
        const verifier = requirement.businessOwners.find((owner) => owner.entrypoint === 'FsusBlog.Server.Services.Fixtures.CanonicalArticleProjectionVerifier.VerifyAsync');
        assert.ok(verifier, kind);
        assert.deepEqual(verifier.parameterTypes, [
            'FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationReceipt',
            'FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationRequest',
            'System.Threading.CancellationToken'
        ]);
        const blocker = 'original_same_run_publication_receipt_and_current_invocation_missing';
        assert.ok(requirement.blockers.includes(blocker));
        assert.ok(result.blockers.includes(`owner:article:${kind}:${blocker}`));
        assert.equal(requirement.qualification, false);
    }
});

test('AOT declaration keeps the actual public route and original route identity owner verbatim', () =>
{
    const binding = syntheticInventoryBinding();
    const result = inspectExpectedQueryOwnerInventory(binding);
    const native = buildQuerySemanticOwnerInventory({ binding, kinds: expectedQueryKinds() });
    const requirement = result.semanticOwners.requirements.find((entry) => entry.domain === 'article' && entry.kind === 'aot-consistency');
    assert.deepEqual(requirement, native.requirements.find((entry) => entry.domain === 'article' && entry.kind === 'aot-consistency'));
    assert.deepEqual(requirement.routePatterns, ['/article/{articleId}']);
    assert.ok(requirement.businessOwners.some((owner) => owner.path === 'src/backend/Infrastructure/PublicAot/PublicRouteIdentity.cs'
        && owner.entrypoint === 'FsusBlog.Server.Infrastructure.PublicAot.PublicRouteIdentity.BuildCanonicalPath'));
    assert.ok(requirement.blockers.includes('original_aot_artifact_and_route_identity_missing'));
});

test('original semantic declarations cannot become closed currentInputs query owners', () =>
{
    const result = inspectExpectedQueryOwnerInventory(syntheticInventoryBinding());
    const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/schemas/expected-query-case-catalog.schema.json'), 'utf8'));
    const errors = validateJsonSchema(result.semanticOwners.requirements, {
        $schema: schema.$schema,
        $defs: schema.$defs,
        $ref: '#/$defs/currentInputs/properties/queryOwners'
    });
    assert.ok(errors.length > 0);
    for (const field of ['id', 'queryOwner', 'actorClass', 'semantics', 'scenarioIds', 'expectedSchema'])
    {
        assert.ok(errors.some((error) => error.includes(`required property '${field}'`)), field);
    }
    assert.ok(errors.some((error) => error.includes('/inputs must be array')));
});

for (const [name, binding] of [
    ['missing identity', {}],
    ['null identity', null],
    ['invalid source commit', { ...syntheticInventoryBinding(), sourceCommit: 'synthetic-not-a-commit' }],
    ['invalid business epoch', { ...syntheticInventoryBinding(), businessEpochUtc: 'not-an-epoch' }]
])
{
    test(`original invalid-binding exception is preserved for ${name}`, () =>
    {
        let nativeError;
        assert.throws(() => buildQueryCaseInventory(binding), (error) =>
        {
            nativeError = error;
            return /query binding/u.test(error.message);
        });
        assert.throws(() => inspectExpectedQueryOwnerInventory(binding), (error) =>
        {
            assert.equal(error.constructor, nativeError.constructor);
            assert.equal(error.message, nativeError.message);
            return true;
        });
    });
}
