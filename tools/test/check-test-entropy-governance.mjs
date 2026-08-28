#!/usr/bin/env node
import {
    existsSync,
    readFileSync,
    readdirSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ReplayContractError } from './execution-replay-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceExtension = /\.(?:c|cc|cjs|cpp|cs|cxx|js|mjs|ps1|sh|ts|tsx)$/u;
const excludedDirectories = new Set(['.git', '.tmp', 'artifacts', 'bin', 'dist', 'node_modules', 'obj']);
const excludedSources = new Set([
    'tools/test/check-test-entropy-governance.mjs'
]);

const entropyPatterns = Object.freeze([
    ['date-now', /\bDate\.now\s*\(\s*\)/gu],
    ['process-pid', /\bprocess\.pid\b/gu],
    ['environment-process-id', /\bEnvironment\.ProcessId\b/gu],
    ['shell-pid', /(?:\$\$|\$BASHPID\b)/gu],
    ['random-uuid', /\b(?:crypto\.)?randomUUID\s*\(/gu],
    ['guid-new-guid', /\bGuid\.NewGuid\s*\(/gu],
    ['os-random-bytes', /\b(?:crypto\.)?randomBytes\s*\(/gu],
    ['os-get-random-values', /\bcrypto\.getRandomValues\s*\(/gu],
    ['os-random-number-generator', /\bRandomNumberGenerator\.(?:Fill|GetBytes)\s*\(/gu],
    ['os-urandom', /(?:\/dev\/urandom|\bgetrandom\s*\()/gu],
    ['math-random', /\bMath\.random\s*\(\s*\)/gu]
]);

const determinismRole = /\b(?:root[_-]?seed|seed|random[_-]?stream|test[_-]?order|order[_-]?key|shard[_-]?key|shuffle|permutation|randomi[sz]e|sort[_-]?key)\b/iu;

function fail(reasonCode, message, details = {})
{
    throw new ReplayContractError(reasonCode, message, details);
}

function lineNumber(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function contextWindow(source, index, matchLength)
{
    const lines = source.split('\n');
    const line = lineNumber(source, index) - 1;
    const first = Math.max(0, line - 2);
    const last = Math.min(lines.length, line + 3);
    return {
        firstLine: first + 1,
        matchLine: line + 1,
        text: lines.slice(first, last).join('\n'),
        matchLength
    };
}

export function scanEntropyGovernanceSource(sourcePath, source)
{
    if (typeof source !== 'string')
    {
        fail('replay.entropy-governance-invalid', `${sourcePath} source must be text`);
    }
    const findings = [];
    for (const [api, pattern] of entropyPatterns)
    {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern))
        {
            const context = contextWindow(source, match.index, match[0].length);
            if (!determinismRole.test(context.text))
            {
                continue;
            }
            findings.push({
                path: sourcePath,
                line: context.matchLine,
                api,
                expression: match[0]
            });
        }
    }
    return findings.sort((left, right) =>
        left.line - right.line || left.api.localeCompare(right.api));
}

function correctnessCandidate(sourcePath, source)
{
    if (excludedSources.has(sourcePath) || /\.test\.[cm]?[jt]s$/u.test(sourcePath))
    {
        return false;
    }
    return /fixture-catalog:[ \t]+producer\b/u.test(source)
      || /executionClass\s*={1,3}\s*['"]correctness['"]/u.test(source)
      || /qualificationEligible/u.test(source)
      || /FSUSBLOG_(?:TEST_)?ROOT_SEED/u.test(source)
      || /testEnumerationOrder|randomStreams|deriveReplayStream/u.test(source);
}

export function discoverCorrectnessEntropySources({
    root = repositoryRoot,
    sourceOverrides = new Map()
} = {})
{
    const sources = new Map();
    const visit = (relative) =>
    {
        const absolute = path.join(root, relative);
        if (!existsSync(absolute))
        {
            return;
        }
        for (const entry of readdirSync(absolute, { withFileTypes: true }))
        {
            const child = path.posix.join(relative, entry.name);
            if (entry.isDirectory())
            {
                if (!excludedDirectories.has(entry.name))
                {
                    visit(child);
                }
                continue;
            }
            if (!sourceExtension.test(entry.name))
            {
                continue;
            }
            const source = sourceOverrides.get(child) ?? readFileSync(path.join(root, child), 'utf8');
            if (correctnessCandidate(child, source))
            {
                sources.set(child, source);
            }
        }
    };
    for (const scanRoot of ['src', 'tests', 'tools'])
    {
        visit(scanRoot);
    }
    for (const [sourcePath, source] of sourceOverrides)
    {
        if (correctnessCandidate(sourcePath, source))
        {
            sources.set(sourcePath, source);
        }
    }
    return sources;
}

export function validateTestEntropyGovernance(sources)
{
    if (!(sources instanceof Map))
    {
        fail('replay.entropy-governance-invalid', 'entropy governance sources must be a Map');
    }
    const findings = [...sources]
        .flatMap(([sourcePath, source]) => scanEntropyGovernanceSource(sourcePath, source));
    if (findings.length > 0)
    {
        fail(
            'replay.entropy-unrecorded',
            'correctness seed/order code consumes runtime or OS entropy outside the replay contract',
            { findings }
        );
    }
    return Object.freeze({
        sourceCount: sources.size,
        findingCount: 0
    });
}

export function verifyRepositoryTestEntropyGovernance(options = {})
{
    return validateTestEntropyGovernance(discoverCorrectnessEntropySources(options));
}

function main(argv)
{
    if (argv.length === 0)
    {
        const result = verifyRepositoryTestEntropyGovernance();
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    const sources = new Map(argv.map((candidate) =>
    {
        const absolute = path.resolve(repositoryRoot, candidate);
        const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/');
        if (relative.startsWith('../') || path.isAbsolute(relative))
        {
            fail('replay.entropy-governance-invalid', `source escapes repository: ${candidate}`);
        }
        return [relative, readFileSync(absolute, 'utf8')];
    }));
    const result = validateTestEntropyGovernance(sources);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
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
