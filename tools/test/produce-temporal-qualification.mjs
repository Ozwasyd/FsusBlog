#!/usr/bin/env node
/**
 * Correctness producer: bind a data-scale seed temporal plan/actual/receipt.
 *
 * Produces run-bound temporal artifacts from the unique qualification temporal
 * context. Business timestamps come from the injected business epoch projection
 * (same formulas as tools/data-scale/seed.sh). Measurement clocks stay real.
 *
 * Usage:
 *   node tools/test/produce-temporal-qualification.mjs \
 *     --producer data-scale-seed \
 *     --tier scale-xs \
 *     --out-dir .tmp/temporal-qualification
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    bindProducerTemporalArtifacts,
    createBusinessWallClock,
    defaultTimeoutPolicyDigest,
    formatBusinessEpochUtc,
    materializeTemporalEnvironment,
    monotonicNow,
    projectDataScaleBusinessOutcome,
    projectSessionFixtureBusinessOutcome,
    semanticOutcomeDigest
} from './temporal-context.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultProducerId = 'data-scale-seed';
const defaultBusinessEpochUtc = '2024-02-29T23:59:59.000Z';
const supportedProducers = new Set(['data-scale-seed', 'session-fixture']);

function option(name, fallback = null)
{
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requiredEnv(name)
{
    const value = String(process.env[name] ?? '').trim();
    if (!value)
    {
        throw new Error(`${name} is required for temporal qualification production`);
    }
    return value;
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

function resolveSourceFingerprint()
{
    const raw = requiredEnv('FSUSBLOG_TEST_SOURCE_FINGERPRINT');
    return raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
}

try
{
    const producerId = option('producer', defaultProducerId);
    if (!supportedProducers.has(producerId))
    {
        throw new Error(`unsupported temporal qualification producer: ${producerId}`);
    }
    const tier = option('tier', 'scale-xs');
    const namespace = option('namespace', process.env.FSUSBLOG_TEST_NAMESPACE || 'local');
    const rememberMe = option('remember-me', 'false') === 'true';
    const accessTokenExpiresMinutes = Number(option('access-token-expires-minutes', '15'));
    const outDir = path.resolve(repositoryRoot, option('out-dir', '.tmp/temporal-qualification'));
    const schedulerRunId = requiredEnv('FSUSBLOG_TEST_RUN_ID');
    const sourceCommit = requiredEnv('FSUSBLOG_TEST_SOURCE_COMMIT');
    const sourceFingerprint = resolveSourceFingerprint();
    const businessEpochUtc = formatBusinessEpochUtc(Date.parse(String(
        process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC
    ?? option('business-epoch', defaultBusinessEpochUtc)
    ).trim()));
    const locale = option('locale', 'en-US');
    const uiLocale = option('ui-locale', locale);

    process.env.TZ = 'UTC';
    process.env.FSUSBLOG_TEST_NODE_TIMEZONE = 'UTC';
    process.env.FSUSBLOG_TEST_POSTGRES_TIMEZONE = 'UTC';
    process.env.FSUSBLOG_TEST_BACKEND_CULTURE = 'Invariant';
    process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC = businessEpochUtc;

    const measurementStarted = monotonicNow('performance-now');
    const outcome = producerId === 'session-fixture'
        ? projectSessionFixtureBusinessOutcome({
      businessEpochUtc,
      accessTokenExpiresMinutes,
      rememberMe
    })
        : projectDataScaleBusinessOutcome({
      businessEpochUtc,
      tier,
      namespace
    });
    // Prove measurement clock is independent of business epoch (real monotonic advance).
    const measurementEnded = monotonicNow('performance-now');
    if (!(measurementEnded >= measurementStarted))
    {
        throw new Error('monotonic measurement clock did not advance');
    }

    const bound = bindProducerTemporalArtifacts({
        contextInput: {
            sourceCommit,
            sourceFingerprint,
            producerId,
            schedulerRunId,
            businessEpochUtc,
            locale,
            uiLocale,
            timeoutPolicyDigest: process.env.FSUSBLOG_TIMEOUT_POLICY_DIGEST?.trim() || defaultTimeoutPolicyDigest()
        },
        outcome,
        observations: {
            businessEpochUtc,
            timezone: 'UTC',
            locale,
            uiLocale,
            backendCulture: 'Invariant',
            postgresTimezone: 'UTC',
            nodeTimezone: process.env.TZ || 'UTC',
            calendar: 'gregory',
            firstDayOfWeek: 'monday',
            monotonicClockSource: 'performance-now'
        },
        // Artifact metadata only — excluded from semanticOutcomeDigest.
        generatedAt: new Date().toISOString()
    });

    const envBindings = materializeTemporalEnvironment(bound.context);
    for (const [key, value] of Object.entries(envBindings))
    {
        process.env[key] = value;
    }

    // Optional explicit advance proof path for expiry-style producers (does not mutate bound plan).
    const wallClock = createBusinessWallClock(bound.context);
    const advanced = wallClock.advanceMs(3_600_000);

    const planPath = path.join(outDir, 'temporal-plan.json');
    const actualPath = path.join(outDir, 'temporal-actual.json');
    const receiptPath = path.join(outDir, 'temporal-receipt.json');
    const outcomePath = path.join(outDir, 'semantic-outcome.json');
    const summaryPath = path.join(outDir, 'producer-summary.json');

    writeJson(planPath, bound.plan);
    writeJson(actualPath, bound.actual);
    writeJson(receiptPath, bound.receipt);
    writeJson(outcomePath, outcome);
    writeJson(summaryPath, {
        schema: 'fsusblog.temporal-qualification-producer-summary.v1',
        producerId,
        tier,
        namespace,
        qualificationEligible: bound.verification.qualificationEligible,
        reasonCode: bound.verification.reasonCode,
        planDigest: bound.plan.digest,
        actualDigest: bound.actual.digest,
        receiptDigest: bound.receipt.digest,
        semanticOutcomeDigest: semanticOutcomeDigest(outcome),
        businessEpochUtc,
        advancedBusinessEpochUtc: advanced,
        measurementDurationMs: measurementEnded - measurementStarted,
        artifacts: {
            plan: path.relative(repositoryRoot, planPath).replaceAll(path.sep, '/'),
            actual: path.relative(repositoryRoot, actualPath).replaceAll(path.sep, '/'),
            receipt: path.relative(repositoryRoot, receiptPath).replaceAll(path.sep, '/'),
            outcome: path.relative(repositoryRoot, outcomePath).replaceAll(path.sep, '/')
        }
    });

    process.stdout.write(
        `[temporal-qualification] producer=${producerId} tier=${tier} eligible=${bound.verification.qualificationEligible} receipt=${bound.receipt.digest}\n`
    );
    process.stdout.write(
        `[temporal-qualification] plan=${planPath}\nactual=${actualPath}\nreceipt=${receiptPath}\n`
    );
}
catch (error)
{
    process.stderr.write(
        `[temporal-qualification] ${error?.reasonCode ?? 'temporal.context-invalid'} ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
}
