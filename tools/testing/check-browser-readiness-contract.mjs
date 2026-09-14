#!/usr/bin/env node

import { readFile, glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const canonicalOwner = 'tests/frontend/support/playwright/readiness.mjs';
const correctnessPatterns = [
    'tests/browser-contract/**/*.mjs',
    'tests/frontend/support/playwright/*.{mjs,ts}',
    'tests/frontend/e2e/acceptance/**/*.{ts,mjs}',
    'tests/frontend/checks/runtime/**/*.mjs',
    'tests/frontend/checks/security/**/*.mjs',
    'tests/frontend/checks/resilience/**/*.mjs'
];

function findClosingParenthesis(source, openingIndex)
{
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let index = openingIndex; index < source.length; index += 1)
    {
        const character = source[index];
        const next = source[index + 1];
        if (lineComment)
        {
            if (character === '\n')
            {
                lineComment = false;
            }
            continue;
        }
        if (blockComment)
        {
            if (character === '*' && next === '/')
            {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote)
        {
            if (escaped)
            {
                escaped = false;
            }
            else if (character === '\\')
            {
                escaped = true;
            }
            else if (character === quote)
            {
                quote = null;
            }
            continue;
        }
        if (character === '/' && next === '/')
        {
            lineComment = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '*')
        {
            blockComment = true;
            index += 1;
            continue;
        }
        if (character === "'" || character === '"' || character === '`')
        {
            quote = character;
            continue;
        }
        if (character === '(')
        {
            depth += 1;
        }
        if (character === ')' && --depth === 0)
        {
            return index;
        }
    }
    return -1;
}

export function inspectBrowserReadinessSource(source, file)
{
    const violations = [];
    const lineForIndex = (index) => source.slice(0, index).split(/\r?\n/u).length;
    const collect = (pattern, message) =>
    {
        for (const match of source.matchAll(pattern))
        {
            violations.push({ index: match.index, diagnostic: `${file}:${lineForIndex(match.index)}: ${message}` });
        }
    };

    collect(
        /waitUntil\s*:\s*['"]networkidle['"]|waitForLoadState\s*\(\s*['"]networkidle['"]/gu,
        'networkidle is not a correctness readiness condition'
    );
    if (file !== canonicalOwner)
    {
        collect(
            /\.\s*waitForTimeout\s*\(/gu,
            'direct page.waitForTimeout is forbidden in correctness assets'
        );
    }
    for (const match of source.matchAll(/\bwaitFor(?:LoadState|Function|URL|Selector)\s*\(/gu))
    {
        const openingIndex = source.indexOf('(', match.index);
        const closingIndex = findClosingParenthesis(source, openingIndex);
        const silentlyIgnored = closingIndex >= 0
      && /^\s*\.catch\s*\(\s*\(\)\s*=>\s*(?:\{\s*\}|undefined)\s*\)/u
          .test(source.slice(closingIndex + 1));
        if (silentlyIgnored)
        {
            violations.push({
                index: match.index,
                diagnostic: `${file}:${lineForIndex(match.index)}: readiness timeout must not be silently ignored`
            });
        }
    }

    return violations
        .sort((left, right) => left.index - right.index)
        .map(({ diagnostic }) => diagnostic);
}

export function inspectMeasurementHelper(source)
{
    const requiredTokens = [
        'runBrowserMeasurementWindow',
        'purpose',
        'maxWindowMs',
        'evidenceClass',
        "'performance'",
        "'soak'",
        'page.waitForTimeout(maxWindowMs)'
    ];
    return requiredTokens
        .filter((token) => !source.includes(token))
        .map((token) => `${canonicalOwner}: approved measurement helper is missing ${token}`);
}

export async function checkBrowserReadinessContract(root = repoRoot)
{
    const violations = [];
    for (const pattern of correctnessPatterns)
    {
        for await (const relative of glob(pattern, { cwd: root }))
        {
            const source = await readFile(path.join(root, relative), 'utf8');
            violations.push(...inspectBrowserReadinessSource(source, relative));
        }
    }
    const ownerSource = await readFile(path.join(root, canonicalOwner), 'utf8');
    violations.push(...inspectMeasurementHelper(ownerSource));
    return violations;
}

async function main()
{
    const violations = await checkBrowserReadinessContract();
    if (violations.length > 0)
    {
        throw new Error(`browser readiness contract failed:\n${violations.join('\n')}`);
    }
    console.log('browser readiness contract passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    await main();
}
