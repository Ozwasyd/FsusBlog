#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourceRoot = join(repoRoot, 'src/frontend/src');
const adapterPath = 'src/frontend/src/performance/browserTaskScheduler.ts';
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.vue']);
const errors = [];

async function sourceFiles(directory)
{
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async entry =>
    {
        const path = join(directory, entry.name);
        if (entry.isDirectory())
        {
            return await sourceFiles(path);
        }
        return sourceExtensions.has(extname(entry.name)) ? [path] : [];
    }));
    return nested.flat();
}

for (const path of await sourceFiles(sourceRoot))
{
    const relativePath = relative(repoRoot, path).replaceAll('\\', '/');
    const source = await readFile(path, 'utf8');
    if (relativePath !== adapterPath && /(?:globalThis\s*\.\s*)?scheduler\s*\.\s*yield\s*\(/u.test(source))
    {
        errors.push(`${relativePath}: direct scheduler.yield() is forbidden; use browserTaskScheduler`);
    }
    if (relativePath !== adapterPath && source.includes('browserTaskScheduler'))
    {
        errors.push(`${relativePath}: production call sites require #1180 workload-specific evidence before enabling`);
    }
}

const adapter = await readFile(join(repoRoot, adapterPath), 'utf8');
for (const token of [
    'AbortSignal',
    "path: 'throttled'",
    "nativeFailure = 'rejected'",
    'fallbackYield',
    'minimumIntervalMs',
    'visibility: environment.visibility()'
])
{
    if (!adapter.includes(token))
    {
        errors.push(`${adapterPath}: missing governed adapter token ${token}`);
    }
}
if (/declare\s+global/u.test(adapter))
{
    errors.push(`${adapterPath}: scheduler capability must stay locally typed instead of expanding the ES2022 global lib`);
}

if (errors.length > 0)
{
    console.error(errors.join('\n'));
    process.exit(1);
}

console.log('ok: scheduler.yield is isolated behind the evidence-gated adapter with no production call sites');
