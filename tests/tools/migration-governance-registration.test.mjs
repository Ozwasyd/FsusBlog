/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the original lifecycle and host owners. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateLifecycleRegistry } from '../../tools/test-lifecycle/lifecycle.mjs';
import {
    buildStaticGovernanceExecutionPlan,
    loadStaticGovernanceRegistry
} from '../../tools/test/static-governance-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryFile = path.join(root, 'tests/governance/test-lifecycle-registry.json');
const migrationChecks = [
    ['migration-execution-evidence', 'migration-execution-evidence.test.mjs'],
    ['migration-fast-lane', 'migration-fast-lane.test.mjs'],
    ['migration-fast-lane-value-3404', 'migration-fast-lane.value-3404.test.mjs'],
    ['migration-retained-inputs', 'migration-retained-inputs.test.mjs'],
    ['migration-retained-inputs-value-5218', 'migration-retained-inputs.value-5218.test.mjs']
];

function registryFixture(t, registry)
{
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-migration-registration-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const file = path.join(temporaryRoot, 'registry.json');
    fs.writeFileSync(file, JSON.stringify(registry));
    return { temporaryRoot, file };
}

test('Migration oracles enter the original host plan exactly once with independent process owners', () =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const hostIds = [];
    for (const [id, basename] of migrationChecks)
    {
        const file = `tests/tools/${basename}`;
        const entries = lifecycle.nodeTests.filter((entry) => entry.file === file);
        assert.equal(entries.length, 1, file);
        assert.equal(entries[0].owner, 'repository-governance:static-node-contracts');
        assert.equal(entries[0].executionCategory, 'repository-governance');
        assert.equal(entries[0].lifecycle, 'canonical-execution');
        assert.equal(entries[0].physicalExecutionCount, 1);
        const hosts = plan.hosts.filter((host) => host.checks.some((check) => check.id === id));
        assert.equal(hosts.length, 1, id);
        assert.equal(hosts[0].category, 'real-subprocess-lifecycle');
        assert.equal(hosts[0].checks.length, 1);
        assert.equal(hosts[0].checks[0].file, file);
        assert.equal(hosts[0].checks[0].physicalOwner, 'process:lifecycle');
        hostIds.push(hosts[0].id);
    }
    assert.equal(new Set(hostIds).size, migrationChecks.length);
});

test('Migration registration rejects a second physical invocation even under a different check ID', (t) =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const entry = lifecycle.nodeTests.find((value) => value.staticGovernance?.id === 'migration-fast-lane');
    const duplicate = { ...entry, staticGovernance: { ...entry.staticGovernance, id: 'duplicate-migration-fast-lane' } };
    const fixture = registryFixture(t, { ...lifecycle, nodeTests: [...lifecycle.nodeTests, duplicate] });
    assert.throws(() => loadStaticGovernanceRegistry(fixture.file, root), /multiple physical owners/u);
    const errors = validateLifecycleRegistry({
        registry: { ...lifecycle, nodeTests: [...lifecycle.nodeTests, duplicate] },
        audit: { files: lifecycle.nodeTests.map(({ file }) => ({ path: file })) }
    });
    assert.ok(errors.some((error) => error.includes('duplicate file')));
});

test('Migration registration requires the actual file before its host can be planned', (t) =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const entry = lifecycle.nodeTests.find((value) => value.staticGovernance?.id === 'migration-fast-lane');
    const fixture = registryFixture(t, { ...lifecycle, nodeTests: [entry] });
    assert.throws(() => loadStaticGovernanceRegistry(fixture.file, fixture.temporaryRoot), /missing file/u);
});

test('Migration host plan rejects repeated check IDs before producing any execution plan', () =>
{
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const check = registry.checks.find((value) => value.id === 'migration-execution-evidence');
    assert.throws(() => buildStaticGovernanceExecutionPlan({
        ...registry,
        checks: [...registry.checks, check]
    }), /duplicate static governance check ID/u);
});

test('Canonical article source fixtures retain one temporary repository owner in the original plan', () =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const entries = lifecycle.nodeTests.filter((entry) =>
        entry.file === 'tests/tools/canonical-article-lifecycle-authority.test.mjs');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].staticGovernance.category, 'isolated-temporary-repository-fixture');
    assert.equal(entries[0].staticGovernance.physicalOwner, 'host:temporary-repository');
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const hosts = plan.hosts.filter((host) =>
        host.checks.some((check) => check.id === 'canonical-article-lifecycle-authority'));
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].category, 'isolated-temporary-repository-fixture');
    assert.equal(hosts[0].checks.filter((check) =>
        check.id === 'canonical-article-lifecycle-authority').length, 1);
});


test('Canvas Link ownership controls enter one existing pure-file host without a second backend invocation', () =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const file = 'tests/tools/article-canvas-link-golden-ownership.test.mjs';
    const entries = lifecycle.nodeTests.filter((entry) => entry.file === file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].owner, 'repository-governance:static-node-contracts');
    assert.equal(entries[0].executionCategory, 'repository-governance');
    assert.equal(entries[0].lifecycle, 'canonical-execution');
    assert.equal(entries[0].physicalExecutionCount, 1);
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const hosts = plan.hosts.filter((host) => host.checks.some((check) => check.file === file));
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].category, 'pure-file-validation');
    assert.match(hosts[0].id, /^host:pure-file:[01]$/u);
    const checks = hosts[0].checks.filter((check) => check.file === file);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, 'article-canvas-link-golden-ownership');
    assert.equal(checks[0].physicalOwner, 'host:pure-file');
    const protocol = lifecycle.nodeTests.filter((entry) => entry.file === 'tests/tools/aeds-protocol-generation.test.mjs');
    assert.equal(protocol.length, 1);
    assert.equal(protocol[0].owner, 'matrix-tier:backend-golden');
    assert.ok(!registry.checks.some((check) => check.file === protocol[0].file));
});

test('Canvas Link registration rejects another physical invocation under a different check ID', (t) =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const entry = lifecycle.nodeTests.find((value) => value.staticGovernance?.id === 'article-canvas-link-golden-ownership');
    const duplicate = { ...entry, staticGovernance: { ...entry.staticGovernance, id: 'duplicate-canvas-link-ownership' } };
    const fixture = registryFixture(t, { ...lifecycle, nodeTests: [...lifecycle.nodeTests, duplicate] });
    assert.throws(() => loadStaticGovernanceRegistry(fixture.file, root), /multiple physical owners/u);
});

test('Canvas Link registration requires its actual source file before any host plan', (t) =>
{
    const lifecycle = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const entry = lifecycle.nodeTests.find((value) => value.staticGovernance?.id === 'article-canvas-link-golden-ownership');
    const fixture = registryFixture(t, { ...lifecycle, nodeTests: [entry] });
    assert.throws(() => loadStaticGovernanceRegistry(fixture.file, fixture.temporaryRoot), /missing file/u);
});

test('Canvas Link host plan rejects a repeated check ID before execution', () =>
{
    const registry = loadStaticGovernanceRegistry(registryFile, root);
    const check = registry.checks.find((value) => value.id === 'article-canvas-link-golden-ownership');
    assert.throws(() => buildStaticGovernanceExecutionPlan({
        ...registry,
        checks: [...registry.checks, check]
    }), /duplicate static governance check ID/u);
});
