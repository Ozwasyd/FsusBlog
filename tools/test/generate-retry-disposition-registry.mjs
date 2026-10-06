#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { canonicalJson, readRetryPolicyRegistry, sealContentDigest } from './attempt-provenance.mjs';
import {
    assertUniquePriorRetryDispositionOwners,
    hiddenRetryScannerVersion,
    resolveReviewedRetryDispositions,
    retryDispositionRegistrySchema,
    scanHiddenRetries,
    sourceDigest,
    validateRetryDispositionRegistry
} from './hidden-retry-scanner.mjs';

const semanticKey = (entry) => [
    entry.producerId,
    entry.location.path,
    entry.ruleId,
    entry.syntaxDigest
].join('\0');

export function produceRetryDispositionRegistry(root, current, {
    reviewedSources = [],
    files = null,
    policyRegistry = readRetryPolicyRegistry()
} = {})
{
    if (files !== null)
    {
        throw new Error('full retry disposition registry producer refuses partial scan scope');
    }
    if (!Array.isArray(current?.entries))
    {
        throw new Error('retry disposition producer requires prior entries');
    }
    const priorByFindingId = new Map(current.entries.map((entry) => [entry.findingId, entry]));
    if (priorByFindingId.size !== current.entries.length)
    {
        throw new Error('retry disposition producer refuses duplicate prior finding identities');
    }
    assertUniquePriorRetryDispositionOwners(current.entries);
    const priorBySemanticKey = new Map();
    for (const entry of current.entries)
    {
        const key = semanticKey(entry);
        priorBySemanticKey.set(key, entry);
    }
    const scan = scanHiddenRetries(root, { files });
    const reviews = resolveReviewedRetryDispositions(root, scan.findings, {
        reviewedSources, priorEntries: current.entries
    });
    const reviewedFindingIds = new Set(reviews.map((review) => review.finding.findingId));
    const priorFor = (finding) => priorByFindingId.get(finding.findingId)
        ?? priorBySemanticKey.get(semanticKey(finding));
    const missing = scan.findings.filter((finding) => !priorFor(finding));
    if (missing.length > 0)
    {
        throw new Error(missing.map((finding) => (
            `new retry finding requires an explicit disposition: ${finding.ruleId} at `
            + `${finding.location.path}:${finding.location.start.line}:${finding.location.start.column}`
        )).join('\n'));
    }
    const entries = scan.findings.map((finding) =>
    {
        const prior = priorFor(finding);
        const digest = sourceDigest(path.join(root, finding.location.path));
        const exactFinding = ['findingId', 'producerId', 'ruleId', 'syntaxDigest']
            .every((field) => prior[field] === finding[field])
            && canonicalJson(prior.location) === canonicalJson(finding.location);
        if ((!exactFinding || prior.sourceDigest !== digest)
            && !reviewedFindingIds.has(finding.findingId))
        {
            throw new Error(`changed retry source or finding requires an exact raw source review: ${finding.location.path}`);
        }
        return {
            ...prior,
            findingId: finding.findingId,
            location: finding.location,
            sourceDigest: digest,
            syntaxDigest: finding.syntaxDigest
        };
    });
    const document = sealContentDigest({
        schema: retryDispositionRegistrySchema,
        scannerVersion: hiddenRetryScannerVersion,
        sourceDigestAlgorithm: 'sha256',
        entries
    });
    validateRetryDispositionRegistry(root, document, scan, policyRegistry, {
        reviewedSources,
        priorEntries: current.entries
    });
    return document;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const registryFile = path.join(root, 'config/testing/retry-disposition-registry.json');
    const current = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    const generated = `${JSON.stringify(produceRetryDispositionRegistry(root, current), null, 4)}\n`;
    if (process.argv.includes('--write'))
    {
        fs.writeFileSync(registryFile, generated);
    }
    else if (process.argv.includes('--check'))
    {
        if (fs.readFileSync(registryFile, 'utf8') !== generated)
        {
            process.stderr.write('config/testing/retry-disposition-registry.json is stale\n');
            process.exitCode = 1;
        }
    }
    else
    {
        process.stdout.write(generated);
    }
}
