#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { verifyTemporalReplay } from './temporal-context.mjs';

function options(argv)
{
    const parsed = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || !value)
        {
            throw new Error(`invalid option: ${name ?? ''}`);
        }
        parsed[name.slice(2)] = value;
    }
    return parsed;
}

function readJson(file, label)
{
    if (!file)
    {
        throw new Error(`${label} path is required`);
    }
    return JSON.parse(readFileSync(file, 'utf8'));
}

try
{
    const parsed = options(process.argv.slice(2));
    const result = verifyTemporalReplay({
        plan: readJson(parsed.plan, 'plan'),
        actual: readJson(parsed.actual, 'actual'),
        receipt: readJson(parsed.receipt, 'receipt')
    });
    process.stdout.write(`[temporal-replay] qualificationEligible=${result.qualificationEligible} reasonCode=${result.reasonCode} receipt=${result.receiptDigest}\n`);
}
catch (error)
{
    process.stderr.write(`[temporal-replay] ${error?.reasonCode ?? 'temporal.context-invalid'} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
