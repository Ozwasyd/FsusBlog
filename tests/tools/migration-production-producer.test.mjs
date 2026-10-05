import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { prepareProductionBuildLayout } = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const { assertProductionFreshBundleProducerWiring, productionFreshProducerInventory } =
    await import(new URL('../../tools/test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));

test('Migration production build has a separate run-owned project layout and assembly', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-build-layout-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const layout = prepareProductionBuildLayout({ root, runId: 'migration-layout' });
    const { artifacts, manifest } = layout;
    assert.deepEqual(Object.keys(manifest.projects).sort(), [
        'FsusBlog.Core.Benchmarks', 'FsusBlog.Migration.Tests', 'FsusBlog.Server', 'FsusBlog.Server.Tests', 'FsusBlog.XunitRoslynAdapter'
    ]);
    assert.equal(artifacts.migrationTests.projectFile, 'tests/migration/FsusBlog.Migration.Tests.csproj');
    assert.equal(manifest.projects['FsusBlog.Migration.Tests'].projectFile, artifacts.migrationTests.projectFile);
    assert.equal(artifacts.migrationTestDll, path.join(layout.dotnetRoot,
        'FsusBlog.Migration.Tests/bin/Release/net10.0/FsusBlog.Migration.Tests.dll'));
    assert.notEqual(artifacts.migrationTestDll, artifacts.testDll);
    assert.equal(artifacts.xunitAdapter.projectFile, 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj');
    assert.equal(artifacts.xunitAdapterDll, path.join(layout.dotnetRoot,
        'FsusBlog.XunitRoslynAdapter/bin/Release/net10.0/FsusBlog.XunitRoslynAdapter.dll'));
    assert.notEqual(artifacts.xunitAdapterDll, artifacts.migrationTestDll);
    const projects = Object.values(manifest.projects);
    for (const property of ['baseOutputPath', 'baseIntermediateOutputPath', 'projectExtensionsPath'])
    {
        assert.equal(new Set(projects.map((entry) => entry[property])).size, projects.length);
    }
    const solution = fs.readFileSync(new URL('../../tests/FsusBlog.ProductionBackend.slnx', import.meta.url), 'utf8');
    assert.equal(solution.split('Path="migration/FsusBlog.Migration.Tests.csproj"').length - 1, 1);
    assert.equal(solution.split('Path="../src/migration/FsusBlog.Migration.csproj"').length - 1, 1);
    const server = fs.readFileSync(new URL('../../src/backend/FsusBlog.Server.csproj', import.meta.url), 'utf8');
    assert.doesNotMatch(server, /ProjectReference[^>]*Migration/iu);
    const producers = productionFreshProducerInventory.bundles['backend-tests'];
    assert.equal(producers.filter((id) => id === 'migration-tests-build').length, 1);
    assert.equal(producers.filter((id) => id === 'xunit-inventory-adapter-build').length, 1);
    assert.equal(producers.filter((id) => id === 'migration-test-execution').length, 1);
    assert.equal(assertProductionFreshBundleProducerWiring('backend-tests', producers), true);
    assert.throws(() => assertProductionFreshBundleProducerWiring('backend-tests',
        producers.filter((id) => id !== 'migration-tests-build')), /missing=migration-tests-build/u);
    assert.throws(() => assertProductionFreshBundleProducerWiring('backend-tests',
        producers.filter((id) => id !== 'xunit-inventory-adapter-build')), /missing=xunit-inventory-adapter-build/u);
    assert.throws(() => assertProductionFreshBundleProducerWiring('backend-tests',
        producers.filter((id) => id !== 'migration-test-execution')), /missing=migration-test-execution/u);
    assert.throws(() => assertProductionFreshBundleProducerWiring('backend-tests',
        [...producers, 'unregistered-migration-build']), /unexpected=unregistered-migration-build/u);
});

test('canonical backend bundle builds independent consumers before reading and registering Migration execution', () =>
{
    const source = fs.readFileSync(new URL('../../tools/test/bundles/run-bundle.mjs', import.meta.url), 'utf8');
    const backend = source.slice(source.indexOf('async function runBackendTests()'), source.indexOf('async function runFrontendTests()'));
    const ordered = [
        'await executeStep(testsBuildStep);',
        'await executeStep(migrationTestsBuildStep);',
        'await executeStep(xunitAdapterBuildStep);',
        'await executeStep(benchmarkBuildStep);',
        'const migrationResult = await executeStep(migrationStep);',
        'const migrationExecution = await readMigrationExecution(migrationContext);',
        "register({ id: migrationStep.id, members: ['backend-unit', 'backend-fast'] }",
        "const testStep = commandStep('dotnet-production-union'"
    ];
    let previous = -1;
    for (const statement of ordered)
    {
        const current = backend.indexOf(statement);
        assert.ok(current > previous, statement);
        assert.equal(backend.indexOf(statement, current + 1), -1, statement);
        previous = current;
    }
    assert.match(backend, /afterSuccess: \(\) => publishMigrationBuildReady\(\{[^]*sourceState: currentSourceState\(\)/u);
    assert.match(backend, /afterSuccess: \(\) => readMigrationExecution\(migrationContext\)/u);
    assert.match(backend, /migrationExecution\.summary\.sourceCaseIds, \[migrationPaths\.directory\]/u);
    assert.match(backend, /dotnet restore tests\/FsusBlog\.ProductionBackend\.slnx --locked-mode/u);
    assert.match(backend, /migration\/FsusBlog\.Migration\.Tests\.csproj -c Release --no-restore -warnaserror/u);
    assert.match(backend, /xunit-roslyn-adapter\/FsusBlog\.XunitRoslynAdapter\.csproj -c Release --no-restore --no-dependencies -warnaserror/u);
});

