#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { writeReleaseFinalExecutionAuthority } from './release-final-static-boundary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

if (process.argv.length !== 2)
{
    throw new Error('usage: node tools/test-matrix/generate-release-final-execution-authority.mjs');
}

writeReleaseFinalExecutionAuthority(root);
console.log('[release-final-execution-authority] wrote independently indexed authority');
