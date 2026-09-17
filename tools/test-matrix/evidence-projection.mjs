import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const evidenceProducerReceiptSchema = 'fsusblog.evidence-producer-receipt.v1';
export const evidenceProjectionReceiptSchema = 'fsusblog.evidence-projection-receipt.v1';
export const evidenceProjectionCatalogSchema = 'fsusblog.evidence-projection-catalog.v1';

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function projectionContentDigest(value)
{
    const content = { ...(value ?? {}) };
    delete content.contentDigest;
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

export function sealProjectionDocument(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = projectionContentDigest(sealed);
    return sealed;
}

function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function requiredText(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} must be non-empty`);
    }
    return normalized;
}

function validateSourceState(sourceState, label)
{
    if (!/^[a-f0-9]{40}$/u.test(String(sourceState?.commit ?? '')))
    {
        throw new Error(`${label}.commit must be a full lowercase commit SHA`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(sourceState?.worktreeFingerprint ?? '')))
    {
        throw new Error(`${label}.worktreeFingerprint must be a lowercase SHA-256 fingerprint`);
    }
    return {
        commit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint
    };
}

function validateIdentitySegment(value, label)
{
    const normalized = requiredText(value, label);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(normalized) || normalized === '.' || normalized === '..')
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

function sortedUniqueStrings(values, label, { allowEmpty = false } = {})
{
    if (!Array.isArray(values) || (!allowEmpty && values.length === 0))
    {
        throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
    }
    const normalized = values.map((value) => requiredText(value, `${label} entry`));
    if (new Set(normalized).size !== normalized.length)
    {
        throw new Error(`${label} contains duplicate IDs`);
    }
    const sorted = [...normalized].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(normalized))
    {
        throw new Error(`${label} must be sorted and unique`);
    }
    return sorted;
}

function validateRelativeArtifactPath(value, label)
{
    const normalized = requiredText(value, label).replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || normalized === '.')
    {
        throw new Error(`${label} must be a repository-relative path`);
    }
    return normalized;
}

function validateDigest(value, label)
{
    const normalized = String(value ?? '');
    if (!/^sha256:[a-f0-9]{64}$/u.test(normalized))
    {
        throw new Error(`${label} must be a SHA-256 digest`);
    }
    return normalized;
}

function normalizeArtifact(artifact, label)
{
    return {
        id: requiredText(artifact?.id, `${label}.id`),
        path: validateRelativeArtifactPath(artifact?.path, `${label}.path`),
        digest: validateDigest(artifact?.digest, `${label}.digest`)
    };
}

function validateSortedUniqueById(entries, label)
{
    if (!Array.isArray(entries) || entries.length === 0)
    {
        throw new Error(`${label} must be a non-empty array`);
    }
    const ids = entries.map((entry) => requiredText(entry?.id, `${label}.id`));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error(`${label} contains duplicate IDs`);
    }
    if (JSON.stringify(ids) !== JSON.stringify([...ids].sort()))
    {
        throw new Error(`${label} must be sorted by ID`);
    }
}

export function createEvidenceProducerReceipt({
    producerId,
    logicalTierId,
    sourceState,
    runId,
    namespace,
    buildIdentity,
    policyIdentity,
    assertionReport,
    assertions,
    artifacts,
    generatedAt = new Date().toISOString()
})
{
    const normalizedSource = validateSourceState(sourceState, 'producer sourceState');
    const normalizedAssertions = (assertions ?? []).map((assertion, index) => ({
        id: requiredText(assertion?.id, `producer assertions[${index}].id`),
        outcome: requiredText(assertion?.outcome, `producer assertions[${index}].outcome`),
        sourceTestIds: sortedUniqueStrings(assertion?.sourceTestIds, `producer assertions[${index}].sourceTestIds`),
        coverageIds: sortedUniqueStrings(assertion?.coverageIds, `producer assertions[${index}].coverageIds`),
        artifactIds: sortedUniqueStrings(assertion?.artifactIds, `producer assertions[${index}].artifactIds`, { allowEmpty: true })
    })).sort((left, right) => left.id.localeCompare(right.id));
    validateSortedUniqueById(normalizedAssertions, 'producer assertions');
    const normalizedArtifacts = (artifacts ?? []).map((artifact, index) => normalizeArtifact(artifact, `producer artifacts[${index}]`))
        .sort((left, right) => left.id.localeCompare(right.id));
    validateSortedUniqueById(normalizedArtifacts, 'producer artifacts');

    const artifactIds = new Set(normalizedArtifacts.map((artifact) => artifact.id));
    for (const assertion of normalizedAssertions)
    {
        const missing = assertion.artifactIds.filter((id) => !artifactIds.has(id));
        if (missing.length > 0)
        {
            throw new Error(`producer assertion ${assertion.id} references missing artifacts: ${missing.join(', ')}`);
        }
    }

    return sealProjectionDocument({
        schema: evidenceProducerReceiptSchema,
        status: 'success',
        producerId: requiredText(producerId, 'producerId'),
        ...(logicalTierId ? { logicalTierId: requiredText(logicalTierId, 'logicalTierId') } : {}),
        sourceState: normalizedSource,
        runId: validateIdentitySegment(runId, 'runId'),
        namespace: validateIdentitySegment(namespace, 'namespace'),
        ...(buildIdentity ? { buildIdentity: validateDigest(buildIdentity, 'buildIdentity') } : {}),
        ...(policyIdentity ? { policyIdentity: validateDigest(policyIdentity, 'policyIdentity') } : {}),
        ...(assertionReport ? { assertionReport: {
            path: validateRelativeArtifactPath(assertionReport?.path, 'assertionReport.path'),
            digest: validateDigest(assertionReport?.digest, 'assertionReport.digest')
        } } : {}),
        assertions: normalizedAssertions,
        artifacts: normalizedArtifacts,
        generatedAt: requiredText(generatedAt, 'generatedAt')
    });
}

function validateCatalog(catalog)
{
    if (catalog?.schema !== evidenceProjectionCatalogSchema)
    {
        throw new Error(`unexpected projection catalog schema: ${catalog?.schema ?? 'missing'}`);
    }
    const requiredArtifacts = (catalog.requiredArtifactDeclarations ?? []).map((artifact, index) => ({
        id: requiredText(artifact?.id, `requiredArtifactDeclarations[${index}].id`),
        path: validateRelativeArtifactPath(artifact?.path, `requiredArtifactDeclarations[${index}].path`)
    }));
    validateSortedUniqueById(requiredArtifacts, 'requiredArtifactDeclarations');
    return {
        tierId: requiredText(catalog.tierId, 'tierId'),
        executionOwner: requiredText(catalog.executionOwner, 'executionOwner'),
        projectFrom: requiredText(catalog.projectFrom, 'projectFrom'),
        requiredTestIds: sortedUniqueStrings(catalog.requiredTestIds, 'requiredTestIds'),
        requiredCoverageIds: sortedUniqueStrings(catalog.requiredCoverageIds, 'requiredCoverageIds'),
        requiredArtifactDeclarations: requiredArtifacts,
        ...(catalog.dispositionLedger ? {
            buildIdentityArtifactId: requiredText(catalog.buildIdentityArtifactId, 'buildIdentityArtifactId'),
            dispositionLedger: validateRelativeArtifactPath(catalog.dispositionLedger, 'dispositionLedger'),
            dispositionIds: sortedUniqueStrings(catalog.dispositionIds, 'dispositionIds'),
            strictReleaseDomain: true
        } : { strictReleaseDomain: false })
    };
}

function assertSameSource(actual, expected)
{
    const normalizedActual = validateSourceState(actual, 'producer sourceState');
    const normalizedExpected = validateSourceState(expected, 'expected sourceState');
    if (normalizedActual.commit !== normalizedExpected.commit)
    {
        throw new Error('producer commit does not match projection source');
    }
    if (normalizedActual.worktreeFingerprint !== normalizedExpected.worktreeFingerprint)
    {
        throw new Error('producer worktree fingerprint does not match projection source');
    }
    return normalizedExpected;
}

export function projectEvidence({
    catalog,
    producerReceipt,
    producerReceiptPath,
    sourceState,
    runId,
    namespace,
    buildIdentity,
    policyIdentity,
    repositoryRoot,
    generatedAt = new Date().toISOString()
})
{
    const expected = validateCatalog(catalog);
    if (producerReceipt?.schema !== evidenceProducerReceiptSchema)
    {
        throw new Error(`unexpected producer receipt schema: ${producerReceipt?.schema ?? 'missing'}`);
    }
    if (producerReceipt.status !== 'success')
    {
        throw new Error(`producer receipt status must be success, got ${producerReceipt.status}`);
    }
    if (producerReceipt.contentDigest !== projectionContentDigest(producerReceipt))
    {
        throw new Error('producer receipt content digest mismatch');
    }
    if (producerReceipt.producerId !== expected.projectFrom || expected.executionOwner !== producerReceipt.producerId)
    {
        throw new Error('projection owner/projectFrom does not match producer identity');
    }
    if (expected.strictReleaseDomain && producerReceipt.logicalTierId !== expected.tierId)
    {
        throw new Error('producer receipt logical tier does not match projection tier');
    }
    const normalizedSource = assertSameSource(producerReceipt.sourceState, sourceState);
    const normalizedRunId = validateIdentitySegment(runId, 'runId');
    const normalizedNamespace = validateIdentitySegment(namespace, 'namespace');
    if (producerReceipt.runId !== normalizedRunId)
    {
        throw new Error('producer receipt belongs to another run');
    }
    if (producerReceipt.namespace !== normalizedNamespace)
    {
        throw new Error('producer receipt belongs to another namespace');
    }
    if (expected.strictReleaseDomain && producerReceipt.buildIdentity !== validateDigest(buildIdentity, 'expected buildIdentity'))
    {
        throw new Error('producer build identity does not match projection build identity');
    }
    if (expected.strictReleaseDomain && producerReceipt.policyIdentity !== validateDigest(policyIdentity, 'expected policyIdentity'))
    {
        throw new Error('producer policy identity does not match projection policy identity');
    }
    if (expected.strictReleaseDomain)
    {
        const reportPath = validateRelativeArtifactPath(producerReceipt.assertionReport?.path, 'producer assertionReport.path');
        const reportDigest = validateDigest(producerReceipt.assertionReport?.digest, 'producer assertionReport.digest');
        const absoluteReport = path.resolve(repositoryRoot, reportPath);
        if (!fs.existsSync(absoluteReport) || !fs.statSync(absoluteReport).isFile() || sha256File(absoluteReport) !== reportDigest)
        {
            throw new Error('producer assertion report digest mismatch');
        }
    }

    validateSortedUniqueById(producerReceipt.assertions, 'producer assertions');
    validateSortedUniqueById(producerReceipt.artifacts, 'producer artifacts');
    const producerTestIds = producerReceipt.assertions.map((assertion) => assertion.id);
    if (expected.strictReleaseDomain && JSON.stringify(producerTestIds) !== JSON.stringify(expected.requiredTestIds))
    {
        throw new Error('producer test IDs do not exactly match requiredTestIds');
    }
    const producerArtifactIds = producerReceipt.artifacts.map((artifact) => artifact.id);
    const requiredArtifactIdsInOrder = expected.requiredArtifactDeclarations.map((artifact) => artifact.id);
    if (expected.strictReleaseDomain && JSON.stringify(producerArtifactIds) !== JSON.stringify(requiredArtifactIdsInOrder))
    {
        throw new Error('producer artifact IDs do not exactly match requiredArtifactDeclarations');
    }
    const assertionsById = new Map(producerReceipt.assertions.map((assertion) => [assertion.id, assertion]));
    const artifactsById = new Map(producerReceipt.artifacts.map((artifact) => [artifact.id, normalizeArtifact(artifact, `producer artifact ${artifact.id}`)]));
    const projectedAssertions = expected.requiredTestIds.map((id) =>
    {
        const assertion = assertionsById.get(id);
        if (!assertion)
        {
            throw new Error(`producer receipt is missing required test ID: ${id}`);
        }
        if (assertion.outcome !== 'Passed')
        {
            throw new Error(`required test ID ${id} did not pass: ${assertion.outcome}`);
        }
        const coverageIds = sortedUniqueStrings(assertion.coverageIds, `producer assertion ${id} coverageIds`);
        const sourceTestIds = sortedUniqueStrings(assertion.sourceTestIds, `producer assertion ${id} sourceTestIds`);
        const artifactIds = sortedUniqueStrings(assertion.artifactIds, `producer assertion ${id} artifactIds`, { allowEmpty: true });
        return { id, outcome: 'Passed', sourceTestIds, coverageIds, artifactIds };
    });
    const projectedCoverageIds = [...new Set(projectedAssertions.flatMap((assertion) => assertion.coverageIds))].sort();
    if (JSON.stringify(projectedCoverageIds) !== JSON.stringify(expected.requiredCoverageIds))
    {
        throw new Error('projected coverage IDs do not exactly match requiredCoverageIds');
    }
    const declaredCoverageIds = [...new Set(producerReceipt.assertions.flatMap((assertion) => assertion.coverageIds))].sort();
    if (expected.strictReleaseDomain && JSON.stringify(declaredCoverageIds) !== JSON.stringify(expected.requiredCoverageIds))
    {
        throw new Error('producer coverage IDs do not exactly match requiredCoverageIds');
    }

    const root = path.resolve(requiredText(repositoryRoot, 'repositoryRoot'));
    const projectedArtifacts = expected.requiredArtifactDeclarations.map((declaration) =>
    {
        const artifact = artifactsById.get(declaration.id);
        if (!artifact)
        {
            throw new Error(`producer receipt is missing required artifact: ${declaration.id}`);
        }
        if (artifact.path !== declaration.path)
        {
            throw new Error(`artifact path mismatch for ${declaration.id}`);
        }
        const absolute = path.resolve(root, artifact.path);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
        {
            throw new Error(`artifact escapes repository root: ${artifact.path}`);
        }
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
        {
            throw new Error(`artifact is missing: ${artifact.path}`);
        }
        if (sha256File(absolute) !== artifact.digest)
        {
            throw new Error(`artifact digest mismatch for ${declaration.id}`);
        }
        return artifact;
    });
    const requiredArtifactIds = new Set(projectedArtifacts.map((artifact) => artifact.id));
    for (const assertion of projectedAssertions)
    {
        const undeclared = assertion.artifactIds.filter((id) => !requiredArtifactIds.has(id));
        if (undeclared.length > 0)
        {
            throw new Error(`projected assertion ${assertion.id} references undeclared artifacts: ${undeclared.join(', ')}`);
        }
    }

    return sealProjectionDocument({
        schema: evidenceProjectionReceiptSchema,
        status: 'success',
        executionMode: 'projection',
        tierId: expected.tierId,
        executionOwner: expected.executionOwner,
        projectFrom: expected.projectFrom,
        sourceState: normalizedSource,
        runId: normalizedRunId,
        namespace: normalizedNamespace,
        buildIdentity: producerReceipt.buildIdentity,
        policyIdentity: producerReceipt.policyIdentity,
        producer: {
            schema: producerReceipt.schema,
            producerId: producerReceipt.producerId,
            receipt: validateRelativeArtifactPath(producerReceiptPath, 'producerReceiptPath'),
            receiptContentDigest: producerReceipt.contentDigest,
            ...(expected.strictReleaseDomain ? { assertionReport: producerReceipt.assertionReport } : {})
        },
        testIds: expected.requiredTestIds,
        coverageIds: expected.requiredCoverageIds,
        assertions: projectedAssertions,
        artifacts: projectedArtifacts,
        executionBoundary: {
            childProcessCount: 0,
            dotnetTestLaunchCount: 0,
            vitestLaunchCount: 0,
            playwrightLaunchCount: 0,
            runtimeProbeLaunchCount: 0
        },
        generatedAt: requiredText(generatedAt, 'generatedAt')
    });
}
