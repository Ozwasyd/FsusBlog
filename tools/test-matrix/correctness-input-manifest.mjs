import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { inspectReleaseFinalCommandTarget } from './release-final-static-boundary.mjs';

const { digestValue } = await import(new URL('../release/browser-contract-receipt-contract.mjs', import.meta.url));

const pathFields = ['staticDependencyPaths', 'dynamicDeclaredInputs', 'toolchainInputs',
    'configurationInputs', 'localAliasInputs'];

function manifestDigest(manifest)
{
    const value = { ...manifest };
    delete value.closureDigest;
    return digestValue(value);
}

function relativeFile(root, value)
{
    if (typeof value !== 'string' || !value || value.includes('\\') || path.isAbsolute(value)
        || value.split('/').some((part) => !part || part === '.' || part === '..')
        || ['*', '?', '[', ']'].some((character) => value.includes(character)))
    {
        throw new Error(`contract.correctness-input-path-invalid: ${String(value)}`);
    }
    const file = path.resolve(root, value);
    for (let current = file; current !== path.resolve(root); current = path.dirname(current))
    {
        if (fs.lstatSync(current).isSymbolicLink())
        {
            throw new Error(`contract.correctness-input-symlink: ${value}`);
        }
    }
    if (!fs.lstatSync(file).isFile())
    {
        throw new Error(`contract.correctness-input-not-finite-file: ${value}`);
    }
    return value;
}

function fileDigest(root, value)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativeFile(root, value)))).digest('hex')}`;
}

function sortedFiles(root, values)
{
    if (!Array.isArray(values))
    {
        throw new Error('contract.correctness-input-declarations-must-be-array');
    }
    return [...new Set(values.map((value) => relativeFile(root, value)))].sort();
}

function inputPaths(manifest)
{
    return [...new Set([manifest.entryPath, ...pathFields.flatMap((field) => manifest[field])])].sort();
}

/** Bounded Node/Shell source closure, using the existing canonical AST inspector.
 * Dynamic declarations are additive finite paths. This is not a runtime trace collector,
 * general MSBuild evaluator, alias resolver, or an admitted release candidate producer.
 */
export function createCorrectnessInputManifest({ root, entryCommand, entryPath,
    dynamicDeclaredInputs = [], toolchainInputs = [], configurationInputs = [], localAliasInputs = [],
    supplementalInputs = [], generatedOutputPaths = [], unresolvedDynamicReads = [] })
{
    relativeFile(root, entryPath);
    if (typeof entryCommand !== 'string' || !entryCommand.trim()
        || !entryCommand.split(/\s+/u).map((word) => word.replace(/^['"]|['"]$/gu, '').replace(/^\.\//u, '')).includes(entryPath))
    {
        throw new Error('contract.correctness-entry-command-path-mismatch');
    }
    if (!/\.(?:mjs|cjs|js|ts|sh)$/u.test(entryPath))
    {
        throw new Error(`contract.correctness-input-language-unavailable: ${entryPath}`);
    }
    const inspection = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: entryPath });
    if (inspection.errors.length > 0)
    {
        throw new Error(`contract.correctness-input-closure-unresolved: ${inspection.errors.join('; ')}`);
    }
    if (!Array.isArray(unresolvedDynamicReads) || unresolvedDynamicReads.length > 0)
    {
        throw new Error('contract.correctness-input-unresolved-dynamic-read');
    }
    const manifest = {
        schema: 'fsusblog.correctness-input-manifest.v1', entryCommand, entryPath,
        staticDependencyPaths: sortedFiles(root, [...inspection.dependencyClosure.map((entry) => entry.path), ...supplementalInputs]),
        dynamicDeclaredInputs: sortedFiles(root, dynamicDeclaredInputs),
        toolchainInputs: sortedFiles(root, toolchainInputs),
        configurationInputs: sortedFiles(root, configurationInputs),
        localAliasInputs: sortedFiles(root, localAliasInputs), unresolvedDynamicReads: [],
        contentDigests: {}, closureDigest: null
    };
    if (!Array.isArray(generatedOutputPaths))
    {
        throw new Error('contract.correctness-generated-output-declarations-must-be-array');
    }
    for (const value of inputPaths(manifest))
    {
        if (/^(?:\.tmp|artifacts\/current-run)\//u.test(value)
            || generatedOutputPaths.some((output) => value === output || value.startsWith(`${output}/`)))
        {
            throw new Error(`contract.correctness-generated-output-in-inputs: ${value}`);
        }
        manifest.contentDigests[value] = fileDigest(root, value);
    }
    manifest.closureDigest = manifestDigest(manifest);
    return manifest;
}

export function validateCorrectnessInputManifest(manifest, { root, entryCommand } = {})
{
    if (manifest?.schema !== 'fsusblog.correctness-input-manifest.v1'
        || (entryCommand !== undefined && manifest.entryCommand !== entryCommand)
        || manifest.closureDigest !== manifestDigest(manifest)
        || !Array.isArray(manifest.unresolvedDynamicReads) || manifest.unresolvedDynamicReads.length > 0
        || pathFields.some((field) => !Array.isArray(manifest[field])
            || JSON.stringify(manifest[field]) !== JSON.stringify([...new Set(manifest[field])].sort())))
    {
        throw new Error('contract.correctness-input-manifest-invalid');
    }
    const paths = inputPaths(manifest);
    if (JSON.stringify(Object.keys(manifest.contentDigests).sort()) !== JSON.stringify(paths))
    {
        throw new Error('contract.correctness-input-digest-roster-mismatch');
    }
    if (root)
    {
        for (const value of paths)
        {
            if (fileDigest(root, value) !== manifest.contentDigests[value])
            {
                throw new Error(`contract.correctness-input-content-drift: ${value}`);
            }
        }
        const actual = createCorrectnessInputManifest({ root, entryCommand: manifest.entryCommand,
            entryPath: manifest.entryPath, dynamicDeclaredInputs: manifest.dynamicDeclaredInputs,
            toolchainInputs: manifest.toolchainInputs, configurationInputs: manifest.configurationInputs,
            localAliasInputs: manifest.localAliasInputs, supplementalInputs: manifest.staticDependencyPaths });
        if (actual.closureDigest !== manifest.closureDigest)
        {
            throw new Error('contract.correctness-input-static-closure-narrowed');
        }
    }
    return manifest;
}

/** Consume an owner-supplied complete trace; absence of a collector never becomes an empty successful trace. */
export function validateCorrectnessInputReadTrace({ manifest, trace, runId, targetTierId, targetAttemptId, root })
{
    validateCorrectnessInputManifest(manifest, { root });
    if (trace?.schema !== 'fsusblog.correctness-input-read-trace.v1' || trace.complete !== true
        || !runId || !targetTierId || !targetAttemptId
        || trace.runId !== runId || trace.targetTierId !== targetTierId || trace.targetAttemptId !== targetAttemptId
        || trace.manifestDigest !== manifest.closureDigest || !Array.isArray(trace.reads))
    {
        throw new Error('contract.correctness-input-read-trace-unavailable-or-mismatched');
    }
    const allowed = new Set(inputPaths(manifest));
    for (const read of trace.reads)
    {
        if (typeof read !== 'string' || !allowed.has(read))
        {
            throw new Error(`contract.correctness-undeclared-read: ${String(read)}`);
        }
    }
    return { schema: 'fsusblog.correctness-input-read-audit.v1', status: 'validated',
        runId, targetTierId, targetAttemptId, manifestDigest: manifest.closureDigest,
        traceDigest: digestValue(trace), qualificationEligible: false };
}
