#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

import {
    loadTemporalContext,
    readTemporalReplayAuthority
} from './temporal-context.mjs';
import { validateTemporalProducerBindings } from './temporal-producer-bindings.mjs';
import { validateTemporalSourceObservation } from './temporal-source-observation-contract.mjs';

function option(name)
{
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : null;
}

try
{
    const kind = option('kind') ?? 'catalog';
    if (kind === 'catalog')
    {
        const result = validateTemporalProducerBindings();
        process.stdout.write(`[temporal-producers] producers=${result.producerCount} implementations=${result.implementationCount} digest=${result.digest}\n`);
    }
    else
    {
        const context = loadTemporalContext();
        const observationFile = option('observation');
        if (!observationFile)
        {
            throw new Error('--observation is required');
        }
        const observation = JSON.parse(readFileSync(observationFile, 'utf8'));
        validateTemporalSourceObservation({ kind, context, observation }, readTemporalReplayAuthority());
        process.stdout.write(`[temporal-producers] ${kind}=ok\n`);
    }
}
catch (error)
{
    process.stderr.write(`[temporal-producers] ${error?.reasonCode ?? 'temporal.context-invalid'} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
}
