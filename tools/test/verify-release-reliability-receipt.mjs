#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { verifyQualifiedReceipt } from './release-reliability-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argumentsList)
{
    if (argumentsList.length !== 2 || argumentsList[0] !== '--receipt')
    {
        throw new Error('usage: verify-release-reliability-receipt.mjs --receipt <path>');
    }
    return path.resolve(root, argumentsList[1]);
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main()
{
    const receiptFile = parseArgs(process.argv.slice(2));
    const receipt = readJson(receiptFile);
    const receiptRoot = path.dirname(receiptFile);
    const scenarioResults = fs.readdirSync(path.join(receiptRoot, 'scenario-results'))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => readJson(path.join(receiptRoot, 'scenario-results', name)));
    verifyQualifiedReceipt({ receipt, scenarioResults });
    console.log(`[release-reliability-receipt] qualified receipt=${path.relative(root, receiptFile)}`);
}

try
{
    main();
}
catch (error)
{
    console.error(`[release-reliability-receipt] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
