#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { buildAttemptGovernanceAcceptance } from './attempt-governance-acceptance.mjs';

function value(name)
{
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1])
    {
        throw new Error(`${name} is required`);
    }
    return process.argv[index + 1];
}

try
{
    const result = buildAttemptGovernanceAcceptance({
        outputDirectory: path.resolve(value('--output')),
        replayRoot: path.resolve(value('--replay-root')),
        replayReceipt: value('--replay-receipt')
    });
    process.stdout.write(`${JSON.stringify({
        receipt: result.file,
        digest: result.receipt.contentDigest,
        producerCount: result.receipt.producers.producerCount,
        focusedTestCount: result.receipt.focusedAcceptance.testCount,
        warnings: result.receipt.warnings
    }, null, 2)}\n`);
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
