#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

let command;
try
{
    command = JSON.parse(String(process.env.FSUSBLOG_BUILD_CACHE_COMMAND_JSON ?? ''));
}
catch (error)
{
    throw new Error(`build cache command payload is invalid JSON: ${error.message}`, { cause: error });
}
if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== 'string' || value.length === 0))
{
    throw new Error('build cache command payload must be a non-empty string array');
}

const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, FSUSBLOG_BUILD_CACHE_INNER: '1' },
    stdio: 'inherit'
});
child.once('error', error =>
{
    console.error(`[build-cache-command] fatal: ${error.message}`);
    process.exitCode = 1;
});
child.once('exit', (code, signal) =>
{
    if (signal)
    {
        try
        {
            process.kill(process.pid, signal);
        }
        catch
        {
            process.exitCode = 1;
        }
        return;
    }
    process.exitCode = code ?? 1;
});
