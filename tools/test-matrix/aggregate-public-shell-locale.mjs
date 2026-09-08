#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    createPublicShellLocaleFailure,
    createPublicShellLocaleQualification,
    validatePublicShellLocaleSubResults
} from './public-shell-locale-evidence.mjs';
import {
    gateDigest,
    loadPublicShellLocaleGate,
    resolveGatePath,
    publicShellLocaleSubResultsSchema,
    verifyPublicShellLocaleBuild
} from './public-shell-locale-gate.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultInput = '.tmp/browser-evidence/public-shell-locale-sub-results.json';

function parseArgs(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (!argument.startsWith('--'))
        {
            throw new Error(`unexpected argument: ${argument}`);
        }
        const key = argument.slice(2);
        if (key === 'help')
        {
            options.help = true;
            continue;
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--'))
        {
            throw new Error(`missing value for --${key}`);
        }
        options[key] = value;
        index += 1;
    }
    return options;
}

function usage()
{
    return 'node tools/test-matrix/aggregate-public-shell-locale.mjs [--root <repo>] [--input <sub-results>] [--out <receipt>] [--build-receipt <receipt>]';
}

function canonicalInput(value)
{
    const { results, ...metadata } = value;
    return {
        ...metadata,
        results: [...results].sort((left, right) => String(left?.scene?.id ?? '').localeCompare(String(right?.scene?.id ?? '')))
    };
}

async function writeJson(file, value)
{
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function aggregatePublicShellLocale({
    root = defaultRoot,
    inputFile = null,
    outputFile = null,
    buildReceiptFile = null
} = {})
{
    root = path.resolve(root);
    const gate = await loadPublicShellLocaleGate({ root, buildReceiptFile });
    const configuredInput = gate.config.subResults.inputPath ?? defaultInput;
    const inputPath = inputFile
        ? resolveGatePath(root, inputFile, 'sub-results')
        : resolveGatePath(root, configuredInput, 'sub-results');
    const configuredOutput = gate.config.output.path ?? '.tmp/browser-evidence/public-shell-locale.json';
    const outputPath = outputFile
        ? resolveGatePath(root, outputFile, 'qualification receipt')
        : resolveGatePath(root, configuredOutput, 'qualification receipt');
    const build = verifyPublicShellLocaleBuild(gate);
    let input;
    let results = [];
    try
    {
        input = JSON.parse(await readFile(inputPath, 'utf8'));
        results = Array.isArray(input?.results) ? input.results : [];
        if (input?.schema !== publicShellLocaleSubResultsSchema)
        {
            throw new Error(`sub-results schema mismatch: ${input?.schema ?? '<missing>'}`);
        }
        const digestInput = gateDigest(canonicalInput(input));
        const validated = validatePublicShellLocaleSubResults({
            matrix: gate.matrix,
            results,
            buildDigest: build.digest
        });
        const receipt = createPublicShellLocaleQualification({
            gate,
            build,
            inputPath,
            inputDigest: digestInput,
            identity: validated.identity,
            results: validated.orderedResults,
            verifierCommand: gate.config.commands.verify
        });
        await writeJson(outputPath, receipt);
        return receipt;
    }
    catch (error)
    {
        const receipt = createPublicShellLocaleFailure({
            gate,
            inputPath,
            inputDigest: input ? gateDigest(canonicalInput(input)) : null,
            results,
            error
        });
        await writeJson(outputPath, receipt);
        throw error;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        if (options.help)
        {
            process.stdout.write(`${usage()}\n`);
        }
        else
        {
            const receipt = await aggregatePublicShellLocale({
                root: options.root ?? defaultRoot,
                inputFile: options.input ?? null,
                outputFile: options.out ?? options.output ?? null,
                buildReceiptFile: options['build-receipt'] ?? null
            });
            process.stdout.write(`${JSON.stringify({ status: receipt.status, receipt: options.out ?? '.tmp/browser-evidence/public-shell-locale.json', sceneCount: receipt.matrix.sceneCount })}\n`);
        }
    }
    catch (error)
    {
        process.stderr.write(`[public-shell-locale-aggregate] ${error.message}\n`);
        process.exitCode = 1;
    }
}
