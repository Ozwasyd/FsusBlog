#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const { governanceContentDigest } = await import(new URL('../test/evidence-location-contract.mjs', import.meta.url));
const { parseYamlDocument } = await import(new URL('../yaml/parse-document.mjs', import.meta.url));

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const registryPath = path.join(root, 'tests/flaky.yml');
const summaryPath = path.join(path.resolve(process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
  ?? path.join(root, '.tmp/release-evidence')), 'flaky/registry.json');
const allowedModes = new Set(['retry-and-report', 'allow-failure-but-report', 'skip-with-evidence']);
const allowedClassifications = new Set(['known-flaky', 'unknown-flaky', 'infra-transient', 'benchmark-noise']);

function parseRegistry(text)
{
    const registry = parseYamlDocument(text, { source: 'tests/flaky.yml' });
    if (registry.entries == null)
    {
        registry.entries = [];
    }
    return registry;
}

function todayUtcDate()
{
    return new Date().toISOString().slice(0, 10);
}

function isIsoDate(value)
{
    return /^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''));
}

export function validateRegistry(registry, { releaseFinal = process.argv.includes('--release-final') } = {})
{
    const errors = [];
    if (registry.version !== 'fsusblog-flaky-v1')
    {
        errors.push(`version must be fsusblog-flaky-v1, got ${registry.version ?? 'missing'}`);
    }
    if (!Array.isArray(registry.entries))
    {
        errors.push('entries must be an array');
    }

    const ids = new Set();
    const today = todayUtcDate();
    for (const entry of registry.entries ?? [])
    {
        const id = entry.id ?? '<missing-id>';
        if (!entry.id || typeof entry.id !== 'string')
        {
            errors.push(`${id}: id is required`);
        }
        if (ids.has(entry.id))
        {
            errors.push(`${id}: duplicate id`);
        }
        ids.add(entry.id);
        for (const field of ['suite', 'test', 'issue', 'reason', 'expires', 'allowedRetries', 'owner', 'mode', 'classification'])
        {
            if (entry[field] === undefined || entry[field] === null || entry[field] === '')
            {
                errors.push(`${id}: ${field} is required`);
            }
        }
        if (!Number.isInteger(entry.issue) || entry.issue <= 0)
        {
            errors.push(`${id}: issue must be a positive integer`);
        }
        if (!Number.isInteger(entry.allowedRetries) || entry.allowedRetries < 0 || entry.allowedRetries > 1)
        {
            errors.push(`${id}: allowedRetries must be 0 or 1`);
        }
        if (!isIsoDate(entry.expires))
        {
            errors.push(`${id}: expires must use YYYY-MM-DD`);
        }
        else if (entry.expires < today)
        {
            errors.push(`${id}: expires ${entry.expires} is before ${today}`);
        }
        if (!allowedModes.has(entry.mode))
        {
            errors.push(`${id}: mode must be one of ${[...allowedModes].join(', ')}`);
        }
        if (!allowedClassifications.has(entry.classification))
        {
            errors.push(`${id}: classification must be one of ${[...allowedClassifications].join(', ')}`);
        }
        if (entry.mode === 'skip-with-evidence' && String(entry.reason).length < 12)
        {
            errors.push(`${id}: skip-with-evidence requires a specific reason`);
        }
        if (entry.linkedIssue !== undefined && (!Number.isInteger(entry.linkedIssue) || entry.linkedIssue <= 0))
        {
            errors.push(`${id}: linkedIssue must be a positive integer when present`);
        }
        if (entry.expiresAt !== undefined && !isIsoDate(entry.expiresAt))
        {
            errors.push(`${id}: expiresAt must use YYYY-MM-DD when present`);
        }
        if (entry.maxQuarantineDays !== undefined && (!Number.isInteger(entry.maxQuarantineDays) || entry.maxQuarantineDays < 1))
        {
            errors.push(`${id}: maxQuarantineDays must be a positive integer when present`);
        }
        if (releaseFinal)
        {
            const criticalSuite = /security|static|contract|migration|coverage|release/i.test(String(entry.suite ?? ''));
            if (criticalSuite && Number(entry.allowedRetries) > 0)
            {
                errors.push(`${id}: release-final forbids retry quarantine for critical suite ${entry.suite}`);
            }
            if (entry.releaseBlocker === true || criticalSuite)
            {
                errors.push(`${id}: release-final blocks critical flaky quarantine`);
            }
            if (entry.mode === 'skip-with-evidence')
            {
                errors.push(`${id}: release-final does not allow skip-with-evidence quarantine`);
            }
        }
    }
    return errors;
}

function writeSummary(status, registry, errors)
{
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, `${JSON.stringify({
        schema: 'fsusblog.ci.flaky-registry.v1',
        status,
        generatedAt: new Date().toISOString(),
        registry: 'tests/flaky.yml',
        entryCount: registry.entries?.length ?? 0,
        classifications: Object.fromEntries((registry.entries ?? []).map((entry) => [entry.id, entry.classification])),
        errors
    }, null, 2)}\n`);
}

function main()
{
    if (!fs.existsSync(registryPath))
    {
        throw new Error('missing tests/flaky.yml');
    }
    const registry = parseRegistry(fs.readFileSync(registryPath, 'utf8'));
    const errors = validateRegistry(registry);
    writeSummary(errors.length === 0 ? 'ok' : 'failed', registry, errors);
    if (errors.length > 0)
    {
        for (const error of errors)
        {
            console.error(`[flaky-registry] ${error}`);
        }
        process.exit(1);
    }
    console.log(`[flaky-registry] ok entries=${registry.entries.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        writeSummary('failed', { entries: [] }, [error.message]);
        console.error(`[flaky-registry] ${error.message}`);
        process.exit(1);
    }

}

export const requiredEvidenceVerifier = Object.freeze({
    version: 1, successStatuses: Object.freeze(['ok']),
    async describe(receipt)
    {
        const { describeOwnerReceipt } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        return { ...describeOwnerReceipt(receipt, {
            identity: { namespace: 'namespace', runId: 'runId', sourceCommit: 'sourceCommit', worktreeFingerprint: 'worktreeFingerprint' },
            status: 'status', contentDigest: 'contentDigest'
        }), contentDigest: governanceContentDigest(receipt) };
    },
    async verify({ receipt, repositoryRoot })
    {
        const { verifiedOwnerResult, requireOwnerChecks } = await import(new URL('../release/required-evidence-owner-contract.mjs', import.meta.url));
        const registry = parseRegistry(fs.readFileSync(path.join(repositoryRoot, 'tests/flaky.yml'), 'utf8'));
        requireOwnerChecks(validateRegistry(registry, { releaseFinal: true }));
        const classifications = Object.fromEntries((registry.entries ?? []).map((entry) => [entry.id, entry.classification]));
        if (receipt.registry !== 'tests/flaky.yml' || receipt.entryCount !== registry.entries.length
      || JSON.stringify(receipt.classifications) !== JSON.stringify(classifications)
      || !Array.isArray(receipt.errors) || receipt.errors.length !== 0)
        {
            throw new Error('flaky summary differs from current registry');
        }
        return verifiedOwnerResult({ entryCount: registry.entries.length, classifications });
    }
});
