import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { buildLifecycleReport, validateLifecycleRegistry } = await import(
    pathToFileURL(path.join(root, 'tools/test-lifecycle/lifecycle.mjs')).href
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
