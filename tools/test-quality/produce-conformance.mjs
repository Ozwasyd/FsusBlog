#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runConformanceCorpus } from './conformance.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const output = path.resolve(root, process.argv[2] ?? '.tmp/release-evidence/test-quality-conformance.json');

try
{
    if (existsSync(output))
    {
        throw new Error(`conformance artifact already exists and cannot be retry-overwritten: ${path.relative(root, output)}`);
    }
    const conformance = runConformanceCorpus(root);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(conformance, null, 2)}\n`, { flag: 'wx' });
    console.log(`[test-quality-conformance] wrote cases=${conformance.cases.length} mutations=${conformance.killedMutations.length} digest=${conformance.contentDigest}`);
}
catch (error)
{
    console.error(`[test-quality-conformance] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
