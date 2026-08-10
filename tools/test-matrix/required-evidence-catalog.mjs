#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateDispositionLedger } from './release-domain-ledger.mjs';
import {
    loadCanonicalReleaseFinalEvidenceInputs
} from './release-final-evidence-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const requiredEvidenceCatalogSchema = 'fsusblog.required-evidence-catalog.v1';
export const requiredEvidenceAuthorityLedgerSchema =
    'fsusblog.required-evidence-authority-ledger.v1';
export const canonicalRequiredEvidenceLedgerPath =
    'config/testing/required-evidence-authority-ledger.json';

export const exactnessValues = Object.freeze([
    'exact-one-authority',
    'test-id-exact',
    'artifact-set-exact',
    'process-boundary-exact',
    'diagnostic-only'
]);
const exactnessSet = new Set(exactnessValues);

// Closed allowlist: a required-evidence authority may only bind a receipt schema
// that a repository producer actually seals. Unsupported schemas fail closed.
export const supportedReceiptSchemas = Object.freeze([
    'fsusblog.behavior-evidence-pre-runtime-receipt.v1',
    'fsusblog.browser-contract-receipt.v2',
    'fsusblog.browser-diagnostics-release-assertions.v1',
    'fsusblog.browser-diagnostics-release-runtime-receipt.v1',
    'fsusblog.browserless-correctness-receipt.v1',
    'fsusblog.ci.flaky-registry.v1',
    'fsusblog.ci.job-result.v1',
    'fsusblog.evidence-projection-receipt.v1',
    'fsusblog.native-test-receipt.v1',
    'fsusblog.release-domain-assertion-report.v1',
    'fsusblog.release-final-test-evidence-binding.v1',
    'fsusblog.release-reliability-qualified-receipt.v3'
]);
const supportedReceiptSchemaSet = new Set(supportedReceiptSchemas);

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/+:-]*$/u;
const authorityIdPattern = /^[a-z][a-z0-9-]*$/u;
const bindingKeyPattern = /^[a-z0-9][a-z0-9_.-]*$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const verifierPattern = /^tools\/[A-Za-z0-9_./-]+(:[A-Za-z0-9_]+)?$/u;
const forbiddenLocatorTerms = ['mtime', 'latest', 'search', 'glob'];
const jobNameOwnerPattern = /\b(jobs?|ci-jobs?|github-actions)\b/iu;

export function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
}

export function entryContentDigest(entry)
{
    const content = { ...(entry ?? {}) };
    delete content.contentDigest;
    delete content.producerDigest;
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

export function producerContractDigest(entry)
{
    const contract = [
        entry?.canonicalOwner ?? '',
        entry?.localProducerCommand ?? '',
        entry?.receiptSchema ?? '',
        entry?.producerVerifier ?? ''
    ].join('\n');
    return `sha256:${crypto.createHash('sha256').update(contract).digest('hex')}`;
}

export function ledgerContentDigest(ledger)
{
    const content = { ...(ledger ?? {}) };
    delete content.contentDigest;
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

export function requiredEvidenceCatalogIdentity(ledgerPath)
{
    const absolute = path.resolve(root, ledgerPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    {
        throw new Error(`required evidence catalog ledger is missing: ${ledgerPath}`);
    }
    return `sha256:${crypto.createHash('sha256')
        .update(fs.readFileSync(absolute)).digest('hex')}`;
}

function sortedUnique(values, label, { allowEmpty = false } = {})
{
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0)
        || values.some((value) => typeof value !== 'string' || !value))
    {
        throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`);
    }
    if (new Set(values).size !== values.length
        || JSON.stringify(values) !== JSON.stringify([...values].sort()))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return values;
}

function validateEntry(entry, index, { canonicalInputs, dispositionByTier, root: repoRoot, checkVerifier })
{
    const label = `entries[${index}]`;
    const errors = [];
    const prefix = (field) => `${label}.${field}`;

    if (typeof entry?.authorityId !== 'string' || !authorityIdPattern.test(entry.authorityId))
    {
        errors.push(`${prefix('authorityId')} must be a stable lowercase authority ID`);
    }

    if (typeof entry?.canonicalOwner !== 'string' || !stableIdPattern.test(entry.canonicalOwner))
    {
        errors.push(`${prefix('canonicalOwner')} must be a stable owner ID`);
    }
    else if (jobNameOwnerPattern.test(entry.canonicalOwner)
        || entry.canonicalOwner.includes(':'))
    {
        errors.push(`${prefix('canonicalOwner')} must not be a job-name-only owner`);
    }

    if (typeof entry?.receiptSchema !== 'string'
        || !supportedReceiptSchemaSet.has(entry.receiptSchema))
    {
        errors.push(`${prefix('receiptSchema')} is unsupported: ${entry?.receiptSchema ?? 'missing'}`);
    }

    try
    {
        sortedUnique(entry?.producerTierIds, prefix('producerTierIds'));
    }
    catch (error)
    {
        errors.push(error.message);
    }
    const tierSet = new Set(canonicalInputs ?? []);
    for (const tierId of entry?.producerTierIds ?? [])
    {
        if (!tierSet.has(tierId))
        {
            errors.push(`${label} producerTierIds references unknown tier ${tierId}`);
        }
    }

    if (typeof entry?.locatorBindingKey !== 'string'
        || !bindingKeyPattern.test(entry.locatorBindingKey))
    {
        errors.push(`${prefix('locatorBindingKey')} must be a binding key without path rules`);
    }
    else
    {
        for (const term of forbiddenLocatorTerms)
        {
            if (entry.locatorBindingKey.includes(term))
            {
                errors.push(
                    `${prefix('locatorBindingKey')} must not use ${term} selection semantics`
                );
            }
        }
    }

    for (const field of ['requiredTestIds', 'requiredCoverageIds', 'requiredArtifactIds'])
    {
        try
        {
            sortedUnique(entry?.[field], prefix(field), { allowEmpty: true });
        }
        catch (error)
        {
            errors.push(error.message);
        }
        for (const id of entry?.[field] ?? [])
        {
            if (!stableIdPattern.test(id))
            {
                errors.push(`${prefix(field)} contains invalid ID ${id}`);
            }
        }
    }

    if (typeof entry?.requiredIdentityFields !== 'string'
        && !Array.isArray(entry?.requiredIdentityFields))
    {
        errors.push(`${prefix('requiredIdentityFields')} must be a non-empty string array`);
    }
    else
    {
        try
        {
            sortedUnique(entry.requiredIdentityFields, prefix('requiredIdentityFields'));
        }
        catch (error)
        {
            errors.push(error.message);
        }
        for (const field of entry.requiredIdentityFields ?? [])
        {
            if (!stableIdPattern.test(field))
            {
                errors.push(`${prefix('requiredIdentityFields')} contains invalid field ${field}`);
            }
        }
    }

    if (!digestPattern.test(String(entry?.contentDigest ?? '')))
    {
        errors.push(`${prefix('contentDigest')} must be a SHA-256 digest`);
    }
    else if (entryContentDigest(entry) !== entry.contentDigest)
    {
        errors.push(`${label} contentDigest does not match its canonical entry content`);
    }
    if (!digestPattern.test(String(entry?.producerDigest ?? '')))
    {
        errors.push(`${prefix('producerDigest')} must be a SHA-256 digest`);
    }
    else if (producerContractDigest(entry) !== entry.producerDigest)
    {
        errors.push(`${label} producerDigest does not match owner/command/schema/verifier`);
    }

    if (typeof entry?.allowDiagnostic !== 'boolean')
    {
        errors.push(`${prefix('allowDiagnostic')} must be a boolean`);
    }
    else if (entry.allowDiagnostic && entry.exactness !== 'diagnostic-only')
    {
        errors.push(`${label} diagnostic authority must declare exactness diagnostic-only`);
    }
    else if (!entry.allowDiagnostic && entry.exactness === 'diagnostic-only')
    {
        errors.push(`${label} diagnostic-only exactness requires allowDiagnostic true`);
    }

    if (!exactnessSet.has(entry?.exactness))
    {
        errors.push(`${prefix('exactness')} must be one of ${exactnessValues.join(', ')}`);
    }
    if (entry?.exactness === 'test-id-exact'
        && !Array.isArray(entry?.requiredTestIds))
    {
        errors.push(`${label} test-id-exact authority must declare requiredTestIds`);
    }
    if (Array.isArray(entry?.requiredTestIds) && entry.requiredTestIds.length > 0
        && entry?.exactness !== 'test-id-exact')
    {
        errors.push(`${label} declared requiredTestIds require exactness test-id-exact`);
    }

    if (typeof entry?.localProducerCommand !== 'string'
        || !entry.localProducerCommand.trim()
        || /\n|;|\|\||&&/u.test(entry.localProducerCommand))
    {
        errors.push(`${prefix('localProducerCommand')} must be a single non-empty command`);
    }

    if (typeof entry?.outputBindingKey !== 'string'
        || !bindingKeyPattern.test(entry.outputBindingKey))
    {
        errors.push(`${prefix('outputBindingKey')} must be a binding key`);
    }

    if (typeof entry?.producerVerifier !== 'string'
        || !verifierPattern.test(entry.producerVerifier))
    {
        errors.push(`${prefix('producerVerifier')} must be a tools-relative verifier`);
    }
    else if (checkVerifier)
    {
        const [verifierFile] = entry.producerVerifier.split(':');
        const absolute = path.resolve(repoRoot ?? root, verifierFile);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
        {
            errors.push(`${prefix('producerVerifier')} file does not exist: ${verifierFile}`);
        }
    }

    // Unknown correctness IDs fail closed: for projection tiers the disposition
    // ledger is the exact authority, so declared IDs must match it exactly.
    const dispositions = dispositionByTier?.get(entry?.authorityId);
    if (dispositions)
    {
        const expectedTestIds = [...new Set(
            dispositions.map((entry) => entry.requiredTestId)
        )].sort();
        const expectedArtifactIds = [
            ...new Set(dispositions.flatMap((entry) => entry.requiredArtifactIds ?? []))
        ].sort();
        const declaredTestIds = [...(entry?.requiredTestIds ?? [])].sort();
        const declaredArtifactIds = [...(entry?.requiredArtifactIds ?? [])].sort();
        if (JSON.stringify(declaredTestIds) !== JSON.stringify(expectedTestIds))
        {
            errors.push(
                `${label} requiredTestIds must exactly match the disposition ledger `
                + `for ${entry.authorityId}`
            );
        }
        if (JSON.stringify(declaredArtifactIds) !== JSON.stringify(expectedArtifactIds))
        {
            errors.push(
                `${label} requiredArtifactIds must exactly match the disposition ledger `
                + `for ${entry.authorityId}`
            );
        }
    }

    return errors;
}

export function validateRequiredEvidenceCatalog(
    ledger,
    {
        canonicalInputs = loadCanonicalReleaseFinalEvidenceInputs().inputs,
        dispositionLedger = JSON.parse(fs.readFileSync(
            path.resolve(root, 'config/testing/release-domain-assertion-dispositions.json'),
            'utf8'
        )),
        root: repoRoot = root,
        checkProducerVerifierExistence = true
    } = {}
)
{
    const errors = [];
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger))
    {
        return ['required evidence catalog must be an object'];
    }
    if (ledger.schema !== requiredEvidenceAuthorityLedgerSchema)
    {
        errors.push(
            `required evidence catalog must use ${requiredEvidenceAuthorityLedgerSchema}`
        );
    }
    if (ledger.catalogSchema !== requiredEvidenceCatalogSchema)
    {
        errors.push(`catalogSchema must be ${requiredEvidenceCatalogSchema}`);
    }
    if (ledger.version !== 1)
    {
        errors.push('required evidence catalog version must be 1');
    }
    if (ledger.contentDigest !== ledgerContentDigest(ledger))
    {
        errors.push('required evidence catalog contentDigest is stale or tampered');
    }
    if (!Array.isArray(ledger.entries) || ledger.entries.length === 0)
    {
        errors.push('required evidence catalog must declare a non-empty entries array');
        return errors;
    }

    const authorityIds = ledger.entries.map((entry) => entry?.authorityId);
    if (new Set(authorityIds).size !== authorityIds.length)
    {
        errors.push('required evidence catalog contains duplicate authority IDs');
    }
    if (JSON.stringify(authorityIds) !== JSON.stringify([...authorityIds].sort()))
    {
        errors.push('required evidence catalog entries must be sorted by authorityId');
    }

    const outputBindingKeys = ledger.entries.map((entry) => entry?.outputBindingKey);
    if (new Set(outputBindingKeys).size !== outputBindingKeys.length)
    {
        errors.push('required evidence catalog contains duplicate outputBindingKey values');
    }
    const locatorBindingKeys = ledger.entries.map((entry) => entry?.locatorBindingKey);
    if (new Set(locatorBindingKeys).size !== locatorBindingKeys.length)
    {
        errors.push('required evidence catalog contains duplicate locatorBindingKey values');
    }

    const dispositionByTier = new Map();
    try
    {
        for (const entry of validateDispositionLedger(dispositionLedger))
        {
            if (!dispositionByTier.has(entry.tierId))
            {
                dispositionByTier.set(entry.tierId, []);
            }
            dispositionByTier.get(entry.tierId).push(entry);
        }
    }
    catch (error)
    {
        errors.push(`disposition ledger is invalid: ${error.message}`);
    }

    for (const [index, entry] of ledger.entries.entries())
    {
        errors.push(...validateEntry(entry, index, {
            canonicalInputs,
            dispositionByTier,
            root: repoRoot,
            checkVerifier: checkProducerVerifierExistence
        }));
    }

    // Bidirectional exact coverage: the catalog must not reduce the current
    // release-final required evidence set, must not add a second authority
    // list, and must never let a diagnostic authority substitute correctness.
    const canonicalSet = new Set(canonicalInputs);
    const correctnessCovered = new Set();
    const diagnosticCovered = new Set();
    for (const entry of ledger.entries)
    {
        for (const tierId of entry.producerTierIds ?? [])
        {
            (entry.allowDiagnostic ? diagnosticCovered : correctnessCovered).add(tierId);
        }
    }
    const missing = canonicalInputs.filter((id) => !correctnessCovered.has(id));
    if (missing.length > 0)
    {
        errors.push(
            `required evidence catalog reduces the required evidence set; missing: ${missing.join(', ')}`
        );
    }
    const extra = [...correctnessCovered].filter((id) => !canonicalSet.has(id)).sort();
    if (extra.length > 0)
    {
        errors.push(
            `required evidence catalog declares non-canonical correctness producers: ${extra.join(', ')}`
        );
    }
    for (const id of canonicalInputs)
    {
        if (correctnessCovered.has(id) && diagnosticCovered.has(id))
        {
            errors.push(
                `authority ${id} is both correctness and diagnostic; diagnostic cannot substitute correctness`
            );
        }
        if (!correctnessCovered.has(id) && diagnosticCovered.has(id))
        {
            errors.push(
                `diagnostic authority ${id} cannot satisfy a correctness evidence requirement`
            );
        }
    }

    return errors;
}

export function loadCanonicalRequiredEvidenceCatalog()
{
    return JSON.parse(fs.readFileSync(
        path.resolve(root, canonicalRequiredEvidenceLedgerPath),
        'utf8'
    ));
}

export function checkRequiredEvidenceCatalog(ledger = loadCanonicalRequiredEvidenceCatalog())
{
    const errors = validateRequiredEvidenceCatalog(ledger);
    if (errors.length > 0)
    {
        throw new Error(`required evidence catalog is invalid:\n${errors.join('\n')}`);
    }
    return ledger.entries;
}

function main()
{
    const mode = process.argv[2] ?? '--check';
    if (mode !== '--check' || process.argv.length > 3)
    {
        throw new Error('usage: node tools/test-matrix/required-evidence-catalog.mjs --check');
    }
    const entries = checkRequiredEvidenceCatalog();
    console.log(
        `[required-evidence-catalog] ok (${entries.length} authorities, `
        + `digest ${loadCanonicalRequiredEvidenceCatalog().contentDigest})`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
