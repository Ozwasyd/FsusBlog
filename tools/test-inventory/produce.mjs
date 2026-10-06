#!/usr/bin/env node
/**
 * Canonical test inventory producer.
 *
 * Usage:
 *   node tools/test-inventory/produce.mjs                 # write artifact
 *   node tools/test-inventory/produce.mjs --check         # fail on missing/stale artifact
 *   node tools/test-inventory/produce.mjs --out <path>    # custom output path
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { xunitTestProjects } from './adapters.mjs';
import { DEFAULT_ARTIFACT_PATH, isInventoryStale } from './api.mjs';
import { canonicalStringify, discoverTestInventory, requireXunitConfiguration } from './discovery.mjs';
import { validateInventoryArtifact } from './schema.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

function prepareXunitCompileContext(configuration)
{
    for (const { project } of xunitTestProjects)
    {
        const result = spawnSync(
            'dotnet',
            [
                'build',
                path.join(root, project),
                '--configuration',
                configuration,
                '--nologo',
                '--verbosity',
                'quiet'
            ],
            { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        );
        if (result.status !== 0)
        {
            const detail = String(result.stderr || result.stdout || result.error?.message || '')
                .trim()
                .split(/\r?\n/u)
                .slice(-20)
                .join('\n');
            throw new Error(
                `canonical xUnit compile context build failed for ${project} (exit ${result.status ?? 'spawn'}): ${detail}`
            );
        }
    }
}

export function parseInventoryArguments(argv)
{
    const options = { check: false, out: path.join(root, DEFAULT_ARTIFACT_PATH), configuration: 'Debug', help: false };
    let configurationSeen = false;
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--check')
        {
            options.check = true;
        }
        else if (arg === '--configuration')
        {
            if (configurationSeen)
            {
                throw new Error('duplicate --configuration argument');
            }
            configurationSeen = true;
            options.configuration = requireXunitConfiguration(argv[index + 1] ?? '');
            index += 1;
        }
        else if (arg === '--out')
        {
            options.out = path.resolve(root, argv[index + 1] ?? '');
            index += 1;
        }
        else if (arg === '--help' || arg === '-h')
        {
            options.help = true;
        }
        else
        {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}

function writeArtifact(artifact, out)
{
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(JSON.parse(canonicalStringify(artifact)), null, 2)}\n`);
}

function run()
{
    const options = parseInventoryArguments(process.argv.slice(2));
    if (options.help)
    {
        console.log('Usage: node tools/test-inventory/produce.mjs [--check] [--out <path>] [--configuration Debug|Release]');
        return;
    }
    prepareXunitCompileContext(options.configuration);
    const artifact = discoverTestInventory(root, { configuration: options.configuration });
    validateInventoryArtifact(artifact);

    if (options.check)
    {
        if (!existsSync(options.out))
        {
            throw new Error(`test inventory artifact missing at ${options.out}; run node tools/test-inventory/produce.mjs`);
        }
        const stored = JSON.parse(readFileSync(options.out, 'utf8'));
        validateInventoryArtifact(stored);
        const stale = isInventoryStale(root, stored, { configuration: options.configuration });
        if (stale.stale)
        {
            throw new Error(`test inventory --check failed: ${stale.reason}`);
        }
        const storedBytes = readFileSync(options.out, 'utf8');
        const expectedBytes = `${JSON.stringify(JSON.parse(canonicalStringify(artifact)), null, 2)}\n`;
        if (storedBytes !== expectedBytes)
        {
            throw new Error('test inventory --check failed: artifact bytes differ from canonical output; rerun the producer');
        }
        console.log(`[test-inventory] ok files=${artifact.sourceFiles.length} cases=${artifact.testCases.length} digest=${artifact.inventoryDigest}`);
        return;
    }

    writeArtifact(artifact, options.out);
    console.log(`[test-inventory] wrote ${options.out} files=${artifact.sourceFiles.length} cases=${artifact.testCases.length} digest=${artifact.inventoryDigest}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        run();
    }
    catch (error)
    {
        console.error(`[test-inventory] ${error.message}`);
        process.exit(1);
    }
}
