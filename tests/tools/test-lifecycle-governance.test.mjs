import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    buildLifecycleReport,
    classifyNodeRegistryEntry,
    reconcileLifecycleRegistry,
    validateLifecycleRegistry
} = await import(
    pathToFileURL(path.join(root, 'tools/test-lifecycle/lifecycle.mjs')).href
);
const { loadRetentionAuditInput, resolveRetentionAudit } = await import(
    pathToFileURL(path.join(root, 'tools/retention/audit-input.mjs')).href
);

const audit = {
    sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) },
    files: [{ path: 'tests/tools/runner.test.mjs', retentionClass: 'must-keep', tierIds: [], referencedBy: [], coverageIds: ['runner'] }],
    testRecords: [{ id: 'node-test:runner', path: 'tests/tools/runner.test.mjs', assertionTargets: ['behavior:schedules work'], coverageIds: ['runner'], failureHistory: { failures: 0 } }]
};

function registry(entry = {})
{
    return {
        schema: 'fsusblog.test-lifecycle-registry.v1',
        nodeTests: [{
            file: 'tests/tools/runner.test.mjs',
            owner: 'repository-governance:test-assets',
            executionCategory: 'repository-governance',
            lifecycle: 'canonical-execution',
            physicalExecutionCount: 1,
            classifications: ['behavior'],
            ...entry
        }]
    };
}

function auditInputFixture(sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
})
{
    return {
        schema: 'fsusblog.test-retention-audit.v2',
        sourceState,
        producer: { sourceState },
        counts: { totalFiles: 1 },
        files: audit.files,
        testRecords: audit.testRecords,
        retainedEvidence: { testRecordCount: 1 }
    };
}

function shellFunction(source, name)
{
    const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'mu').exec(source);
    assert.ok(match, `missing shell function ${name}`);
    return match[0];
}

test('lifecycle report binds every test ID and assertion target to one physical owner', () =>
{
    const result = buildLifecycleReport({ audit, registry: registry() });
    assert.deepEqual(result.errors, []);
    assert.equal(result.report.testRecords[0].canonicalOwner, 'repository-governance:test-assets');
    assert.deepEqual(result.report.testRecords[0].semanticAssertionTargets, ['behavior:schedules work']);
    assert.deepEqual(result.report.testRecords[0].coverageIds, ['runner']);
});

test('unowned and duplicate physical execution fail closed', () =>
{
    assert.match(validateLifecycleRegistry({ audit, registry: { schema: 'fsusblog.test-lifecycle-registry.v1', nodeTests: [] } }).join('\n'), /unowned Node test/u);
    assert.match(validateLifecycleRegistry({ audit, registry: registry({ physicalExecutionCount: 2 }) }).join('\n'), /exactly one physical owner/u);
});

test('mixed xunit files preserve the resolved singleton case owner instead of the file first tier', () =>
{
    const file = 'tests/backend/Unit/RedisCases.cs';
    const ordinaryTiers = ['backend-unit', 'coverage-backend'];
    const producerTier = 'perception-character-v3-release-gate';
    const mixedAudit = {
        sourceState: audit.sourceState,
        files: [{
            path: file,
            retentionClass: 'must-keep',
            tierIds: [...ordinaryTiers, producerTier],
            referencedBy: [],
            coverageIds: ['ordinary', 'local-redis']
        }],
        testRecords: [
            {
                id: 'xunit:ordinary',
                path: file,
                assertionTargets: ['behavior:ordinary'],
                tierIds: ordinaryTiers,
                tierInvocationCount: 2,
                coverageIds: ['ordinary'],
                failureHistory: { failures: 0 }
            },
            {
                id: 'xunit:local-redis',
                path: file,
                assertionTargets: ['behavior:budget'],
                tierIds: [producerTier],
                tierInvocationCount: 1,
                coverageIds: ['local-redis'],
                failureHistory: { failures: 0 }
            }
        ]
    };
    const before = structuredClone(mixedAudit);
    const result = buildLifecycleReport({
        audit: mixedAudit,
        registry: { schema: 'fsusblog.test-lifecycle-registry.v1', nodeTests: [] }
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(mixedAudit, before);
    assert.equal(result.report.files[0].canonicalOwner, 'matrix:backend-unit');
    assert.equal(result.report.testRecords[0].canonicalOwner, 'matrix:backend-unit');
    assert.equal(result.report.testRecords[1].canonicalOwner, `matrix:${producerTier}`);
    assert.deepEqual(result.report.testRecords[1].coverageIds, ['local-redis']);
    assert.equal(result.report.testRecords[1].physicalExecutionCount, 1);
    assert.equal(result.report.testRecords[1].observedTierInvocationCount, 1);
    assert.deepEqual(result.report.duplicatePhysicalExecutions.map(({ id }) => id), ['xunit:ordinary']);
});

test('case tiers cannot replace explicit Node canonical or projection owners', () =>
{
    const nodeAudit = structuredClone(audit);
    nodeAudit.testRecords[0].tierIds = ['perception-character-v3-release-gate'];
    assert.equal(buildLifecycleReport({ audit: nodeAudit, registry: registry() })
        .report.testRecords[0].canonicalOwner, 'repository-governance:test-assets');
    const projected = buildLifecycleReport({
        audit: nodeAudit,
        registry: registry({
            owner: 'projection:current-source',
            lifecycle: 'projection',
            executionCategory: 'projection-contract',
            physicalExecutionCount: 0
        })
    });
    assert.deepEqual(projected.errors, []);
    assert.equal(projected.report.testRecords[0].canonicalOwner, 'projection:current-source');
    assert.equal(projected.report.testRecords[0].physicalExecutionCount, 0);
});

test('singleton case owners reject malformed and unregistered tiers without forging matrix identities', () =>
{
    const file = 'tests/backend/Unit/RedisCases.cs';
    const original = {
        sourceState: audit.sourceState,
        files: [{ path: file, retentionClass: 'must-keep', tierIds: ['backend-unit'], referencedBy: [], coverageIds: ['ordinary'] }],
        testRecords: [{ id: 'xunit:case', path: file, assertionTargets: ['behavior:case'], tierIds: ['backend-unit'], tierInvocationCount: 1, coverageIds: ['ordinary'], failureHistory: { failures: 0 } }]
    };
    const emptyRegistry = { schema: 'fsusblog.test-lifecycle-registry.v1', nodeTests: [] };
    for (const invalid of ['x', null, [7], [''], [' '], [' backend-unit'], ['unknown-tier']])
    {
        const candidate = structuredClone(original);
        candidate.testRecords[0].tierIds = invalid;
        const result = buildLifecycleReport({ audit: candidate, registry: emptyRegistry });
        assert.match(result.errors.join('\n'), /case tier owner/u);
        assert.equal(result.report, null);
    }
    for (const legacy of [[], undefined])
    {
        const candidate = structuredClone(original);
        candidate.testRecords[0].tierIds = legacy;
        const result = buildLifecycleReport({ audit: candidate, registry: emptyRegistry });
        assert.deepEqual(result.errors, []);
        assert.equal(result.report.testRecords[0].canonicalOwner, 'matrix:backend-unit');
    }
});

test('static governance metadata requires the canonical lifecycle owner', () =>
{
    const staticGovernance = {
        id: 'runner',
        category: 'pure-file-validation',
        physicalOwner: 'host:pure-file'
    };
    assert.match(
        validateLifecycleRegistry({
            audit,
            registry: registry({
                owner: 'manual-diagnostic:tests/tools/runner.test.mjs',
                executionCategory: 'manual-diagnostic',
                lifecycle: 'manual-diagnostic',
                physicalExecutionCount: 0,
                staticGovernance
            })
        }).join('\n'),
        /requires one canonical static-node-contracts owner/u
    );
    assert.deepEqual(validateLifecycleRegistry({
        audit,
        registry: registry({
            owner: 'repository-governance:static-node-contracts',
            staticGovernance
        })
    }), []);
});

test('projection and summary records cannot execute a producer', () =>
{
    assert.match(validateLifecycleRegistry({ audit, registry: registry({ lifecycle: 'projection', executionCategory: 'projection-contract', physicalExecutionCount: 1 }) }).join('\n'), /must not execute a producer/u);
    assert.match(validateLifecycleRegistry({ audit, registry: registry({ lifecycle: 'summary', physicalExecutionCount: 1 }) }).join('\n'), /must not execute a producer/u);
});

test('replacement conclusions need proof and migration retirement cannot depend on age', () =>
{
    assert.match(validateLifecycleRegistry({ audit, registry: registry({ lifecycle: 'obsolete', executionCategory: 'obsolete', physicalExecutionCount: 0 }) }).join('\n'), /needs replacement IDs/u);
    assert.match(validateLifecycleRegistry({ audit, registry: registry({ lifecycle: 'migration-bound', physicalExecutionCount: 1, retireCondition: { olderThanDays: 30 } }) }).join('\n'), /not time or age/u);
    assert.deepEqual(validateLifecycleRegistry({ audit, registry: registry({ lifecycle: 'migration-bound', physicalExecutionCount: 1, retireCondition: { contract: 'api-v2', condition: 'v1 reader removed from supported runtime' } }) }), []);
});

test('fixture distinguishes source mirrors, compatibility wrappers, and unique behavior owners', () =>
{
    const sourceMirror = registry({
        lifecycle: 'replacement-ready',
        executionCategory: 'replacement-ready',
        physicalExecutionCount: 0,
        classifications: ['source-text'],
        replacementTestIds: ['node-test:runtime-behavior']
    });
    const report = buildLifecycleReport({ audit, registry: sourceMirror }).report;
    assert.equal(report.decisions[0].action, 'merge-or-delete');
    assert.deepEqual(report.decisions[0].replacementTestIds, ['node-test:runtime-behavior']);
    assert.deepEqual(validateLifecycleRegistry({
        audit,
        registry: registry({ classifications: ['compatibility-wrapper'], lifecycle: 'migration-bound', retireCondition: { contract: 'v1 API', condition: 'all supported callers use v2 API' } })
    }), []);
    assert.equal(buildLifecycleReport({ audit, registry: registry() }).report.decisions[0].action, 'retain');
});

test('registry classification resolves lane, authority, workflow and package-script owners', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-lifecycle-owner-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const write = (relative, content) =>
    {
        const target = path.join(fixtureRoot, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    write('tools/test/lanes/static-governance.sh', [
        'TEST_ASSET_BEHAVIOR_FILES=(',
        '  tests/tools/test-asset-owner.test.mjs',
        ')',
        'node --test tests/tools/lane-owner.test.mjs',
        ''
    ].join('\n'));
    write('.github/workflows/quality-gate.yml', 'run: node --test tests/tools/workflow-reference.test.mjs\n');
    write('src/frontend/package.json', JSON.stringify({
        scripts: { 'test:package-owner': 'node --test ../../tests/tools/package-owner.test.mjs' }
    }));
    write('config/governance/repository-governance-authorities.json', JSON.stringify({
        authorities: [{
            id: 'workflow-lint',
            commands: [{ argv: ['node', '--test', 'tests/tools/authority-owner.test.mjs'] }]
        }]
    }));

    assert.equal(
        classifyNodeRegistryEntry(fixtureRoot, 'tests/tools/lane-owner.test.mjs', 'test("behavior", () => {})').owner,
        'repository-governance:static-node-contracts'
    );
    assert.equal(
        classifyNodeRegistryEntry(fixtureRoot, 'tests/tools/test-asset-owner.test.mjs', 'test("behavior", () => {})').owner,
        'repository-governance:test-asset-behavior'
    );
    assert.deepEqual(
        classifyNodeRegistryEntry(fixtureRoot, 'tests/tools/authority-owner.test.mjs', 'test("behavior", () => {})'),
        {
            owner: 'workflow-lint:tests/tools/authority-owner.test.mjs',
            executionCategory: 'workflow-only',
            lifecycle: 'conditional-governance',
            physicalExecutionCount: 1,
            classifications: ['behavior']
        }
    );
    assert.equal(
        classifyNodeRegistryEntry(fixtureRoot, 'tests/tools/workflow-reference.test.mjs', 'test("behavior", () => {})').executionCategory,
        'workflow-only'
    );
    assert.equal(
        classifyNodeRegistryEntry(fixtureRoot, 'tests/tools/package-owner.test.mjs', 'test("behavior", () => {})').owner,
        'package-script:test:package-owner'
    );
});

test('registry reconciliation preserves explicit owners and reaches a byte-identical fixed point', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-lifecycle-reconcile-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const write = (relative, content) =>
    {
        const target = path.join(fixtureRoot, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    const testSource = 'import test from "node:test";\ntest("registered behavior", () => {});\n';
    write('tests/tools/runner.test.mjs', testSource);
    write('tests/tools/new-owner.test.mjs', testSource);
    write('tools/test/lanes/static-governance.sh', 'STATIC_GOVERNANCE_FILES=()\n');
    write('src/frontend/package.json', JSON.stringify({ scripts: {} }));
    fs.mkdirSync(path.join(fixtureRoot, '.github/workflows'), { recursive: true });

    const explicit = registry({
        owner: 'repository-governance:high-value-release-gate',
        executionCategory: 'repository-governance',
        lifecycle: 'canonical-execution',
        physicalExecutionCount: 1,
        classifications: ['runtime']
    });
    const reconcileAudit = {
        files: [
            { path: 'tests/tools/new-owner.test.mjs' },
            { path: 'tests/tools/runner.test.mjs' }
        ]
    };
    const first = reconcileLifecycleRegistry({
        root: fixtureRoot,
        audit: reconcileAudit,
        registry: explicit
    });
    assert.deepEqual(first.errors, []);
    assert.equal(first.additions.length, 1);
    assert.equal(first.additions[0].file, 'tests/tools/new-owner.test.mjs');
    assert.deepEqual(first.registry.nodeTests[0], explicit.nodeTests[0]);

    const firstBytes = `${JSON.stringify(first.registry, null, 4)}\n`;
    const second = reconcileLifecycleRegistry({
        root: fixtureRoot,
        audit: reconcileAudit,
        registry: JSON.parse(firstBytes)
    });
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.additions, []);
    assert.equal(`${JSON.stringify(second.registry, null, 4)}\n`, firstBytes);
});

test('registry reconciliation rejects entries whose Node test no longer exists', () =>
{
    const result = reconcileLifecycleRegistry({
        root,
        audit: { files: [] },
        registry: registry()
    });
    assert.match(result.errors.join('\n'), /registry references missing Node test/u);
    assert.equal(result.registry, null);
    assert.deepEqual(result.additions, []);
});

test('registry reconciliation rejects duplicate unowned Node test paths', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-lifecycle-duplicate-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const file = 'tests/tools/duplicate.test.mjs';
    const result = reconcileLifecycleRegistry({
        root: fixtureRoot,
        audit: { files: [{ path: file }, { path: file }] },
        registry: { schema: 'fsusblog.test-lifecycle-registry.v1', nodeTests: [] }
    });
    assert.deepEqual(result.errors, [`audit contains duplicate Node test file: ${file}`]);
    assert.equal(result.registry, null);
    assert.deepEqual(result.additions, []);
});

test('lifecycle audit input rejects invalid or stale artifacts and never invokes the standalone producer', async (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-lifecycle-audit-input-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const currentSourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: 'b'.repeat(64)
    };
    const file = path.join(fixtureRoot, 'retention.json');
    const write = (value) => fs.writeFileSync(
        file,
        typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
    );

    await assert.rejects(
        loadRetentionAuditInput({
            root: fixtureRoot,
            auditInput: path.join(fixtureRoot, 'missing.json'),
            currentSourceState
        }),
        /audit input does not exist/u
    );
    write('{');
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /audit input is invalid JSON/u
    );
    write({ ...auditInputFixture(), schema: 'wrong' });
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /must use fsusblog\.test-retention-audit\.v2/u
    );
    write({
        ...auditInputFixture(),
        counts: { totalFiles: 0 },
        files: [],
        testRecords: [],
        retainedEvidence: { testRecordCount: 0 }
    });
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /audit input is empty/u
    );
    write({
        ...auditInputFixture(),
        counts: { totalFiles: 2 }
    });
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /audit input file count is incomplete/u
    );
    write({
        ...auditInputFixture(),
        retainedEvidence: { testRecordCount: 2 }
    });
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /audit input test-record count is incomplete/u
    );
    write({
        ...auditInputFixture(),
        producer: {
            sourceState: {
                commit: 'c'.repeat(40),
                worktreeFingerprint: 'd'.repeat(64)
            }
        }
    });
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /producer source state does not match/u
    );
    write(auditInputFixture({
        commit: 'c'.repeat(40),
        worktreeFingerprint: 'd'.repeat(64)
    }));
    await assert.rejects(
        loadRetentionAuditInput({ root: fixtureRoot, auditInput: file, currentSourceState }),
        /does not match the current commit\/worktree/u
    );

    write(auditInputFixture());
    const before = fs.readFileSync(file);
    let producerCalls = 0;
    const resolved = await resolveRetentionAudit({
        root: fixtureRoot,
        auditInput: file,
        currentSourceState,
        produceStandaloneAudit: () =>
        {
            producerCalls += 1;
            throw new Error('must not run');
        }
    });
    assert.equal(producerCalls, 0);
    assert.equal(resolved.schema, 'fsusblog.test-retention-audit.v2');
    assert.deepEqual(fs.readFileSync(file), before);
});

test('test-assets phase invokes one canonical retention producer before lifecycle consumes it', (context) =>
{
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-retention-topology-'));
    context.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
    const fakeNode = path.join(fixtureRoot, 'count-node.sh');
    const countLog = path.join(fixtureRoot, 'calls.log');
    fs.writeFileSync(fakeNode, [
        '#!/usr/bin/env bash',
        'printf "CALL" >>"$FSUSBLOG_COUNT_LOG"',
        'printf "\\t%s" "$@" >>"$FSUSBLOG_COUNT_LOG"',
        'printf "\\n" >>"$FSUSBLOG_COUNT_LOG"',
        ''
    ].join('\n'), { mode: 0o755 });
    const laneSource = fs.readFileSync(
        path.join(root, 'tools/test/lanes/static-governance.sh'),
        'utf8'
    );
    const script = [
        'set -euo pipefail',
        `ROOT_DIR=${JSON.stringify(root)}`,
        `FSUSBLOG_NODE=${JSON.stringify(fakeNode)}`,
        `FSUSBLOG_RELEASE_EVIDENCE_DIR=${JSON.stringify(path.join(fixtureRoot, 'evidence'))}`,
        `FSUSBLOG_COUNT_LOG=${JSON.stringify(countLog)}`,
        'export FSUSBLOG_NODE FSUSBLOG_RELEASE_EVIDENCE_DIR FSUSBLOG_COUNT_LOG',
        'Run() { "$@"; }',
        'RunCollectParallel() {',
        '    local group="$1"',
        '    shift',
        '    while (($# > 0)); do',
        '        local label="$1"',
        '        local command="$2"',
        '        shift 2',
        '        if [[ "$label" == "test-lifecycle" ]]; then "$command"; fi',
        '    done',
        '}',
        shellFunction(laneSource, 'StaticTestLifecycle'),
        shellFunction(laneSource, 'StaticRetention'),
        shellFunction(laneSource, 'RunTestAssetGovernancePhase'),
        'RunTestAssetGovernancePhase',
        ''
    ].join('\n');
    const result = spawnSync('bash', ['-s'], {
        cwd: root,
        input: script,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(countLog, 'utf8').trim().split(/\r?\n/u);
    const retentionCalls = calls.filter((line) => line.includes('/tools/check-test-retention.mjs'));
    const lifecycleCalls = calls.filter((line) => line.includes('/tools/check-test-lifecycle.mjs'));
    const nativeCalls = calls.filter((line) => line.includes('/tools/test/native-test-governance.mjs'));
    assert.equal(retentionCalls.length, 1);
    assert.equal(lifecycleCalls.length, 1);
    assert.equal(nativeCalls.length, 1);
    assert.match(retentionCalls[0], /--out\t.*\/test-retention-audit\.json/u);
    assert.match(lifecycleCalls[0], /--audit-input\t.*\/test-retention-audit\.json/u);
    assert.ok(calls.indexOf(retentionCalls[0]) < calls.indexOf(lifecycleCalls[0]));
    assert.doesNotMatch(calls.join('\n'), /test-lifecycle-retention-input\.json/u);
});


test('canonical article lifecycle keeps its complete check under one fixture owner', async () =>
{
    const { loadStaticGovernanceRegistry, buildStaticGovernanceExecutionPlan } = await import(
        pathToFileURL(path.join(root, 'tools/test/static-governance-host.mjs')).href
    );
    const registry = loadStaticGovernanceRegistry(path.join(root, 'tests/governance/test-lifecycle-registry.json'), root);
    const file = 'tests/tools/canonical-article-lifecycle-authority.test.mjs';
    const checks = registry.checks.filter(check => check.file === file);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].id, 'canonical-article-lifecycle-authority');
    assert.equal(checks[0].category, 'isolated-temporary-repository-fixture');
    const plan = buildStaticGovernanceExecutionPlan(registry);
    const executions = plan.hosts.flatMap(host => host.checks).filter(check => check.file === file);
    assert.deepEqual(executions, checks);
});
