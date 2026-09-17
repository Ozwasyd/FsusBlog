import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line import-x/no-relative-parent-imports -- The host consumes the canonical repository test inventory.
import { loadCanonicalInventory } from '../test-inventory/api.mjs';

const categories = new Set([
    'pure-file-validation',
    'isolated-temporary-repository-fixture',
    'real-subprocess-lifecycle',
    'exclusive-resource-destructive-rehearsal'
]);
const pureFileHostCount = 2;
const behaviorTestRuntimeRegistrationPath = 'tools/contracts/behavior-test.mjs';

function assertUnique(values, message)
{
    if (new Set(values).size !== values.length)
    {
        throw new Error(message);
    }
}

function normalizeCheck(check, root)
{
    if (!check || typeof check.id !== 'string' || !check.id.trim())
    {
        throw new Error('static governance check ID is required');
    }
    if (!categories.has(check.category))
    {
        throw new Error(`unknown isolation category for ${check.id}: ${check.category ?? '<missing>'}`);
    }
    if (typeof check.file !== 'string' || !check.file.startsWith('tests/') || path.isAbsolute(check.file))
    {
        throw new Error(`static governance check ${check.id} requires a repository-relative test file`);
    }
    if (!fs.existsSync(path.join(root, check.file)))
    {
        throw new Error(`static governance check ${check.id} references a missing file: ${check.file}`);
    }
    if (typeof check.physicalOwner !== 'string' || !check.physicalOwner.trim())
    {
        throw new Error(`static governance check ${check.id} requires one physicalOwner`);
    }
    if (check.category === 'isolated-temporary-repository-fixture')
    {
        if (typeof check.temporaryRoot !== 'string' || !check.temporaryRoot.includes('{checkId}'))
        {
            throw new Error(`temporary fixture ${check.id} requires a check-scoped temporaryRoot`);
        }
        if (typeof check.output !== 'string' || !check.output.includes('{checkId}'))
        {
            throw new Error(`temporary fixture ${check.id} requires a check-scoped output`);
        }
    }
    if (check.exclusive !== undefined
        && (check.category !== 'real-subprocess-lifecycle' || check.exclusive !== true))
    {
        throw new Error(`static governance check ${check.id} has an invalid exclusive lifecycle declaration`);
    }
    return { ...check };
}

export function loadStaticGovernanceRegistry(file, root)
{
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (registry?.schema !== 'fsusblog.test-lifecycle-registry.v1')
    {
        throw new Error('test lifecycle registry has an invalid schema');
    }
    if (!Array.isArray(registry.nodeTests))
    {
        throw new Error('test lifecycle registry nodeTests are required');
    }
    const checks = registry.nodeTests.flatMap((entry) =>
    {
        const staticGovernance = entry?.staticGovernance;
        if (!staticGovernance)
        {
            return [];
        }
        const shards = staticGovernance.shards;
        if (shards !== undefined)
        {
            if (staticGovernance.category !== 'exclusive-resource-destructive-rehearsal'
                || !Array.isArray(shards) || shards.length === 0
                || shards.some((shard) => typeof shard !== 'string' || !shard.trim()))
            {
                throw new Error(`static governance destructive rehearsal shards are invalid: ${entry.file}`);
            }
            return shards.map((shard) => normalizeCheck({
                ...staticGovernance,
                id: `${staticGovernance.id}:${shard}`,
                file: entry.file,
                environment: { FSUSBLOG_ZDT_FIXTURE_SHARD: shard }
            }, root));
        }
        return [normalizeCheck({ ...staticGovernance, file: entry.file }, root)];
    });
    if (checks.length === 0)
    {
        throw new Error('test lifecycle registry static governance entries are required');
    }
    assertUnique(checks.map((check) => check.id), 'duplicate static governance check ID');
    assertUnique(
        checks.map((check) => `${check.file}\0${JSON.stringify(check.environment ?? {})}`),
        'static governance test invocation has multiple physical owners'
    );
    return { schema: registry.schema, checks };
}

export function buildStaticGovernanceExecutionPlan(registry)
{
    if (!Array.isArray(registry?.checks) || registry.checks.length === 0)
    {
        throw new Error('static governance isolation registry checks are required');
    }
    assertUnique(registry.checks.map((check) => check.id), 'duplicate static governance check ID');
    for (const check of registry.checks)
    {
        if (!categories.has(check.category))
        {
            throw new Error(`unknown isolation category for ${check.id}: ${check.category ?? '<missing>'}`);
        }
        if (check.exclusive !== undefined
            && (check.category !== 'real-subprocess-lifecycle' || check.exclusive !== true))
        {
            throw new Error(`static governance check ${check.id} has an invalid exclusive lifecycle declaration`);
        }
    }

    const pureFileHostByCheckId = new Map(
        registry.checks
            .filter((check) => check.category === 'pure-file-validation')
            .toSorted((left, right) => left.id.localeCompare(right.id))
            .map((check, index) => [
                check.id,
                `${check.physicalOwner}:${index % pureFileHostCount}`
            ])
    );
    const grouped = new Map();
    for (const check of registry.checks)
    {
        const isolated = check.category === 'real-subprocess-lifecycle'
      || check.category === 'exclusive-resource-destructive-rehearsal';
        const hostId = check.category === 'pure-file-validation'
            ? pureFileHostByCheckId.get(check.id)
            : isolated
                ? `${check.physicalOwner}:${check.id}`
                : check.physicalOwner;
        const current = grouped.get(hostId) ?? {
            id: hostId,
            category: check.category,
            checks: [],
            exclusive: check.category === 'exclusive-resource-destructive-rehearsal'
                || check.exclusive === true
        };
        if (current.category !== check.category)
        {
            throw new Error(`physical owner ${check.physicalOwner} mixes isolation categories`);
        }
        current.checks.push(check);
        grouped.set(hostId, current);
    }
    const hosts = [...grouped.values()];
    const owned = hosts.flatMap((host) => host.checks.map((check) => check.id));
    assertUnique(owned, 'static governance execution plan repeats a check ID');
    if (owned.length !== registry.checks.length)
    {
        throw new Error('static governance execution plan is not exact-once');
    }
    return {
        schema: 'fsusblog.static-governance-execution-plan.v1',
        hosts
    };
}

export function buildStaticGovernanceTestCatalog(root, registry, inventory = loadCanonicalInventory(root))
{
    const byFile = new Map();
    for (const check of registry.checks)
    {
        const owners = byFile.get(check.file) ?? [];
        owners.push(check);
        byFile.set(check.file, owners);
    }
    const tests = [];
    for (const [file, owners] of byFile)
    {
        const cases = (inventory.testCases ?? []).filter((testCase) => testCase.ownerFile === file);
        if (cases.length === 0)
        {
            throw new Error(`static governance canonical test inventory has no cases: ${file}`);
        }
        for (const testCase of cases)
        {
            tests.push({
                testId: testCase.id,
                path: file,
                runtimeRegistrationPath: testCase.adapter === 'node-test' && testCase.kind === 'behavior-test'
                    ? behaviorTestRuntimeRegistrationPath
                    : file,
                name: testCase.displayName,
                physicalOwner: owners[0].physicalOwner,
                checkIds: owners.map((check) => check.id)
            });
        }
    }
    assertUnique(tests.map((entry) => entry.testId), 'static governance catalog contains duplicate test IDs');
    assertUnique(
        tests
            .filter((entry) => entry.runtimeRegistrationPath === behaviorTestRuntimeRegistrationPath)
            .map((entry) => `${entry.runtimeRegistrationPath}\0${entry.name}`),
        'behaviorTest runtime registration requires globally unique test titles'
    );
    return tests.sort((left, right) => left.testId.localeCompare(right.testId));
}

export function collectExecutedStaticGovernanceTestIds(root, testCatalog, hostResults)
{
    const catalogByIdentity = new Map();
    for (const entry of testCatalog)
    {
        const key = `${entry.runtimeRegistrationPath ?? entry.path}\0${entry.name}`;
        const current = catalogByIdentity.get(key) ?? [];
        current.push(entry.testId);
        catalogByIdentity.set(key, current);
    }
    const occurrenceByIdentity = new Map();
    const executedTestIds = [];
    for (const result of hostResults)
    {
        if (result?.schema !== 'fsusblog.static-governance-host-result.v1' || !Array.isArray(result.events))
        {
            throw new Error('static governance host result has an invalid schema');
        }
        for (const event of result.events)
        {
            const relative = path.relative(root, String(event.file ?? '')).split(path.sep).join('/');
            const key = `${relative}\0${String(event.name ?? '')}`;
            const occurrence = occurrenceByIdentity.get(key) ?? 0;
            const testId = catalogByIdentity.get(key)?.[occurrence];
            if (!testId)
            {
                throw new Error(`unexpected executed static governance test: ${relative}#${event.name ?? '<missing>'}`);
            }
            if (event.type !== 'test:pass' || event.skipped === true || event.todo === true)
            {
                throw new Error(`static governance test did not execute successfully: ${testId}`);
            }
            occurrenceByIdentity.set(key, occurrence + 1);
            executedTestIds.push(testId);
        }
    }
    return executedTestIds;
}

export function buildStaticGovernanceHostEvidence({
    registry,
    plan,
    executedCheckIds,
    testCatalog = [],
    executedTestIds = testCatalog.map((entry) => entry.testId),
    source = null,
    runId = null,
    metrics = {}
})
{
    assertUnique(executedCheckIds, 'duplicate executed check IDs');
    const expected = registry.checks.map((check) => check.id).toSorted();
    const actual = [...executedCheckIds].toSorted();
    const missing = expected.filter((id) => !actual.includes(id));
    const unexpected = actual.filter((id) => !expected.includes(id));
    if (missing.length > 0)
    {
        throw new Error(`missing check IDs: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0)
    {
        throw new Error(`unexpected check IDs: ${unexpected.join(', ')}`);
    }
    assertUnique(executedTestIds, 'duplicate executed test IDs');
    const expectedTests = testCatalog.map((entry) => entry.testId).toSorted();
    const actualTests = [...executedTestIds].toSorted();
    const missingTests = expectedTests.filter((id) => !actualTests.includes(id));
    const unexpectedTests = actualTests.filter((id) => !expectedTests.includes(id));
    if (missingTests.length > 0)
    {
        throw new Error(`missing test IDs: ${missingTests.join(', ')}`);
    }
    if (unexpectedTests.length > 0)
    {
        throw new Error(`unexpected test IDs: ${unexpectedTests.join(', ')}`);
    }
    return {
        schema: 'fsusblog.static-governance-host-evidence.v1',
        source,
        runId,
        catalog: {
            registrySchema: registry.schema,
            checkCount: expected.length,
            checkIds: expected,
            physicalOwners: Object.fromEntries(registry.checks.map((check) => [check.id, check.physicalOwner])),
            testCount: expectedTests.length,
            testIds: expectedTests
        },
        execution: {
            hostCount: plan.hosts.length,
            executedCheckIds: actual,
            executedTestIds: actualTests,
            hosts: plan.hosts.map((host) => ({
                id: host.id,
                category: host.category,
                exclusive: host.exclusive,
                checkIds: host.checks.map((check) => check.id)
            }))
        },
        processes: {
            beforeEstimated: registry.checks.length,
            afterMeasured: plan.hosts.length
        },
        metrics: {
            wallTimeMs: Number(metrics.wallTimeMs ?? 0),
            cpuSeconds: Number(metrics.cpuSeconds ?? 0),
            fileReadBytes: Number(metrics.fileReadBytes ?? 0)
        }
    };
}
