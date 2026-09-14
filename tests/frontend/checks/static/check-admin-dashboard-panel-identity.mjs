#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const adminComponentsRoot = path.join(repoRoot, 'src/frontend/src/components/admin');
const forbiddenIdentityPattern = /\b(?:userName|userId)\b/g;
const failures = [];

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/');

const sourceFileExtensions = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.cjs']);

function collectSourceFiles(dir)
{
    return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
        {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory())
            {
                return collectSourceFiles(entryPath);
            }

            return entry.isFile() && sourceFileExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
        });
}

function lineOf(source, index)
{
    return source.slice(0, index).split(/\r?\n/).length;
}

for (const file of collectSourceFiles(adminComponentsRoot))
{
    const source = fs.readFileSync(file, 'utf8');
    forbiddenIdentityPattern.lastIndex = 0;

    for (const match of source.matchAll(forbiddenIdentityPattern))
    {
        failures.push(`${rel(file)}:${lineOf(source, match.index ?? 0)}: admin components must use accountId/displayName/anonymousCredentialId contracts instead of ${match[0]}`);
    }
}

if (failures.length > 0)
{
    console.error(failures.map((failure) => `[admin-dashboard-panel-identity] ${failure}`).join('\n'));
    process.exit(1);
}

console.log('[admin-dashboard-panel-identity] ok');
