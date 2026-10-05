import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { dotnetProjectLayout, prepareProductionBuildLayout } = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const { migrationBuildMarkerContext, migrationProducerIdentity, publishMigrationBuildReady, readMigrationBuildReady } =
    await import(new URL('../../tools/test/migration-build-binding.mjs', import.meta.url));
const { publishRunBoundMarker } = await import(new URL('../../tools/test-matrix/run-bound-marker.mjs', import.meta.url));
const { snapshotSourceState } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));

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
});

async function buildBindingFixture(t, { execution = false, mysqlSource = false } = {})
{
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-marker-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '.gitignore'), '.tmp/\n');
    fs.writeFileSync(path.join(root, 'source.txt'), 'controlled build-binding fixture\n');
    for (const file of [
        'tests/migration/FsusBlog.Migration.Tests.csproj',
        'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj',
        'src/migration/FsusBlog.Migration.csproj',
        'src/shared/FsusBlog.Shared.csproj'
    ])
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), '<Project />\n');
    }
    if (execution)
    {
        fs.mkdirSync(path.join(root, 'tools/test'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tools/test/run-migration-tests.mjs'),
            `export { readMigrationExecution, readMigrationExecutionDependency } from ${JSON.stringify(new URL('../../tools/test/run-migration-tests.mjs', import.meta.url).href)};\n`);
        fs.mkdirSync(path.join(root, 'tests/backend/Fixtures'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tests/matrix.yml'), 'tiers: []\n');
        fs.writeFileSync(path.join(root, 'tests/coverage-registry.json'), '{"entries":[]}');
        fs.writeFileSync(path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'), '{"profiles":[]}');
        fs.writeFileSync(path.join(root, 'tests/migration/ExampleTests.cs'), 'public class ExampleTests { }\n');
        if (mysqlSource)
        {
            fs.writeFileSync(path.join(root, 'tests/migration/MySqlDdlExecutionTests.cs'),
                'public class MySqlDdlExecutionTests { }\n');
        }
    }
    const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '--quiet']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture']);
    const options = { root, runId: 'migration-binding', namespace: 'migration-binding-fixture', sourceState: await snapshotSourceState(root) };
    const layout = prepareProductionBuildLayout(options);
    // This controlled owner-state fixture is not a physical build attestation.
    const manifest = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    manifest.owner.state = 'building';
    fs.writeFileSync(layout.manifestFile, JSON.stringify(manifest));
    const projects = [
        layout.artifacts.migrationTests, layout.artifacts.xunitAdapter,
        dotnetProjectLayout(layout, 'src/migration/FsusBlog.Migration.csproj'),
        dotnetProjectLayout(layout, 'src/shared/FsusBlog.Shared.csproj')
    ];
    const write = (file, contents = 'controlled fixture') =>
    {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    };
    for (const project of projects)
    {
        write(project.assetsFile);
        write(path.join(project.outputDirectory, `${project.name}.dll`));
        write(path.join(project.intermediateDirectory, `${project.name}.dll`));
        write(path.join(project.intermediateDirectory, `${project.name}.GlobalUsings.g.cs`));
    }
    for (const project of projects.slice(0, 2))
    {
        write(path.join(project.outputDirectory, `${project.name}.deps.json`), '{}');
        write(path.join(project.outputDirectory, `${project.name}.runtimeconfig.json`), '{}');
    }
    await publishMigrationBuildReady(options);
    return { options, layout, projects };
}

test('Migration build marker binds current Git source, namespace, Release tool and compiled dependency closure', async (t) =>
{
    const { options, layout, projects } = await buildBindingFixture(t);
    const { marker } = await readMigrationBuildReady(options);
    assert.equal(marker.producer.stepId, 'xunit-inventory-adapter-build');
    assert.equal(marker.bindings.configuration, 'Release');
    assert.equal(marker.bindings.namespace, options.namespace);
    assert.deepEqual(marker.sourceState, options.sourceState);
    assert.equal(marker.artifacts.length, 20);
    assert.equal(Object.hasOwn(marker, 'qualificationEligible'), false);
    for (const project of projects)
    {
        assert.ok(marker.artifacts.some((entry) => entry.path.endsWith(`/${project.name}.GlobalUsings.g.cs`)));
    }
    const original = fs.readFileSync(layout.artifacts.migrationTestDll);
    fs.appendFileSync(layout.artifacts.migrationTestDll, 'changed');
    await assert.rejects(readMigrationBuildReady(options), /artifact changed/u);
    fs.writeFileSync(layout.artifacts.migrationTestDll, original);
    await readMigrationBuildReady(options);
});

test('Migration build marker rejects crossed identity, missing context, changed source and foreign outputs', async (t) =>
{
    const { options, layout, projects } = await buildBindingFixture(t);
    for (const patch of [
        { sourceState: { ...options.sourceState, commit: 'a'.repeat(40) } },
        { sourceState: { ...options.sourceState, worktreeFingerprint: 'b'.repeat(64) } },
        { runId: 'another-run' },
        { namespace: 'another-namespace' }
    ])
    {
        await assert.rejects(readMigrationBuildReady({ ...options, ...patch }), /Migration|ENOENT/u);
    }
    const context = migrationBuildMarkerContext(options);
    for (const patch of [
        { producerStepId: 'backend-tests-build' },
        { producerBundleId: 'foreign-bundle' },
        { runId: 'foreign-run' },
        { bindings: { ...context.expected.bindings, namespace: 'foreign-namespace' } }
    ])
    {
        publishRunBoundMarker({ file: context.file, ...context.expected, ...patch });
        await assert.rejects(readMigrationBuildReady(options), /run-bound marker/u);
    }
    await publishMigrationBuildReady(options);
    for (const file of [
        layout.manifestFile,
        projects[0].assetsFile,
        path.join(projects[1].intermediateDirectory, `${projects[1].name}.dll`),
        context.file
    ])
    {
        fs.renameSync(file, `${file}.fixture-backup`);
        await assert.rejects(readMigrationBuildReady(options), /ENOENT|unreadable/u);
        fs.renameSync(`${file}.fixture-backup`, file);
    }
    for (const mutate of [
        (manifest) =>
        {
            manifest.owner.state = 'failed';
        },
        (manifest) =>
        {
            manifest.owner.namespace = 'foreign';
        },
        (manifest) =>
        {
            manifest.sourceState.commit = 'c'.repeat(40);
        },
        (manifest) =>
        {
            manifest.projects['FsusBlog.Migration.Tests'].baseOutputPath = '.tmp/server';
        }
    ])
    {
        const original = fs.readFileSync(layout.manifestFile);
        const manifest = JSON.parse(original);
        mutate(manifest);
        fs.writeFileSync(layout.manifestFile, JSON.stringify(manifest));
        await assert.rejects(readMigrationBuildReady(options), /Migration/u);
        fs.writeFileSync(layout.manifestFile, original);
    }
    for (const file of [
        path.join(projects[2].intermediateDirectory, `${projects[2].name}.GlobalUsings.g.cs`),
        projects[3].assetsFile,
        path.join(projects[1].outputDirectory, `${projects[1].name}.deps.json`)
    ])
    {
        const original = fs.readFileSync(file);
        fs.appendFileSync(file, 'changed');
        await assert.rejects(readMigrationBuildReady(options), /artifact changed/u);
        fs.writeFileSync(file, original);
    }
    const extra = path.join(projects[0].outputDirectory, 'Extra.dll');
    fs.writeFileSync(extra, 'unregistered output');
    await assert.rejects(readMigrationBuildReady(options), /artifact declaration/u);
    fs.unlinkSync(extra);
    fs.symlinkSync(layout.artifacts.xunitAdapterDll, extra);
    await assert.rejects(readMigrationBuildReady(options), /symbolic links/u);
    fs.unlinkSync(extra);
    fs.appendFileSync(path.join(options.root, 'source.txt'), 'source drift');
    await assert.rejects(readMigrationBuildReady(options), /current worktree/u);
});

test('Migration build markers accept only the original closed producer identities', () =>
{
    assert.deepEqual(migrationProducerIdentity(), {
        bundleId: 'backend-tests', buildStepId: 'xunit-inventory-adapter-build', executionStepId: 'migration-test-execution'
    });
    assert.deepEqual(migrationProducerIdentity('backend-unit'), {
        bundleId: 'matrix:backend-unit', buildStepId: 'migration-tests-build', executionStepId: 'migration-test-execution'
    });
    for (const producer of ['backend-fast', 'foreign', '', null])
    {
        assert.throws(() => migrationProducerIdentity(producer), /registered execution producer/u);
    }
});
