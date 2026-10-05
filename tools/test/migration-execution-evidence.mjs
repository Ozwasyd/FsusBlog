import path from 'node:path';

const { groupXunitSources } = await import(new URL('../test-inventory/xunit-projects.mjs', import.meta.url));
const { parseBackendPlatformBoundExecution } = await import(new URL('./backend-platform-selection.mjs', import.meta.url));
const { parseTrxExecutionEvidence } = await import(new URL('./run-backend-production-shards.mjs', import.meta.url));

const migrationProject = 'tests/migration/FsusBlog.Migration.Tests.csproj';
const runtimeIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function requireText(value, label)
{
    if (typeof value !== 'string' || !value.trim())
    {
        throw new Error(`migration execution requires ${label}`);
    }
    return value;
}

/**
 * Reconcile a validated inventory's Migration cases against records from the
 * existing VSTest discovery and TRX readers. This is case membership evidence,
 * not a build, source/run binding, fixture receipt, or qualification decision.
 */
export function reconcileMigrationDiscovery({
    sourceFiles,
    inventoryCases,
    discoveredCases,
    assemblyFile
})
{
    if (!path.isAbsolute(requireText(assemblyFile, 'an absolute assembly path'))
        || path.basename(assemblyFile) !== 'FsusBlog.Migration.Tests.dll')
    {
        throw new Error('migration execution requires the independent Migration test assembly');
    }
    if (![sourceFiles, inventoryCases, discoveredCases].every(Array.isArray)
        || inventoryCases.length === 0
        || discoveredCases.length === 0)
    {
        throw new Error('migration execution requires nonempty inventory and discovery records');
    }
    const owner = groupXunitSources(sourceFiles).find((entry) => entry.project === migrationProject);
    const ownedFiles = new Set(owner.sourceFiles.map((file) => file.path));
    const sourceIds = new Set();
    const methods = new Map();
    for (const testCase of inventoryCases)
    {
        const method = `${requireText(testCase?.ownerSuite, 'a fully-qualified source suite')}.${requireText(testCase?.methodName, 'a source method')}`;
        const id = requireText(testCase?.id, 'a source case ID');
        if (testCase.adapter !== 'xunit'
            || !ownedFiles.has(testCase.ownerFile)
            || !id.startsWith(`xunit:${testCase.ownerFile}#${method}#`))
        {
            throw new Error('migration execution source case has foreign or inconsistent ownership');
        }
        // Current Migration tests have closed Fact/InlineData expansion. Do not
        // count a dynamic method placeholder as an executed data row.
        if (testCase.identity !== 'static')
        {
            throw new Error('migration execution needs explicit runtime expansion authority for dynamic source cases');
        }
        if (sourceIds.has(id))
        {
            throw new Error('migration execution source case ID is duplicated');
        }
        sourceIds.add(id);
        const entry = methods.get(method) ?? { method, sourceCaseIds: [], runtimeCaseIds: [] };
        entry.sourceCaseIds.push(id);
        methods.set(method, entry);
    }
    const runtimeCases = new Map();
    for (const record of discoveredCases)
    {
        const id = requireText(record?.id, 'a discovered case ID');
        const method = requireText(record?.fullyQualifiedName, 'a discovered method');
        requireText(record?.displayName, 'a discovered display name');
        const source = requireText(record?.source, 'a discovered assembly');
        if (!runtimeIdPattern.test(id) || runtimeCases.has(id))
        {
            throw new Error('migration execution discovered case ID is invalid or duplicated');
        }
        if (!path.isAbsolute(source) || path.resolve(source) !== path.resolve(assemblyFile))
        {
            throw new Error('migration execution discovery belongs to a different assembly');
        }
        const entry = methods.get(method);
        if (!entry)
        {
            throw new Error(`migration execution discovered a method absent from its source inventory: ${method}`);
        }
        entry.runtimeCaseIds.push(id);
        runtimeCases.set(id, record);
    }
    for (const entry of methods.values())
    {
        if (entry.sourceCaseIds.length !== entry.runtimeCaseIds.length)
        {
            throw new Error(`migration execution discovery case count differs from source inventory: ${entry.method}`);
        }
    }
    return {
        project: migrationProject,
        assembly: assemblyFile,
        sourceCaseIds: [...sourceIds].sort(),
        methods: [...methods.values()].map((entry) => ({
            method: entry.method,
            sourceCaseIds: entry.sourceCaseIds.sort(),
            runtimeCaseIds: entry.runtimeCaseIds.sort()
        })).sort((left, right) => left.method.localeCompare(right.method))
    };
}

/** Require exactly one passed execution of each source-bound discovered case. */
export function reconcileMigrationTestCases({ executedCases, ...input })
{
    const reconciliation = reconcileMigrationDiscovery(input);
    if (!Array.isArray(executedCases) || executedCases.length === 0)
    {
        throw new Error('migration execution requires nonempty TRX records');
    }
    const runtimeCases = new Map(input.discoveredCases.map((record) => [record.id, record]));
    const executedIds = new Set();
    for (const record of executedCases)
    {
        const id = requireText(record?.testId, 'an executed case ID');
        const planned = runtimeCases.get(id);
        if (!planned || executedIds.has(id))
        {
            throw new Error('migration execution TRX contains an unplanned or duplicate case');
        }
        if (record.testName !== planned.displayName)
        {
            throw new Error('migration execution TRX display identity differs from discovery');
        }
        if (record.outcome !== 'Passed')
        {
            throw new Error('migration execution TRX contains a failed, skipped or unknown outcome');
        }
        executedIds.add(id);
    }
    if (executedIds.size !== runtimeCases.size)
    {
        throw new Error('migration execution TRX is missing required cases');
    }
    return {
        ...reconciliation,
        executedCaseIds: [...executedIds].sort()
    };
}

/**
 * Require the raw TRX to name the independent assembly, discovered methods and
 * one execution per case. Its TestRun UUID is not the scheduler run identity;
 * source/build/run/fixture receipts remain the execution producer's obligation.
 */
export function reconcileMigrationTrx({ trx, ...input })
{
    const execution = parseTrxExecutionEvidence(trx);
    const binding = parseBackendPlatformBoundExecution(trx);
    const reconciliation = reconcileMigrationTestCases({ ...input, executedCases: execution.records });
    const discovered = new Map(input.discoveredCases.map((entry) => [entry.id, entry]));
    for (const record of binding.records)
    {
        const planned = discovered.get(record.testId);
        if (record.codeBase !== input.assemblyFile
            // VSTest lowercases UnitTest.storage even on case-sensitive Linux.
            || record.storage !== input.assemblyFile.toLowerCase()
            || record.adapterTypeName !== 'executor://xunit/VsTestRunner3/netcore/'
            || `${record.className}.${record.methodName}` !== planned?.fullyQualifiedName)
        {
            throw new Error('migration TRX assembly, adapter or method differs from discovery');
        }
    }
    return {
        ...reconciliation,
        trxRunId: binding.runId,
        executionIds: binding.records.map((record) => record.executionId).sort()
    };
}
