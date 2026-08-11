#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FSUSUI_BASELINE_SCHEMA = 'fsusblog.testing.fsusui-baseline.v1';

const fullCommit = /^[0-9a-f]{40}$/u;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultBaselineFile = path.resolve(
    scriptDirectory,
    '../../config/testing/fsusui-baseline.json'
);

export function readFsusUiBaseline(file = defaultBaselineFile)
{
    const absoluteFile = path.resolve(file);
    const baseline = JSON.parse(fs.readFileSync(absoluteFile, 'utf8'));
    const keys = Object.keys(baseline).sort();
    if (
        keys.join(',') !== 'commit,repository,schema'
    || baseline.schema !== FSUSUI_BASELINE_SCHEMA
    || baseline.repository !== 'Ozwasyd/FsusUI'
    || !fullCommit.test(baseline.commit)
    )
    {
        throw new Error(`invalid FsusUI baseline contract: ${absoluteFile}`);
    }
    return Object.freeze({
        schema: baseline.schema,
        repository: baseline.repository,
        commit: baseline.commit
    });
}

function main(args)
{
    const baseline = readFsusUiBaseline();
    if (args.length === 1 && args[0] === '--commit')
    {
        process.stdout.write(`${baseline.commit}\n`);
        return;
    }
    if (args.length === 2 && args[0] === '--github-output')
    {
        fs.appendFileSync(path.resolve(args[1]), `commit=${baseline.commit}\n`);
        return;
    }
    throw new Error(
        'usage: fsusui-baseline.mjs --commit | --github-output FILE'
    );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain)
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
