#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { reject, writeImmutable } from './contract.mjs';
import { recommendCpu } from './cpu-recommendations.mjs';
import { recommendMemory } from './memory-recommendations.mjs';
import {
    activateProductionModel, createModelBundle, evaluateActivationCandidate, publishCandidatePointer,
    rollbackCandidatePointer, selectCandidateModel, shadowModel
} from './model-lifecycle.mjs';
import { appendSampleCandidate, createSampleCandidate, enrollProductionSample, readSampleLedger } from './sample-ledger.mjs';
import { recommendStartup } from './startup-recommendations.mjs';

const commands = Object.freeze({
    sample: createSampleCandidate,
    append: appendSampleCandidate,
    ledger: readSampleLedger,
    cpu: recommendCpu,
    memory: recommendMemory,
    startup: recommendStartup,
    bundle: createModelBundle,
    shadow: shadowModel,
    evaluate: evaluateActivationCandidate,
    publish: publishCandidatePointer,
    rollback: rollbackCandidatePointer,
    select: selectCandidateModel,
    'production-enroll': enrollProductionSample,
    'production-activate': activateProductionModel
});

/** Commands take one explicit input JSON file; optional output publication refuses replacement. */
export function runCommand(argv)
{
    const [command, ...options] = argv;
    if (!Object.hasOwn(commands, command))
    {
        reject('unknown-command', command ?? '<missing>');
    }
    let input;
    let output;
    for (let index = 0; index < options.length; index += 2)
    {
        const key = options[index];
        const value = options[index + 1];
        if (!value || value.startsWith('--') || !['--input', '--out'].includes(key))
        {
            reject('invalid-argument', key ?? '<missing>');
        }
        if (key === '--input' && !input)
        {
            input = value;
        }
        else if (key === '--out' && !output)
        {
            output = value;
        }
        else
        {
            reject('duplicate-argument', key);
        }
    }
    if (!input)
    {
        reject('missing-input', '--input');
    }
    const result = commands[command](JSON.parse(fs.readFileSync(input, 'utf8')));
    if (output)
    {
        writeImmutable(output, result);
    }
    return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    try
    {
        process.stdout.write(`${JSON.stringify(runCommand(process.argv.slice(2)), null, 4)}\n`);
    }
    catch (error)
    {
        process.stderr.write(`${JSON.stringify({ code: error.code ?? 'command-failed',
            evidenceRef: error.evidenceRef ?? null, message: error.message })}\n`);
        process.exitCode = 1;
    }
}
