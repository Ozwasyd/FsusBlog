#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const legacyRealDumpContract = Object.freeze({
    producerId: 'legacy-20260517-real-dump',
    fixture: 'Legacy20260517RealDump',
    canonicalTestId: 'xunit:tests/backend/Integration/SchemaMigrationIntegrationTests.cs#SchemaMigrationIntegrationTests.RunAsync_UpgradesLegacy20260517RealDump_WhenProvided',
    fullyQualifiedName: 'FsusBlog.Server.Tests.SchemaMigrationIntegrationTests.RunAsync_UpgradesLegacy20260517RealDump_WhenProvided',
    runtimeEvidencePrefix: 'fsusblog-legacy-real-dump-evidence ',
    outputSchema: 'fsusblog.legacy-20260517-real-dump-outcome.v1'
});

function requiredText(value, label)
{
    const result = String(value ?? '').trim();
    if (!result)
    {
        throw new Error(`${label} is required`);
    }
    return result;
}

function sha256Buffer(value)
{
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function contentDigest(value)
{
    return `sha256:${sha256Buffer(JSON.stringify(canonicalize(value)))}`;
}

function decodeXml(value)
{
    return String(value ?? '')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function attribute(source, name)
{
    return decodeXml(source.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1] ?? '');
}

export function buildLegacyRealDumpMembership(producerId)
{
    if (!['integration', legacyRealDumpContract.producerId].includes(producerId))
    {
        throw new Error(`unsupported legacy real-dump membership producer: ${producerId}`);
    }
    const result = producerId === legacyRealDumpContract.producerId ? 'planned' : 'not-selected';
    return {
        schema: 'fsusblog.legacy-20260517-real-dump-membership.v1',
        producerId,
        testId: legacyRealDumpContract.canonicalTestId,
        fullyQualifiedName: legacyRealDumpContract.fullyQualifiedName,
        fixture: legacyRealDumpContract.fixture,
        result,
        reason: result === 'planned'
            ? 'selected only by the dedicated real-dump producer'
            : 'excluded from the ordinary Category=Integration producer'
    };
}

export function parseLegacyRealDumpTrx(xml)
{
    const results = [...String(xml).matchAll(
        /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/gu
    )];
    if (results.length !== 1)
    {
        throw new Error(`dedicated real-dump producer requires exactly one TRX result, got ${results.length}`);
    }
    const [match] = results;
    const testName = attribute(match[1], 'testName');
    const outcome = attribute(match[1], 'outcome');
    if (testName !== legacyRealDumpContract.fullyQualifiedName)
    {
        throw new Error(`dedicated real-dump producer executed unexpected test ID: ${testName || '<missing>'}`);
    }
    if (!['Passed', 'Failed'].includes(outcome))
    {
        throw new Error(`dedicated real-dump producer has non-semantic outcome: ${outcome || '<missing>'}`);
    }
    const evidenceLines = [...String(xml).matchAll(/<StdOut>([\s\S]*?)<\/StdOut>/gu)]
        .flatMap((stdout) => decodeXml(stdout[1]).split(/\r?\n/gu))
        .map((line) => line.trim())
        .filter((line) => line.startsWith(legacyRealDumpContract.runtimeEvidencePrefix));
    if (outcome === 'Passed' && evidenceLines.length !== 1)
    {
        throw new Error('real-dump Passed result requires exactly one restore/migration runtime evidence row');
    }
    if (outcome === 'Failed' && evidenceLines.length > 1)
    {
        throw new Error('real-dump Failed result contains duplicate runtime evidence rows');
    }
    let runtimeEvidence = null;
    if (evidenceLines.length === 1)
    {
        try
        {
            runtimeEvidence = JSON.parse(evidenceLines[0].slice(legacyRealDumpContract.runtimeEvidencePrefix.length));
        }
        catch (error)
        {
            throw new Error(`real-dump runtime evidence is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
    }
    return { testName, outcome, runtimeEvidence };
}

export function validateLegacyRealDumpRuntimeEvidence(evidence, expected)
{
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.schema !== 'fsusblog.legacy-20260517-real-dump-runtime-evidence.v1')
    {
        throw new Error('real-dump runtime evidence schema is invalid');
    }
    if (evidence.producerId !== legacyRealDumpContract.producerId
    || evidence.testId !== legacyRealDumpContract.canonicalTestId
    || evidence.fullyQualifiedName !== legacyRealDumpContract.fullyQualifiedName)
    {
        throw new Error('real-dump runtime evidence test or producer identity drifted');
    }
    if (evidence.sourceSha !== expected.sourceSha)
    {
        throw new Error('real-dump runtime evidence source SHA drifted');
    }
    if (evidence.dumpSha256 !== expected.dumpSha256)
    {
        throw new Error('real-dump runtime evidence dump identity drifted');
    }
    if (evidence.postgres?.imageReference !== expected.postgresImage
    || evidence.postgres?.imageId !== expected.postgresImageId
    || !String(evidence.postgres?.serverVersion ?? '').trim())
    {
        throw new Error('real-dump runtime evidence PostgreSQL identity drifted');
    }
    if (evidence.restoreCompleted !== true
    || evidence.migrationExecutionCount !== 2
    || evidence.postconditionsVerified !== true
    || !evidence.legacyCounts || typeof evidence.legacyCounts !== 'object')
    {
        throw new Error('real-dump Passed result lacks restore, double-migration, legacy-count, or postcondition evidence');
    }
    return evidence;
}

export function validateLegacyRealDumpPreflight({
    env,
    repositoryRoot,
    inspectImage,
    currentSourceSha,
    currentWorktreeStatus = ''
})
{
    if (env.FSUS_ENABLE_LEGACY_DUMP_TESTS !== '1')
    {
        throw new Error('FSUS_ENABLE_LEGACY_DUMP_TESTS must equal 1');
    }
    const dumpPath = path.resolve(requiredText(env.FSUS_LEGACY_20260517_DUMP, 'FSUS_LEGACY_20260517_DUMP'));
    let stat;
    try
    {
        stat = fs.lstatSync(dumpPath);
        fs.accessSync(dumpPath, fs.constants.R_OK);
    }
    catch (error)
    {
        throw new Error(`legacy 20260517 dump is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('legacy 20260517 dump must be a readable regular file');
    }
    const expectedDumpSha256 = requiredText(env.FSUS_LEGACY_20260517_DUMP_SHA256, 'FSUS_LEGACY_20260517_DUMP_SHA256').toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(expectedDumpSha256))
    {
        throw new Error('FSUS_LEGACY_20260517_DUMP_SHA256 must be a SHA-256 digest');
    }
    const actualDumpSha256 = sha256Buffer(fs.readFileSync(dumpPath));
    if (actualDumpSha256 !== expectedDumpSha256)
    {
        throw new Error('legacy 20260517 dump identity mismatch');
    }

    const sourceSha = requiredText(currentSourceSha, 'current source SHA');
    if (!/^[0-9a-f]{40}$/u.test(sourceSha))
    {
        throw new Error('current source SHA is invalid');
    }
    if (String(currentWorktreeStatus).trim())
    {
        throw new Error('legacy real-dump producer requires a clean tracked worktree');
    }
    const requestedSourceSha = requiredText(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? sourceSha, 'FSUSBLOG_TEST_SOURCE_COMMIT');
    if (requestedSourceSha !== sourceSha)
    {
        throw new Error('legacy real-dump producer source SHA drifted');
    }

    const postgresImage = requiredText(env.FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE, 'FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE');
    const expectedPostgresImageId = requiredText(
        env.FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID,
        'FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID'
    );
    if (!/^sha256:[0-9a-f]{64}$/u.test(expectedPostgresImageId))
    {
        throw new Error('FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID must be a Docker sha256 image ID');
    }
    const actualPostgresImageId = requiredText(inspectImage(postgresImage), 'local PostgreSQL image ID');
    if (actualPostgresImageId !== expectedPostgresImageId)
    {
        throw new Error('PostgreSQL image identity mismatch');
    }

    return {
        repositoryRoot: path.resolve(repositoryRoot),
        dumpPath,
        dumpSha256: actualDumpSha256,
        sourceSha,
        postgresImage,
        postgresImageId: actualPostgresImageId
    };
}

export function buildLegacyRealDumpOutcome({ identity, result })
{
    const passed = result.outcome === 'Passed';
    const base = {
        schema: legacyRealDumpContract.outputSchema,
        producerId: legacyRealDumpContract.producerId,
        testId: legacyRealDumpContract.canonicalTestId,
        fullyQualifiedName: legacyRealDumpContract.fullyQualifiedName,
        membership: {
            integration: 'not-selected',
            [legacyRealDumpContract.producerId]: 'planned'
        },
        execution: {
            plannedTestIds: [legacyRealDumpContract.canonicalTestId],
            executedTestIds: [legacyRealDumpContract.canonicalTestId],
            passedTestIds: passed ? [legacyRealDumpContract.canonicalTestId] : [],
            failedTestIds: passed ? [] : [legacyRealDumpContract.canonicalTestId],
            outcome: passed ? 'passed' : 'failed'
        },
        sourceSha: identity.sourceSha,
        dumpSha256: identity.dumpSha256,
        postgres: {
            imageReference: identity.postgresImage,
            imageId: identity.postgresImageId,
            serverVersion: result.runtimeEvidence?.postgres?.serverVersion ?? null
        },
        runtimeEvidence: result.runtimeEvidence
    };
    return { ...base, contentDigest: contentDigest(base) };
}

export function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function option(args, name)
{
    const index = args.indexOf(name);
    if (index < 0 || index + 1 >= args.length)
    {
        throw new Error(`${name} is required`);
    }
    return args[index + 1];
}

function main(args)
{
    if (args[0] !== 'plan')
    {
        throw new Error('usage: legacy-real-dump-contract.mjs plan --producer <id> --out <path>');
    }
    writeJson(path.resolve(option(args, '--out')), buildLegacyRealDumpMembership(option(args, '--producer')));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url))
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(`[legacy-real-dump-contract] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
