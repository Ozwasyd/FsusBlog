import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildFixtureProfileMatrixInventory,
    classifyTierExecutionClass,
    expectedFixtureProfileReason,
    FIXTURE_EXECUTION_CLASSES,
    validateFixtureProfileMatrix
} from '../../tools/test-matrix/fixture-profile-contract.mjs';
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs';
import { validateJsonSchema } from '../../tools/test-matrix/schema-validator/validate.mjs';
import { validateFixtureCatalogs } from '../../tools/testing/fixture-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(path.join(root, 'config/testing/fixture-profile-catalog.json'), 'utf8'));
const profileIds = new Set(catalog.profiles.map((item) => item.id));

function profileTier(id, fixtureProfile, executionClass)
{
    return {
        id,
        executionClass,
        fixtureProfile,
        fixtureProfileReason: expectedFixtureProfileReason({ id, executionClass, fixtureProfile }),
        fixtureProfileProof: 'tests/tools/matrix-fixture-profile.test.mjs',
        fixtureMutatorAllowed: fixtureProfile !== 'none'
    };
}

function errorsFor(matrix, { catalogFile = path.join(root, 'config/testing/fixture-profile-catalog.json') } = {})
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-profile-matrix-'));
    const inventoryFile = path.join(directory, 'fixture-profile-matrix.generated.json');
    writeFileSync(inventoryFile, JSON.stringify(buildFixtureProfileMatrixInventory(matrix)));
    try
    {
        return validateFixtureProfileMatrix(matrix, { inventoryFile, catalogFile });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

function fixtureCatalogErrorsForMatrix(tiersYaml)
{
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-profile-matrix-file-'));
    const matrixFile = path.join(directory, 'matrix.yml');
    writeFileSync(matrixFile, `version: fsusblog-test-matrix-v2\ntiers:\n${tiersYaml}`);
    try
    {
        return validateFixtureCatalogs({ matrixFile, validateRepositoryAuthority: false });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
}

function matrixTierYaml(id, executionClass, fixtureProfile)
{
    return `  - id: ${id}
    executionClass: ${executionClass}
${executionClass === 'coordination' ? '    executionMode: summary\n' : ''}    fixtureProfile: ${fixtureProfile}
    fixtureProfileReason: ${fixtureProfile === 'none' ? `none-${executionClass}` : `binds-${fixtureProfile}`}
    fixtureProfileProof: tests/tools/matrix-fixture-profile.test.mjs
    fixtureMutatorAllowed: ${fixtureProfile !== 'none'}
    requiresBootstrap: none
    command: node tools/run-test-matrix.mjs aggregate ${id}-summary
    executionDependsOn: []
`;
}

test('every executable matrix step binds exactly one valid fixtureProfile', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    assert.deepEqual(validateFixtureProfileMatrix(matrix), []);
    const inventory = buildFixtureProfileMatrixInventory(matrix);
    assert.equal(inventory.schema, 'fsusblog.fixture-profile-matrix.v1');
    assert.equal(inventory.entries.length, matrix.tiers.length);
    assert.equal(inventory.digest.startsWith('sha256:'), true);
    assert.deepEqual(buildFixtureProfileMatrixInventory(matrix), inventory);
    for (const entry of inventory.entries)
    {
        const tier = matrix.tiers.find((candidate) => candidate.id === entry.tierId);
        assert.equal(entry.executionClass, tier.executionClass);
        assert.equal(entry.fixtureProfile, tier.fixtureProfile);
        assert.equal(entry.fixtureProfileReason, tier.fixtureProfileReason);
        assert.equal(entry.fixtureMutatorAllowed, tier.fixtureMutatorAllowed);
    }
});

test('runtime-cache pagination binds the dedicated deep-keyset fixture profile', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const tier = matrix.tiers.find((item) => item.id === 'runtime-cache-pagination');
    assert.equal(tier.fixtureProfile, 'runtime-cache-pagination');
    assert.equal(tier.fixtureProfileReason, 'binds-runtime-cache-pagination');
    const profile = catalog.profiles.find((item) => item.id === tier.fixtureProfile);
    assert.deepEqual(profile.capabilities, ['public.article.pagination-deep']);
    assert.equal(profile.requiresFreshNamespace, true);
});

test('missing/null/empty/free-command fixtureProfile fails closed', () =>
{
    const missing = errorsFor({ tiers: [profileTier('sample', 'none', 'runtime')] });
    assert.deepEqual(missing, []);
    const withMissing = { tiers: [{ id: 'sample', executionClass: 'runtime' }] };
    assert.match(errorsFor(withMissing).join('\n'), /must bind fixtureProfile/);
    assert.match(validateJsonSchema(withMissing, schema).join('\n'), /must have required property 'fixtureProfile'/);
    const withNull = { tiers: [profileTier('sample', 'none', 'runtime'), { ...profileTier('other', 'none', 'runtime'), fixtureProfile: null }] };
    assert.match(errorsFor(withNull).join('\n'), /unknown fixture profile/);
    const withEmpty = { tiers: [profileTier('sample', 'none', 'runtime'), { ...profileTier('other', 'none', 'runtime'), fixtureProfile: '' }] };
    assert.match(errorsFor(withEmpty).join('\n'), /unknown fixture profile/);
    const withFreeCommand = { tiers: [profileTier('sample', 'none', 'runtime'), { ...profileTier('other', 'none', 'runtime'), fixtureProfile: 'npm run test -- --watch' }] };
    assert.match(errorsFor(withFreeCommand).join('\n'), /unknown fixture profile/);
});

test('coordination/static/build-only steps must fix fixtureProfile to none', () =>
{
    assert.match(fixtureCatalogErrorsForMatrix(matrixTierYaml('fast', 'coordination', 'auth-basic')).join('\n'), /matrix non-consumer fast must use fixtureProfile none/);
    assert.match(fixtureCatalogErrorsForMatrix(matrixTierYaml('static-governance', 'static-governance', 'public-minimal')).join('\n'), /matrix non-consumer static-governance must use fixtureProfile none/);
    assert.match(fixtureCatalogErrorsForMatrix(matrixTierYaml('frontend-build', 'build', 'auth-basic')).join('\n'), /matrix non-consumer frontend-build must use fixtureProfile none/);
    const ok = fixtureCatalogErrorsForMatrix(matrixTierYaml('fast', 'coordination', 'none')).join('\n');
    assert.doesNotMatch(ok, /must use fixtureProfile none/);
});

test('runtime/browser steps reject unknown, deprecated and tier-name profile values', () =>
{
    const unknown = { tiers: [profileTier('sample', 'acceptance-representativ', 'runtime')] };
    assert.match(errorsFor(unknown).join('\n'), /unknown fixture profile/);
    const tierName = { tiers: [profileTier('sample', 'acceptance', 'runtime')] };
    assert.match(errorsFor(tierName).join('\n'), /unknown fixture profile/);
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-profile-deprecated-'));
    try
    {
        const deprecatedCatalog = JSON.parse(JSON.stringify(catalog));
        deprecatedCatalog.profiles.find((item) => item.id === 'auth-basic').status = 'deprecated';
        const catalogFile = path.join(directory, 'fixture-profile-catalog.json');
        writeFileSync(catalogFile, JSON.stringify(deprecatedCatalog));
        const deprecated = { tiers: [profileTier('sample', 'auth-basic', 'runtime')] };
        assert.match(errorsFor(deprecated, { catalogFile }).join('\n'), /references deprecated fixture profile auth-basic/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('none is an explicit zero-data contract distinct from a missing declaration', () =>
{
    assert.deepEqual(errorsFor({ tiers: [profileTier('sample', 'none', 'runtime')] }), []);
    const missing = { tiers: [{ id: 'sample', fixtureProfile: undefined, executionClass: 'runtime' }] };
    assert.match(errorsFor(missing).join('\n'), /must bind fixtureProfile/);
});

test('old fixture field, compat alias and second profile table are rejected', () =>
{
    const oldField = { tiers: [{ ...profileTier('sample', 'none', 'runtime'), fixtureCapabilities: [] }] };
    assert.match(errorsFor(oldField).join('\n'), /must not declare retired fixtureCapabilities field/);
    const alias = { tiers: [{ ...profileTier('sample', 'none', 'runtime'), fixtureProfileAlias: 'legacy' }] };
    assert.match(validateJsonSchema(alias, schema).join('\n'), /fixtureProfileAlias/);
    const secondTable = { tiers: [{ ...profileTier('sample', 'none', 'runtime'), fixtureProfiles: ['auth-basic'] }] };
    assert.match(validateJsonSchema(secondTable, schema).join('\n'), /fixtureProfiles/);
});

test('new step without declaration and malformed contract fields fail closed', () =>
{
    const newTier = { tiers: [{ id: 'brand-new-step', command: 'node tools/test/check.mjs' }] };
    assert.match(errorsFor(newTier).join('\n'), /must bind executionClass, fixtureProfile, fixtureProfileReason, fixtureProfileProof, fixtureMutatorAllowed/);
    const wrongReason = { tiers: [profileTier('sample', 'auth-basic', 'runtime')] };
    wrongReason.tiers[0].fixtureProfileReason = 'none-runtime';
    assert.match(errorsFor(wrongReason).join('\n'), /fixtureProfileReason must be binds-auth-basic/);
    const wrongMutator = { tiers: [profileTier('sample', 'none', 'runtime')] };
    wrongMutator.tiers[0].fixtureMutatorAllowed = true;
    assert.match(errorsFor(wrongMutator).join('\n'), /fixtureMutatorAllowed must be false/);
    const wrongClass = { tiers: [profileTier('sample', 'none', 'banana')] };
    assert.match(errorsFor(wrongClass).join('\n'), /unknown executionClass banana/);
    const mismatchedClass = { tiers: [profileTier('sample', 'none', 'coordination')] };
    assert.match(errorsFor(mismatchedClass).join('\n'), /executionClass must be runtime/);
    const badProof = { tiers: [profileTier('sample', 'none', 'runtime')] };
    badProof.tiers[0].fixtureProfileProof = 'not/a/test.txt';
    assert.match(errorsFor(badProof).join('\n'), /fixtureProfileProof must reference a tests\/tools focused test/);
});

test('duplicate profile ids fail closed in the canonical catalog validator', () =>
{
    const names = ['capability', 'profile', 'producer', 'inventory', 'variant'];
    const directory = mkdtempSync(path.join(tmpdir(), 'fixture-profile-dup-'));
    try
    {
        const data = {
            capability: JSON.parse(readFileSync(path.join(root, 'config/testing/fixture-capability-catalog.json'), 'utf8')),
            profile: JSON.parse(readFileSync(path.join(root, 'config/testing/fixture-profile-catalog.json'), 'utf8')),
            producer: JSON.parse(readFileSync(path.join(root, 'config/testing/fixture-producer-registry.json'), 'utf8')),
            inventory: JSON.parse(readFileSync(path.join(root, 'config/testing/fixture-consumer-inventory.generated.json'), 'utf8')),
            variant: JSON.parse(readFileSync(path.join(root, 'config/testing/fixture-variant-catalog.json'), 'utf8'))
        };
        data.profile.profiles.push(JSON.parse(JSON.stringify(data.profile.profiles.find((item) => item.id === 'auth-basic'))));
        const files = Object.fromEntries(names.map((name) => [name, path.join(directory, `${name}.json`)]));
        for (const name of names)
        {
            writeFileSync(files[name], JSON.stringify(data[name]));
        }
        assert.match(validateFixtureCatalogs({ files, validateRepositoryAuthority: false }).join('\n'), /duplicate profile id auth-basic/);
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('inventory digest is stable for identical input and changes with declarations', () =>
{
    const matrixA = { tiers: [profileTier('sample', 'none', 'runtime')] };
    const matrixB = { tiers: [profileTier('sample', 'auth-basic', 'runtime')] };
    const first = buildFixtureProfileMatrixInventory(matrixA);
    assert.deepEqual(buildFixtureProfileMatrixInventory(matrixA), first);
    assert.notEqual(buildFixtureProfileMatrixInventory(matrixB).digest, first.digest);
    assert.equal(first.entries[0].fixtureMutatorAllowed, false);
    assert.equal(buildFixtureProfileMatrixInventory(matrixB).entries[0].fixtureMutatorAllowed, true);
});

test('closed execution-class vocabulary is stable and classification is deterministic', () =>
{
    assert.deepEqual(FIXTURE_EXECUTION_CLASSES, [
        'acceptance', 'benchmark', 'browser', 'build', 'coordination', 'diagnostic',
        'development', 'load', 'runtime', 'security', 'static-governance'
    ]);
    assert.equal(classifyTierExecutionClass({ id: 'sample' }), 'runtime');
    assert.equal(classifyTierExecutionClass({ id: 'backend-qps-view-count-flush' }), 'load');
    assert.equal(classifyTierExecutionClass({ id: 'security' }), 'security');
    assert.equal(classifyTierExecutionClass({ id: 'frontend-build' }), 'build');
    assert.equal(classifyTierExecutionClass({ id: 'fast', executionMode: 'summary' }), 'coordination');
});

test('source declaration and governance tiers coordinate checks without fixture mutation', () =>
{
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    for (const id of ['validate-declarations', 'source-governance'])
    {
        const tier = matrix.tiers.find((candidate) => candidate.id === id);
        assert.equal(tier.executionClass, 'coordination');
        assert.equal(tier.qualificationEligible, false);
        assert.equal(tier.fixtureProfile, 'none');
        assert.equal(tier.fixtureMutatorAllowed, false);
        assert.equal(tier.requiresBootstrap, 'none');
        assert.equal(tier.requiresDotnet, false);
        assert.equal(tier.requiresPlaywright, 'none');
        assert.deepEqual(tier.services, []);
        assert.equal(classifyTierExecutionClass(tier), 'coordination');
        assert.equal(expectedFixtureProfileReason(tier), 'none-coordination');
        assert.deepEqual(errorsFor({ tiers: [tier] }), []);
        const misclassified = {
            ...tier, executionClass: 'runtime', fixtureProfileReason: 'none-runtime'
        };
        assert.match(errorsFor({ tiers: [misclassified] }).join('\n'), /executionClass must be coordination/u);
    }
    assert.equal(classifyTierExecutionClass({ id: 'unregistered', executionClass: 'coordination' }), 'runtime');
});
