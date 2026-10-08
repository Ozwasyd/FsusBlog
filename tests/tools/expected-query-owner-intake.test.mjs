import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { expectedQueryKinds, inspectExpectedQueryOwnerInventory } = await import(new URL('../../tools/data-scale/expected-query-case-catalog.mjs', import.meta.url));
const { buildQueryCaseInventory, queryCaseIds } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));
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
    const result = inspectExpectedQueryOwnerInventory(binding);
    assert.deepEqual(result.inventory, native);
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
    assert.deepEqual(result.blockers, [...new Set([...nativeBlockers, ...coverageBlockers])]);
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
