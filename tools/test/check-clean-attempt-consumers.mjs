#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {readCleanAttemptConsumerInventory} = await import(new URL('../release/browser-release-clean-attempt-consumers.mjs', import.meta.url));
const {readSemanticOutcomeConsumerInventory} = await import(new URL('../release/semantic-outcome-clean-attempt-consumers.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adapters = [
    'tools/release/browser-release-clean-attempt-consumers.mjs',
    'tools/release/release-clean-attempt-cohort.mjs',
    'tools/release/semantic-outcome-clean-attempt-consumers.mjs'
];
const cohortCli = 'tools/release/release-clean-attempt-cohort-cli.mjs';
const releaseCollector = 'tools/operations/collect-release-evidence.sh';

try
{
    const direct = readCleanAttemptConsumerInventory();
    const semantic = readSemanticOutcomeConsumerInventory();
    for (const relative of adapters)
    {
        const source = fs.readFileSync(path.join(root, relative), 'utf8');
        const calls = [...source.matchAll(/cleanFirstAttemptVerdict\s*\(/gu)].length;
        if (calls !== 1
            || !source.includes("from './clean-first-attempt-verifier.mjs'"))
        {
            throw new Error(`${relative} must call the unified verifier exactly once`);
        }
    }
    for (const consumer of direct.consumers)
    {
        for (const entrypoint of consumer.entrypoints)
        {
            const source = fs.readFileSync(path.join(root, entrypoint), 'utf8');
            if (!/requireCleanAttemptConsumerAdmission\s*\(/u.test(source))
            {
                throw new Error(`${entrypoint} must call requireCleanAttemptConsumerAdmission`);
            }
        }
    }
    const cohortCliSource = fs.readFileSync(path.join(root, cohortCli), 'utf8');
    const collectorSource = fs.readFileSync(path.join(root, releaseCollector), 'utf8');
    if (!/admitCleanAttemptCohort\s*\(/u.test(cohortCliSource)
        || !collectorSource.includes('release-clean-attempt-cohort-cli.mjs')
        || !collectorSource.includes('FSUSBLOG_RELEASE_CLEAN_ATTEMPT_COHORT_INPUT'))
    {
        throw new Error('release collector must fail closed through the clean-attempt cohort adapter');
    }
    const semanticSource = fs.readFileSync(path.join(root, adapters[2]), 'utf8');
    if (/child_process|readdirSync|statSync|from\s+['"][^'"]*(?:immutable-build|release-projection|release-finalizer)-adapter/u.test(semanticSource))
    {
        throw new Error('semantic outcome consumers must not execute producers or parse raw domains');
    }
    process.stdout.write(`${JSON.stringify({
        schema: 'fsusblog.clean-attempt-consumer-governance.v1',
        directConsumers: direct.consumers.length,
        semanticConsumers: semantic.consumers.length,
        cohortSlots: 3,
        migrationState: 'migrated',
        qualificationEligible: true
    }, null, 2)}\n`);
}
catch (error)
{
    process.stderr.write(`[clean-attempt-consumers] ${error.message}\n`);
    process.exitCode = 1;
}
