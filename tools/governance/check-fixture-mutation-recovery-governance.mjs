#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const authorityFiles = Object.freeze([
    'tools/test-fixtures/mutation-recovery/mutation-adapters.mjs',
    'tools/test-fixtures/mutation-recovery/runner.mjs',
    'tools/test-fixtures/mutation-recovery/semantic-snapshot.mjs'
]);

function read(root, relativePath)
{
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute))
    {
        throw new Error(`missing mutation recovery authority ${relativePath}`);
    }
    return fs.readFileSync(absolute, 'utf8');
}

function toolingSources(root)
{
    const result = [];
    function visit(directory)
    {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && entry.name.endsWith('.mjs')) result.push(fs.readFileSync(absolute, 'utf8'));
        }
    }
    visit(path.join(root, 'tools'));
    return result.join('\n');
}

export function checkFixtureMutationRecoveryGovernance(root = defaultRoot)
{
    const errors = [];
    const sources = Object.fromEntries(authorityFiles.map((file) => [file, read(root, file)]));
    const combined = Object.values(sources).join('\n');
    const allTooling = toolingSources(root);
    const exports = [
        ['runMutationRecovery', /export async function runMutationRecovery\s*\(/gu],
        ['applyFixtureMutation', /export async function applyFixtureMutation\s*\(/gu],
        ['verifyMutationRecoveryReceipt', /export function verifyMutationRecoveryReceipt\s*\(/gu],
        ['verifyMutationJournal', /export async function verifyMutationJournal\s*\(/gu],
        ['verifySemanticSnapshot', /export function verifySemanticSnapshot\s*\(/gu]
    ];
    for (const [name, pattern] of exports)
    {
        if ([...allTooling.matchAll(pattern)].length !== 1)
        {
            errors.push(`${name} must have exactly one canonical implementation`);
        }
    }
    const forbiddenImports = [
        "from 'node:child_process'",
        'from "node:child_process"'
    ];
    for (const token of forbiddenImports)
    {
        if (combined.includes(token)) errors.push(`mutation recovery authority forbids process execution: ${token}`);
    }
    const adapterSource = sources[authorityFiles[0]];
    const forbiddenAdapterPatterns = [
        [/\.query\s*\(/u, 'raw database query'],
        [/\.exec\s*\(/u, 'raw command execution'],
        [/\.scan\s*\(/iu, 'Redis wildcard scan'],
        [/\.flush(?:db|all)?\s*\(/iu, 'Redis/global cache flush'],
        [/\b(?:unlink|rm|rmdir)Sync\s*\(/u, 'unscoped filesystem removal'],
        [/\$\{[^}]+\}[^\n]*(?:SELECT|UPDATE|DELETE|INSERT)/iu, 'concatenated database statement']
    ];
    for (const [pattern, label] of forbiddenAdapterPatterns)
    {
        if (pattern.test(adapterSource)) errors.push(`mutation adapter contains forbidden ${label}`);
    }
    const runnerSource = sources[authorityFiles[1]];
    const forbiddenRunnerCalls = [
        [/\.cleanup\s*\(/u, 'cleanup'],
        [/\.restart\s*\(/u, 'restart'],
        [/\.reset\s*\(/u, 'reset'],
        [/\.flush\s*\(/u, 'cache flush'],
        [/\bspawn(?:Sync)?\s*\(/u, 'process spawn'],
        [/\bexec(?:File|Sync)?\s*\(/u, 'command execution']
    ];
    for (const [pattern, label] of forbiddenRunnerCalls)
    {
        if (pattern.test(runnerSource)) errors.push(`mutation recovery runner contains forbidden ${label} call`);
    }
    if (!runnerSource.includes("retryPolicy: 'none'")
      || !runnerSource.includes("recoveryMethod: 'same-sealed-profile-canonical-prepare'"))
    {
        errors.push('mutation recovery runner must seal no-retry and canonical same-profile recovery');
    }
    if (!adapterSource.includes('operationId: request.mutationKind')
      || !adapterSource.includes('targets: request.targets'))
    {
        errors.push('mutation adapter must pass only closed operation identity and resolved targets');
    }
    const snapshotSource = sources[authorityFiles[2]];
    if (!snapshotSource.includes('fieldDispositions')
      || !snapshotSource.includes("'secret-redacted'")
      || !snapshotSource.includes('semantic timestamp requires a #1730 semanticRole'))
    {
        errors.push('semantic snapshot must retain the closed field disposition and temporal authority');
    }
    if (/from ['"][^'"]*\/producers\//u.test(snapshotSource)
      || /(?:readdir|glob|latestSnapshot|expectedFixtureState)\s*\(/u.test(snapshotSource))
    {
        errors.push('semantic snapshot must observe current receipt state without producer copy, latest scan or expected-state derivation');
    }
    if (!snapshotSource.includes('semanticRecordDigest(record)')
      || !snapshotSource.includes('relationChanges')
      || !snapshotSource.includes('ttlChanges')
      || !snapshotSource.includes('byteChanges')
      || !snapshotSource.includes('projectionChanges'))
    {
        errors.push('semantic comparison must not degrade to row-count-only evidence');
    }
    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    let errors;
    try
    {
        errors = checkFixtureMutationRecoveryGovernance(defaultRoot);
    }
    catch (error)
    {
        errors = [error.message];
    }
    if (errors.length > 0)
    {
        for (const error of errors) console.error(`[fixture-mutation-recovery] ${error}`);
        process.exitCode = 1;
    }
    else
    {
        console.log('[fixture-mutation-recovery] governance passed');
    }
}
