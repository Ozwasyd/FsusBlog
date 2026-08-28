#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readRetryPolicyRegistry } from './attempt-provenance.mjs';
import {
    scanHiddenRetries,
    validateRetryDispositionRegistry
} from './hidden-retry-scanner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryFile = path.join(root, 'config/testing/retry-disposition-registry.json');

try
{
    const scan = scanHiddenRetries(root);
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    validateRetryDispositionRegistry(root, registry, scan, readRetryPolicyRegistry());
    process.stdout.write(`${JSON.stringify({
        schema: scan.schema,
        scannerVersion: scan.scannerVersion,
        findingCount: scan.findings.length,
        contentDigest: scan.contentDigest,
        warnings: 0
    }, null, 2)}\n`);
}
catch (error)
{
    process.stderr.write(`[hidden-retry] ${error.message}\n`);
    process.exitCode = 1;
}
