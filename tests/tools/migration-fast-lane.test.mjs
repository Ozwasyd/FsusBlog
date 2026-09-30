import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const support = path.resolve(import.meta.dirname, '../../tools/test/lanes/_suite-support.sh');
const { parseMatrix } = await import(new URL('../../tools/test-matrix/parse-matrix.mjs', import.meta.url));
const { buildStaticGovernanceExecutionPlan, loadStaticGovernanceRegistry } =
    await import(new URL('../../tools/test/static-governance-host.mjs', import.meta.url));
const { auditTestRecords, inferTierIdsForFile } =
    await import(new URL('../../tools/test-retention/audit.mjs', import.meta.url));

test('Migration retention projects its independent executor without Server coverage or summary invocations', async (t) =>
{
    const file = 'tests/migration/FutureProviderTests.cs';
    for (const category of [null, 'Integration', 'Concurrency', 'Property', 'Performance'])
    {
        assert.deepEqual(inferTierIdsForFile(file, '', category), ['backend-unit']);
    }
    assert.deepEqual(inferTierIdsForFile('tests/backend/Unit/ExampleTests.cs', '', null),
        ['backend-unit', 'coverage-backend']);
    assert.deepEqual(inferTierIdsForFile('tests/backend/Unit/ExampleTests.cs', '', 'Concurrency'),
        ['backend-concurrency', 'backend-nightly']);
    assert.deepEqual(inferTierIdsForFile('tests/migration-other/ForeignTests.cs', ''), []);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-retention-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tests/migration'), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'public sealed class FutureProviderTests { }\n');
    const fixtureFile = 'tests/migration/ProviderFixture.cs';
    fs.writeFileSync(path.join(root, fixtureFile), 'public sealed class ProviderFixture { }\n');
    // Controlled adapter input exercises the retention consumer, not Roslyn
    // extraction or a physical Migration test execution.
    const id = `xunit:${file}#FutureProviderTests.ProviderCase#case-0000`;
    const records = await auditTestRecords({
        root,
        files: [file, fixtureFile],
        fileMetadata: new Map([[file, {
            coverageIds: [],
            tierIds: ['backend-fast', 'coverage-backend', 'static-governance']
        }]]),
        timingHistory: new Map(),
        failureHistory: new Map(),
        inventory: { testCases: [{
            id, displayName: 'FutureProviderTests.ProviderCase', kind: 'fact',
            identity: 'static', adapter: 'xunit', ownerFile: file,
            ownerClass: 'FutureProviderTests', ownerSuite: 'FutureProviderTests',
            methodName: 'ProviderCase', bodySource: '{ Assert.True(true); }',
            traits: [{ name: 'Category', value: 'Integration' }]
        }] }
    });
    const cases = records.filter((entry) => entry.framework === 'xunit');
    assert.equal(records.length, 2);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].id, id);
    assert.deepEqual(cases[0].tierIds, ['backend-unit']);
    assert.equal(cases[0].tierInvocationCount, 1);
    assert.equal(records.find((entry) => entry.path === fixtureFile).framework, 'xunit-support');
});

test('Migration governance suites have exactly one independent physical owner', () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const file = path.join(root, 'tests/governance/test-lifecycle-registry.json');
    const lifecycle = JSON.parse(fs.readFileSync(file, 'utf8'));
    const registry = loadStaticGovernanceRegistry(file, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    for (const id of ['migration-execution-evidence', 'migration-fast-lane'])
    {
        const testFile = `tests/tools/${id}.test.mjs`;
        const entries = lifecycle.nodeTests.filter((entry) => entry.file === testFile);
        assert.equal(entries.length, 1, testFile);
        assert.equal(entries[0].owner, 'repository-governance:static-node-contracts');
        assert.equal(entries[0].executionCategory, 'repository-governance');
        assert.equal(entries[0].lifecycle, 'canonical-execution');
        assert.equal(entries[0].physicalExecutionCount, 1);
        const hosts = plan.hosts.filter((host) => host.checks.some((check) => check.id === id));
        assert.equal(hosts.length, 1, id);
        assert.equal(hosts[0].category, 'real-subprocess-lifecycle');
        assert.equal(hosts[0].checks.length, 1);
        assert.equal(hosts[0].checks[0].file, testFile);
        assert.equal(hosts[0].checks[0].physicalOwner, 'process:lifecycle');
    }
});

test('matrix fast lanes track the independent Migration implementation and keep the summary a consumer', () =>
{
    const matrix = parseMatrix(fs.readFileSync(new URL('../matrix.yml', import.meta.url), 'utf8'));
    const unit = matrix.tiers.find((tier) => tier.id === 'backend-unit');
    const fast = matrix.tiers.find((tier) => tier.id === 'backend-fast');
    for (const input of [
        'tools/test/build-migration-tests.mjs', 'tools/test/run-migration-tests.mjs',
        'tools/test/migration-build-binding.mjs', 'tools/test/migration-execution-evidence.mjs',
        'tools/test-inventory', 'tests/tools/migration-fast-lane.test.mjs'
    ])
    {
        assert.ok(unit.cacheInputs.includes(input), input);
    }
    assert.ok(fast.executionDependsOn.includes('backend-unit'));
    assert.ok(fast.cacheInputs.includes('tools/test/lanes/_suite-support.sh'));
    assert.ok(fast.cacheInputs.includes('tools/test/run-migration-tests.mjs'));
    assert.equal(fast.requiresNode, true);
    assert.equal(fast.requiresDotnet, false);
    assert.equal(fast.executionKey, 'backend-fast-summary');
});

function shell(script, args = [], env = {})
{
    return spawnSync('bash', ['-c', script, 'migration-lane-fixture', support, ...args], {
        encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024
    });
}

test('backend-unit calls the locked Release Migration builder and independent runner exactly once', () =>
{
    const result = shell([
        'source "$1"',
        'Run() { printf "CALL %s\\n" "$*"; }',
        'ConfigureDotnetTestProcessors() { printf "PROCESSORS\\n"; }',
        'WriteBackendSplitSummary() { printf "SUMMARY %s\\n" "$*"; }',
        'FSUSBLOG_TEST_SELECTION=affected',
        'RunBackendUnitLane'
    ].join('\n'), [], {
        CURRENT_TIER: 'backend-unit',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64),
        FSUSBLOG_TEST_RUN_ID: 'matrix-unit-fixture',
        FSUSBLOG_TEST_NAMESPACE: 'matrix-unit-fixture'
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = result.stdout.split('\n').filter((line) => line.startsWith('CALL '));
    const builds = calls.filter((line) => line.includes('/build-migration-tests.mjs'));
    const executions = calls.filter((line) => line.includes('/run-migration-tests.mjs'));
    assert.equal(builds.length, 1);
    assert.equal(executions.length, 1);
    assert.match(builds[0], /run-with-dotnet-release-build-lock\.sh .*build-with-data-env\.sh .*build-migration-tests\.mjs/u);
    assert.match(executions[0], /run-migration-tests\.mjs --backend-unit$/u);
    assert.doesNotMatch(result.stdout, /dotnet test.*Migration/u);
    assert.ok(result.stdout.indexOf(builds[0]) < result.stdout.indexOf('PROCESSORS'));
    assert.ok(result.stdout.indexOf('PROCESSORS') < result.stdout.indexOf(executions[0]));
    assert.ok(result.stdout.indexOf(executions[0]) < result.stdout.indexOf('SUMMARY backend-unit'));
});

test('backend-unit build failure does not proceed to Migration execution or success summary', () =>
{
    const result = shell([
        'source "$1"',
        'Run() { printf "CALL %s\\n" "$*"; if [[ "$*" == *build-migration-tests.mjs* ]]; then return 23; fi; }',
        'ConfigureDotnetTestProcessors() { printf "PROCESSORS\\n"; }',
        'WriteBackendSplitSummary() { printf "SUMMARY\\n"; }',
        'FSUSBLOG_TEST_SELECTION=affected',
        'RunBackendUnitLane'
    ].join('\n'), [], { CURRENT_TIER: 'backend-unit' });
    assert.equal(result.status, 23, result.stderr);
    assert.doesNotMatch(result.stdout, /run-migration-tests\.mjs|SUMMARY|PROCESSORS/u);
});

function summaryFixture(t, { failing = false } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-summary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tools/test'), { recursive: true });
    // Only the shell-to-reader contract is simulated here; raw evidence and
    // negative bindings are exercised by migration-execution-evidence tests.
    fs.writeFileSync(path.join(root, 'tools/test/run-migration-tests.mjs'), [
        'export async function readMigrationExecution(options) {',
        '  if (options.producer !== "backend-unit" || options.runId !== "summary-run"',
        '    || options.namespace !== "summary-namespace"',
        '    || options.sourceState.commit !== "a".repeat(40)',
        '    || options.sourceState.worktreeFingerprint !== "b".repeat(64)) throw new Error("crossed summary identity");',
        ...(failing ? ['  throw new Error("controlled missing Migration receipt");'] : [
            '  return { receipt: { digest: "c".repeat(64) },',
            '    receiptFile: options.root + "/.tmp/test-runs/summary-run/migration-execution/receipt.json",',
            '    summary: { project: "tests/migration/FsusBlog.Migration.Tests.csproj",',
            '      sourceCaseIds: ["source-case"], executedCaseIds: ["runtime-case"] } };'
        ]),
        '}',
        'export const readMigrationExecutionDependency = readMigrationExecution;',
        ''
    ].join('\n'));
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'summary-run', FSUSBLOG_TEST_NAMESPACE: 'summary-namespace',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40), FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64)
    };
    return { root, env };
}

test('backend-unit and backend-fast summaries consume the bound receipt without rerunning tests', (t) =>
{
    const { root, env } = summaryFixture(t);
    for (const lane of ['backend-unit', 'backend-fast'])
    {
        const result = shell([
            'source "$1"',
            'ROOT_DIR="$2"',
            'WriteBackendSplitSummary "$3" dependency-summary'
        ].join('\n'), [root, lane], { ...env, CURRENT_TIER: lane });
        assert.equal(result.status, 0, result.stderr);
        const summary = JSON.parse(fs.readFileSync(path.join(root, '.tmp', lane, 'summary.json')));
        assert.equal(summary.status, 'success');
        assert.deepEqual(summary.migrationExecution, {
            receiptFile: '.tmp/test-runs/summary-run/migration-execution/receipt.json',
            receiptDigest: 'c'.repeat(64),
            project: 'tests/migration/FsusBlog.Migration.Tests.csproj',
            sourceCaseIds: ['source-case'],
            executedCaseIds: ['runtime-case']
        });
    }
});

test('fast summary fails closed when its Migration receipt is missing or crosses scheduler identity', (t) =>
{
    for (const failing of [true, false])
    {
        const { root, env } = summaryFixture(t, { failing });
        const result = shell([
            'source "$1"',
            'ROOT_DIR="$2"',
            'WriteBackendSplitSummary backend-fast dependency-summary'
        ].join('\n'), [root], { ...env, ...(!failing ? { FSUSBLOG_TEST_NAMESPACE: 'foreign' } : {}) });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /controlled missing Migration receipt|crossed summary identity/u);
        assert.equal(fs.existsSync(path.join(root, '.tmp/backend-fast/summary.json')), false);
    }
});
