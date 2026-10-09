import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { composeBackendPlatformFilter, normalizeBackendRuntimePlatform, parseBackendPlatformBoundExecution } from './backend-platform-selection.mjs';
import { parseTrxExecutionEvidence } from './run-backend-production-shards.mjs';
import { readVstestDiscoveryDiagnostic } from './vstest-discovery-diagnostic.mjs';

const selectionSchema = 'fsusblog.backend-unit-server-selection.v1';
const excludedCategories = ['Integration', 'ApiIntegration', 'Concurrency', 'Performance', 'Property', 'GoldenContract', 'SecurityStateMachine'];
const ordinaryFilter = `${excludedCategories.map((category) => `Category!=${category}`).join('&')}&Fixture!=LocalRedis`;
const runtimeIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function requireCondition(condition, message)
{
    if (!condition)
    {
        throw new Error(`bounded backend-unit selection: ${message}`);
    }
}

function exactKeys(value, keys, label)
{
    requireCondition(value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), `${label} has missing or unknown fields`);
}

/** A bounded Server invocation cannot execute or supply the whole Migration dependency. */
export function requireWholeMigrationSelection(env)
{
    const selection = String(env.FSUSBLOG_TEST_SELECTION ?? '');
    requireCondition(selection !== 'bounded-server'
        && (env.CURRENT_TIER !== 'backend-unit' || ['', 'full', 'affected'].includes(selection))
        && !String(env.FSUSBLOG_BACKEND_UNIT_SELECTION_FILE ?? ''), 'Server-only selection does not admit Migration execution or aggregate receipt consumption');
}

/** Select whole methods only; every actual theory row must match the declared count. */
export function resolveBackendUnitServerSelection(selection, sourceState)
{
    exactKeys(selection, ['schema', 'sourceState', 'methods', 'migration'], 'selection');
    exactKeys(selection.sourceState, ['commit', 'worktreeFingerprint'], 'selection source');
    requireCondition(selection.schema === selectionSchema && selection.migration === 'not-selected', 'requires the explicit Server-only schema and Migration not-selected decision');
    requireCondition(/^[0-9a-f]{40}$/u.test(selection.sourceState.commit)
        && /^(?:sha256:)?[0-9a-f]{64}$/u.test(selection.sourceState.worktreeFingerprint)
        && selection.sourceState.commit === sourceState?.commit
        && selection.sourceState.worktreeFingerprint === sourceState?.worktreeFingerprint, 'selection differs from the current scheduler source identity');
    requireCondition(Array.isArray(selection.methods) && selection.methods.length > 0, 'requires nonempty whole-method selection');
    const methods = new Map();
    for (const method of selection.methods)
    {
        exactKeys(method, ['fullyQualifiedName', 'expectedCaseCount'], 'selected method');
        requireCondition(typeof method.fullyQualifiedName === 'string'
            && /^FsusBlog\.Server\.Tests\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(method.fullyQualifiedName), 'requires exact Server method names, not filter expressions or row selectors');
        requireCondition(Number.isSafeInteger(method.expectedCaseCount) && method.expectedCaseCount > 0
            && method.expectedCaseCount <= 100000 && !methods.has(method.fullyQualifiedName), 'method count is invalid or selection is duplicated/ambiguous');
        methods.set(method.fullyQualifiedName, method.expectedCaseCount);
    }
    const expectedCaseCount = [...methods.values()].reduce((sum, count) => sum + count, 0);
    requireCondition(expectedCaseCount <= 100000, 'selection exceeds the supported case count');
    const filter = `(${[...methods.keys()].sort().map((name) => `FullyQualifiedName=${name}`).join('|')})&${ordinaryFilter}`;
    return { methods, expectedCaseCount, filter };
}

/** Bind the declaration to the original platform discovery, without inventing runtime IDs. */
export function planBackendUnitServerSelection({ selection, sourceState, runId, namespace, assemblyFile, records, platformPlan })
{
    const resolved = resolveBackendUnitServerSelection(selection, sourceState);
    requireCondition(typeof runId === 'string' && runId.trim() && typeof namespace === 'string' && namespace.trim(), 'requires the original run and namespace');
    requireCondition(typeof assemblyFile === 'string' && path.isAbsolute(assemblyFile)
        && path.basename(assemblyFile) === 'FsusBlog.Server.Tests.dll', 'requires the original Server assembly');
    requireCondition(platformPlan?.schema === 'fsusblog.backend-platform-plan.v1' && platformPlan.lane === 'backend-unit'
        && platformPlan.runtimePlatform === normalizeBackendRuntimePlatform(process.platform)
        && platformPlan.baseFilter === resolved.filter
        && platformPlan.executionFilter === composeBackendPlatformFilter(resolved.filter)
        && platformPlan.discoveredTestCaseCount === resolved.expectedCaseCount
        && platformPlan.plannedTestCaseCount === resolved.expectedCaseCount && platformPlan.notSelectedTestCaseCount === 0,
    'original platform plan differs from the exact bounded selection');
    requireCondition(Array.isArray(records) && records.length === resolved.expectedCaseCount, 'discovery differs from the expected case count');
    const counts = new Map();
    const ids = new Set();
    const names = new Set();
    for (const record of records)
    {
        requireCondition(resolved.methods.has(record.fullyQualifiedName), 'discovery includes an unselected method');
        requireCondition(typeof record.id === 'string' && runtimeIdPattern.test(record.id) && !ids.has(record.id), 'discovery case ID is missing, invalid or duplicated');
        requireCondition(typeof record.displayName === 'string' && record.displayName.trim()
            && !names.has(JSON.stringify([record.fullyQualifiedName, record.displayName])), 'discovery display identity is missing or ambiguous');
        requireCondition(typeof record.source === 'string' && path.isAbsolute(record.source)
            && path.resolve(record.source) === path.resolve(assemblyFile), 'discovery belongs to another assembly');
        requireCondition(record.traits && typeof record.traits === 'object' && !Array.isArray(record.traits)
            && Object.values(record.traits).every(Array.isArray), 'discovery traits are invalid');
        requireCondition(!(record.traits.Category ?? []).some((category) => excludedCategories.includes(category))
            && (record.traits.Fixture ?? []).length === 0, 'selection includes a nonordinary category or fixture');
        ids.add(record.id);
        names.add(JSON.stringify([record.fullyQualifiedName, record.displayName]));
        counts.set(record.fullyQualifiedName, (counts.get(record.fullyQualifiedName) ?? 0) + 1);
    }
    requireCondition([...resolved.methods].every(([name, count]) => counts.get(name) === count), 'a selected method is missing or its actual theory row count differs');
    return {
        schema: 'fsusblog.backend-unit-server-selection-plan.v1',
        qualificationEligible: false,
        aggregateCoverage: 'incomplete',
        sourceState: { ...sourceState }, runId, namespace,
        selectionDigest: `sha256:${createHash('sha256').update(JSON.stringify(selection)).digest('hex')}`,
        executionFilter: platformPlan.executionFilter,
        expectedCaseCount: resolved.expectedCaseCount,
        cases: records.map(({ id, fullyQualifiedName, displayName, source }) => ({ id, fullyQualifiedName, displayName, source }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        migration: 'not-selected'
    };
}

function ownedFile(root, file)
{
    requireCondition(typeof file === 'string' && file.length > 0, 'file argument is missing');
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    requireCondition(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        && fs.realpathSync(absolute) === absolute && fs.statSync(absolute).isFile(), 'requires a regular canonical repository-owned file');
    return absolute;
}

function readJson(root, file)
{
    const absolute = ownedFile(root, file);
    requireCondition(fs.statSync(absolute).size <= 1024 * 1024, 'JSON input exceeds the supported size');
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

/** Use native path components; canonical filesystem checks remain mandatory at the caller. */
export function isBackendUnitTemporaryPath(root, file, pathApi = path)
{
    const relative = pathApi.relative(pathApi.resolve(root, '.tmp'), pathApi.resolve(root, file));
    return relative !== '' && !pathApi.isAbsolute(relative) && relative.split(pathApi.sep)[0] !== '..';
}

function writeNewJson(root, file, value)
{
    const absolute = path.resolve(root, file);
    requireCondition(isBackendUnitTemporaryPath(root, absolute)
        && fs.realpathSync(path.dirname(absolute)) === path.dirname(absolute), 'output must use the original repository temporary directory');
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** CLI planning/verification only uses existing discovery and TRX readers; never spawns an engine. */
export function runBackendUnitServerSelectionAction(args, { root, env })
{
    requireCondition(args[0] === '--backend-unit' && args.length >= 5, 'requires --backend-unit and explicit selection arguments');
    const values = new Map();
    const allowed = new Set(['--server-selection', '--selection-action', '--diagnostic-root', '--source', '--platform-plan', '--selection-plan', '--trx', '--out']);
    for (let index = 1; index < args.length; index += 2)
    {
        requireCondition(allowed.has(args[index]) && typeof args[index + 1] === 'string'
            && args[index + 1].length > 0 && !args[index + 1].startsWith('--') && !values.has(args[index]), 'unknown, missing or duplicate option');
        values.set(args[index], args[index + 1]);
    }
    const action = values.get('--selection-action');
    const keys = action === 'filter' ? ['--server-selection', '--selection-action']
        : action === 'verify' ? ['--server-selection', '--selection-action', '--diagnostic-root', '--source', '--platform-plan', '--selection-plan']
          : action === 'outcome' ? ['--server-selection', '--selection-action', '--diagnostic-root', '--source', '--platform-plan', '--selection-plan', '--trx', '--out'] : [];
    requireCondition(keys.length > 0 && values.size === keys.length && keys.every((key) => values.has(key)), 'invalid selection action or its exact option set');
    requireCondition(env.CURRENT_TIER === 'backend-unit' && env.FSUSBLOG_TEST_SELECTION === 'bounded-server'
        && !String(env.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? '').trim(), 'requires the original matrix backend-unit producer and explicit bounded-server mode');
    requireCondition(typeof env.FSUSBLOG_TEST_RUN_ID === 'string' && env.FSUSBLOG_TEST_RUN_ID.trim()
        && typeof env.FSUSBLOG_TEST_NAMESPACE === 'string' && env.FSUSBLOG_TEST_NAMESPACE.trim(), 'requires the original run and namespace before discovery');
    const file = ownedFile(root, values.get('--server-selection'));
    requireCondition(file === path.resolve(root, String(env.FSUSBLOG_BACKEND_UNIT_SELECTION_FILE ?? '')), 'selection argument differs from the explicit environment declaration');
    const sourceState = { commit: env.FSUSBLOG_TEST_SOURCE_COMMIT, worktreeFingerprint: env.FSUSBLOG_TEST_SOURCE_FINGERPRINT };
    const selection = readJson(root, file);
    const resolved = resolveBackendUnitServerSelection(selection, sourceState);
    if (action === 'filter')
    {
        return resolved.filter;
    }
    const assemblyFile = ownedFile(root, values.get('--source'));
    const diagnosticRoot = path.resolve(root, values.get('--diagnostic-root'));
    requireCondition(isBackendUnitTemporaryPath(root, diagnosticRoot)
        && fs.realpathSync(diagnosticRoot) === diagnosticRoot, 'discovery must use the original repository temporary directory');
    const { file: diagnosticFile, records } = readVstestDiscoveryDiagnostic(diagnosticRoot, { expectedSource: assemblyFile });
    ownedFile(root, diagnosticFile);
    const plan = planBackendUnitServerSelection({ selection, sourceState,
        runId: env.FSUSBLOG_TEST_RUN_ID, namespace: env.FSUSBLOG_TEST_NAMESPACE, assemblyFile, records,
        platformPlan: readJson(root, values.get('--platform-plan')) });
    if (action === 'verify')
    {
        writeNewJson(root, values.get('--selection-plan'), plan);
        return `Bounded Server selection planned: ${plan.expectedCaseCount} actual discovered cases; Migration not-selected`;
    }
    requireCondition(JSON.stringify(readJson(root, values.get('--selection-plan'))) === JSON.stringify(plan), 'selection plan differs from current declaration/discovery/source');
    const trx = fs.readFileSync(ownedFile(root, values.get('--trx')), 'utf8');
    const executed = parseBackendPlatformBoundExecution(trx);
    parseTrxExecutionEvidence(trx);
    const planned = new Map(plan.cases.map((record) => [record.id, record]));
    requireCondition(executed.records.length === planned.size && executed.records.every((record) =>
    {
        const discovered = planned.get(record.testId);
        return discovered && record.outcome === 'Passed' && record.testName === discovered.displayName
            && `${record.className}.${record.methodName}` === discovered.fullyQualifiedName
            && path.resolve(record.codeBase) === assemblyFile && record.storage === assemblyFile.toLowerCase()
            && /^executor:\/\/xunit\/VsTestRunner(?:2|3)?\/netcore\/$/u.test(record.adapterTypeName);
    }), 'TRX does not execute exactly the original discovered Server cases');
    writeNewJson(root, values.get('--out'), { ...plan, schema: 'fsusblog.backend-unit-server-selection-outcome.v1',
        status: 'bounded-passed', executedCaseIds: executed.records.map((record) => record.testId).sort(),
        trxRunId: executed.runId, aggregateExitCode: 3 });
    return `Bounded Server selection passed: ${plan.expectedCaseCount} cases; aggregate acceptance remains unrun`;
}
