import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    validateBackendProductionBuildAuthority
} = await import(pathToFileURL(path.join(root, 'tools/test/check-backend-production-build-authority.mjs')).href);

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const inputs = () => ({
    inventory: JSON.parse(read('tests/governance/backend-production-build-consumers.json')),
    bundleSource: read('tools/test/bundles/run-bundle.mjs'),
    shardSource: read('tools/test/run-backend-production-shards.mjs'),
    rightsSource: read('tools/test/project-rights-v3-evidence.mjs'),
    integritySource: read('tools/test/project-evidence.mjs'),
    privacySource: read('tools/test/lanes/project-privacy-zk-production.mjs'),
    crossStackSource: read('tools/test/lanes/cross-stack-contract.sh')
});

test('Production fresh has one canonical Release backend build set and no governance postlude', () =>
{
    assert.deepEqual(validateBackendProductionBuildAuthority(inputs()), {
        schema: 'fsusblog.backend-production-build-authority.v1',
        status: 'success',
        buildRequestCount: 5,
        debugBuildRequestCount: 0,
        postludeTesthostCount: 0,
        consumers: inputs().inventory.consumers
    });
});

test('validator rejects a Debug compatibility build in the Production backend bundle', () =>
{
    const fixture = inputs();
    fixture.bundleSource = fixture.bundleSource.replace(
        'async function runBackendTests()\n{',
        'async function runBackendTests()\n{\nFSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild'
    );
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /Debug or filtered backend compatibility build/u
    );
});

test('validator rejects missing duplicate unknown and non-Release Migration build requests', () =>
{
    const target = 'dotnet build tests/migration/FsusBlog.Migration.Tests.csproj';
    const mutations = [
        (source) => source.replace(target, 'missing-migration-build'),
        (source) => source.replace(target, 'dotnet build tests/unknown/Unregistered.Tests.csproj'),
        (source) => source.replace(`${target} -c Release`, `${target} -c Debug`),
        (source) => source.replace('async function runBackendTests()\n{',
            `async function runBackendTests()\n{\n'${target} -c Release'`)
    ];
    for (const mutate of mutations)
    {
        const input = inputs();
        input.bundleSource = mutate(input.bundleSource);
        assert.throws(() => validateBackendProductionBuildAuthority(input), /inventoried Release build requests/u);
    }
    const input = inputs();
    input.inventory.producer.requests = input.inventory.producer.requests.filter((entry) => entry.id !== 'migration-tests-build');
    assert.throws(() => validateBackendProductionBuildAuthority(input), /backend build requests/u);
});

test('validator rejects a Migration build that borrows the Server artifact or never executes', () =>
{
    for (const [before, after] of [
        ['artifacts: [migrationTestDll]', 'artifacts: [backendTestDll]'],
        ['const migrationTestDll = dotnetArtifacts.migrationTestDll;', 'const migrationTestDll = dotnetArtifacts.testDll;'],
        ['await executeStep(migrationTestsBuildStep);', '']
    ])
    {
        const input = inputs();
        input.bundleSource = input.bundleSource.replace(before, after);
        assert.throws(() => validateBackendProductionBuildAuthority(input), /independent assembly artifact/u);
    }
});

test('validator rejects an unbound, omitted or substituted inventory tool build', () =>
{
    for (const [before, after] of [
        ['const xunitAdapterDll = dotnetArtifacts.xunitAdapterDll;', 'const xunitAdapterDll = dotnetArtifacts.testDll;'],
        ["artifacts: [xunitAdapterDll, runMarkerFile('migration-tests-ready')]", 'artifacts: [backendTestDll]'],
        ['await executeStep(xunitAdapterBuildStep);', ''],
        ['afterSuccess: () => publishMigrationBuildReady({', 'afterSuccess: () => ignoredBuildHook({']
    ])
    {
        const input = inputs();
        input.bundleSource = input.bundleSource.replace(before, after);
        assert.throws(() => validateBackendProductionBuildAuthority(input), /inventory tool/u);
    }
    for (const target of [
        'missing-tool',
        'dotnet build tools/foreign/Foreign.csproj -c Release',
        'dotnet build tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj -c Debug'
    ])
    {
        const input = inputs();
        input.bundleSource = input.bundleSource.replace(
            'dotnet build tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj -c Release', target
        );
        assert.throws(() => validateBackendProductionBuildAuthority(input), /inventoried Release build requests/u);
    }
});

test('validator rejects a single-test governance postlude regression', () =>
{
    const fixture = inputs();
    fixture.shardSource += '\nconst postludeResult = runDotnet("governance-postlude.trx")\n';
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /governance postlude/u
    );
});

test('validator rejects loss of the canonical test-DLL receipt digest', () =>
{
    const fixture = inputs();
    fixture.bundleSource = fixture.bundleSource.replace(
        'contentDigest: fileContentDigest(backendTestDll)',
        'contentDigest: null'
    );
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /test-DLL receipt binding/u
    );
});

test('validator rejects a legacy ambient Rights V3 backend summary path', () =>
{
    const fixture = inputs();
    fixture.rightsSource = fixture.rightsSource
        .replace(
            "path.join(testResultsRoot, 'trx/backend/production/summary.json')",
            "path.join(root, '.tmp/test-results/backend/production/summary.json')"
        )
        .replace(
            "const testResultsRoot = outputRoot ? path.join(outputRoot, 'reports')",
            "const testResultsRoot = path.join(root, '.tmp/test-results')"
        );
    assert.throws(
        () => validateBackendProductionBuildAuthority(fixture),
        /Rights V3 is not projected from the canonical backend summary and TRX artifacts/u
    );
});
