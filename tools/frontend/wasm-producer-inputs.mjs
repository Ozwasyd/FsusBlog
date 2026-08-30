#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const wasmProducerInputInventoryPath = 'ops/docker/wasm-producer-inputs.json';
const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fail(message)
{
    throw new Error(message);
}

function normalizeRelative(value, label)
{
    const normalized = String(value ?? '').replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..'))
    {
        fail(`${label} must be a repository-relative path: ${normalized || '<missing>'}`);
    }
    return normalized;
}

function readSource(repositoryRoot, relativePath, sourceOverrides)
{
    if (sourceOverrides.has(relativePath))
    {
        const override = sourceOverrides.get(relativePath);
        if (override === null)
        {
            fail(`WASM producer input is missing: ${relativePath}`);
        }
        return Buffer.isBuffer(override) ? override : Buffer.from(String(override));
    }
    const absolutePath = path.join(repositoryRoot, relativePath);
    let stat;
    try
    {
        stat = fs.lstatSync(absolutePath);
    }
    catch
    {
        fail(`WASM producer input is missing: ${relativePath}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        fail(`WASM producer input must be a regular non-symlink file: ${relativePath}`);
    }
    return fs.readFileSync(absolutePath);
}

function readJson(repositoryRoot, relativePath, sourceOverrides)
{
    try
    {
        return JSON.parse(readSource(repositoryRoot, relativePath, sourceOverrides).toString('utf8'));
    }
    catch (error)
    {
        fail(`${relativePath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function pointerValue(document, pointer)
{
    if (!/^\/(?:[^/]+)(?:\/[^/]+)*$/u.test(pointer))
    {
        fail(`WASM producer conditional input has invalid JSON pointer: ${pointer}`);
    }
    let value = document;
    for (const token of pointer.slice(1).split('/'))
    {
        value = value?.[token.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    return normalizeRelative(value, `WASM producer conditional input ${pointer}`);
}

function walkTree(repositoryRoot, input, sourceOverrides)
{
    const relativeRoot = input.path.replace(/\/$/u, '');
    const absoluteRoot = path.join(repositoryRoot, relativeRoot);
    let rootStat;
    try
    {
        rootStat = fs.lstatSync(absoluteRoot);
    }
    catch
    {
        fail(`WASM producer input tree is missing: ${input.path}`);
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    {
        fail(`WASM producer input tree must be a regular non-symlink directory: ${input.path}`);
    }
    const excluded = new Set(input.excludedTopLevelDirectories ?? []);
    const files = [];
    const visit = (absoluteDirectory) =>
    {
        for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true }))
        {
            const absolute = path.join(absoluteDirectory, entry.name);
            const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/');
            const rootChild = path.relative(absoluteRoot, absolute).split(path.sep)[0];
            if (excluded.has(rootChild))
            {
                continue;
            }
            if (entry.isSymbolicLink())
            {
                fail(`WASM producer input tree contains a symlink: ${relative}`);
            }
            if (entry.isDirectory())
            {
                visit(absolute);
            }
            else if (entry.isFile())
            {
                files.push(relative);
            }
        }
    };
    visit(absoluteRoot);
    for (const [relativePath, override] of sourceOverrides)
    {
        if (relativePath.startsWith(`${relativeRoot}/`) && override !== null
            && !excluded.has(relativePath.slice(relativeRoot.length + 1).split('/')[0])
            && !files.includes(relativePath))
        {
            files.push(relativePath);
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

export function loadWasmProducerInputInventory({
    repositoryRoot = defaultRepositoryRoot,
    sourceOverrides = new Map()
} = {})
{
    return readJson(path.resolve(repositoryRoot), wasmProducerInputInventoryPath, sourceOverrides);
}

export function resolveWasmProducerInputFiles({
    repositoryRoot = defaultRepositoryRoot,
    sourceOverrides = new Map(),
    productionZkEnabled = false
} = {})
{
    const root = path.resolve(repositoryRoot);
    const inventory = loadWasmProducerInputInventory({ repositoryRoot: root, sourceOverrides });
    const files = [];
    for (const input of inventory.inputs ?? [])
    {
        const inputPath = normalizeRelative(input.path, 'WASM producer input');
        if (input.kind === 'file')
        {
            readSource(root, inputPath, sourceOverrides);
            files.push(inputPath);
        }
        else if (input.kind === 'tree')
        {
            files.push(...walkTree(root, { ...input, path: inputPath }, sourceOverrides));
        }
        else
        {
            fail(`WASM producer input has unsupported kind: ${input.kind ?? '<missing>'}`);
        }
    }
    if (productionZkEnabled)
    {
        for (const conditional of inventory.productionZkConditionalInputs ?? [])
        {
            const manifestPath = normalizeRelative(conditional.manifest, 'WASM producer conditional manifest');
            const document = readJson(root, manifestPath, sourceOverrides);
            const resolved = pointerValue(document, conditional.jsonPointer);
            readSource(root, resolved, sourceOverrides);
            files.push(resolved);
        }
    }
    const unique = [...new Set(files)].sort((left, right) => left.localeCompare(right));
    if (unique.length !== files.length)
    {
        fail('WASM producer input inventory resolves duplicate files');
    }
    return unique;
}

export function computeWasmProducerInputDescriptor({
    repositoryRoot = defaultRepositoryRoot,
    sourceOverrides = new Map(),
    productionZkEnabled = false
} = {})
{
    const root = path.resolve(repositoryRoot);
    const files = resolveWasmProducerInputFiles({
        repositoryRoot: root,
        sourceOverrides,
        productionZkEnabled
    });
    const hash = createHash('sha256');
    for (const relativePath of files)
    {
        const contentHash = createHash('sha256')
            .update(readSource(root, relativePath, sourceOverrides))
            .digest('hex');
        hash.update(relativePath);
        hash.update('\0');
        hash.update(contentHash);
        hash.update('\0');
    }
    return {
        sourceHash: hash.digest('hex'),
        sourceFiles: files
    };
}
