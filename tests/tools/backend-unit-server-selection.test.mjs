import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { projectBackendPlatformPlan } = await import(new URL('../../tools/test/backend-platform-selection.mjs', import.meta.url));
const { planBackendUnitServerSelection, resolveBackendUnitServerSelection, runBackendUnitServerSelectionAction } = await import(new URL('../../tools/test/backend-unit-server-selection.mjs', import.meta.url));
const { readMigrationExecution, readMigrationExecutionDependency, runMigrationTests } = await import(new URL('../../tools/test/run-migration-tests.mjs', import.meta.url));

// These ordinary selection/entry controls use synthetic discovery metadata only.
// No SDK, real test assembly, DB fixture, receipt or consumer execution is used.
const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) };
const fact = 'FsusBlog.Server.Tests.Unit.OrdinarySelectionControl.Fact';
const theory = 'FsusBlog.Server.Tests.Unit.OrdinarySelectionControl.Theory';
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const support = path.join(repositoryRoot, 'tools/test/lanes/_suite-support.sh');

function fixture()
{
    const assemblyFile = path.resolve('ordinary-selection-fixture/FsusBlog.Server.Tests.dll');
    const selection = { schema: 'fsusblog.backend-unit-server-selection.v1', sourceState: { ...sourceState },
        methods: [{ fullyQualifiedName: fact, expectedCaseCount: 1 }, { fullyQualifiedName: theory, expectedCaseCount: 2 }],
        migration: 'not-selected' };
    const records = [fact, `${theory}(value: 1)`, `${theory}(value: 2)`].map((displayName, index) => ({
        id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
        fullyQualifiedName: index === 0 ? fact : theory, displayName, source: assemblyFile, traits: {}
    }));
    const { filter } = resolveBackendUnitServerSelection(selection, sourceState);
    return { selection, sourceState, runId: 'ordinary-selection-control', namespace: 'ordinary-selection-control',
        assemblyFile, records, platformPlan: projectBackendPlatformPlan(records, process.platform, { baseFilter: filter, lane: 'backend-unit' }) };
}

test('ordinary exact whole-method plan retains all actual fixture rows and declares incomplete aggregate coverage', () =>
{
    const input = fixture();
    const before = structuredClone(input);
    const plan = planBackendUnitServerSelection(input);
    assert.equal(plan.expectedCaseCount, 3);
    assert.deepEqual(plan.cases.map((record) => record.id), input.records.map((record) => record.id));
    assert.deepEqual(plan.cases.map((record) => record.displayName), input.records.map((record) => record.displayName));
    assert.equal(plan.migration, 'not-selected');
    assert.equal(plan.qualificationEligible, false);
    assert.equal(plan.aggregateCoverage, 'incomplete');
    assert.match(plan.executionFilter, /FullyQualifiedName=FsusBlog\.Server\.Tests\.Unit\.OrdinarySelectionControl\.Fact\|FullyQualifiedName=FsusBlog\.Server\.Tests\.Unit\.OrdinarySelectionControl\.Theory/u);
    assert.match(plan.executionFilter, /Category!=Property.*Fixture!=LocalRedis$/u);
    assert.deepEqual(input, before);
});

test('ordinary declaration rejects missing, broad, duplicate, row-specific and foreign-source selections', () =>
{
    const mutations = [
        (value) =>
        {
            delete value.methods;
        },
        (value) =>
        {
            value.methods = [];
        },
        (value) =>
        {
            value.migration = 'all';
        },
        (value) =>
        {
            value.filter = 'FullyQualifiedName~Ordinary';
        },
        (value) =>
        {
            value.methods.push({ ...value.methods[0] });
        },
        (value) =>
        {
            value.methods[0].fullyQualifiedName += '|Category=Integration';
        },
        (value) =>
        {
            value.methods[0].fullyQualifiedName = 'FullyQualifiedName~Ordinary';
        },
        (value) =>
        {
            value.methods[0].fullyQualifiedName += '(value: 1)';
        },
        (value) =>
        {
            value.methods[0].fullyQualifiedName = 'FsusBlog.Migration.Tests.Example.Fact';
        },
        (value) =>
        {
            value.methods[0].expectedCaseCount = 0;
        },
        (value) =>
        {
            value.methods[0].expectedCaseCount = 1.5;
        },
        (value) =>
        {
            value.sourceState.commit = 'c'.repeat(40);
        },
        (value) =>
        {
            value.sourceState.worktreeFingerprint = 'c'.repeat(64);
        }
    ];
    for (const mutate of mutations)
    {
        const { selection } = fixture();
        mutate(selection);
        assert.throws(() => resolveBackendUnitServerSelection(selection, sourceState), /bounded backend-unit selection/u);
    }
});

test('ordinary plan rejects missing rows, ambiguous identities, other assemblies, fixtures and platform drift', () =>
{
    const mutations = [
        (value) =>
        {
            value.records.pop();
        },
        (value) =>
        {
            value.records[2].id = value.records[1].id;
        },
        (value) =>
        {
            value.records[2].displayName = value.records[1].displayName;
        },
        (value) =>
        {
            value.records[2].fullyQualifiedName = `${fact}Other`;
        },
        (value) =>
        {
            value.records[2].source = path.resolve('ordinary-selection-fixture/FsusBlog.Migration.Tests.dll');
        },
        (value) =>
        {
            value.records[2].traits = { Fixture: ['LocalRedis'] };
        },
        (value) =>
        {
            value.records[2].traits = { Category: ['Integration'] };
        },
        (value) =>
        {
            value.records[2].traits = { Category: 'Integration' };
        },
        (value) =>
        {
            value.platformPlan.executionFilter = 'FullyQualifiedName~Ordinary';
        },
        (value) =>
        {
            value.platformPlan.plannedTestCaseCount = 2;
        },
        (value) =>
        {
            value.selection.methods[1].expectedCaseCount = 3;
        },
        (value) =>
        {
            value.namespace = '';
        }
    ];
    for (const mutate of mutations)
    {
        const input = fixture();
        mutate(input);
        assert.throws(() => planBackendUnitServerSelection(input), /bounded backend-unit selection/u);
    }
});

function filesFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ordinary-selection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const temporary = path.join(root, '.tmp');
    fs.mkdirSync(temporary);
    const input = fixture();
    input.assemblyFile = path.join(temporary, 'FsusBlog.Server.Tests.dll');
    fs.writeFileSync(input.assemblyFile, 'ordinary unit metadata fixture, not an executable assembly');
    input.records.forEach((record) =>
    {
        record.source = input.assemblyFile;
    });
    const file = path.join(temporary, 'selection.json');
    fs.writeFileSync(file, JSON.stringify(input.selection));
    const env = { CURRENT_TIER: 'backend-unit', FSUSBLOG_TEST_SELECTION: 'bounded-server',
        FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: file, FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
        FSUSBLOG_TEST_RUN_ID: input.runId, FSUSBLOG_TEST_NAMESPACE: input.namespace };
    const args = ['--backend-unit', '--server-selection', file, '--selection-action', 'filter'];
    return { root, input, file, env, args };
}

test('ordinary explicit CLI action validates exact options and source before returning a filter', (t) =>
{
    const { root, input, args, env } = filesFixture(t);
    assert.equal(runBackendUnitServerSelectionAction(args, { root, env }), resolveBackendUnitServerSelection(input.selection, sourceState).filter);
    for (const invalid of [args.slice(0, -1), [...args, '--selection-action', 'filter'], [...args, '--unknown', 'value'],
        args.map((value) => value === 'filter' ? 'all' : value), args.slice(1)])
    {
        assert.throws(() => runBackendUnitServerSelectionAction(invalid, { root, env }), /bounded backend-unit selection/u);
    }
    for (const changed of [{ ...env, FSUSBLOG_TEST_SELECTION: 'affected' }, { ...env, CURRENT_TIER: 'backend-fast' },
        { ...env, FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: '' }, { ...env, FSUSBLOG_PHYSICAL_BUNDLE_ID: 'physical-owner' },
        { ...env, FSUSBLOG_TEST_RUN_ID: '' }, { ...env, FSUSBLOG_TEST_NAMESPACE: '' }])
    {
        assert.throws(() => runBackendUnitServerSelectionAction(args, { root, env: changed }), /bounded backend-unit selection/u);
    }
});

function verificationFixture(t)
{
    const { root, input, file, env } = filesFixture(t);
    const directory = path.join(root, '.tmp', 'discovery');
    fs.mkdirSync(directory);
    const payload = { TotalTests: 3, LastDiscoveredTests: input.records.map((record) => ({
        Id: record.id, FullyQualifiedName: record.fullyQualifiedName, DisplayName: record.displayName, Source: record.source, Properties: []
    })), IsAborted: false, FullyDiscoveredSources: [input.assemblyFile], PartiallyDiscoveredSources: [], NotDiscoveredSources: [], SkippedDiscoverySources: [] };
    fs.writeFileSync(path.join(directory, 'union.host.fixture.txt'), `sending data from testhost: ${JSON.stringify({ MessageType: 'TestDiscovery.Completed', Payload: payload })}\n`);
    const platformFile = path.join(root, '.tmp', 'platform-plan.json');
    fs.writeFileSync(platformFile, JSON.stringify(input.platformPlan));
    const selectionPlan = path.join(root, '.tmp', 'selection-plan.json');
    const args = ['--backend-unit', '--server-selection', file, '--selection-action', 'verify', '--diagnostic-root', directory,
        '--source', input.assemblyFile, '--platform-plan', platformFile, '--selection-plan', selectionPlan];
    return { root, env, args, selectionPlan, directory };
}

test('ordinary verify action uses the original completed diagnostic reader and never creates a Migration receipt', (t) =>
{
    const { root, env, args, selectionPlan } = verificationFixture(t);
    assert.match(runBackendUnitServerSelectionAction(args, { root, env }), /3 actual discovered cases; Migration not-selected/u);
    const planned = JSON.parse(fs.readFileSync(selectionPlan, 'utf8'));
    assert.equal(planned.qualificationEligible, false);
    assert.equal(fs.existsSync(path.join(root, '.tmp', 'migration-execution')), false);
    assert.throws(() => runBackendUnitServerSelectionAction(args, { root, env }), /EEXIST/u);
});

test('ordinary temporary guards reject escaped and symlinked discovery and output paths', (t) =>
{
    const { root, env, args, directory } = verificationFixture(t);
    const outside = fs.mkdtempSync(`${root}-outside-`);
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const sibling = path.join(root, '.tmp-sibling');
    fs.mkdirSync(sibling);
    const redirected = path.join(root, '.tmp', 'redirected');
    fs.symlinkSync(sibling, redirected, 'junction');
    for (const [option, files] of [['--diagnostic-root', [root, path.join(root, '.tmp'), sibling,
        path.join(root, '.tmp', '..', '.tmp-sibling'), outside, redirected]],
    ['--selection-plan', [path.join(root, 'plan.json'), path.join(sibling, 'plan.json'),
        path.join(root, '.tmp', '..', '.tmp-sibling', 'plan.json'), path.join(outside, 'plan.json'), path.join(redirected, 'plan.json')]]])
    {
        for (const file of files)
        {
            const invalid = [...args];
            invalid[invalid.indexOf(option) + 1] = file;
            assert.throws(() => runBackendUnitServerSelectionAction(invalid, { root, env }), /original repository temporary directory/u);
        }
    }
    assert.equal(fs.existsSync(path.join(root, 'plan.json')), false);
    assert.equal(fs.existsSync(path.join(sibling, 'plan.json')), false);
    assert.equal(fs.existsSync(path.join(outside, 'plan.json')), false);
    assert.equal(fs.existsSync(path.join(directory, 'plan.json')), false);
});

test('ordinary direct Migration calls refuse bounded mode before build, engine or execution access', async () =>
{
    let commands = 0;
    const env = { FSUSBLOG_TEST_SELECTION: 'bounded-server' };
    await assert.rejects(runMigrationTests({}, { env, execute: () =>
    {
        commands++;
    } }), /does not admit Migration/u);
    await assert.rejects(readMigrationExecution({}, env), /does not admit Migration/u);
    await assert.rejects(readMigrationExecutionDependency({}, env), /does not admit Migration/u);
    await assert.rejects(runMigrationTests({}, { env: { FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: 'explicit.json' } }), /does not admit Migration/u);
    await assert.rejects(runMigrationTests({}, { env: { FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: ' ' } }), /does not admit Migration/u);
    await assert.rejects(runMigrationTests({}, { env: { CURRENT_TIER: 'backend-unit', FSUSBLOG_TEST_SELECTION: 'bounded-server ' } }), /does not admit Migration/u);
    assert.equal(commands, 0);
});

test('ordinary original CLI rejects missing selection before starting any engine', () =>
{
    for (const args of [['--backend-unit'], ['--backend-unit', '--server-selection']])
    {
        const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tools/test/run-migration-tests.mjs'), ...args], {
            env: { ...process.env, FSUSBLOG_TEST_SELECTION: 'bounded-server', FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: '', CURRENT_TIER: 'backend-unit' }, encoding: 'utf8'
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /bounded backend-unit selection/u);
    }
});

test('ordinary original CLI accepts the explicit positive filter plan without an engine', (t) =>
{
    fs.mkdirSync(path.join(repositoryRoot, '.tmp'), { recursive: true });
    const directory = fs.mkdtempSync(path.join(repositoryRoot, '.tmp', 'ordinary-server-selection-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'selection.json');
    fs.writeFileSync(file, JSON.stringify(fixture().selection));
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tools/test/run-migration-tests.mjs'),
        '--backend-unit', '--server-selection', file, '--selection-action', 'filter'], {
        env: { ...process.env, FSUSBLOG_TEST_SELECTION: 'bounded-server', FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: file,
            CURRENT_TIER: 'backend-unit', FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint, FSUSBLOG_PHYSICAL_BUNDLE_ID: '',
            FSUSBLOG_TEST_RUN_ID: 'ordinary-positive-cli', FSUSBLOG_TEST_NAMESPACE: 'ordinary-positive-cli' }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), resolveBackendUnitServerSelection(fixture().selection, sourceState).filter);
});

test('ordinary default full and affected shell paths keep the whole Migration entry and aggregate producers', () =>
{
    for (const mode of ['', 'full', 'affected'])
    {
        const result = spawnSync('bash', ['-c', [
            'source "$1"',
            'node() { printf "DEFAULT_FILTER"; }',
            'Run() { printf "CALL %s\\n" "$*"; }',
            'PrepareBackendPlatformPlan() { printf "PLATFORM %s\\n" "$*"; }',
            'RunBackendDotnetFilterOnly() { printf "ORACLE %s\\n" "$*"; }',
            'FinalizeBackendPlatformOutcome() { printf "FINALIZE %s\\n" "$*"; }',
            'ConfigureDotnetTestProcessors() { printf "PROCESSORS\\n"; }',
            'WriteBackendSplitSummary() { printf "SUMMARY %s\\n" "$*"; }',
            'RunBackendUnitLane'
        ].join('\n'), 'ordinary-default-shell', support], { env: { ...process.env, FSUSBLOG_NODE: 'node',
            CURRENT_TIER: 'backend-unit', FSUSBLOG_TEST_SELECTION: mode, FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: '',
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit, FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
            FSUSBLOG_TEST_RUN_ID: 'ordinary-default', FSUSBLOG_TEST_NAMESPACE: 'ordinary-default' }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.split('\n').filter((line) => /CALL .*run-migration-tests\.mjs --backend-unit$/u.test(line)).length, 1);
        assert.match(result.stdout, /build-migration-tests\.mjs/u);
        assert.match(result.stdout, /generate-migration-assembly-receipt\.mjs --write --backend-unit/u);
        assert.match(result.stdout, /SUMMARY backend-unit/u);
        assert.match(result.stdout, /produce-integrity-proof-evidence\.mjs/u);
        assert.doesNotMatch(result.stdout, /--server-selection|bounded-server/u);
    }
});

test('ordinary original shell dispatch preserves build/discovery/oracle order and prevents aggregate success', () =>
{
    const result = spawnSync('bash', ['-c', [
        'source "$1"',
        'Log() { printf "LOG %s\\n" "$*"; }',
        'node() { if [[ "$*" == *"--selection-action filter"* ]]; then printf "EXACT_FILTER"; else printf "EXECUTION_FILTER"; fi; }',
        'Run() { printf "CALL %s\\n" "$*"; }',
        'PrepareBackendPlatformPlan() { printf "PLATFORM %s\\n" "$*"; }',
        'RunBackendDotnetFilterOnly() { printf "ORACLE %s\\n" "$*"; }',
        'FinalizeBackendPlatformOutcome() { printf "FINALIZE %s\\n" "$*"; }',
        'BackendTestRuntimeOutputDirectory() { printf "/ordinary-fixture"; }',
        'WriteBackendSplitSummary() { printf "FORBIDDEN_SUMMARY\\n"; }',
        'RunBackendUnitLane'
    ].join('\n'), 'ordinary-selection-shell', support], { env: { ...process.env, FSUSBLOG_NODE: 'node',
        CURRENT_TIER: 'backend-unit', FSUSBLOG_TEST_SELECTION: 'bounded-server', FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: 'ordinary-fixture.json' }, encoding: 'utf8' });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /PLATFORM backend-unit EXACT_FILTER/u);
    assert.match(result.stdout, /ORACLE EXECUTION_FILTER backend-unit/u);
    assert.ok(result.stdout.indexOf('--selection-action verify') < result.stdout.indexOf('ORACLE'));
    assert.ok(result.stdout.indexOf('FINALIZE') < result.stdout.indexOf('--selection-action outcome'));
    assert.doesNotMatch(result.stdout, /build-migration-tests|generate-migration-assembly-receipt|FORBIDDEN_SUMMARY|produce-integrity-proof/u);
});

test('ordinary original shell refuses implicit or missing selection before any Run command', () =>
{
    for (const [mode, file] of [['full', 'explicit.json'], ['bounded-server', ''], ['bounded-server ', ''], ['unknown', '']])
    {
        const result = spawnSync('bash', ['-c', 'source "$1"\nRun() { printf "FORBIDDEN_RUN\\n"; }\nRunBackendUnitLane',
            'ordinary-refusal-shell', support], { env: { ...process.env, FSUSBLOG_TEST_SELECTION: mode, FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: file }, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /FORBIDDEN_RUN/u);
    }
});

test('ordinary original preparation propagates build and discovery failures under conditional dispatch', (t) =>
{
    const { root } = filesFixture(t);
    for (const [stage, expectedStatus] of [['membership', 31], ['configuration', 19], ['build', 17],
        ['output', 21], ['platform', 22], ['diagnostic-cleanup', 24], ['plan-cleanup', 25],
        ['directory', 26], ['discovery', 23], ['plan', 37]])
    {
        const result = spawnSync('bash', ['-c', [
            'source "$1"',
            'ROOT_DIR="$2"',
            'failureStage="$3"',
            'Log() { :; }',
            'node() { if [[ "$*" == *"--selection-action filter"* ]]; then printf "EXACT_FILTER"; elif [[ "$*" == *"process.platform"* ]]; then [[ "$failureStage" != platform ]] || return 22; printf "linux"; else printf "EXECUTION_FILTER"; fi; }',
            'Run() { printf "CALL %s\\n" "$*"; if [[ "$*" == *"--ordinary-plan"* && "$failureStage" == membership ]]; then return 31; fi; if [[ "$*" == *"backend-platform-selection.mjs plan"* && "$failureStage" == plan ]]; then return 37; fi; }',
            'BackendTestConfiguration() { [[ "$failureStage" != configuration ]] || return 19; printf "Debug"; }',
            'EnsureBackendFilteredBuild() { printf "BUILD\\n"; [[ "$failureStage" != build ]] || return 17; }',
            'BackendTestRuntimeOutputDirectory() { [[ "$failureStage" != output ]] || return 21; printf "%s/.tmp/runtime" "$ROOT_DIR"; }',
            'rm() { if [[ "$failureStage" == diagnostic-cleanup && "$1" == -rf ]]; then return 24; fi; if [[ "$failureStage" == plan-cleanup && "$1" == -f ]]; then return 25; fi; command rm "$@"; }',
            'mkdir() { [[ "$failureStage" != directory ]] || return 26; command mkdir "$@"; }',
            'OrdinaryDiscovery() { printf "DISCOVERY\\n" >&2; [[ "$failureStage" != discovery ]] || return 23; }',
            'BUILD_ENV_RUNNER=OrdinaryDiscovery',
            'RunBackendDotnetFilterOnly() { printf "FORBIDDEN_ORACLE\\n"; }',
            'FinalizeBackendPlatformOutcome() { printf "FORBIDDEN_FINALIZE\\n"; }',
            'WriteBackendSplitSummary() { printf "FORBIDDEN_SUMMARY\\n"; }',
            'status=0',
            'RunBackendUnitLane || status=$?',
            'exit "$status"'
        ].join('\n'), 'ordinary-preparation-failure', support, root, stage], { env: { ...process.env,
            FSUSBLOG_NODE: 'node', CURRENT_TIER: 'backend-unit', FSUSBLOG_TEST_SELECTION: 'bounded-server',
            FSUSBLOG_BACKEND_UNIT_SELECTION_FILE: 'ordinary-fixture.json', FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint, FSUSBLOG_TEST_RUN_ID: 'ordinary-failure',
            FSUSBLOG_TEST_NAMESPACE: 'ordinary-failure' }, encoding: 'utf8' });
        assert.equal(result.status, expectedStatus, `${stage}: ${result.stderr}\n${result.stdout}`);
        assert.doesNotMatch(result.stdout, /--selection-action verify|--selection-action outcome|FORBIDDEN_|build-migration-tests|generate-migration-assembly-receipt|produce-integrity-proof/u);
        if (!['discovery', 'plan'].includes(stage))
        {
            assert.doesNotMatch(result.stderr, /DISCOVERY/u);
        }
        if (stage !== 'plan')
        {
            assert.doesNotMatch(result.stdout, /backend-platform-selection\.mjs plan/u);
        }
    }
});

test('ordinary temporary containment uses POSIX and Windows path components without normalizing separators', async () =>
{
    const { isBackendUnitTemporaryPath } = await import(new URL('../../tools/test/backend-unit-server-selection.mjs', import.meta.url));
    for (const [pathApi, root] of [[path.posix, '/ordinary-repository'], [path.win32, 'C:\\ordinary-repository'],
        [path.win32, '\\\\server\\share\\repository']])
    {
        for (const file of [pathApi.join(root, '.tmp', 'plan.json'), pathApi.join(root, '.tmp', 'discovery', 'host.txt'),
            pathApi.join(root, '.tmp', '..ordinary', 'plan.json')])
        {
            assert.equal(isBackendUnitTemporaryPath(root, file, pathApi), true, file);
        }
        for (const file of [root, pathApi.join(root, '.tmp'), pathApi.join(root, '.tmp-sibling', 'plan.json'),
            pathApi.join(root, '.tmp', '..', 'plan.json'), pathApi.join(root, '..', '.tmp', 'plan.json')])
        {
            assert.equal(isBackendUnitTemporaryPath(root, file, pathApi), false, file);
        }
    }
    assert.equal(isBackendUnitTemporaryPath('C:\\ordinary-repository', 'D:\\ordinary-repository\\.tmp\\plan.json', path.win32), false);
    assert.equal(isBackendUnitTemporaryPath('\\\\server\\share\\repository', '\\\\server\\other-share\\repository\\.tmp\\plan.json', path.win32), false);
    assert.equal(isBackendUnitTemporaryPath('/ordinary-repository', '/ordinary-repository/.tmp\\plan.json', path.posix), false);
});
