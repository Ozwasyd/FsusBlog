#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { discoverTestInventory } = await import(new URL('../test-inventory/discovery.mjs', import.meta.url));
const { groupXunitSources, validateXunitProjectReport } = await import(new URL('../test-inventory/xunit-projects.mjs', import.meta.url));
const { productionDotnetArtifacts, resolveProductionBuildLayout } = await import(new URL('../test-matrix/production-build-layout.mjs', import.meta.url));
const { publishRunBoundMarker, readRunBoundMarker } = await import(new URL('../test-matrix/run-bound-marker.mjs', import.meta.url));
const { migrationProducerIdentity, readMigrationBuildReady } = await import(new URL('./migration-build-binding.mjs', import.meta.url));
const { observeExecutableIdentity, resolveExecutablePath } = await import(new URL('./execution-envelope-environment.mjs', import.meta.url));
const { reconcileMigrationDiscovery, reconcileMigrationTrx } = await import(new URL('./migration-execution-evidence.mjs', import.meta.url));
const { readVstestDiscoveryDiagnostic } = await import(new URL('./vstest-discovery-diagnostic.mjs', import.meta.url));

const project = 'tests/migration/FsusBlog.Migration.Tests.csproj';
const mysqlFixtureOwner = Object.freeze({
    ownerFile: 'tests/migration/MySqlDdlExecutionTests.cs',
    ownerSuite: 'FsusBlog.Migration.Tests.MySqlDdlExecutionTests',
    fixture: 'FsusBlog.Migration.Tests.MySqlDdlFixture'
});

function requireOwnedPath(root, file, { createDirectories = false } = {})
{
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(root) !== root)
    {
        throw new Error('Migration execution evidence requires a canonical repository-owned path');
    }
    let cursor = root;
    for (const part of relative.split(path.sep))
    {
        cursor = path.join(cursor, part);
        if (createDirectories && !fs.existsSync(cursor))
        {
            fs.mkdirSync(cursor);
        }
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        {
            throw new Error('Migration execution evidence cannot use symlinks or special files');
        }
    }
}

function evidenceFiles(root, directory)
{
    requireOwnedPath(root, directory);
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const file = path.join(directory, entry.name);
        requireOwnedPath(root, file);
        return entry.isDirectory() ? evidenceFiles(root, file) : [file];
    }).sort();
}

/** One separate, run-owned evidence root; never share the Server TRX union. */
export function migrationExecutionPaths({ root, runId }, env = process.env)
{
    const layout = resolveProductionBuildLayout({ root, runId });
    const outputRoot = String(env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim();
    const directory = outputRoot
        ? path.join(path.resolve(outputRoot), 'reports/trx/migration/production')
        : path.join(layout.repositoryRoot, '.tmp/test-runs', runId, 'migration-execution');
    if (!path.relative(path.resolve(root), directory).startsWith('.tmp/'))
    {
        throw new Error('Migration execution evidence must stay in the repository temporary output root');
    }
    return {
        directory,
        summaryFile: path.join(directory, 'summary.json'),
        receiptFile: path.join(directory, 'receipt.json'),
        trxFile: path.join(directory, 'execution/migration.trx')
    };
}

function executionPlan(options, env)
{
    const layout = resolveProductionBuildLayout(options);
    const artifacts = productionDotnetArtifacts(layout);
    const paths = migrationExecutionPaths(options, env);
    return {
        ...paths,
        assemblyFile: artifacts.migrationTestDll,
        commands: {
            sdk: ['--version'],
            sdkPaths: ['--list-sdks'],
            inventory: [artifacts.xunitAdapterDll, options.root, path.join(options.root, project), '--configuration', 'Release'],
            discovery: ['vstest', artifacts.migrationTestDll, '--ListTests', `--Diag:${path.join(paths.directory, 'discovery/union.txt')}`],
            execution: ['vstest', artifacts.migrationTestDll, '--logger:trx;LogFileName=migration.trx',
                `--ResultsDirectory:${path.join(paths.directory, 'execution')}`]
        }
    };
}

function sourceOwner(root)
{
    const inventory = discoverTestInventory(root, { includeSourceState: false, runAdapters: false });
    return groupXunitSources(inventory.sourceFiles).find((owner) => owner.project === project);
}

/** Classify only the source-owned fixture need; this is not service admission. */
export function migrationFixtureRequirements(report)
{
    if (!Array.isArray(report?.testCases))
    {
        throw new Error('Migration execution requires a validated source inventory');
    }
    const mysqlCaseIds = [];
    for (const testCase of report.testCases)
    {
        if (testCase.skipReason != null || testCase.explicit !== false
            || !Array.isArray(testCase.traits) || testCase.traits.length !== 0
            || testCase.identity !== 'static')
        {
            throw new Error('Migration execution requires admitted static, non-skipped cases without unregistered fixtures or traits');
        }
        if (testCase.fixture == null)
        {
            continue;
        }
        if (Object.entries(mysqlFixtureOwner).some(([field, value]) => testCase[field] !== value)
            || testCase.ownerClass !== 'MySqlDdlExecutionTests'
            || typeof testCase.id !== 'string' || !testCase.id.startsWith(`xunit:${mysqlFixtureOwner.ownerFile}#`))
        {
            throw new Error('Migration execution requires an exact source-owned MySQL fixture identity');
        }
        mysqlCaseIds.push(testCase.id);
    }
    return {
        profile: mysqlCaseIds.length === 0 ? 'none' : 'mysql',
        fixture: mysqlCaseIds.length === 0 ? null : { ...mysqlFixtureOwner },
        sourceCaseIds: mysqlCaseIds.sort()
    };
}

function requireAdmittedCases(report)
{
    const requirements = migrationFixtureRequirements(report);
    // Source ownership alone never admits a Docker service or permits execution.
    if (requirements.profile !== 'none')
    {
        throw new Error('Migration execution requires admitted MySQL fixture service, grant and cleanup evidence');
    }
}

/** Capture an actual dotnet child; the enclosing producer owns resource admission and cancellation. */
export async function executeMigrationDotnet(args, { root, env, stdoutFile, stderrFile })
{
    const stdout = fs.openSync(stdoutFile, 'wx');
    let stderr;
    try
    {
        stderr = fs.openSync(stderrFile, 'wx');
        return await new Promise((resolve, reject) =>
        {
            const executable = resolveExecutablePath('dotnet', { pathValue: env.PATH });
            const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', stdout, stderr] });
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
    }
    finally
    {
        fs.closeSync(stdout);
        if (stderr !== undefined)
        {
            fs.closeSync(stderr);
        }
    }
}

function commandPaths(plan, name)
{
    return {
        stdoutFile: path.join(plan.directory, `${name}.stdout`),
        stderrFile: path.join(plan.directory, `${name}.stderr`),
        commandFile: path.join(plan.directory, `${name}.command.json`)
    };
}

function readCommand(plan, name)
{
    const files = commandPaths(plan, name);
    if (!fs.statSync(files.stderrFile).isFile())
    {
        throw new Error(`Migration execution is missing command stderr evidence: ${name}`);
    }
    const record = JSON.parse(fs.readFileSync(files.commandFile, 'utf8'));
    if (record.executable !== 'dotnet' || record.code !== 0 || record.signal !== null
        || JSON.stringify(record.args) !== JSON.stringify(plan.commands[name]))
    {
        throw new Error(`Migration execution command failed or changed: ${name}`);
    }
    return fs.readFileSync(files.stdoutFile, 'utf8');
}

function readInventory(options, plan)
{
    const owner = sourceOwner(options.root);
    const report = validateXunitProjectReport(owner, JSON.parse(readCommand(plan, 'inventory')));
    requireAdmittedCases(report);
    return { sourceFiles: owner.sourceFiles, inventoryCases: report.testCases, assemblyFile: plan.assemblyFile };
}

function readDiscovery(plan)
{
    const discovery = readVstestDiscoveryDiagnostic(path.join(plan.directory, 'discovery'), { expectedSource: plan.assemblyFile });
    if (discovery.records.some((record) => Object.keys(record.traits).length !== 0))
    {
        throw new Error('Migration discovery contains unadmitted runtime traits');
    }
    return discovery.records;
}

function observeEngine(plan, env)
{
    const sdkVersion = readCommand(plan, 'sdk').trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(sdkVersion))
    {
        throw new Error('Migration execution is missing the observed SDK version');
    }
    const prefix = `${sdkVersion} [`;
    const sdkPaths = readCommand(plan, 'sdkPaths').split(/\r?\n/u)
        .filter((line) => line.startsWith(prefix) && line.endsWith(']'))
        .map((line) => line.slice(prefix.length, -1));
    if (sdkPaths.length !== 1 || !path.isAbsolute(sdkPaths[0]))
    {
        throw new Error('Migration execution requires one observed path for the selected SDK');
    }
    const vstestFile = fs.realpathSync(path.join(sdkPaths[0], sdkVersion, 'vstest.console.dll'));
    return {
        dotnet: observeExecutableIdentity('dotnet', {
            pathValue: env.PATH,
            observeVersion: () => ({ status: 0, stdout: sdkVersion })
        }),
        vstest: { file: vstestFile, sha256: createHash('sha256').update(fs.readFileSync(vstestFile)).digest('hex') }
    };
}

function requireUnchangedEngine(plan, env)
{
    const engine = observeEngine(plan, env);
    if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(plan.directory, 'engine.json'), 'utf8'))) !== JSON.stringify(engine))
    {
        throw new Error('Migration execution engine binary or selected SDK path changed');
    }
    return engine;
}

function inspectExecution(options, plan, build, env)
{
    const engine = requireUnchangedEngine(plan, env);
    const versions = ['discovery', 'execution'].map((name) =>
    {
        const matches = [...readCommand(plan, name).matchAll(/^VSTest version ([^\r\n]+)$/gmu)];
        if (matches.length !== 1)
        {
            throw new Error(`Migration execution is missing one observed VSTest version: ${name}`);
        }
        return matches[0][1];
    });
    // The same SDK prints an informational -release-* suffix only during
    // discovery. Preserve both banners; compare their core/architecture while
    // separately requiring the exact host and VSTest binary identities above.
    const parsed = versions.map((version) => /^(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)? \(([^)]+)\)$/u.exec(version));
    if (parsed.some((version) => !version) || parsed[0][1] !== parsed[1][1] || parsed[0][2] !== parsed[1][2])
    {
        throw new Error('Migration execution engine changed between discovery and execution');
    }
    const input = readInventory(options, plan);
    const discoveredCases = readDiscovery(plan);
    if (JSON.stringify(evidenceFiles(options.root, path.join(plan.directory, 'execution')).filter((file) => file.endsWith('.trx')))
        !== JSON.stringify([plan.trxFile]))
    {
        throw new Error('Migration execution requires exactly one independent TRX');
    }
    const reconciliation = reconcileMigrationTrx({
        ...input,
        discoveredCases,
        trx: fs.readFileSync(plan.trxFile, 'utf8')
    });
    return {
        schema: 'fsusblog.migration-execution.v1',
        runId: options.runId,
        namespace: options.namespace,
        sourceState: options.sourceState,
        buildMarkerDigest: build.marker.digest,
        configuration: 'Release',
        engine: { ...engine, discoveryVersion: versions[0], executionVersion: versions[1] },
        fixture: { profile: 'none', observations: [] },
        ...reconciliation
    };
}

function receiptOptions(options, plan, build)
{
    const producer = migrationProducerIdentity(options.producer);
    return {
        root: options.root,
        markerId: 'migration-tests-executed',
        runId: options.runId,
        sourceState: options.sourceState,
        producerBundleId: producer.bundleId,
        producerStepId: producer.executionStepId,
        artifacts: [build.file, ...evidenceFiles(options.root, plan.directory).filter((file) => file !== plan.receiptFile)],
        bindings: {
            schema: 'fsusblog.migration-execution-binding.v1',
            namespace: options.namespace,
            buildMarkerDigest: build.marker.digest,
            project,
            assembly: plan.assemblyFile
        }
    };
}

/** Revalidate raw execution, source/build closure and the producer's artifact seal. */
export async function readMigrationExecution(options, env = process.env)
{
    const build = await readMigrationBuildReady(options);
    const plan = executionPlan(options, env);
    const receipt = readRunBoundMarker(plan.receiptFile, receiptOptions(options, plan, build));
    const summary = inspectExecution(options, plan, build, env);
    if (JSON.stringify(JSON.parse(fs.readFileSync(plan.summaryFile, 'utf8'))) !== JSON.stringify(summary))
    {
        throw new Error('Migration execution summary differs from current raw evidence');
    }
    await readMigrationBuildReady(options);
    return { summary, receipt, ...plan };
}

/**
 * Execute the prebuilt independent assembly once. The injectable command driver
 * is for controlled unit fixtures; physical qualification belongs to the outer
 * execution owner, never to this function or its marker.
 */
export async function runMigrationTests(options, { env = process.env, execute = executeMigrationDotnet } = {})
{
    const layout = resolveProductionBuildLayout(options);
    if (env.FSUSBLOG_PRODUCTION_BUILD_ROOT !== layout.runRoot
        || env.FSUSBLOG_TEST_RUN_ID !== options.runId || env.FSUSBLOG_TEST_NAMESPACE !== options.namespace
        || env.FSUSBLOG_TEST_SOURCE_COMMIT !== options.sourceState?.commit
        || env.FSUSBLOG_TEST_SOURCE_FINGERPRINT !== options.sourceState?.worktreeFingerprint)
    {
        throw new Error('Migration execution environment differs from its run/source/build identity');
    }
    if (options.producer === 'backend-unit'
        && (env.CURRENT_TIER !== 'backend-unit' || String(env.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? '').trim()))
    {
        throw new Error('Migration unit execution requires its own matrix producer');
    }
    const build = await readMigrationBuildReady(options);
    const plan = executionPlan(options, env);
    requireOwnedPath(options.root, path.dirname(plan.directory), { createDirectories: true });
    // Exclusive creation rejects stale output and concurrent/repeated execution.
    fs.mkdirSync(plan.directory);
    fs.mkdirSync(path.join(plan.directory, 'discovery'));
    fs.mkdirSync(path.join(plan.directory, 'execution'));
    for (const name of ['sdk', 'sdkPaths', 'inventory', 'discovery', 'execution'])
    {
        if (!['sdk', 'sdkPaths'].includes(name))
        {
            requireUnchangedEngine(plan, env);
        }
        const files = commandPaths(plan, name);
        const result = await execute(plan.commands[name], { root: options.root, env, ...files });
        fs.writeFileSync(files.commandFile, JSON.stringify({
            executable: 'dotnet', args: plan.commands[name], code: result.code, signal: result.signal
        }), { flag: 'wx' });
        readCommand(plan, name);
        if (name === 'sdkPaths')
        {
            fs.writeFileSync(path.join(plan.directory, 'engine.json'), JSON.stringify(observeEngine(plan, env)), { flag: 'wx' });
        }
        if (name === 'inventory')
        {
            readInventory(options, plan);
        }
        if (name === 'discovery')
        {
            const input = readInventory(options, plan);
            reconcileMigrationDiscovery({ ...input, discoveredCases: readDiscovery(plan) });
            await readMigrationBuildReady(options);
        }
    }
    const summary = inspectExecution(options, plan, build, env);
    await readMigrationBuildReady(options);
    fs.writeFileSync(plan.summaryFile, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    publishRunBoundMarker({ file: plan.receiptFile, ...receiptOptions(options, plan, build) });
    return readMigrationExecution(options, env);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const args = process.argv.slice(2);
        if (args.length > 1 || (args.length === 1 && args[0] !== '--backend-unit'))
        {
            throw new Error('Migration execution accepts only the canonical scheduler environment, not CLI overrides');
        }
        const result = await runMigrationTests({
            producer: args[0] === '--backend-unit' ? 'backend-unit' : 'backend-tests',
            root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
            runId: process.env.FSUSBLOG_TEST_RUN_ID,
            namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
            sourceState: {
                commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
                worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
            }
        });
        console.log(`Migration execution passed: ${result.summary.executedCaseIds.length} cases; ${result.receiptFile}`);
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
