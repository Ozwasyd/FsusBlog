import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { reconcileMigrationTestCases, reconcileMigrationTrx } = await import(new URL('../../tools/test/migration-execution-evidence.mjs', import.meta.url));
const { dotnetProjectLayout, prepareProductionBuildLayout } = await import(new URL('../../tools/test-matrix/production-build-layout.mjs', import.meta.url));
const { migrationBuildMarkerContext, migrationProducerIdentity, publishMigrationBuildReady, readMigrationBuildReady } =
    await import(new URL('../../tools/test/migration-build-binding.mjs', import.meta.url));
const { buildMigrationUnitTests } = await import(new URL('../../tools/test/build-migration-tests.mjs', import.meta.url));
const { publishRunBoundMarker } = await import(new URL('../../tools/test-matrix/run-bound-marker.mjs', import.meta.url));
const { snapshotSourceState } = await import(new URL('../../tools/test-matrix/scheduler.mjs', import.meta.url));
const { migrationExecutionPaths, migrationFixtureRequirements, readMigrationExecution, runMigrationTests } =
    await import(new URL('../../tools/test/run-migration-tests.mjs', import.meta.url));
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

async function buildBindingFixture(t, { execution = false, mysqlSource = false } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-marker-'));
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

function fixture()
{
    const ownerFile = 'tests/migration/ExampleTests.cs';
    const ownerSuite = 'Example.Migration.ExampleTests';
    const assemblyFile = path.resolve('fixture-build/FsusBlog.Migration.Tests.dll');
    const specifications = [
        { methodName: 'Fact', ordinal: 0, displayName: `${ownerSuite}.Fact` },
        { methodName: 'Theory', ordinal: 0, displayName: `${ownerSuite}.Theory(value: 1)` },
        { methodName: 'Theory', ordinal: 1, displayName: `${ownerSuite}.Theory(value: 2)` }
    ];
    const inventoryCases = specifications.map(({ methodName, ordinal }) => ({
        adapter: 'xunit',
        identity: 'static',
        ownerFile,
        ownerClass: 'ExampleTests',
        ownerSuite,
        methodName,
        id: `xunit:${ownerFile}#${ownerSuite}.${methodName}#case-${String(ordinal).padStart(4, '0')}`
    }));
    const discoveredCases = specifications.map(({ methodName, displayName }, index) => ({
        id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
        fullyQualifiedName: `${ownerSuite}.${methodName}`,
        displayName,
        source: assemblyFile,
        traits: {}
    }));
    return {
        assemblyFile,
        sourceFiles: [{ path: ownerFile, adapter: 'xunit' }],
        inventoryCases,
        discoveredCases,
        executedCases: discoveredCases.map((entry) => ({
            testId: entry.id,
            testName: entry.displayName,
            outcome: 'Passed'
        }))
    };
}

async function executionFixture(t, mutate = () =>
{}, { mysqlSource = false } = {})
{
    const { options, layout } = await buildBindingFixture(t, { execution: true, mysqlSource });
    const engineRoot = path.join(options.root, '.tmp/controlled-sdk');
    fs.mkdirSync(path.join(engineRoot, 'sdk/10.0.302'), { recursive: true });
    fs.writeFileSync(path.join(engineRoot, 'dotnet'), 'controlled host, not an actual engine', { mode: 0o755 });
    fs.writeFileSync(path.join(engineRoot, 'sdk/10.0.302/vstest.console.dll'), 'controlled VSTest, not an actual engine');
    const env = {
        PATH: engineRoot,
        FSUSBLOG_PRODUCTION_BUILD_ROOT: layout.runRoot,
        FSUSBLOG_TEST_RUN_ID: options.runId,
        FSUSBLOG_TEST_NAMESPACE: options.namespace,
        FSUSBLOG_TEST_SOURCE_COMMIT: options.sourceState.commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: options.sourceState.worktreeFingerprint
    };
    const input = fixture();
    input.assemblyFile = layout.artifacts.migrationTestDll;
    input.discoveredCases.forEach((entry) =>
    {
        entry.source = input.assemblyFile;
    });
    const report = {
        schema: 'fsusblog.test-inventory.xunit-roslyn.v1',
        adapter: 'xunit', adapterVersion: 'xunit.v2', diagnostics: [],
        testCases: input.inventoryCases.map((entry) => ({ ...entry, traits: [], explicit: false }))
    };
    const calls = [];
    const paths = migrationExecutionPaths(options, env);
    // Deliberate command simulation: these receipts are never live qualification.
    const execute = async (args, files) =>
    {
        const name = args[0] === '--version' ? 'sdk' : args[0] === '--list-sdks' ? 'sdkPaths'
            : args[0] !== 'vstest' ? 'inventory' : args.includes('--ListTests') ? 'discovery' : 'execution';
        calls.push({ name, args });
        const state = { name, input, report, stdout: '', code: 0, signal: null, trx: boundTrx(input) };
        state.stdout = name === 'sdk' ? '10.0.302\n'
            : name === 'sdkPaths' ? `10.0.302 [${path.join(engineRoot, 'sdk')}]\n`
                : name === 'inventory' ? JSON.stringify(report)
                    : name === 'discovery' ? 'VSTest version 18.6.0-release-26329-109 (x64)\n' : 'VSTest version 18.6.0 (x64)\n';
        mutate(state);
        fs.writeFileSync(files.stdoutFile, state.stdout, { flag: 'wx' });
        fs.writeFileSync(files.stderrFile, '', { flag: 'wx' });
        if (name === 'discovery')
        {
            const records = state.input.discoveredCases.map((entry) => ({
                Id: entry.id, FullyQualifiedName: entry.fullyQualifiedName, DisplayName: entry.displayName,
                Source: entry.source,
                Properties: [{ Key: { Id: 'TestObject.Traits' }, Value: Object.entries(entry.traits).flatMap(([key, values]) =>
                    values.map((value) => ({ Key: key, Value: value }))) }]
            }));
            const message = {
                MessageType: 'TestDiscovery.Completed',
                Payload: { IsAborted: false, TotalTests: records.length,
                    LastDiscoveredTests: records, FullyDiscoveredSources: [input.assemblyFile] }
            };
            fs.writeFileSync(path.join(paths.directory, 'discovery/union.host.fixture.txt'),
                `sending data from testhost: ${JSON.stringify(message)}\n`);
        }
        if (name === 'execution')
        {
            fs.writeFileSync(paths.trxFile, state.trx);
        }
        return { code: state.code, signal: state.signal };
    };
    return { options, layout, env, execute, calls, paths, input, report };
}

test('Migration owner consumes the build, discovers and executes once, and seals separate raw evidence', async (t) =>
{
    const subject = await executionFixture(t);
    const result = await runMigrationTests(subject.options, subject);
    assert.deepEqual(subject.calls.map((entry) => entry.name), ['sdk', 'sdkPaths', 'inventory', 'discovery', 'execution']);
    assert.equal(subject.calls.some((entry) => ['build', 'test', 'run'].includes(entry.args[0])), false);
    assert.equal(subject.calls[4].args.some((arg) => /filter/iu.test(arg)), false);
    assert.equal(subject.calls[2].args[0], subject.layout.artifacts.xunitAdapterDll);
    assert.deepEqual(subject.calls[2].args.slice(-2), ['--configuration', 'Release']);
    assert.equal(result.summary.assembly, subject.layout.artifacts.migrationTestDll);
    assert.equal(result.summary.sourceCaseIds.length, 3);
    assert.equal(result.summary.executedCaseIds.length, 3);
    assert.equal(result.summary.namespace, subject.options.namespace);
    assert.equal(result.summary.engine.dotnet.version, '10.0.302');
    assert.match(result.summary.engine.vstest.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.summary.engine.discoveryVersion, '18.6.0-release-26329-109 (x64)');
    assert.equal(result.summary.engine.executionVersion, '18.6.0 (x64)');
    assert.deepEqual(result.summary.fixture, { profile: 'none', observations: [] });
    assert.equal(result.receipt.producer.stepId, 'migration-test-execution');
    assert.equal(Object.hasOwn(result.summary, 'qualificationEligible'), false);
    assert.equal(result.receipt.artifacts.some((entry) => entry.path.endsWith('/migration.trx')), true);
    assert.equal(result.receipt.artifacts.some((entry) => entry.path.endsWith('/migration-tests-ready.json')), true);
    assert.deepEqual((await readMigrationExecution(subject.options, subject.env)).summary, result.summary);
    await assert.rejects(runMigrationTests(subject.options, subject), /EEXIST/u);
    assert.equal(subject.calls.length, 5, 'repeat invocation must not run another testhost');
});

test('Migration command driver executes the observed tool path with captured raw outputs', async (t) =>
{
    const subject = await executionFixture(t);
    const records = subject.input.discoveredCases.map((entry) => ({
        Id: entry.id, FullyQualifiedName: entry.fullyQualifiedName, DisplayName: entry.displayName,
        Source: entry.source, Properties: []
    }));
    const message = {
        MessageType: 'TestDiscovery.Completed',
        Payload: { IsAborted: false, TotalTests: records.length, LastDiscoveredTests: records,
            FullyDiscoveredSources: [subject.input.assemblyFile] }
    };
    // Execute real child processes, but with a deliberately simulated SDK. This
    // exercises process/file plumbing only, not actual .NET engine qualification.
    fs.writeFileSync(path.join(subject.env.PATH, 'simulation.json'), JSON.stringify({
        report: subject.report, diagnostic: `sending data from testhost: ${JSON.stringify(message)}\n`,
        trx: boundTrx(subject.input)
    }));
    fs.writeFileSync(path.join(subject.env.PATH, 'dotnet'), [
        `#!${process.execPath}`,
        "const fs = require('node:fs'); const path = require('node:path');",
        "const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'simulation.json')));",
        "const args = process.argv.slice(2);",
        "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');",
        "if (args[0] === '--version') process.stdout.write('10.0.302\\n');",
        "else if (args[0] === '--list-sdks') process.stdout.write('10.0.302 [' + path.join(__dirname, 'sdk') + ']\\n');",
        "else if (args[0] !== 'vstest') process.stdout.write(JSON.stringify(data.report));",
        "else if (args.includes('--ListTests')) {",
        "  const directory = path.dirname(args.find(arg => arg.startsWith('--Diag:')).slice('--Diag:'.length));",
        "  fs.writeFileSync(path.join(directory, 'union.host.process.txt'), data.diagnostic);",
        "  process.stdout.write('VSTest version 18.6.0-release-26329-109 (x64)\\n');",
        "} else {",
        "  const directory = args.find(arg => arg.startsWith('--ResultsDirectory:')).slice('--ResultsDirectory:'.length);",
        "  fs.writeFileSync(path.join(directory, 'migration.trx'), data.trx);",
        "  process.stdout.write('VSTest version 18.6.0 (x64)\\n');",
        "}",
        ''
    ].join('\n'));
    const result = await runMigrationTests(subject.options, { env: subject.env });
    assert.equal(result.summary.executedCaseIds.length, 3);
    const calls = fs.readFileSync(path.join(subject.env.PATH, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 5);
    assert.equal(calls.filter((args) => args[0] === 'vstest' && !args.includes('--ListTests')).length, 1);
    assert.equal(result.summary.engine.dotnet.realPath, path.join(subject.env.PATH, 'dotnet'));
    assert.deepEqual((await readMigrationExecution(subject.options, subject.env)).summary, result.summary);
});


test('Migration fixture requirement binds only the exact MySQL source owner without admitting a service', () =>
{
    const source = fixture().inventoryCases[0];
    const mysql = {
        ...source,
        id: 'xunit:tests/migration/MySqlDdlExecutionTests.cs#FsusBlog.Migration.Tests.MySqlDdlExecutionTests.Fact#case-0000',
        ownerFile: 'tests/migration/MySqlDdlExecutionTests.cs',
        ownerClass: 'MySqlDdlExecutionTests',
        ownerSuite: 'FsusBlog.Migration.Tests.MySqlDdlExecutionTests',
        fixture: 'FsusBlog.Migration.Tests.MySqlDdlFixture',
        traits: [], explicit: false
    };
    const report = { testCases: [mysql] };
    assert.deepEqual(migrationFixtureRequirements(report), {
        profile: 'mysql',
        fixture: {
            ownerFile: mysql.ownerFile, ownerSuite: mysql.ownerSuite, fixture: mysql.fixture
        },
        sourceCaseIds: [mysql.id]
    });
    assert.deepEqual(migrationFixtureRequirements({ testCases: [{ ...source, traits: [], explicit: false }] }), {
        profile: 'none', fixture: null, sourceCaseIds: []
    });
    for (const mutation of [
        { ownerFile: 'tests/migration/OtherTests.cs' },
        { ownerSuite: 'FsusBlog.Migration.Tests.OtherTests' },
        { ownerClass: 'OtherTests' },
        { fixture: 'FsusBlog.Migration.Tests.OtherFixture' },
        { id: 'xunit:tests/migration/OtherTests.cs#Other.Fact#case-0000' }
    ])
    {
        assert.throws(() => migrationFixtureRequirements({ testCases: [{ ...mysql, ...mutation }] }),
            /exact source-owned MySQL fixture identity/u);
    }
    for (const mutation of [{ skipReason: 'missing' }, { explicit: true }, { identity: 'dynamic' },
        { traits: [{ name: 'Dependency', value: 'Docker' }] }])
    {
        assert.throws(() => migrationFixtureRequirements({ testCases: [{ ...mysql, ...mutation }] }),
            /requires admitted static/u);
    }
    assert.throws(() => migrationFixtureRequirements({}), /validated source inventory/u);
});

test('Migration execution refuses its exact source-owned MySQL fixture before discovery without scheduler admission', async (t) =>
{
    const subject = await executionFixture(t, (state) =>
    {
        if (state.name === 'inventory')
        {
            Object.assign(state.report.testCases[0], {
                id: 'xunit:tests/migration/MySqlDdlExecutionTests.cs#FsusBlog.Migration.Tests.MySqlDdlExecutionTests.Fact#case-0000',
                ownerFile: 'tests/migration/MySqlDdlExecutionTests.cs',
                ownerClass: 'MySqlDdlExecutionTests',
                ownerSuite: 'FsusBlog.Migration.Tests.MySqlDdlExecutionTests',
                fixture: 'FsusBlog.Migration.Tests.MySqlDdlFixture'
            });
            state.stdout = JSON.stringify(state.report);
        }
    }, { mysqlSource: true });
    await assert.rejects(runMigrationTests(subject.options, subject),
        /requires admitted MySQL fixture service, grant and cleanup evidence/u);
    assert.deepEqual(subject.calls.map((entry) => entry.name), ['sdk', 'sdkPaths', 'inventory']);
});

test('Migration owner rejects unadmitted fixtures and skipped, explicit or dynamic cases before discovery', async (t) =>
{
    for (const change of [
        { fixture: 'Example.MySqlDdlFixture' }, { traits: [{ name: 'Dependency', value: 'Docker' }] },
        { skipReason: 'not available' }, { explicit: true }, { identity: 'dynamic' }
    ])
    {
        const subject = await executionFixture(t, (state) =>
        {
            if (state.name === 'inventory')
            {
                Object.assign(state.report.testCases[0], change);
                state.stdout = JSON.stringify(state.report);
            }
        });
        await assert.rejects(runMigrationTests(subject.options, subject),
            change.fixture ? /requires an exact source-owned MySQL fixture identity/u : /requires admitted static/u);
        assert.deepEqual(subject.calls.map((entry) => entry.name), ['sdk', 'sdkPaths', 'inventory']);
        assert.equal(fs.existsSync(subject.paths.receiptFile), false);
    }
});

test('Migration owner fails closed on command failure, inventory drift and discovery drift', async (t) =>
{
    for (const phase of ['sdk', 'sdkPaths', 'inventory', 'discovery', 'execution', 'diagnostics', 'foreign-project', 'missing-case', 'runtime-trait'])
    {
        const subject = await executionFixture(t, (state) =>
        {
            if (phase === state.name)
            {
                state.code = 1;
            }
            if (state.name === 'inventory' && ['diagnostics', 'foreign-project'].includes(phase))
            {
                if (phase === 'diagnostics')
                {
                    state.report.diagnostics.push({ severity: 'error', message: 'fixture diagnostic' });
                }
                else
                {
                    state.report.testCases[0].ownerFile = 'tests/backend/ExampleTests.cs';
                }
                state.stdout = JSON.stringify(state.report);
            }
            if (phase === 'missing-case' && state.name === 'discovery')
            {
                state.input.discoveredCases.pop();
            }
            if (phase === 'runtime-trait' && state.name === 'discovery')
            {
                state.input.discoveredCases[0].traits = { Fixture: ['Unadmitted'] };
            }
        });
        await assert.rejects(runMigrationTests(subject.options, subject), /command failed|diagnostics|ownership|case count|unadmitted runtime traits/u);
        assert.equal(fs.existsSync(subject.paths.receiptFile), false);
        assert.equal(fs.existsSync(subject.paths.summaryFile), false);
        if (['diagnostics', 'foreign-project', 'missing-case', 'runtime-trait'].includes(phase))
        {
            assert.equal(subject.calls.some((entry) => entry.name === 'execution'), false);
        }
    }
});

test('Migration owner rejects non-passing TRX, engine changes and post-command source/build changes', async (t) =>
{
    for (const kind of ['skipped', 'failed', 'engine', 'engine-binary', 'host-binary', 'source', 'build'])
    {
        const subject = await executionFixture(t, (state) =>
        {
            if (state.name !== 'execution')
            {
                return;
            }
            if (kind === 'skipped' || kind === 'failed')
            {
                state.trx = state.trx.replace('outcome="Passed"', `outcome="${kind === 'failed' ? 'Failed' : 'NotExecuted'}"`);
            }
            else if (kind === 'engine')
            {
                state.stdout = 'VSTest version 99.0.0 (x64)\n';
            }
            else if (kind === 'source')
            {
                fs.appendFileSync(path.join(subject.options.root, 'source.txt'), 'source changed');
            }
            else if (kind === 'engine-binary' || kind === 'host-binary')
            {
                fs.appendFileSync(path.join(subject.env.PATH, kind === 'host-binary' ? 'dotnet' : 'sdk/10.0.302/vstest.console.dll'), 'engine changed');
            }
            else
            {
                fs.appendFileSync(subject.layout.artifacts.migrationTestDll, 'build changed');
            }
        });
        await assert.rejects(runMigrationTests(subject.options, subject), /TRX|outcome|engine.*changed|current worktree|artifact/iu);
        assert.equal(fs.existsSync(subject.paths.receiptFile), false);
    }
});

test('Migration receipt rejects stale identities, missing evidence, tampering, extra TRX and symlink output', async (t) =>
{
    const subject = await executionFixture(t);
    const result = await runMigrationTests(subject.options, subject);
    for (const patch of [
        { namespace: 'foreign-namespace' }, { runId: 'foreign-run' },
        { sourceState: { ...subject.options.sourceState, worktreeFingerprint: 'f'.repeat(64) } }
    ])
    {
        await assert.rejects(readMigrationExecution({ ...subject.options, ...patch }, subject.env));
    }
    for (const file of [result.summaryFile, result.trxFile, result.receiptFile,
        path.join(result.directory, 'discovery/union.host.fixture.txt'), path.join(result.directory, 'sdk.stdout'),
        path.join(result.directory, 'sdk.stderr'), path.join(result.directory, 'engine.json')])
    {
        const bytes = fs.readFileSync(file);
        fs.unlinkSync(file);
        await assert.rejects(readMigrationExecution(subject.options, subject.env));
        fs.writeFileSync(file, bytes);
        fs.appendFileSync(file, 'tampered');
        await assert.rejects(readMigrationExecution(subject.options, subject.env));
        fs.writeFileSync(file, bytes);
    }
    const extra = path.join(result.directory, 'execution/foreign.trx');
    fs.copyFileSync(result.trxFile, extra);
    await assert.rejects(readMigrationExecution(subject.options, subject.env), /run-bound marker artifact declaration mismatch/u);
    fs.unlinkSync(extra);
    fs.symlinkSync(result.trxFile, extra);
    await assert.rejects(readMigrationExecution(subject.options, subject.env), /symlink/u);
    fs.unlinkSync(extra);
    assert.deepEqual((await readMigrationExecution(subject.options, subject.env)).summary, result.summary);
});

test('Migration entry point refuses crossed environment, unsafe paths and preexisting output before any command', async (t) =>
{
    const subject = await executionFixture(t);
    for (const key of Object.keys(subject.env).filter((entry) => entry !== 'PATH'))
    {
        await assert.rejects(runMigrationTests(subject.options, { ...subject, env: { ...subject.env, [key]: 'foreign' } }),
            /environment differs/u);
    }
    assert.throws(() => migrationExecutionPaths(subject.options, { FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT: '/tmp/foreign' }),
        /temporary output root/u);
    fs.mkdirSync(path.dirname(subject.paths.directory), { recursive: true });
    fs.symlinkSync(subject.layout.runRoot, subject.paths.directory);
    await assert.rejects(runMigrationTests(subject.options, subject), /EEXIST/u);
    assert.equal(subject.calls.length, 0);
});


async function unitBuildFixture(t)
{
    const subject = await executionFixture(t);
    const marker = await readMigrationBuildReady(subject.options);
    fs.unlinkSync(marker.file);
    subject.options.producer = 'backend-unit';
    subject.env.CURRENT_TIER = 'backend-unit';
    subject.env.FSUSBLOG_STEP_CPU_BUDGET = '1';
    subject.env.FSUSBLOG_STEP_MEMORY_GIB = '1';
    subject.buildCalls = [];
    subject.buildExecute = async (args, files) =>
    {
        subject.buildCalls.push(args);
        fs.writeFileSync(files.stdoutFile, 'controlled build command, not a live compiler\n');
        fs.writeFileSync(files.stderrFile, '');
        return { code: 0, signal: null };
    };
    return subject;
}

test('matrix Migration build and execution retain their own producer instead of borrowing production evidence', async (t) =>
{
    const subject = await unitBuildFixture(t);
    const built = await buildMigrationUnitTests(subject.options, { env: subject.env, execute: subject.buildExecute });
    assert.equal(built.marker.producer.bundleId, 'matrix:backend-unit');
    assert.equal(built.marker.producer.stepId, 'migration-tests-build');
    assert.equal(built.marker.artifacts.length, 29);
    assert.deepEqual(subject.buildCalls.map((args) => args.slice(0, 2)), [
        ['restore', 'tests/migration/FsusBlog.Migration.Tests.csproj'],
        ['restore', 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj'],
        ['build', 'tests/migration/FsusBlog.Migration.Tests.csproj'],
        ['build', 'tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj']
    ]);
    assert.equal(subject.buildCalls.slice(0, 2).every((args) => args.includes('--locked-mode')), true);
    assert.equal(subject.buildCalls.slice(2).every((args) => args.includes('Release') && args.includes('--no-restore') && args.includes('/m:1')), true);
    assert.equal(subject.buildCalls[2].includes('--no-dependencies'), false);
    assert.equal(subject.buildCalls[3].includes('--no-dependencies'), true);
    await assert.rejects(readMigrationBuildReady({ ...subject.options, producer: 'backend-tests' }), /producer mismatch/u);
    const result = await runMigrationTests(subject.options, subject);
    assert.equal(result.receipt.producer.bundleId, 'matrix:backend-unit');
    assert.equal(result.summary.executedCaseIds.length, 3);
    // The fast summary is a consumer only, not a second execution producer.
    const consumerEnv = { ...subject.env, CURRENT_TIER: 'backend-fast' };
    assert.deepEqual((await readMigrationExecution(subject.options, consumerEnv)).summary, result.summary);
    assert.equal(subject.calls.filter((entry) => entry.name === 'execution').length, 1);
    await assert.rejects(runMigrationTests(subject.options, { ...subject, env: consumerEnv }), /own matrix producer/u);
    await assert.rejects(buildMigrationUnitTests(subject.options, { env: subject.env, execute: subject.buildExecute }), /existing producer marker/u);
    const commandsFile = path.join(subject.layout.runRoot, 'migration-unit-build/commands.json');
    fs.appendFileSync(commandsFile, 'tampered');
    await assert.rejects(readMigrationBuildReady(subject.options), /artifact/u);
});

test('matrix Migration build rejects failed restore/build without publishing or retrying its first attempt', async (t) =>
{
    for (const failingIndex of [0, 1, 2, 3])
    {
        const subject = await unitBuildFixture(t);
        const execute = async (args, files) =>
        {
            await subject.buildExecute(args, files);
            return { code: subject.buildCalls.length - 1 === failingIndex ? 1 : 0, signal: null };
        };
        await assert.rejects(buildMigrationUnitTests(subject.options, { env: subject.env, execute }), /build command failed/u);
        assert.equal(subject.buildCalls.length, failingIndex + 1);
        assert.equal(fs.existsSync(path.join(subject.options.root, '.tmp/test-runs', subject.options.runId, 'migration-tests-ready.json')), false);
        await assert.rejects(buildMigrationUnitTests(subject.options, { env: subject.env, execute }), /EEXIST/u);
        assert.equal(subject.buildCalls.length, failingIndex + 1);
    }
});

test('matrix Migration build refuses crossed producer, source, namespace and layout before invoking a compiler', async (t) =>
{
    const subject = await unitBuildFixture(t);
    for (const patch of [
        { CURRENT_TIER: 'backend-fast' }, { FSUSBLOG_PHYSICAL_BUNDLE_ID: 'backend-tests' },
        { FSUSBLOG_TEST_RUN_ID: 'foreign' }, { FSUSBLOG_TEST_NAMESPACE: 'foreign' },
        { FSUSBLOG_TEST_SOURCE_COMMIT: 'f'.repeat(40) }, { FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'e'.repeat(64) },
        { FSUSBLOG_PRODUCTION_BUILD_ROOT: path.join(subject.options.root, '.tmp/foreign') }
    ])
    {
        await assert.rejects(buildMigrationUnitTests(subject.options, { env: { ...subject.env, ...patch }, execute: subject.buildExecute }),
            /matrix producer|output root/u);
    }
    await assert.rejects(buildMigrationUnitTests({ ...subject.options, producer: 'backend-tests' },
        { env: subject.env, execute: subject.buildExecute }), /matrix producer/u);
    assert.throws(() => migrationProducerIdentity('unregistered'), /registered execution producer/u);
    assert.equal(subject.buildCalls.length, 0);
    assert.equal(fs.existsSync(path.join(subject.layout.runRoot, 'migration-unit-build')), false);
});

test('matrix Migration cannot consume an existing production marker or replace a foreign marker', async (t) =>
{
    const subject = await executionFixture(t);
    const options = { ...subject.options, producer: 'backend-unit' };
    const env = { ...subject.env, CURRENT_TIER: 'backend-unit' };
    await assert.rejects(readMigrationBuildReady(options));
    await assert.rejects(buildMigrationUnitTests(options, { env, execute: subject.execute }), /existing producer marker/u);
    assert.equal(subject.calls.length, 0);
    assert.equal((await readMigrationBuildReady(subject.options)).marker.producer.bundleId, 'backend-tests');
});


function boundTrx(input)
{
    const attribute = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const records = input.discoveredCases.map((record, index) => ({
        ...record,
        executionId: `11111111-1111-1111-1111-${String(index + 1).padStart(12, '0')}`
    }));
    const results = records.map((record) => `<UnitTestResult testId="${record.id}" executionId="${record.executionId}" testName="${attribute(record.displayName)}" outcome="Passed" />`);
    const definitions = records.map((record) => `<UnitTest id="${record.id}" name="${attribute(record.displayName)}" storage="${attribute(record.source.toLowerCase())}">
<Execution id="${record.executionId}" />
<TestMethod codeBase="${attribute(record.source)}" adapterTypeName="executor://xunit/VsTestRunner3/netcore/" className="${record.fullyQualifiedName.slice(0, record.fullyQualifiedName.lastIndexOf('.'))}" name="${record.fullyQualifiedName.slice(record.fullyQualifiedName.lastIndexOf('.') + 1)}" />
</UnitTest>`);
    const entries = records.map((record) => `<TestEntry testId="${record.id}" executionId="${record.executionId}" />`);
    return `<TestRun id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa">
<Results>${results.join('\n')}</Results>
<TestDefinitions>${definitions.join('\n')}</TestDefinitions>
<TestEntries>${entries.join('\n')}</TestEntries>
<ResultSummary outcome="Completed"><Counters total="3" executed="3" passed="3" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" /></ResultSummary>
</TestRun>`;
}

test('Migration TRX joins exact assembly, method, adapter and execution identities using the shared reader', () =>
{
    const input = fixture();
    const result = reconcileMigrationTrx({ ...input, trx: boundTrx(input) });
    assert.equal(result.trxRunId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(result.executionIds.length, 3);
    assert.equal(new Set(result.executionIds).size, 3);
    assert.deepEqual(result.sourceCaseIds, input.inventoryCases.map((entry) => entry.id).sort());
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
});

test('Migration TRX rejects foreign assemblies, methods, adapters and inconsistent execution bindings', () =>
{
    const input = fixture();
    const trx = boundTrx(input);
    const mutations = [
        (value) => value.replace('<TestRun id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"', '<TestRun id="unknown"'),
        (value) => value.replace(/<TestDefinitions>[\s\S]*?<\/TestDefinitions>/u, ''),
        (value) => value.replace(/<TestEntries>[\s\S]*?<\/TestEntries>/u, ''),
        (value) => value.replace('</TestDefinitions>', '</TestDefinitions><TestDefinitions></TestDefinitions>'),
        (value) => value.replace(/<UnitTest\b[\s\S]*?<\/UnitTest>/u, ''),
        (value) => value.replace(/(<UnitTest\b[\s\S]*?<\/UnitTest>)/u, '$1$1'),
        (value) => value.replace(/<TestEntry\b[^>]*\/>/u, ''),
        (value) => value.replace(/(<TestEntry\b[^>]*\/>)/u, '$1$1'),
        (value) => value.replace(/<Execution\b[^>]*\/>/u, ''),
        (value) => value.replace(/(<Execution\b[^>]*\/>)/u, '$1$1'),
        (value) => value.replace(/<TestMethod\b[^>]*\/>/u, ''),
        (value) => value.replace(/(<TestMethod\b[^>]*\/>)/u, '$1$1'),
        (value) => value.replace(/codeBase="[^"]*"/u, 'codeBase="/foreign/FsusBlog.Server.Tests.dll"'),
        (value) => value.replace(/storage="[^"]*"/u, 'storage="/foreign/fsusblog.server.tests.dll"'),
        (value) => value.replace(/adapterTypeName="[^"]*"/u, 'adapterTypeName="foreign-adapter"'),
        (value) => value.replace(/className="[^"]*"/u, 'className="Foreign.Project.Tests"'),
        (value) => value.replace(/(<TestMethod\b[^>]* name=)"[^"]*"/u, '$1"ForeignMethod"'),
        (value) => value.replace(/executionId="[^"]*"/u, 'executionId="22222222-2222-2222-2222-222222222222"'),
        (value) => value.replace(/(<Execution id=)"[^"]*"/u, '$1"22222222-2222-2222-2222-222222222222"'),
        (value) => value.replace(/(<TestEntry\b[^>]* executionId=)"[^"]*"/u, '$1"22222222-2222-2222-2222-222222222222"'),
        (value) => value.replaceAll('11111111-1111-1111-1111-000000000002', '11111111-1111-1111-1111-000000000001'),
        (value) => value.replace(/(<UnitTest id=)"[^"]*"/u, '$1"33333333-3333-3333-3333-333333333333"'),
        (value) => value.replace(/(<UnitTest\b[^>]* name=)"[^"]*"/u, '$1"Wrong display name"'),
        (value) => value.replace('outcome="Passed"', 'outcome="NotExecuted"'),
        (value) => value.replace('failed="0"', 'failed="1"')
    ];
    for (const [index, mutate] of mutations.entries())
    {
        const corrupted = mutate(trx);
        assert.notEqual(corrupted, trx, `mutation ${index} must change the fixture`);
        assert.throws(() => reconcileMigrationTrx({ ...input, trx: corrupted }),
            /TRX|migration execution/iu, `mutation ${index} must fail closed`);
    }
});

test('Migration evidence reconciles independent assembly, fully-qualified methods and every theory row', () =>
{
    const input = fixture();
    const before = structuredClone(input);
    const result = reconcileMigrationTestCases(input);
    assert.equal(result.project, 'tests/migration/FsusBlog.Migration.Tests.csproj');
    assert.equal(result.assembly, input.assemblyFile);
    assert.deepEqual(result.sourceCaseIds, input.inventoryCases.map((entry) => entry.id).sort());
    assert.deepEqual(result.executedCaseIds, input.discoveredCases.map((entry) => entry.id).sort());
    assert.deepEqual(result.methods.map((entry) => [
        entry.method, entry.sourceCaseIds.length, entry.runtimeCaseIds.length
    ]), [
        ['Example.Migration.ExampleTests.Fact', 1, 1],
        ['Example.Migration.ExampleTests.Theory', 2, 2]
    ]);
    assert.equal(Object.hasOwn(result, 'qualificationEligible'), false);
    assert.deepEqual(input, before);
});

test('Migration evidence rejects missing inputs, wrong assembly and unknown source ownership', () =>
{
    const mutations = [
        (input) =>
        {
            input.assemblyFile = path.resolve('fixture-build/FsusBlog.Server.Tests.dll');
        },
        (input) =>
        {
            input.assemblyFile = 'FsusBlog.Migration.Tests.dll';
        },
        (input) =>
        {
            input.inventoryCases = [];
        },
        (input) =>
        {
            input.discoveredCases = [];
        },
        (input) =>
        {
            input.executedCases = [];
        },
        (input) =>
        {
            input.sourceFiles = null;
        },
        (input) =>
        {
            input.sourceFiles = [];
        },
        (input) =>
        {
            input.sourceFiles[0].adapter = 'xunit-support';
        },
        (input) =>
        {
            input.inventoryCases[0].ownerFile = 'tests/backend/ExampleTests.cs';
        },
        (input) =>
        {
            input.inventoryCases[0].ownerFile = 'tests/migration/MySqlDdlFixture.cs';
        },
        (input) =>
        {
            input.inventoryCases[0].ownerSuite = 'Another.Namespace.ExampleTests';
        },
        (input) =>
        {
            input.inventoryCases[0].id = 'foreign-id';
        },
        (input) =>
        {
            input.inventoryCases[0].adapter = 'node-test';
        },
        (input) =>
        {
            input.inventoryCases[0].identity = 'dynamic';
        },
        (input) =>
        {
            input.inventoryCases.push(input.inventoryCases[0]);
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => reconcileMigrationTestCases(input), /migration execution/u);
    }
});

test('Migration evidence rejects discovery omissions, duplicates, foreign methods and source drift', () =>
{
    const mutations = [
        (input) =>
        {
            input.discoveredCases.pop();
        },
        (input) =>
        {
            input.discoveredCases.shift();
        },
        (input) =>
        {
            input.discoveredCases[0].id = 'not-a-runtime-id';
        },
        (input) =>
        {
            input.discoveredCases[0].id = input.discoveredCases[1].id;
        },
        (input) =>
        {
            input.discoveredCases[0].source = path.resolve('other-run/FsusBlog.Migration.Tests.dll');
        },
        (input) =>
        {
            input.discoveredCases[0].source = 'FsusBlog.Migration.Tests.dll';
        },
        (input) =>
        {
            input.discoveredCases[0].fullyQualifiedName = 'Example.Server.ExampleTests.Fact';
        },
        (input) =>
        {
            input.discoveredCases[0].displayName = '';
        },
        (input) =>
        {
            input.discoveredCases.push({ ...input.discoveredCases[1], id: '00000000-0000-0000-0000-000000000004' });
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => reconcileMigrationTestCases(input), /migration execution/u);
    }
});

test('Migration evidence rejects missing, repeated, unplanned, renamed and non-passing TRX rows', () =>
{
    const mutations = [
        (input) =>
        {
            input.executedCases.pop();
        },
        (input) =>
        {
            input.executedCases.push(input.executedCases[0]);
        },
        (input) =>
        {
            input.executedCases[0].testId = '00000000-0000-0000-0000-000000000099';
        },
        (input) =>
        {
            input.executedCases[0].testName = input.discoveredCases[1].displayName;
        },
        (input) =>
        {
            input.executedCases[0].outcome = 'Failed';
        },
        (input) =>
        {
            input.executedCases[0].outcome = 'NotExecuted';
        },
        (input) =>
        {
            input.executedCases[0].outcome = 'Skipped';
        },
        (input) =>
        {
            input.executedCases[0].outcome = null;
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => reconcileMigrationTestCases(input), /migration execution/u);
    }
});
