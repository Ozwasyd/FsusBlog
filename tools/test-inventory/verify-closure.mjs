#!/usr/bin/env node
/**
 * Independent filesystem/matrix closure verifier for the test inventory.
 *
 * Re-walks the repository surfaces and matrix/coverage/requirement
 * projections instead of trusting the artifact, then compares the observed
 * surface with the canonical inventory. Missing files, unrecorded surfaces,
 * duplicate adapter ownership, cross-adapter duplicate test IDs and stale
 * source digests all fail closed.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from '../test-matrix/parse-matrix.mjs';

import { classifyFile } from './adapters.mjs';
import { DEFAULT_ARTIFACT_PATH, loadCanonicalInventory } from './api.mjs';
import { DIRECTORY_CLOSURE, TOOLS_DIRECTORY_CLOSURE } from './discovery.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

const WALK_IGNORE_DIRS = new Set([
    'bin',
    'obj',
    'node_modules',
    'coverage',
    'test-results',
    'TestResults',
    'playwright-report',
    'dist',
    '.tmp',
    '.artifacts'
]);

const EXECUTABLE_EXTENSIONS = new Set([
    '.sh',
    '.mjs',
    '.js',
    '.cjs',
    '.mts',
    '.ts',
    '.ps1'
]);

function walkFiles(directory, relativeDirectory, results = new Set())
{
    const absolute = path.join(directory, relativeDirectory);
    if (!existsSync(absolute))
    {
        return results;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true }))
    {
        const relative = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory())
        {
            if (WALK_IGNORE_DIRS.has(entry.name))
            {
                continue;
            }
            walkFiles(directory, relative, results);
        }
        else if (entry.isFile())
        {
            results.add(relative);
        }
    }
    return results;
}

function commandReferencedFiles(command)
{
    const refs = [];
    for (const token of String(command ?? '').split(/\s+/))
    {
        const normalized = token.replace(/^['"]|['"]$/g, '').replace(/\\$/, '').replace(/^\.\//, '');
        if (!/^(tools|tests)\//u.test(normalized))
        {
            continue;
        }
        if (existsSync(path.join(root, normalized)))
        {
            refs.push(normalized);
        }
    }
    return refs;
}

function addProjectedPath(files, relative)
{
    const absolute = path.join(root, relative);
    if (!existsSync(absolute))
    {
        return;
    }
    if (statSync(absolute).isDirectory())
    {
        for (const file of walkFiles(root, relative))
        {
            files.add(file);
        }
        return;
    }
    if (statSync(absolute).isFile())
    {
        files.add(relative);
    }
}

function projectedFiles()
{
    const files = new Set();
    const matrix = parseMatrix(readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const coverageRegistry = JSON.parse(readFileSync(path.join(root, 'tests/coverage-registry.json'), 'utf8'));
    const requirementCatalog = JSON.parse(
        readFileSync(path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'), 'utf8')
    );
    for (const tier of matrix.tiers ?? [])
    {
        for (const file of commandReferencedFiles(tier.command))
        {
            addProjectedPath(files, file);
        }
        for (const value of [...(tier.evidence ?? []), ...(tier.artifacts ?? [])])
        {
            if (typeof value !== 'string' || value.startsWith('.tmp/') || value.includes('*'))
            {
                continue;
            }
            if (/^(tools|tests)\//u.test(value))
            {
                addProjectedPath(files, value);
            }
        }
    }
    for (const entry of coverageRegistry.entries ?? [])
    {
        for (const value of entry.evidencePaths ?? [])
        {
            if (typeof value !== 'string' || value.startsWith('.tmp/') || value.includes('*'))
            {
                continue;
            }
            if (/^(tools|tests)\//u.test(value))
            {
                addProjectedPath(files, value);
            }
        }
    }
    for (const profile of requirementCatalog.profiles ?? [])
    {
        for (const file of commandReferencedFiles(profile.command))
        {
            addProjectedPath(files, file);
        }
        for (const value of profile.evidencePaths ?? [])
        {
            if (typeof value !== 'string' || value.startsWith('.tmp/') || value.includes('*'))
            {
                continue;
            }
            if (/^(tools|tests)\//u.test(value))
            {
                addProjectedPath(files, value);
            }
        }
    }
    return files;
}

function observedSurfaces()
{
    const files = new Set();
    for (const directory of DIRECTORY_CLOSURE)
    {
        for (const file of walkFiles(root, directory))
        {
            files.add(file);
        }
    }
    for (const directory of TOOLS_DIRECTORY_CLOSURE)
    {
        for (const file of walkFiles(root, directory))
        {
            if (directory === 'tools/security')
            {
                if (/\.mjs$/u.test(file) && /\/check-[^/]+$/u.test(file))
                {
                    files.add(file);
                }
            }
            else if (/\.(?:sh|mjs)$/u.test(file))
            {
                files.add(file);
            }
        }
    }
    if (existsSync(path.join(root, 'tools')))
    {
        for (const entry of readdirSync(path.join(root, 'tools'), { withFileTypes: true }))
        {
            const file = `tools/${entry.name}`;
            if (entry.isFile() && /^tools\/check-.*\.(?:mjs|sh)$/u.test(file))
            {
                files.add(file);
            }
        }
    }
    for (const file of [
        'tools/docs/generate-testing-docs.mjs',
        'tools/check-workflow-matrix-sync.mjs',
        'tools/run-test-matrix.mjs'
    ])
    {
        if (existsSync(path.join(root, file)))
        {
            files.add(file);
        }
    }
    for (const file of projectedFiles())
    {
        files.add(file);
    }
    return files;
}

function verify()
{
    const artifact = loadCanonicalInventory(root, { artifactPath: DEFAULT_ARTIFACT_PATH });
    const errors = [];
    const recorded = new Set(artifact.sourceFiles.map((file) => file.path));

    for (const file of artifact.sourceFiles)
    {
        const absolute = path.join(root, file.path);
        if (!existsSync(absolute))
        {
            errors.push(`inventory records missing source file: ${file.path}`);
            continue;
        }
        const source = readFileSync(absolute, 'utf8');
        const digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
        if (digest !== file.sourceDigest)
        {
            errors.push(`stale source digest for ${file.path}: stored ${file.sourceDigest}, current ${digest}`);
        }
    }

    for (const file of observedSurfaces())
    {
        if (!recorded.has(file))
        {
            errors.push(`test surface not recorded by canonical inventory: ${file}`);
        }
    }

    for (const file of observedSurfaces())
    {
        const absolute = path.join(root, file);
        const source = readFileSync(absolute, 'utf8');
        let classification;
        try
        {
            classification = classifyFile(file, source);
        }
        catch (error)
        {
            errors.push(`duplicate adapter ownership: ${error.message}`);
            continue;
        }
        if (classification === null)
        {
            const extension = path.extname(file).toLowerCase();
            if (EXECUTABLE_EXTENSIONS.has(extension))
            {
                errors.push(`unknown executable test surface without adapter record: ${file}`);
            }
            continue;
        }
        const recordedFile = artifact.sourceFiles.find((entry) => entry.path === file);
        if (recordedFile && recordedFile.adapter !== classification.adapter)
        {
            errors.push(`adapter drift for ${file}: inventory ${recordedFile.adapter}, filesystem ${classification.adapter}`);
        }
    }

    const caseIdOwners = new Map();
    for (const testCase of artifact.testCases ?? [])
    {
        const owner = `${testCase.ownerFile}@${testCase.adapter ?? 'unknown'}`;
        const previous = caseIdOwners.get(testCase.id);
        if (previous !== undefined && previous !== owner)
        {
            errors.push(`cross-adapter duplicate test id ${testCase.id}: ${previous} and ${owner}`);
        }
        caseIdOwners.set(testCase.id, owner);
    }

    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[test-inventory-verifier] ${error}`);
        }
        process.exit(1);
    }
    console.log(
        `[test-inventory-verifier] ok files=${artifact.sourceFiles.length} surfaces=${observedSurfaces().size} cases=${artifact.testCases.length}`
    );
}

verify();
