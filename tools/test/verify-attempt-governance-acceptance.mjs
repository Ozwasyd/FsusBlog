#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { verifyAttemptGovernanceAcceptance } from './attempt-governance-acceptance.mjs';

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
    const receipt = JSON.parse(fs.readFileSync(path.resolve(value('--receipt')), 'utf8'));
    process.stdout.write(`${JSON.stringify(verifyAttemptGovernanceAcceptance(receipt, {
        replayRoot: path.resolve(value('--replay-root')),
        replayReceipt: value('--replay-receipt')
    }), null, 2)}\n`);
}
catch (error)
{
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
