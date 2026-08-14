#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    LOCAL_FSUSUI_ROOT_ENV,
    resolveLocalFsusUiIdentity
} from '../../tests/browser-diagnostics/local-fsusui-identity.mjs';

const scriptPath = fileURLToPath(import.meta.url);

function fail(message)
{
    throw new Error(`FsusUI baseline preparation: ${message}`);
}

function resolveRoot(rawRoot)
{
    const requestedRoot = String(rawRoot ?? '').trim();
    if (!requestedRoot)
    {
        fail(`${LOCAL_FSUSUI_ROOT_ENV} is required`);
    }
    const absoluteRoot = path.resolve(requestedRoot);
    let canonicalRoot;
    try
    {
        canonicalRoot = fs.realpathSync(absoluteRoot);
    }
    catch
    {
        fail(`${LOCAL_FSUSUI_ROOT_ENV} does not resolve to a directory`);
    }
    if (!fs.statSync(canonicalRoot).isDirectory())
    {
        fail(`${LOCAL_FSUSUI_ROOT_ENV} does not resolve to a directory`);
    }
    return canonicalRoot;
}

export function fsusUiPreparationCommands(root)
{
    return [
        ['corepack', 'pnpm', '--dir', root, 'install', '--frozen-lockfile', '--ignore-scripts'],
        ['corepack', 'pnpm', '--dir', root, 'run', 'stub'],
        ['corepack', 'pnpm', '--dir', root, 'run', 'ensure:wasm'],
        ['corepack', 'pnpm', '--dir', root, 'run', 'build:theme']
    ];
}

function run(command, root)
{
    const result = spawnSync(command[0], command.slice(1), {
        cwd: root,
        env: process.env,
        stdio: 'inherit'
    });
    if (result.error)
    {
        fail(`${command[0]} could not start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        fail(`${command.join(' ')} exited with ${result.status ?? 'no status'}`);
    }
}

export function prepareFsusUiBaseline(options = {})
{
    const root = resolveRoot(options.root ?? process.env[LOCAL_FSUSUI_ROOT_ENV]);
    const before = resolveLocalFsusUiIdentity({ root });
    for (const command of fsusUiPreparationCommands(root))
    {
        run(command, root);
    }
    const after = resolveLocalFsusUiIdentity({ root });
    if (after.contentDigest !== before.contentDigest)
    {
        fail('source or generated theme identity changed during preparation');
    }
    process.stdout.write(
        `[fsusui-baseline-prepare] ok commit=${after.commit} digest=${after.contentDigest}\n`
    );
    return after;
}

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 1)
    {
        if (argv[index] !== '--root' || options.root || !argv[index + 1])
        {
            fail('usage: prepare-fsusui-baseline.mjs [--root ROOT]');
        }
        options.root = argv[index + 1];
        index++;
    }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath))
{
    try
    {
        prepareFsusUiBaseline(parseArgs(process.argv.slice(2)));
    }
    catch (error)
    {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
