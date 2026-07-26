import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    releaseFinalDomainProjectionTierIds
} from '../release/release-domain-final-binding.mjs';
import { evidenceProjectionCatalogSchema } from './evidence-projection.mjs';

export { releaseFinalDomainProjectionTierIds };

export const releaseDomainLedgerSchema = 'fsusblog.release-domain-assertion-dispositions.v1';
export const releaseDomainReportSchema = 'fsusblog.release-domain-assertion-report.v1';
export const browserDiagnosticsReleaseAssertionsSchema =
    'fsusblog.browser-diagnostics-release-assertions.v1';
export const browserDiagnosticsReleaseRuntimeReceiptSchema =
    'fsusblog.browser-diagnostics-release-runtime-receipt.v1';
const projectionDispositions = new Set([
    'production-fresh-canonical-projection',
    'browser-diagnostics-canonical-projection',
    'immutable-build-artifact-projection',
    'static-governance-producer-projection'
]);
export const browserDiagnosticsReleaseProbeAssertions = new Map([
    ['release-runtime/release-aot-consumption', [
        'check:distribution-version-coherence',
        'check:pow-runtime',
        'check:public-hydration'
    ]],
    ['release-runtime/release-rbac-negative', [
        'check:security:attack-matrix',
        'check:security:permissions'
    ]]
]);
export const browserDiagnosticsReleaseProbeIds =
    [...browserDiagnosticsReleaseProbeAssertions.keys()]
        .map((value) => value.split('/').at(-1))
        .sort();

export function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function evidenceSelectorDigest(selector)
{
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(selector)).digest('hex')}`;
}

export function sortedUnique(values, label, { allowEmpty = false } = {})
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

export function safeRelativePath(value, label)
{
    const normalized = String(value ?? '').trim().replaceAll('\\', '/');
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)
        || normalized.split('/').includes('..'))
    {
        throw new Error(`${label} must be a repository-relative path`);
    }
    return normalized;
}

export function validateDigest(value, label)
{
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(value ?? '')))
    {
        throw new Error(`${label} must be a SHA-256 digest`);
    }
    return value;
}

export function validateProducerEvidence(entry)
{
    const selector = entry.producerEvidence;
    if (!selector || typeof selector !== 'object' || Array.isArray(selector))
    {
        throw new Error(`disposition ${entry.id} has no producer evidence selector`);
    }
    switch (selector.kind)
    {
    case 'vitest-file':
        safeRelativePath(selector.file, `${entry.id}.producerEvidence.file`);
        break;
    case 'vitest-file-set':
        sortedUnique(selector.files, `${entry.id}.producerEvidence.files`);
        selector.files.forEach((file) =>
            safeRelativePath(file, `${entry.id}.producerEvidence.files`));
        break;
    case 'live-grant-child':
        if (!String(selector.lane ?? '').trim() || !String(selector.childId ?? '').trim())
        {
            throw new Error(`${entry.id}.producerEvidence must identify a live-grant lane and child`);
        }
        if (selector.nestedId !== undefined && !String(selector.nestedId).trim())
        {
            throw new Error(`${entry.id}.producerEvidence.nestedId must be non-empty`);
        }
        break;
    case 'browser-diagnostics-release-assertion':
    {
        const receiptPath = safeRelativePath(
            selector.receiptPath,
            `${entry.id}.producerEvidence.receiptPath`
        );
        const assertionArtifactPath = safeRelativePath(
            selector.assertionArtifactPath,
            `${entry.id}.producerEvidence.assertionArtifactPath`
        );
        if (receiptPath === assertionArtifactPath)
        {
            throw new Error(`${entry.id}.producerEvidence source artifact paths must be distinct`);
        }
        const probeKey = `${selector.categoryId}/${selector.probeId}`;
        const expectedAssertionIds = browserDiagnosticsReleaseProbeAssertions.get(probeKey);
        if (!expectedAssertionIds)
        {
            throw new Error(`${entry.id}.producerEvidence does not identify a canonical release-runtime probe`);
        }
        sortedUnique(selector.assertionIds, `${entry.id}.producerEvidence.assertionIds`);
        if (JSON.stringify(selector.assertionIds) !== JSON.stringify(expectedAssertionIds))
        {
            throw new Error(`${entry.id}.producerEvidence assertion IDs do not exactly match ${probeKey}`);
        }
        if (!selector.assertionIds.includes(selector.assertionId))
        {
            throw new Error(`${entry.id}.producerEvidence assertionId is absent from assertionIds`);
        }
        break;
    }
    default:
        throw new Error(
            `${entry.id}.producerEvidence.kind is unsupported: ${selector.kind ?? 'missing'}`
        );
    }
    return selector;
}

export function validateDispositionLedger(ledger)
{
    if (ledger?.schema !== releaseDomainLedgerSchema
        || !Array.isArray(ledger.entries)
        || ledger.entries.length === 0)
    {
        throw new Error(
            `unexpected release domain disposition ledger schema: ${ledger?.schema ?? 'missing'}`
        );
    }
    const ids = ledger.entries.map((entry) => entry?.id);
    sortedUnique(ids, 'disposition IDs');
    for (const entry of ledger.entries)
    {
        if (!entry.tierId || !entry.canonicalProducer || !entry.requiredTestId)
        {
            throw new Error(`disposition ${entry.id} is incomplete`);
        }
        const expectedOutputReceipt =
            `.tmp/release-evidence/projections/${entry.tierId}.json`;
        if (safeRelativePath(entry.outputReceiptPath, `${entry.id}.outputReceiptPath`)
            !== expectedOutputReceipt)
        {
            throw new Error(`${entry.id}.outputReceiptPath must be ${expectedOutputReceipt}`);
        }
        sortedUnique(entry.requiredArtifactIds, `${entry.id}.requiredArtifactIds`);
        sortedUnique(entry.sourceTestIds, `${entry.id}.sourceTestIds`);
        if (Object.hasOwn(entry, 'command'))
        {
            throw new Error(`disposition ${entry.id} must not contain an executable command`);
        }
        validateProducerEvidence(entry);
        if (entry.targetOnly === true)
        {
            if (entry.disposition !== 'target-environment-release-closeout'
                || entry.tierId !== 'release-closeout')
            {
                throw new Error(
                    `target-only disposition ${entry.id} must belong to release-closeout`
                );
            }
        }
        else if (entry.obsolete === true)
        {
            if (entry.disposition !== 'obsolete-duplicate'
                || !entry.replacementProof?.requiredTestId)
            {
                throw new Error(`obsolete disposition ${entry.id} requires replacement proof`);
            }
        }
        else if (!projectionDispositions.has(entry.disposition))
        {
            throw new Error(`disposition ${entry.id} has invalid projection class`);
        }
        if (entry.replacementProof?.kind !== 'structured-producer-assertion'
            || entry.replacementProof?.reportSchema !== releaseDomainReportSchema)
        {
            throw new Error(`disposition ${entry.id} lacks structured replacement proof`);
        }
    }
    return ledger.entries;
}

export function validateCatalogAgainstLedger(catalog, ledger)
{
    if (catalog?.schema !== evidenceProjectionCatalogSchema)
    {
        throw new Error(`invalid projection catalog ${catalog?.tierId ?? 'unknown'}`);
    }
    const entries = validateDispositionLedger(ledger)
        .filter((entry) => entry.tierId === catalog.tierId);
    if (entries.length === 0)
    {
        throw new Error(`${catalog.tierId} has no disposition entries`);
    }
    if (entries.some((entry) => entry.targetOnly === true || entry.obsolete === true))
    {
        throw new Error(`${catalog.tierId} cannot project target-only or obsolete assertions`);
    }
    const dispositionIds = entries.map((entry) => entry.id).sort();
    const testIds = entries.map((entry) => entry.requiredTestId).sort();
    const artifactIds =
        [...new Set(entries.flatMap((entry) => entry.requiredArtifactIds))].sort();
    const declaredArtifactIds =
        catalog.requiredArtifactDeclarations.map((entry) => entry.id);
    if (JSON.stringify(catalog.dispositionIds) !== JSON.stringify(dispositionIds))
    {
        throw new Error(`${catalog.tierId} disposition IDs do not exactly match ledger`);
    }
    if (JSON.stringify(catalog.requiredTestIds) !== JSON.stringify(testIds))
    {
        throw new Error(`${catalog.tierId} required test IDs do not exactly match ledger`);
    }
    if (JSON.stringify(declaredArtifactIds) !== JSON.stringify(artifactIds))
    {
        throw new Error(`${catalog.tierId} required artifact IDs do not exactly match ledger`);
    }
    if (entries.some((entry) => entry.canonicalProducer !== catalog.projectFrom)
        || catalog.executionOwner !== catalog.projectFrom)
    {
        throw new Error(`${catalog.tierId} canonical producer does not match ledger`);
    }
    if (!artifactIds.includes(catalog.buildIdentityArtifactId))
    {
        throw new Error(`${catalog.tierId} build identity artifact is undeclared`);
    }
    return entries;
}

export function releasePolicyIdentity(ledgerPath)
{
    return sha256File(ledgerPath);
}

export function releaseBuildIdentity(root, catalog)
{
    const declaration = catalog.requiredArtifactDeclarations
        .find((entry) => entry.id === catalog.buildIdentityArtifactId);
    if (!declaration)
    {
        throw new Error(`${catalog.tierId} build identity artifact is missing`);
    }
    const absolute = path.resolve(root, declaration.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    {
        throw new Error(`build identity artifact is missing: ${declaration.path}`);
    }
    return sha256File(absolute);
}

export function normalizeSourceArtifact(root, artifact, label)
{
    const relative = safeRelativePath(artifact?.path, `${label}.path`);
    const digest = validateDigest(artifact?.digest, `${label}.digest`);
    if (root)
    {
        const repositoryRoot = path.resolve(root);
        const absolute = path.resolve(repositoryRoot, relative);
        if (absolute !== repositoryRoot
            && !absolute.startsWith(`${repositoryRoot}${path.sep}`))
        {
            throw new Error(`${label}.path escapes repository root`);
        }
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
        {
            throw new Error(`native source artifact is missing: ${relative}`);
        }
        if (sha256File(absolute) !== digest)
        {
            throw new Error(`native source artifact digest mismatch: ${relative}`);
        }
    }
    return { path: relative, digest };
}

export function normalizeTestResultPath(root, value)
{
    const repositoryRoot = path.resolve(root);
    const absolute = path.isAbsolute(String(value ?? ''))
        ? path.resolve(String(value))
        : path.resolve(repositoryRoot, String(value ?? ''));
    const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/');
    return relative.startsWith('../')
        ? String(value ?? '').replaceAll('\\', '/')
        : relative;
}

export function readJsonArtifact(root, relative)
{
    return JSON.parse(fs.readFileSync(path.resolve(root, relative), 'utf8'));
}

export function identitySlug(value)
{
    return String(value ?? '').trim().toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
}
