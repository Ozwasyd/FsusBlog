#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
    verifyExecutionEnvelopeReceipt
} from './execution-envelope-receipt.mjs';
const { executionEnvelopeDigest } = await import(new URL('../test-matrix/execution-envelope-policy.mjs', import.meta.url));
function options(argv)
{
    const parsed = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value == null)
        {
            throw new Error(`invalid execution envelope verifier option: ${name ?? ''}`);
        }
        parsed.set(name, value);
    }
    return parsed;
}

function readJson(file, label)
{
    const resolved = path.resolve(file ?? '');
    if (!file || !fs.statSync(resolved).isFile())
    {
        throw new Error(`${label} is missing`);
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

export function verifyExecutionEnvelopeFiles({ planFile, receiptFile })
{
    const plan = readJson(planFile, 'execution envelope plan');
    const receipt = readJson(receiptFile, 'execution envelope receipt');
    if (executionEnvelopeDigest(plan) !== executionEnvelopeDigest(receipt.plan))
    {
        throw new Error('execution envelope plan/receipt binding failed');
    }
    return verifyExecutionEnvelopeReceipt(receipt);
}

function main(argv)
{
    const values = options(argv);
    const verified = verifyExecutionEnvelopeFiles({
        planFile: values.get('--plan'),
        receiptFile: values.get('--receipt')
    });
    console.log(
        `[execution-envelope] verified producer=${verified.producerId} run=${verified.schedulerRunId} attempt=${verified.attemptId} digest=${verified.envelopeDigest}`
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(`[execution-envelope] ${error.message}`);
        process.exitCode = 1;
    }
}
