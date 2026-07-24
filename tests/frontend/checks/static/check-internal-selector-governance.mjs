#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    expandInternalSelectorRegistryEntries,
    scanInternalSelectors,
    validateInternalSelectorMigrationEvidence,
    validateInternalSelectorRegistry
} from './internal-selector-governance-lib.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const repoRoot = path.resolve(process.env.FSUSBLOG_INTERNAL_SELECTOR_ROOT ?? defaultRoot);
const registryPath = path.resolve(
    repoRoot,
    process.env.FSUSBLOG_INTERNAL_SELECTOR_REGISTRY
    ?? 'tests/frontend/internal-selector-registry.json'
);
const evidencePath = path.resolve(
    repoRoot,
    process.env.FSUSBLOG_INTERNAL_SELECTOR_EVIDENCE
    ?? 'tests/frontend/internal-selector-migration-evidence.json'
);
const sourceRoot = path.join(repoRoot, 'src/frontend/src');
const sourceExtensions = new Set(['.css', '.scss', '.vue']);

function collectFiles(directory, files = [])
{
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            collectFiles(absolutePath, files);
            continue;
        }
        if (!sourceExtensions.has(path.extname(entry.name)))
        {
            continue;
        }
        files.push({
            path: path.relative(repoRoot, absolutePath).replaceAll(path.sep, '/'),
            source: fs.readFileSync(absolutePath, 'utf8')
        });
    }
    return files;
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const findings = scanInternalSelectors(collectFiles(sourceRoot));
const today = process.env.FSUSBLOG_INTERNAL_SELECTOR_TODAY
  ?? new Date().toISOString().slice(0, 10);
const errors = [
    ...validateInternalSelectorRegistry({ findings, registry, today }),
    ...validateInternalSelectorMigrationEvidence({ evidence, registry })
];

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[internal-selector-governance] ${error}`);
    }
    process.exit(1);
}

const deepCount = findings.filter((finding) => finding.kind === 'deep').length;
const directElCount = findings.filter((finding) => finding.kind === 'direct-el').length;
console.log(
    `[internal-selector-governance] ok deep=${deepCount} directEl=${directElCount} registered=${expandInternalSelectorRegistryEntries(registry).length}`
);
