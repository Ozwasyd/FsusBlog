#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { produceRuntimeOrderIdentity } from './runtime-order-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function option(name, fallback = null)
{
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
}

function required(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} is required`);
    }
    return normalized;
}

try
{
    const result = produceRuntimeOrderIdentity({
        root,
        outputFile: required(option('--output'), '--output'),
        runId: required(option('--run-id', process.env.FSUSBLOG_TEST_RUN_ID), '--run-id'),
        attemptId: required(option('--attempt-id', process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID), '--attempt-id'),
        sourceState: {
            commit: required(process.env.FSUSBLOG_TEST_SOURCE_COMMIT, 'FSUSBLOG_TEST_SOURCE_COMMIT'),
            worktreeFingerprint: required(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT, 'FSUSBLOG_TEST_SOURCE_FINGERPRINT')
        },
        buildReceiptFile: required(option('--build-receipt'), '--build-receipt'),
        replayQualificationFile: required(option('--replay-qualification'), '--replay-qualification'),
        fixedClockEpochMs: Number(required(option('--fixed-clock-epoch-ms'), '--fixed-clock-epoch-ms')),
        executionEnvelopePolicyFile: option('--execution-envelope-policy') ?? undefined
    });
    console.log(`[runtime-order-identity] file=${path.relative(root, result.file)} digest=${result.authority.contentDigest}`);
}
catch (error)
{
    console.error(`[runtime-order-identity] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
}
