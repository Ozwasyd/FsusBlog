/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tool under test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';


import {
    buildStaticGovernanceExecutionPlan,
    buildStaticGovernanceHostEvidence,
    buildStaticGovernanceTestCatalog,
    collectExecutedStaticGovernanceTestIds,
    loadStaticGovernanceIsolationRegistry
} from '../../tools/test/static-governance-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryFile = path.join(root, 'tests/governance/static-governance-isolation-registry.json');

test('isolation registry assigns every migrated static check to one physical owner', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const owned = plan.hosts.flatMap((host) => host.checks.map((check) => check.id));

    assert.equal(new Set(owned).size, registry.checks.length);
    assert.deepEqual(owned.toSorted(), registry.checks.map((check) => check.id).toSorted());
    assert.ok(plan.hosts.filter((host) => host.category === 'pure-file-validation').length <= 2);
});

test('temporary repository cases share a host but retain unique roots and outputs', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    const fixtures = registry.checks.filter((check) => check.category === 'isolated-temporary-repository-fixture');
    assert.ok(fixtures.length > 1);
    assert.equal(new Set(fixtures.map((check) => check.physicalOwner)).size, 1);
    assert.equal(new Set(fixtures.map((check) => check.temporaryRoot)).size, fixtures.length);
    assert.equal(new Set(fixtures.map((check) => check.output)).size, fixtures.length);
});

test('lifecycle and destructive checks preserve independent process boundaries', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    for (const host of plan.hosts.filter((entry) => entry.category === 'real-subprocess-lifecycle'))
    {
        assert.equal(host.checks.length, 1);
        assert.equal(host.exclusive, false);
    }
    for (const host of plan.hosts.filter((entry) => entry.category === 'exclusive-resource-destructive-rehearsal'))
    {
        assert.equal(host.checks.length, 1);
        assert.equal(host.exclusive, true);
    }
});

test('registry and execution evidence fail closed for missing, duplicate and unknown checks', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    assert.throws(
        () => buildStaticGovernanceExecutionPlan({ ...registry, checks: [...registry.checks, registry.checks[0]] }),
        /duplicate static governance check ID/u
    );
    assert.throws(
        () => buildStaticGovernanceExecutionPlan({
            ...registry,
            checks: [{ ...registry.checks[0], category: 'invented' }]
        }),
        /unknown isolation category/u
    );

    const plan = buildStaticGovernanceExecutionPlan(registry);
    const executed = registry.checks.map((check) => check.id);
    assert.throws(
        () => buildStaticGovernanceHostEvidence({ registry, plan, executedCheckIds: executed.slice(1) }),
        /missing check IDs/u
    );
    assert.throws(
        () => buildStaticGovernanceHostEvidence({ registry, plan, executedCheckIds: [...executed, executed[0]] }),
        /duplicate executed check IDs/u
    );
});

test('structured evidence records exact-once catalog and before/after child process counts', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const testCatalog = buildStaticGovernanceTestCatalog(root, registry);
    const evidence = buildStaticGovernanceHostEvidence({
        registry,
        plan,
        executedCheckIds: registry.checks.map((check) => check.id),
        testCatalog,
        source: { commit: 'abc123', worktreeFingerprint: 'def456' },
        runId: 'run-1',
        metrics: { wallTimeMs: 25, cpuSeconds: 0.02, fileReadBytes: 4096 }
    });

    assert.equal(evidence.schema, 'fsusblog.static-governance-host-evidence.v1');
    assert.equal(evidence.catalog.checkCount, registry.checks.length);
    assert.equal(evidence.catalog.testCount, testCatalog.length);
    assert.equal(evidence.execution.executedCheckIds.length, registry.checks.length);
    assert.deepEqual(evidence.execution.executedTestIds, evidence.catalog.testIds);
    assert.ok(evidence.processes.beforeEstimated > evidence.processes.afterMeasured);
    assert.deepEqual(evidence.metrics, { wallTimeMs: 25, cpuSeconds: 0.02, fileReadBytes: 4096 });
});

test('canonical test ID catalog fails closed when execution omits or duplicates an ID', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const testCatalog = buildStaticGovernanceTestCatalog(root, registry);
    const base = {
        registry,
        plan,
        executedCheckIds: registry.checks.map((check) => check.id),
        testCatalog
    };
    const ids = testCatalog.map((entry) => entry.testId);
    assert.throws(
        () => buildStaticGovernanceHostEvidence({ ...base, executedTestIds: ids.slice(1) }),
        /missing test IDs/u
    );
    assert.throws(
        () => buildStaticGovernanceHostEvidence({ ...base, executedTestIds: [...ids, ids[0]] }),
        /duplicate executed test IDs/u
    );
});

test('structured host results are the authority for actual exact-once test execution', () =>
{
    const registry = loadStaticGovernanceIsolationRegistry(registryFile, root);
    const catalog = buildStaticGovernanceTestCatalog(root, registry);
    const entries = catalog.slice(0, 2);
    const hostResult = {
        schema: 'fsusblog.static-governance-host-result.v1',
        events: entries.map((entry) => ({
            type: 'test:pass',
            name: entry.name,
            file: path.join(root, entry.path),
            skipped: false,
            todo: false
        }))
    };
    assert.deepEqual(
        collectExecutedStaticGovernanceTestIds(root, catalog, [hostResult]),
        entries.map((entry) => entry.testId)
    );
    assert.throws(
        () => collectExecutedStaticGovernanceTestIds(root, catalog, [{
            ...hostResult,
            events: [{ ...hostResult.events[0], skipped: true }]
        }]),
        /did not execute successfully/u
    );
    assert.throws(
        () => collectExecutedStaticGovernanceTestIds(root, catalog, [{
            ...hostResult,
            events: [{ ...hostResult.events[0], name: 'unregistered runtime test' }]
        }]),
        /unexpected executed static governance test/u
    );
});

test('runner binds cancellation and partial child evidence without weakening lifecycle isolation', () =>
{
    const runner = fs.readFileSync(path.join(root, 'tools/test/run-governance-suites.mjs'), 'utf8');
    assert.match(runner, /new AbortController\(\)/u);
    assert.match(runner, /static governance host cancelled by \$\{signal\}/u);
    assert.match(runner, /signal: controller\.signal/u);
    assert.match(runner, /\.tmp\/test-governance\/live-grant\.json/u);
    assert.match(runner, /static-governance-reporter\.mjs/u);
    assert.match(runner, /collectExecutedStaticGovernanceTestIds/u);
});
