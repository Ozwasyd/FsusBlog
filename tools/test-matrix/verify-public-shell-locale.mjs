#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    compactPublicShellLocaleScene,
    publicShellLocaleIdentity,
    publicShellLocaleCoverage,
    validatePublicShellLocaleSubResults
} from './public-shell-locale-evidence.mjs';
import {
    gateDigest,
    loadPublicShellLocaleGate,
    publicShellLocaleQualificationSchema,
    resolveGatePath,
    verifyPublicShellLocaleBuild
} from './public-shell-locale-gate.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultReceipt = '.tmp/browser-evidence/public-shell-locale.json';

function parseArgs(argv)
{
    const options = {};
    const positional = [];
    for (let index = 0; index < argv.length; index += 1)
    {
        const argument = argv[index];
        if (!argument.startsWith('--'))
        {
            positional.push(argument);
            continue;
        }
        const key = argument.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith('--'))
        {
            throw new Error(`missing value for --${key}`);
        }
        options[key] = value;
        index += 1;
    }
    if (positional.length > 1)
    {
        throw new Error('verifier accepts one qualification receipt');
    }
    options.receipt = positional[0] ?? null;
    return options;
}

function relative(root, absolute)
{
    return `./${path.relative(root, absolute).replaceAll(path.sep, '/')}`;
}

function withoutDigest(value)
{
    const { contentDigest: _ignored, ...body } = value;
    return body;
}

export async function verifyPublicShellLocaleQualification({
    root = defaultRoot,
    receiptFile = null,
    buildReceiptFile = null,
    inputFile = null
} = {})
{
    root = path.resolve(root);
    const errors = [];
    let receipt = null;
    try
    {
        const gate = await loadPublicShellLocaleGate({ root, buildReceiptFile });
        const resolvedReceipt = receiptFile
            ? resolveGatePath(root, receiptFile, 'qualification receipt')
            : resolveGatePath(root, defaultReceipt, 'qualification receipt');
        receipt = JSON.parse(await readFile(resolvedReceipt, 'utf8'));
        if (receipt.schema !== publicShellLocaleQualificationSchema)
        {
            errors.push(`qualification receipt schema mismatch: ${receipt.schema ?? '<missing>'}`);
            return { ok: false, errors, receipt };
        }
        if (receipt.status !== 'success' || receipt.qualificationEligible !== true || receipt.evidenceKind !== 'verified')
        {
            errors.push('qualification receipt is not a verified success');
        }
        if (receipt.producer?.browserSpawnCount !== 0 || receipt.producer?.subMatrixSpawnCount !== 0)
        {
            errors.push('aggregate receipt reports browser or sub-matrix spawning');
        }
        if (receipt.verifier?.independent !== true
            || receipt.verifier?.browserSpawnCount !== 0
            || receipt.verifier?.subMatrixSpawnCount !== 0)
        {
            errors.push('verifier receipt is not independent and browser-free');
        }
        const build = verifyPublicShellLocaleBuild(gate);
        if (receipt.build?.receiptPath !== relative(root, gate.receiptFile))
        {
            errors.push('qualification receipt build path is not the configured current build');
        }
        if (receipt.build?.digest !== build.digest)
        {
            errors.push('qualification receipt build digest mismatch');
        }
        if (JSON.stringify(receipt.build?.domains ?? []) !== JSON.stringify(build.domains))
        {
            errors.push('qualification receipt build domain set mismatch');
        }
        const configuredInput = gate.config.subResults.inputPath ?? '.tmp/browser-evidence/public-shell-locale-sub-results.json';
        const expectedInputFile = inputFile
            ? resolveGatePath(root, inputFile, 'sub-results')
            : resolveGatePath(root, configuredInput, 'sub-results');
        const inputPath = receipt.input?.path;
        if (inputPath !== relative(root, expectedInputFile))
        {
            errors.push('qualification receipt input path is not the configured current sub-result input');
        }
        const resolvedInput = expectedInputFile;
        const input = JSON.parse(await readFile(resolvedInput, 'utf8'));
        const canonicalInput = {
            ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'results')),
            results: [...(input.results ?? [])].sort((left, right) => String(left?.scene?.id ?? '').localeCompare(String(right?.scene?.id ?? '')))
        };
        const inputDigest = gateDigest(canonicalInput);
        if (receipt.input?.digest !== inputDigest)
        {
            errors.push('qualification receipt input digest mismatch');
        }
        const validated = validatePublicShellLocaleSubResults({
            matrix: gate.matrix,
            results: input.results,
            buildDigest: build.digest
        });
        if (receipt.input?.sceneCount !== validated.orderedResults.length)
        {
            errors.push('qualification receipt input scene count mismatch');
        }
        const expectedIdentity = publicShellLocaleIdentity(gate.matrix, build.digest, validated.identity);
        if (JSON.stringify(receipt.identity) !== JSON.stringify(expectedIdentity))
        {
            errors.push('qualification receipt identity closure mismatch');
        }
        if (JSON.stringify(receipt.matrix) !== JSON.stringify({
            schema: gate.matrix.schema,
            digest: gate.matrix.contentDigest,
            sourceCommit: gate.matrix.identity.sourceCommit,
            sceneCount: gate.matrix.scenes.length,
            locales: gate.matrix.locales.map((locale) => locale.code),
            issueCounts: Object.fromEntries([...new Set(gate.matrix.scenes.map((scene) => scene.issue))].sort((left, right) => left - right)
                .map((issue) => [String(issue), gate.matrix.scenes.filter((scene) => scene.issue === issue).length]))
        }))
        {
            errors.push('qualification receipt matrix summary mismatch');
        }
        if (JSON.stringify(receipt.coverage) !== JSON.stringify(publicShellLocaleCoverage(gate.matrix)))
        {
            errors.push('qualification receipt coverage mismatch');
        }
        const expectedScenes = validated.orderedResults.map(compactPublicShellLocaleScene);
        if (JSON.stringify(receipt.scenes) !== JSON.stringify(expectedScenes))
        {
            errors.push('qualification receipt scene evidence mismatch');
        }
        if (!Array.isArray(receipt.errors) || receipt.errors.length !== 0
            || !Array.isArray(receipt.warnings) || receipt.warnings.length !== 0
            || !Array.isArray(receipt.notObserved) || receipt.notObserved.length !== 0
            || receipt.firstFailure !== null)
        {
            errors.push('qualification receipt contains errors, warnings, not-observed evidence, or a first failure');
        }
        if (receipt.contentDigest !== gateDigest(withoutDigest(receipt)))
        {
            errors.push('qualification receipt content digest mismatch');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    return { ok: errors.length === 0, errors, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2));
        if (options.help)
        {
            process.stdout.write('node tools/test-matrix/verify-public-shell-locale.mjs <receipt> [--root <repo>] [--input <sub-results>] [--build-receipt <receipt>]\n');
        }
        else
        {
            const result = await verifyPublicShellLocaleQualification({
                root: options.root ?? defaultRoot,
                receiptFile: options.receipt,
                buildReceiptFile: options['build-receipt'] ?? null,
                inputFile: options.input ?? null
            });
            if (!result.ok)
            {
                throw new Error(result.errors.join('; '));
            }
            process.stdout.write(JSON.stringify({ status: 'success', receipt: options.receipt ?? defaultReceipt }) + '\n');
        }
    }
    catch (error)
    {
        process.stderr.write(`[public-shell-locale-verify] ${error.message}\n`);
        process.exitCode = 1;
    }
}
