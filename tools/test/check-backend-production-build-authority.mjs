#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const expectedRequests = [
    ['backend-server-build', 'src/backend/FsusBlog.Server.csproj', 'canonical-runtime'],
    ['backend-tests-build', 'tests/backend/FsusBlog.Server.Tests.csproj', 'canonical-test-assembly'],
    ['backend-benchmark-build', 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj', 'separate-benchmark-input']
];
const expectedConsumers = [
    ['backend-exact-union', 'build-receipt+test-dll-digest'],
    ['perception-v2', 'exact-union-summary+test-dll-digest'],
    ['rights-v3', 'exact-union-summary+trx-digests'],
    ['integrity-proof', 'backend-producer-receipt+artifact-digests'],
    ['privacy-zk', 'exact-union-summary+trx-digests'],
    ['cross-stack', 'no-backend-artifact']
];

function exactRows(actual, expected, fields, label)
{
    const rows = Array.isArray(actual) ? actual.map((entry) => fields.map((field) => entry?.[field])) : [];
    if (JSON.stringify(rows) !== JSON.stringify(expected))
    {
        throw new Error(`${label} does not match the canonical inventory`);
    }
}

export function validateBackendProductionBuildAuthority({
    inventory,
    bundleSource,
    shardSource,
    rightsSource,
    integritySource,
    privacySource,
    crossStackSource
})
{
    if (inventory?.schema !== 'fsusblog.backend-production-build-consumers.v1'
        || inventory.issue !== 1389
        || inventory.producer?.bundle !== 'backend-tests'
        || inventory.producer?.configuration !== 'Release'
        || inventory.producer?.receipt !== '.tmp/test-runs/<runId>/backend-tests-ready.json')
    {
        throw new Error('backend Production build consumer inventory identity is invalid');
    }
    exactRows(inventory.producer.requests, expectedRequests, ['id', 'target', 'role'], 'backend build requests');
    exactRows(inventory.consumers, expectedConsumers, ['id', 'binding'], 'backend build consumers');

    const runBackendStart = bundleSource.indexOf('async function runBackendTests()');
    const runBackendEnd = bundleSource.indexOf('\nfunction listFiles', runBackendStart);
    if (runBackendStart < 0 || runBackendEnd <= runBackendStart)
    {
        throw new Error('backend Production bundle implementation is missing');
    }
    const productionBundle = bundleSource.slice(runBackendStart, runBackendEnd);
    const buildRequests = [...productionBundle.matchAll(/dotnet build (src\/backend\/FsusBlog\.Server\.csproj|tests\/backend\/FsusBlog\.Server\.Tests\.csproj|benchmarks\/core\/FsusBlog\.Core\.Benchmarks\.csproj)([^\n']*)/gu)];
    if (buildRequests.length !== 3 || buildRequests.some((match) => !match[2].includes('-c Release')))
    {
        throw new Error('Production fresh must declare exactly the three inventoried Release build requests');
    }
    if (/\bDebug\b|EnsureBackendFilteredBuild|FSUSBLOG_BACKEND_TEST_CONFIGURATION/gu.test(productionBundle))
    {
        throw new Error('Production fresh reintroduced a Debug or filtered backend compatibility build');
    }
    if (!bundleSource.includes("schema: 'fsusblog.local-production.backend-tests-ready.v1'")
        || !bundleSource.includes('buildLayout: buildLayoutBinding()')
        || !bundleSource.includes('contentDigest: fileContentDigest(backendTestDll)')
        || !bundleSource.includes('afterSuccess: publishBackendTestsReady'))
    {
        throw new Error('canonical backend Release producer does not publish the run/source/test-DLL receipt binding');
    }

    if (/postludeResult|governance-postlude\.trx|FullyQualifiedName!=.*Issue40Requirements/gu.test(shardSource)
        || !shardSource.includes("executionMode: 'expandable-exact-partitions'")
        || !shardSource.includes('governanceRequirementTestCaseCount: 1')
        || !shardSource.includes('buildBinding: canonicalBackendBuildBinding()'))
    {
        throw new Error('backend exact-union reintroduced a governance postlude or lost its canonical build binding');
    }
    if (!rightsSource.includes("['.tmp/test-results/backend/production/summary.json'")
        || !rightsSource.includes('digest: digest(backendSummary)')
        || !rightsSource.includes('readTrxResults(backendTrxFiles)'))
    {
        throw new Error('Rights V3 is not projected from the canonical backend summary and TRX artifacts');
    }
    if (!integritySource.includes('readEvidenceDocument(producerPath)')
        || !integritySource.includes('producerReceiptPath: path.relative(repositoryRoot, producerPath)'))
    {
        throw new Error('Integrity Proof is not projected from its canonical backend producer receipt');
    }
    if (!privacySource.includes("mode: 'exact-production-result-projection'")
        || !privacySource.includes('requireRunBinding(summary, expectedRunId')
        || !privacySource.includes('evidenceDigests: Object.fromEntries'))
    {
        throw new Error('Privacy/ZK is not projected from run-bound backend TRX digests');
    }
    if (/EnsureBackendFilteredBuild|FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug|dotnet build/gu.test(crossStackSource))
    {
        throw new Error('Cross-stack static reintroduced a backend build request');
    }
    return {
        schema: 'fsusblog.backend-production-build-authority.v1',
        status: 'success',
        buildRequestCount: buildRequests.length,
        debugBuildRequestCount: 0,
        postludeTesthostCount: 0,
        consumers: inventory.consumers
    };
}

function read(root, relative)
{
    return fs.readFileSync(path.join(root, relative), 'utf8');
}

export function checkBackendProductionBuildAuthority({ root = defaultRoot } = {})
{
    const inventory = JSON.parse(read(root, 'tests/governance/backend-production-build-consumers.json'));
    return validateBackendProductionBuildAuthority({
        inventory,
        bundleSource: read(root, 'tools/test/bundles/run-bundle.mjs'),
        shardSource: read(root, 'tools/test/run-backend-production-shards.mjs'),
        rightsSource: read(root, 'tools/test/project-rights-v3-evidence.mjs'),
        integritySource: read(root, 'tools/test/project-evidence.mjs'),
        privacySource: read(root, 'tools/test/lanes/project-privacy-zk-production.mjs'),
        crossStackSource: read(root, 'tools/test/lanes/cross-stack-contract.sh')
    });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    try
    {
        const result = checkBackendProductionBuildAuthority();
        process.stdout.write(`[backend-production-build-authority] ok builds=${result.buildRequestCount} debug=${result.debugBuildRequestCount} postlude=${result.postludeTesthostCount}\n`);
    }
    catch (error)
    {
        process.stderr.write(`[backend-production-build-authority] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
