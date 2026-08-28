#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    generateReleaseReliabilitySchedulerMatrix,
    loadReleaseReliabilityCatalog,
    validateReleaseReliabilitySchedulerCatalog
} from './release-reliability-scheduler-projection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrixPath = path.join(root, 'tests/matrix.yml');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode) || process.argv.length > 3)
{
    throw new Error('usage: generate-release-reliability-scheduler-projection.mjs [--check|--write]');
}
const catalog = loadReleaseReliabilityCatalog({ root });
const errors = validateReleaseReliabilitySchedulerCatalog(catalog);
if (errors.length > 0)
{
    throw new Error(`invalid release reliability scheduler catalog:\n- ${errors.join('\n- ')}`);
}
const current = fs.readFileSync(matrixPath, 'utf8');
const generated = generateReleaseReliabilitySchedulerMatrix(current, catalog);
if (mode === '--write')
{
    fs.writeFileSync(matrixPath, generated);
    console.log('[release-reliability-scheduler] wrote tests/matrix.yml');
}
else if (current !== generated)
{
    throw new Error(
        'tests/matrix.yml release reliability scheduler projection is stale; run with --write'
    );
}
else
{
    console.log('[release-reliability-scheduler] matrix projection is current');
}
