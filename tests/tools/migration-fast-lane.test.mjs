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


function shell(script, args = [], env = {})
{
    return spawnSync('bash', ['-c', script, 'migration-lane-fixture', support, ...args], {
        encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024
    });
}



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
        ''
    ].join('\n'));
    const env = {
        FSUSBLOG_TEST_RUN_ID: 'summary-run', FSUSBLOG_TEST_NAMESPACE: 'summary-namespace',
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40), FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'b'.repeat(64)
    };
    return { root, env };
}



// Keep the original fixture context available after its already retained cases
// move to their existing physical owner. This module does not execute them.
export { parseMatrix, shell, summaryFixture };
