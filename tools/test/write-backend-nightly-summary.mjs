#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dependencies = [
    ['backend-property', '.tmp/backend-property/summary.json'],
    ['backend-golden', '.tmp/backend-golden/summary.json'],
    ['backend-concurrency', '.tmp/backend-concurrency/summary.json'],
    ['backend-auth-state-machine', '.tmp/backend-auth-state-machine/summary.json'],
    ['backend-api-integration', '.tmp/backend-api-integration/summary.json'],
    ['backend-perf', '.tmp/backend-perf/summary.json'],
    ['backend-test-governance', '.tmp/backend-test-governance'],
    ['backend-mutation', '.tmp/mutation/backend']
];

const missing = dependencies.filter(([, relative]) => !fs.existsSync(path.join(root, relative)));
if (missing.length > 0)
{
    throw new Error(`backend-nightly dependencies are incomplete: ${missing.map(([id, relative]) => `${id}=${relative}`).join(', ')}`);
}

const outputDirectory = path.join(root, '.tmp/backend-nightly');
fs.mkdirSync(outputDirectory, { recursive: true });
const summary = {
    schema: 'fsusblog.backend-nightly-join.v1',
    status: 'success',
    runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
    dependencies: dependencies.map(([id, relative]) => ({ id, evidence: relative })),
    generatedAt: new Date().toISOString()
};
fs.writeFileSync(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[backend-nightly] joined ${dependencies.length} scheduler dependencies`);
