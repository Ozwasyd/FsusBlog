/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the repository tool under test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';


import {
    buildStaticGovernanceExecutionPlan,
    buildStaticGovernanceHostEvidence,
    buildStaticGovernanceTestCatalog,
    collectExecutedStaticGovernanceTestIds,
    loadStaticGovernanceRegistry
} from '../../tools/test/static-governance-host.mjs';
import { loadCanonicalInventory } from '../../tools/test-inventory/api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryFile = path.join(root, 'tests/governance/test-lifecycle-registry.json');
const inventory = loadCanonicalInventory(root);

test('lifecycle registry assigns every migrated static check to one physical owner', () =>
{
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const owned = plan.hosts.flatMap((host) => host.checks.map((check) => check.id));
    const pureFileHosts = plan.hosts
        .filter((host) => host.category === 'pure-file-validation');

    assert.equal(new Set(owned).size, registry.checks.length);
    assert.deepEqual(owned.toSorted(), registry.checks.map((check) => check.id).toSorted());
    assert.equal(pureFileHosts.length, 2);
    assert.ok(
        Math.abs(pureFileHosts[0].checks.length - pureFileHosts[1].checks.length) <= 1
    );

    const reversed = buildStaticGovernanceExecutionPlan({
        ...registry,
        checks: registry.checks.toReversed()
    });
    const hostByCheckId = (executionPlan) => new Map(
        executionPlan.hosts.flatMap((host) => host.checks.map((check) => [check.id, host.id]))
    );
    assert.deepEqual(
        [...hostByCheckId(reversed)].toSorted(),
        [...hostByCheckId(plan)].toSorted()
    );
});

test('temporary repository cases share a host but retain unique roots and outputs', () =>
{
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const fixtures = registry.checks.filter((check) => check.category === 'isolated-temporary-repository-fixture');
    assert.ok(fixtures.length > 1);
    assert.equal(new Set(fixtures.map((check) => check.physicalOwner)).size, 1);
    assert.equal(new Set(fixtures.map((check) => check.temporaryRoot)).size, fixtures.length);
    assert.equal(new Set(fixtures.map((check) => check.output)).size, fixtures.length);
});

test('lifecycle and destructive checks preserve independent process boundaries', () =>
{
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    for (const host of plan.hosts.filter((entry) => entry.category === 'real-subprocess-lifecycle'))
    {
        assert.equal(host.checks.length, 1);
        assert.equal(host.exclusive, host.checks[0].exclusive === true);
    }
    assert.equal(plan.hosts.find((host) => host.id.endsWith(':gateway-switch')).exclusive, true);
    assert.equal(plan.hosts.find((host) => host.id.endsWith(':deployment-slots')).exclusive, true);
    assert.ok(
        plan.hosts.some((host) =>
            host.category === 'real-subprocess-lifecycle' && host.exclusive === false)
    );
    for (const host of plan.hosts.filter((entry) => entry.category === 'exclusive-resource-destructive-rehearsal'))
    {
        assert.equal(host.checks.length, 1);
        assert.equal(host.exclusive, true);
    }
});

test('registry and execution evidence fail closed for missing, duplicate and unknown checks', () =>
{
    const registry = loadStaticGovernanceRegistry(registryFile, root);
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
    assert.throws(
        () => buildStaticGovernanceExecutionPlan({
            ...registry,
            checks: [{ ...registry.checks[0], exclusive: false }]
        }),
        /invalid exclusive lifecycle declaration/u
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
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const testCatalog = buildStaticGovernanceTestCatalog(root, registry, inventory);
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
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const testCatalog = buildStaticGovernanceTestCatalog(root, registry, inventory);
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
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const catalog = buildStaticGovernanceTestCatalog(root, registry, inventory);
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

test('behaviorTest runtime registration resolves to its canonical caller and rejects ambiguous titles', () =>
{
    const behaviorRegistry = {
        schema: 'fsusblog.test-lifecycle-registry.v1',
        checks: [
            {
                id: 'behavior-caller',
                file: 'tests/tools/test-asset-audit.test.mjs',
                physicalOwner: 'host:pure-file'
            }
        ]
    };
    const behaviorCase = {
        adapter: 'node-test',
        id: 'node-test:behavior-caller',
        ownerFile: 'tests/tools/test-asset-audit.test.mjs',
        displayName: 'behavior caller title',
        kind: 'behavior-test'
    };
    const catalog = buildStaticGovernanceTestCatalog(root, behaviorRegistry, {
        testCases: [behaviorCase]
    });
    assert.equal(catalog[0].path, behaviorCase.ownerFile);
    assert.equal(catalog[0].runtimeRegistrationPath, 'tools/contracts/behavior-test.mjs');
    assert.deepEqual(
        collectExecutedStaticGovernanceTestIds(root, catalog, [{
            schema: 'fsusblog.static-governance-host-result.v1',
            events: [{
                type: 'test:pass',
                name: behaviorCase.displayName,
                file: path.join(root, catalog[0].runtimeRegistrationPath),
                skipped: false,
                todo: false
            }]
        }]),
        [behaviorCase.id]
    );

    assert.throws(
        () => buildStaticGovernanceTestCatalog(root, {
            ...behaviorRegistry,
            checks: [
                ...behaviorRegistry.checks,
                {
                    id: 'second-behavior-caller',
                    file: 'tests/tools/code-intent.test.mjs',
                    physicalOwner: 'host:pure-file'
                }
            ]
        }, {
            testCases: [
                behaviorCase,
                {
                    ...behaviorCase,
                    id: 'node-test:second-behavior-caller',
                    ownerFile: 'tests/tools/code-intent.test.mjs'
                }
            ]
        }),
        /behaviorTest runtime registration requires globally unique test titles/u
    );
});

test('runner binds cancellation and partial child evidence without weakening lifecycle isolation', () =>
{
    const runner = fs.readFileSync(path.join(root, 'tools/test/run-governance-suites.mjs'), 'utf8');
    const unicodeRoot = path.join(path.dirname(root), '靜態治理 root');
    const unicodeRunner = pathToFileURL(path.join(unicodeRoot, 'tools/test/run-governance-suites.mjs'));

    assert.equal(
        path.resolve(fileURLToPath(new URL('../..', unicodeRunner))),
        unicodeRoot
    );
    assert.match(runner, /fileURLToPath\(new URL\('\.\.\/\.\.', import\.meta\.url\)\)/u);
    assert.doesNotMatch(runner, /new URL\('\.\.\/\.\.', import\.meta\.url\)\.pathname/u);
    assert.match(runner, /new AbortController\(\)/u);
    assert.match(runner, /static governance host cancelled by \$\{signal\}/u);
    assert.match(runner, /signal: controller\.signal/u);
    assert.match(runner, /live-grant\.json/u);
    assert.match(runner, /static-governance-reporter\.mjs/u);
    assert.match(runner, /collectExecutedStaticGovernanceTestIds/u);
});
