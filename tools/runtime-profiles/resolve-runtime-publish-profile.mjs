#!/usr/bin/env node
import process from 'node:process';

import { resolveRuntimeProfile, runtimeProfileBuildArgs } from './runtime-publish-profile.mjs';

try
{
    const options = parseArgs(process.argv.slice(2));
    const resolved = resolveRuntimeProfile(options.profile, options.manifest);
    const output = { ...runtimeProfileBuildArgs(resolved), profile: resolved.profile };
    if (options.format === 'lines')
    {
        for (const key of [
            'runtimeProfileId', 'runtimeProfileManifestDigest', 'runtimeProfileDigest', 'runtimeBaseFlavor',
            'targetRuntime', 'publishSingleFile', 'publishReadyToRun', 'tieredPgo', 'quickJitForLoops',
            'serverGc', 'nativeAot', 'gcHeapCountMode', 'gcHeapHardLimitMode', 'gcHeapHardLimitPercent', 'threadPoolMode', 'threadPoolMinThreadsPerCpu', 'topologyMode'
        ])
        {
            console.log(output[key]);
        }
    }
    else
    {
        console.log(JSON.stringify(output));
    }
}
catch (error)
{
    console.error(`[resolve-runtime-publish-profile] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${key ?? '<end>'}`);
        }
        options[key.slice(2)] = value;
    }
    return options;
}
