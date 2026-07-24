#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    executeRuntimeScenarioHost,
    repositoryRoot
} from './runtime-scenario-host.mjs';

function parseArguments(argumentsList)
{
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 1)
    {
        const argument = argumentsList[index];
        if (argument === '--phase')
        {
            options.phase = argumentsList[++index];
        }
        else if (argument === '--evidence-root')
        {
            options.evidenceRoot = path.resolve(repositoryRoot, argumentsList[++index]);
        }
        else
        {
            throw new Error(`unknown runtime scenario host argument: ${argument}`);
        }
    }
    return options;
}

export async function runRuntimeScenarioHostCli(argumentsList = process.argv.slice(2))
{
    const options = parseArguments(argumentsList);
    const controller = new AbortController();
    const cancel = (signal) =>
    {
        if (!controller.signal.aborted)
        {
            controller.abort(`user-cancelled:${signal}`);
        }
    };
    process.once('SIGINT', () => cancel('SIGINT'));
    process.once('SIGTERM', () => cancel('SIGTERM'));
    const result = await executeRuntimeScenarioHost({
        ...options,
        signal: controller.signal
    });
    const { summary, outputRoot } = result;
    console.log(
        `[runtime-scenario-host] phase=${summary.phase}`
        + ` status=${summary.status}`
        + ` scenarios=${summary.results.length}`
        + ` failures=${summary.correctness.failedScenarioIds.length}`
        + ` pid=${summary.initialization.processId}`
        + ` evidence=${path.relative(repositoryRoot, outputRoot)}`
    );
    if (summary.status !== 'success')
    {
        process.exitCode = summary.status === 'cancelled' ? 130 : 1;
        if (summary.status === 'cancelled')
        {
            setImmediate(() => process.exit(130));
        }
    }
    return result;
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    runRuntimeScenarioHostCli().catch((error) =>
    {
        console.error(`[runtime-scenario-host] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
