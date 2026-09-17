#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TARGETS = [
    'src/frontend/src/components/public',
    'src/frontend/src/components/article',
    'src/frontend/src/layouts',
    'src/frontend/src/views/auth',
    'src/frontend/src/views/error'
];
const ALLOWED = [
    /src\/frontend\/src\/locales\//u,
    /<style[\s\S]*$/u,
    /<!--/u,
    /\/\//u
];

async function CollectFiles(relative)
{
    const absolute = path.join(ROOT, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    const files = [];
    for (const entry of entries)
    {
        const child = path.join(relative, entry.name);
        if (entry.isDirectory())
        {
            files.push(...await CollectFiles(child));
        }
        else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts'))
        {
            files.push(child);
        }
    }
    return files;
}

export async function FindHardcodedLocaleLiterals(targets = TARGETS)
{
    const files = (await Promise.all(targets.map(CollectFiles))).flat();
    const findings = [];
    for (const file of files)
    {
        if (ALLOWED[0].test(file))
        {
            continue;
        }
        const source = await readFile(path.join(ROOT, file), 'utf8');
        const lines = source.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1)
        {
            const line = lines[index];
            if (!/[\p{Script=Han}]{2,}/u.test(line) || ALLOWED.slice(1).some((rule) => rule.test(line)))
            {
                continue;
            }
            findings.push({ file, line: index + 1, text: line.trim().slice(0, 140) });
        }
    }
    return findings;
}

async function Main()
{
    const strict = process.argv.includes('--strict');
    const findings = await FindHardcodedLocaleLiterals();
    if (findings.length === 0)
    {
        console.log('[i18n-literals] ok');
        return;
    }

    console.warn(`[i18n-literals] warning: ${findings.length} possible untranslated literals`);
    for (const finding of findings.slice(0, 50))
    {
        console.warn(`${finding.file}:${finding.line} ${finding.text}`);
    }
    if (strict)
    {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    await Main();
}
