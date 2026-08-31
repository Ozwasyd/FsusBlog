#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { loadCanonicalInventory } from '../test-inventory/api.mjs';

import { buildOracleFacts } from './oracle-facts.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const output = path.resolve(root, process.argv[2] ?? '.tmp/release-evidence/test-oracle-facts.json');

try
{
    if (existsSync(output))
    {
        throw new Error(`oracle facts artifact already exists and cannot be retry-overwritten: ${path.relative(root, output)}`);
    }
    const inventory = loadCanonicalInventory(root, { requireArtifact: true, runAdapters: false });
    const facts = buildOracleFacts(inventory, { root });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(facts, null, 2)}\n`, { flag: 'wx' });
    console.log(`[test-oracle-facts] wrote cases=${facts.cases.length} digest=${facts.contentDigest}`);
}
catch (error)
{
    console.error(`[test-oracle-facts] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
