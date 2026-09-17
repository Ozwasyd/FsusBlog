#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { isDirectExecution } = await import(new URL('../../support/direct-execution.mjs', import.meta.url));
const runtimeClass = 'FsusBlog.Server.Tests.Unit.SecurityHardening.CsrfOriginGuardRuntimeTests';
const expectedMethodCounts = new Map([
    ['CredentialedUnsafeRequest_RejectsMissingTrustedOrigin', 4],
    ['CredentialedUnsafeRequest_RejectsCrossSiteOrigin', 1],
    ['CredentialedUnsafeRequest_DoesNotAllowCsrfHeaderToBypassOrigin', 1],
    ['CredentialedUnsafeRequest_RejectsUntrustedOriginEvenWhenRefererTrusted', 1],
    ['CredentialedUnsafeRequest_AllowsTrustedOrigin', 1],
    ['CredentialedUnsafeRequest_AllowsTrustedRefererWhenOriginMissing', 1],
    ['SafeCookieRequest_BypassesOriginGuard', 1],
    ['UnsafeCookielessRequest_BypassesOriginGuard', 1]
]);

function xmlAttribute(source, name)
{
    const value = String(source).match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1] ?? '';
    return value
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

export function projectCsrfRuntimeEvidence(trx)
{
    const definitions = new Map();
    for (const match of String(trx).matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu))
    {
        const method = match[2].match(/<TestMethod\b([^>]*)\/?\s*>/u)?.[1] ?? '';
        definitions.set(xmlAttribute(match[1], 'id'), {
            className: xmlAttribute(method, 'className'),
            methodName: xmlAttribute(method, 'name')
        });
    }

    const observations = [...String(trx).matchAll(/<UnitTestResult\b([^>]*)\/?\s*>/gu)]
        .flatMap((match) =>
        {
            const attributes = match[1];
            const definition = definitions.get(xmlAttribute(attributes, 'testId'));
            return definition?.className === runtimeClass
                ? [{
            method: definition.methodName,
            outcome: xmlAttribute(attributes, 'outcome'),
            duration: xmlAttribute(attributes, 'duration')
          }]
                : [];
        });

    const expectedTotal = [...expectedMethodCounts.values()].reduce((sum, count) => sum + count, 0);
    if (observations.length !== expectedTotal)
    {
        throw new Error(`CSRF runtime matrix result count mismatch: expected ${expectedTotal}, received ${observations.length}`);
    }
    if (observations.some((entry) => entry.outcome !== 'Passed'))
    {
        const failures = observations
            .filter((entry) => entry.outcome !== 'Passed')
            .map((entry) => `${entry.method}:${entry.outcome || '<missing>'}`);
        throw new Error(`CSRF runtime matrix contains non-passing results: ${failures.join(', ')}`);
    }

    const counts = new Map();
    for (const observation of observations)
    {
        counts.set(observation.method, (counts.get(observation.method) ?? 0) + 1);
    }
    const unexpected = [...counts.keys()].filter((method) => !expectedMethodCounts.has(method));
    const mismatches = [...expectedMethodCounts]
        .filter(([method, count]) => counts.get(method) !== count)
        .map(([method, count]) => `${method}:${counts.get(method) ?? 0}/${count}`);
    if (unexpected.length > 0 || mismatches.length > 0)
    {
        throw new Error(`CSRF runtime matrix identity mismatch: ${[...unexpected, ...mismatches].join(', ')}`);
    }

    return [...expectedMethodCounts].map(([method, expectedResults]) => ({
        method: `${runtimeClass}.${method}`,
        expectedResults,
        outcome: 'passed'
    }));
}

function sha256(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function resolveTestAssembly()
{
    const configured = String(process.env.FSUSBLOG_BACKEND_TEST_DLL ?? '').trim();
    if (configured)
    {
        const assembly = path.resolve(configured);
        if (!fs.existsSync(assembly) || !fs.statSync(assembly).isFile())
        {
            throw new Error(`configured CSRF runtime matrix test assembly is missing: ${configured}`);
        }
        return assembly;
    }

    const configuration = String(
        process.env.FSUSBLOG_BACKEND_TEST_CONFIGURATION
      ?? process.env.FSUSBLOG_RUNTIME_CONFIGURATION
      ?? 'Debug');
    if (!['Debug', 'Release'].includes(configuration))
    {
        throw new Error(`CSRF runtime matrix build configuration must be Debug or Release, received ${configuration}`);
    }
    const candidates = configuration === 'Release'
        ? [path.join(root, 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll')]
        : [path.join(root, 'tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.dll')];
    const assembly = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!assembly)
    {
        throw new Error('CSRF runtime matrix requires a built FsusBlog.Server.Tests.dll');
    }
    return path.resolve(assembly);
}

function runDotnetTest(testAssembly, trxFile)
{
    const runner = path.join(root, 'tools/build-with-data-env.sh');
    const args = [
        'dotnet',
        'test',
        testAssembly,
        '--filter',
        `FullyQualifiedName~${runtimeClass}`,
        '--logger',
        `trx;LogFileName=${path.basename(trxFile)}`,
        '--results-directory',
        path.dirname(trxFile)
    ];
    return new Promise((resolveRun, rejectRun) =>
    {
        const child = spawn(runner, args, { cwd: root, env: process.env, stdio: 'inherit' });
        child.on('error', rejectRun);
        child.on('exit', (code, signal) =>
        {
            if (signal)
            {
                rejectRun(new Error(`CSRF runtime matrix dotnet test terminated by ${signal}`));
            }
            else if (code !== 0)
            {
                rejectRun(new Error(`CSRF runtime matrix dotnet test failed with exit code ${code}`));
            }
            else
            {
                resolveRun();
            }
        });
    });
}

export async function runCsrfBrowserMatrix()
{
    const evidenceDir = path.resolve(
        process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence'));
    const resultsDir = path.resolve(
        process.env.FSUSBLOG_TEST_RESULTS_ROOT ?? path.join(root, '.tmp/test-results'),
        'csrf-browser-matrix');
    const outFile = path.join(evidenceDir, 'security-depth-summary.json');
    const trxFile = path.join(resultsDir, 'csrf-browser-matrix.trx');
    const testAssembly = resolveTestAssembly();

    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.rmSync(trxFile, { force: true });
    fs.rmSync(outFile, { force: true });
    await runDotnetTest(testAssembly, trxFile);
    if (!fs.existsSync(trxFile))
    {
        throw new Error('CSRF runtime matrix completed without a TRX result');
    }

    const checks = projectCsrfRuntimeEvidence(fs.readFileSync(trxFile, 'utf8'));
    const evidence = {
        schema: 'fsusblog.csrf-origin-runtime-matrix.v1',
        status: 'success',
        generatedAt: new Date().toISOString(),
        producer: {
            tier: 'csrf-browser-matrix',
            schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
            sourceIdentity: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
        },
        runtimeBoundary: 'TestServer -> UseFsusCsrfOriginGuard -> mapped endpoint',
        contract: {
            protectedRequests: 'unsafe methods carrying browser credentials',
            proof: 'trusted absolute HTTP Origin, or trusted Referer when Origin is absent',
            antiforgeryHeader: 'X-Fsus-Csrf-Token',
            tokenIssuanceFlow: 'not configured for current binary mutation endpoints',
            tokenExpiryContract: 'not applicable'
        },
        checks,
        sources: {
            testAssembly: path.relative(root, testAssembly).replaceAll(path.sep, '/'),
            testAssemblyDigest: sha256(testAssembly),
            trx: path.relative(root, trxFile).replaceAll(path.sep, '/'),
            trxDigest: sha256(trxFile)
        }
    };
    const temporary = `${outFile}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.renameSync(temporary, outFile);
    console.log(`[csrf-browser-matrix] passed ${checks.length} runtime contracts | evidence=${outFile}`);
}

if (isDirectExecution(import.meta.url))
{
    await runCsrfBrowserMatrix();
}
