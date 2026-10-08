import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataScaleTierCounts } from '../test/temporal-context.mjs';

export function validateDataScaleTier(tier)
{
    // The temporal authority remains the only Node tier/count table.
    return resolveDataScaleTierCounts(tier);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        if (process.argv.length !== 3)
        {
            throw new Error('exactly one canonical scale tier is required');
        }
        validateDataScaleTier(process.argv[2]);
    }
    catch (error)
    {
        console.error(`[data-scale] ${error.message}`);
        process.exitCode = 1;
    }
}
