#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    defaultTimeoutPolicyDigest,
    qualificationTemporalContext
} from './temporal-context.mjs';

function option(name, fallback = null)
{
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

try
{
    const output = path.resolve(option('output') ?? (() =>
    {
        throw new Error('--output is required');
    })());
    const producerId = option('producer') ?? (() =>
    {
        throw new Error('--producer is required');
    })();
    const sourceCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const fingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    const sourceFingerprint = fingerprint.startsWith('sha256:') ? fingerprint : `sha256:${fingerprint}`;
    const schedulerRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const locale = option('locale', process.env.FSUSBLOG_TEST_LOCALE || 'en-US');
    const uiLocale = option('ui-locale', process.env.FSUSBLOG_TEST_UI_LOCALE || locale);
    const context = qualificationTemporalContext({
        sourceCommit,
        sourceFingerprint,
        producerId,
        schedulerRunId,
        businessEpochUtc: option(
            'business-epoch',
            process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC || '2024-02-29T23:59:59.000Z'
        ),
        locale,
        uiLocale,
        timeoutPolicyDigest: process.env.FSUSBLOG_TIMEOUT_POLICY_DIGEST?.trim()
      || defaultTimeoutPolicyDigest()
    });
    mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.next-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, output);
    process.stdout.write(`${output}\n`);
}
catch (error)
{
    process.stderr.write(`[temporal-context] ${error?.reasonCode ?? 'temporal.context-invalid'} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
