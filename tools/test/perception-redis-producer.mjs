#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

export const CANONICAL_LOCAL_REDIS_TESTS = Object.freeze([
    'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.ArtifactPoolBurnSurvivesCancellationProcessInterruptionAndAmbiguousReply',
    'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.BudgetedLeaseAtomicallyAccountsExactBytesQuotasAndRetryIdentity',
    'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3ContractCutoverTests.RedisStore_RetiresAllV3NamespacesAndEnvelopeIdempotently',
    'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.ProviderRejectsCrossNamespaceReplay'
]);

export const MANDATORY_BURN_TEST =
    'FsusBlog.Server.Tests.Unit.PerceptionCharacterV3Tests.ArtifactPoolBurnSurvivesCancellationProcessInterruptionAndAmbiguousReply';
export const MANDATORY_BURN_FILTER =
    `Fixture=LocalRedis&FullyQualifiedName=${MANDATORY_BURN_TEST}`;

function decodeXml(value)
{
    return String(value ?? '')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function trxAttribute(raw, name)
{
    const match = String(raw).match(new RegExp(`\\b${name}="([^"]*)"`, 'u'));
    return match ? decodeXml(match[1]) : '';
}

export function parseTrxResults(trxContent)
{
    const text = String(trxContent);
    const results = [];
    const unitTestResults = [...text.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/gu)];
    for (const match of unitTestResults)
    {
        const rawAttrs = match[1];
        const testId = trxAttribute(rawAttrs, 'testId');
        const testName = trxAttribute(rawAttrs, 'testName');
        const outcome = trxAttribute(rawAttrs, 'outcome');
        const duration = trxAttribute(rawAttrs, 'duration');
        results.push({
            testId,
            testName,
            outcome,
            duration
        });
    }
    return results;
}

export function reconcileLocalRedisOutcome({
    trxContent,
    container,
    endpoint,
    testAssembly,
    testAssemblyDigest,
    filter,
    prefixNamespace,
    cleanupVerified,
    redisLuaCallsBefore,
    redisLuaCallsAfter,
    plannedTestIds = [MANDATORY_BURN_TEST],
    runId,
    sourceCommit,
    sourceFingerprint
})
{
    if (!trxContent || typeof trxContent !== 'string')
    {
        throw new Error('TRX content is required for LocalRedis reconciliation');
    }
    if (!container || typeof container !== 'string')
    {
        throw new Error('Redis container identity is required');
    }
    if (!endpoint || typeof endpoint !== 'string')
    {
        throw new Error('Redis endpoint is required');
    }
    if (!testAssembly || typeof testAssembly !== 'string')
    {
        throw new Error('LocalRedis test assembly is required');
    }
    if (!testAssemblyDigest || !/^sha256:[0-9a-f]{64}$/u.test(testAssemblyDigest))
    {
        throw new Error('LocalRedis test assembly digest is required');
    }
    if (filter !== MANDATORY_BURN_FILTER)
    {
        throw new Error(`LocalRedis producer filter must be exact: ${MANDATORY_BURN_FILTER}`);
    }
    if (!prefixNamespace || !/^test:perception-v3-local-redis:[^:]+:$/u.test(prefixNamespace))
    {
        throw new Error('LocalRedis prefix namespace is invalid');
    }
    if (!runId || !sourceCommit || !sourceFingerprint)
    {
        throw new Error('LocalRedis run and source identity are required');
    }
    if (!Array.isArray(plannedTestIds) || plannedTestIds.length === 0)
    {
        throw new Error('LocalRedis planned test IDs are required');
    }
    if (new Set(plannedTestIds).size !== plannedTestIds.length)
    {
        throw new Error('LocalRedis planned test IDs must be unique');
    }
    if (plannedTestIds.some((testId) => !CANONICAL_LOCAL_REDIS_TESTS.includes(testId)))
    {
        throw new Error('LocalRedis planned test IDs must belong to the canonical owner');
    }

    const results = parseTrxResults(trxContent);
    const executedByName = new Map();
    const duplicateExecutedTestIds = [];
    for (const result of results)
    {
        if (executedByName.has(result.testName))
        {
            duplicateExecutedTestIds.push(result.testName);
        }
        executedByName.set(result.testName, result);
    }

    const missingPlannedTestIds = plannedTestIds.filter((testId) => !executedByName.has(testId));
    const extraExecutedTestIds = results
        .map((result) => result.testName)
        .filter((testId) => !plannedTestIds.includes(testId));
    const failedTests = plannedTestIds
        .map((testId) => executedByName.get(testId))
        .filter((result) => result && result.outcome !== 'Passed');
    const failureCodes = [];
    if (results.length === 0)
        failureCodes.push('zero-tests-executed');
    if (missingPlannedTestIds.length > 0)
        failureCodes.push('planned-test-not-executed');
    if (extraExecutedTestIds.length > 0)
        failureCodes.push('unplanned-test-executed');
    if (duplicateExecutedTestIds.length > 0)
        failureCodes.push('duplicate-test-executed');
    if (failedTests.length > 0)
        failureCodes.push('test-outcome-not-passed');
    if (cleanupVerified !== true)
        failureCodes.push('prefix-cleanup-not-verified');
    if (!Number.isSafeInteger(redisLuaCallsBefore) || !Number.isSafeInteger(redisLuaCallsAfter) ||
        redisLuaCallsAfter <= redisLuaCallsBefore)
        failureCodes.push('no-test-redis-lua-calls');

    const receipt = {
        schema: 'fsusblog.perception-character-v3-redis-fixture.v1',
        producer: 'perception-character-v3-redis-fixture',
        status: failureCodes.length === 0 ? 'passed' : 'failed',
        failureCodes,
        runId,
        sourceCommit,
        sourceFingerprint,
        container,
        endpoint,
        testAssembly: path.relative(root, path.resolve(root, testAssembly)).replaceAll(path.sep, '/'),
        testAssemblyDigest,
        filter,
        plannedTestIds,
        totalExecuted: results.length,
        missingPlannedTestIds,
        extraExecutedTestIds,
        duplicateExecutedTestIds,
        mandatoryTestId: MANDATORY_BURN_TEST,
        mandatoryTestOutcome: executedByName.get(MANDATORY_BURN_TEST)?.outcome ?? null,
        tests: plannedTestIds.map((fullyQualifiedName) => ({
            planned: true,
            executionStatus: executedByName.has(fullyQualifiedName) ? 'executed' : 'not-executed',
            testId: executedByName.get(fullyQualifiedName)?.testId ?? null,
            fullyQualifiedName,
            outcome: executedByName.get(fullyQualifiedName)?.outcome ?? null,
            duration: executedByName.get(fullyQualifiedName)?.duration ?? null
        })),
        redisObservation: {
            luaCallsBefore: redisLuaCallsBefore,
            luaCallsAfter: redisLuaCallsAfter,
            observed: Number.isSafeInteger(redisLuaCallsBefore) &&
                Number.isSafeInteger(redisLuaCallsAfter) &&
                redisLuaCallsAfter > redisLuaCallsBefore
        },
        cleanupIdentity: {
            containerName: container,
            prefixNamespace,
            trapRegistered: true,
            prefixIsolation: true,
            verified: cleanupVerified === true
        }
    };

    return receipt;
}

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg.startsWith('--'))
        {
            const key = arg.slice(2);
            const value = argv[index + 1];
            if (value !== undefined && !value.startsWith('--'))
            {
                options[key] = value;
                index += 1;
            }
            else
            {
                options[key] = true;
            }
        }
    }
    return options;
}

function main()
{
    const args = parseArgs(process.argv.slice(2));
    const required = [
        'trx',
        'container',
        'endpoint',
        'assembly',
        'filter',
        'prefix',
        'run-id',
        'source-commit',
        'source-fingerprint',
        'redis-lua-calls-before',
        'redis-lua-calls-after',
        'cleanup-verified',
        'output'
    ];
    const missing = required.filter((key) => args[key] === undefined || args[key] === true || args[key] === '');
    if (missing.length > 0)
    {
        console.error(`[perception-redis-producer] ERROR: missing required arguments: ${missing.join(', ')}`);
        process.exit(1);
    }

    const trxPath = path.resolve(args.trx);
    if (!fs.existsSync(trxPath))
    {
        console.error(`[perception-redis-producer] ERROR: TRX file not found: ${trxPath}`);
        process.exit(1);
    }

    const assemblyPath = path.resolve(args.assembly);
    if (!fs.existsSync(assemblyPath))
    {
        console.error(`[perception-redis-producer] ERROR: test assembly not found: ${assemblyPath}`);
        process.exit(1);
    }

    const trxContent = fs.readFileSync(trxPath, 'utf8');
    const receipt = reconcileLocalRedisOutcome({
        trxContent,
        container: args.container,
        endpoint: args.endpoint,
        testAssembly: assemblyPath,
        testAssemblyDigest: `sha256:${createHash('sha256').update(fs.readFileSync(assemblyPath)).digest('hex')}`,
        filter: args.filter,
        prefixNamespace: args.prefix,
        cleanupVerified: args['cleanup-verified'] === 'true',
        redisLuaCallsBefore: Number(args['redis-lua-calls-before']),
        redisLuaCallsAfter: Number(args['redis-lua-calls-after']),
        runId: args['run-id'],
        sourceCommit: args['source-commit'],
        sourceFingerprint: args['source-fingerprint']
    });

    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    console.log(`[perception-redis-producer] wrote outcome receipt to ${outputPath}`);

    if (receipt.status !== 'passed')
    {
        console.error(`[perception-redis-producer] ERROR: ${receipt.failureCodes.join(', ')}`);
        process.exit(1);
    }

    console.log(`[perception-redis-producer] ok executed=${receipt.totalExecuted} mandatoryTest=${receipt.mandatoryTestOutcome}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
{
    main();
}
