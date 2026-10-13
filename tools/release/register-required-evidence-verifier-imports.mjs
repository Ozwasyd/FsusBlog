#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createDomainVerifierImportClosure } from './required-evidence-verifier-registry.mjs';

export function registerRequiredEvidenceVerifierImports({ repositoryRoot, write = false })
{
    const file = path.join(repositoryRoot, 'config/testing/release-final-execution-authority-index.json');
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(repositoryRoot,
        'config/testing/required-evidence-authority-ledger.json'), 'utf8'));
    const expected = createDomainVerifierImportClosure({ catalog, repositoryRoot });
    const existing = index.runtimeDynamicImports.filter((entry) => entry.owner === expected.owner);
    if (!write)
    {
        if (existing.length !== 1 || JSON.stringify(existing[0]) !== JSON.stringify(expected))
        {
            throw new Error('required owner import closure is missing, duplicated or differs from the canonical catalog/source');
        }
        return expected;
    }
    const entries = index.runtimeDynamicImports.filter((entry) => entry.owner !== expected.owner);
    entries.push(expected);
    index.runtimeDynamicImports = entries;
    fs.writeFileSync(file, `${JSON.stringify(index, null, 4)}\n`);
    return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const mode = process.argv[2] ?? '--check';
    if (!['--check', '--write'].includes(mode) || process.argv.length > 3)
    {
        throw new Error('usage: register-required-evidence-verifier-imports.mjs [--check|--write]');
    }
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const entry = registerRequiredEvidenceVerifierImports({ repositoryRoot, write: mode === '--write' });
    console.log(`[required-evidence-verifier-imports] dependencies=${entry.dependencies.length} mode=${mode}`);
}
