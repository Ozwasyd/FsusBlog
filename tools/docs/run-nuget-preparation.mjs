#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExecutionFailureOwner, retainExecutionFailure, formatExecutionFailure } from '../test/execution-failure-diagnostic.mjs';
import { runOwnedNugetPreparation } from '../test/nuget-preparation-owner.mjs';

export function parseNugetParentArguments(argv)
{
    const names = new Set(['--purpose', '--run-id', '--out', '--feed-root', '--feed-digest',
        '--cpu-units', '--memory-gib', '--consumer']);
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index], value = argv[index + 1];
        if (!names.has(name) || values.has(name) || !value || value.startsWith('--'))
            throw new Error('NuGet parent requires unique explicit named arguments');
        values.set(name, value);
    }
    for (const name of [...names].filter((name) => name !== '--consumer'))
        if (!values.has(name)) throw new Error('Missing NuGet parent argument: ' + name);
    return { purpose: values.get('--purpose'), runId: values.get('--run-id'),
        outputFile: values.get('--out'), feedRoot: values.get('--feed-root'), feedDigest: values.get('--feed-digest'),
        cpuUnits: Number(values.get('--cpu-units')), memoryGiB: Number(values.get('--memory-gib')),
        consumerId: values.get('--consumer') ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const failureOwner = createExecutionFailureOwner();
    try
    {
        const result = await runOwnedNugetPreparation({ repositoryRoot, failureOwner,
            ...parseNugetParentArguments(process.argv.slice(2)) });
        console.log(JSON.stringify(result, null, 2));
    }
    catch (reason)
    {
        retainExecutionFailure(failureOwner, reason);
        console.error(`[nuget-preparation] ${formatExecutionFailure(reason, failureOwner)}`);
        process.exitCode = 1;
    }
}
