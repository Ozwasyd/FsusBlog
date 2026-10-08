#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { digest } = await import(new URL('../test-fixtures/mutation-recovery/canonical.mjs', import.meta.url));
const { validateFixtureAuthoritySources } = await import(new URL('../testing/fixture-catalog.mjs', import.meta.url));

import { buildFixtureMatrixAcceptance, scanFixtureMatrixSources } from './fixture-matrix-governance.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensions = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.vue', '.cs', '.sh', '.ps1', '.yml', '.yaml', '.md', '.json', '.toml']);

export function checkFixtureMatrixGovernance(root = defaultRoot)
{
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
        .split('\0').filter(Boolean);
    const sources = {};
    for (const file of [...new Set(files)].sort())
    {
        if (!extensions.has(path.extname(file)))
        {
            continue;
        }
        const absolute = path.join(root, file);
        if (!fs.lstatSync(absolute).isFile())
        {
            throw new Error(`scanner refuses nonregular source ${file}`);
        }
        sources[file] = fs.readFileSync(absolute, 'utf8');
    }
    const authorityErrors = validateFixtureAuthoritySources({ repositoryRoot: root });
    const scanner = scanFixtureMatrixSources(sources, { authorityErrors });
    const source = {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        worktreeFingerprint: digest(Object.keys(sources).map((file) => ({ file, digest: digest(sources[file]) })))
    };
    return { scanner, acceptance: buildFixtureMatrixAcceptance({ source, scanner }) };
}

function main()
{
    if (process.argv.slice(2).some((argument) => argument !== '--write'))
    {
        throw new Error('usage: node tools/test/check-fixture-matrix-governance.mjs [--write]');
    }
    const result = checkFixtureMatrixGovernance();
    if (process.argv.includes('--write'))
    {
        const output = path.join(defaultRoot, '.tmp/test-evidence/fixture-matrix-acceptance.json');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, `${JSON.stringify(result.acceptance, null, 4)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 4)}\n`);
    process.exitCode = result.acceptance.status === 'accepted' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 1;
    }
}
