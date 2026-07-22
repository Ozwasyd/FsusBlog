import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { projectionContentDigest, sealProjectionDocument } from './evidence-projection.mjs';

export const crossStackOwnershipSchema = 'fsusblog.cross-stack-assertion-ownership.v1';
export const crossStackOwnerReceiptSchema = 'fsusblog.cross-stack-owner-receipt.v1';
export const crossStackJoinReceiptSchema = 'fsusblog.cross-stack-join-receipt.v1';

function requiredText(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} must be non-empty`);
    }
    return normalized;
}

function sortedUnique(values, label)
{
    if (!Array.isArray(values) || values.length === 0)
    {
        throw new Error(`${label} must be a non-empty array`);
    }
    const normalized = values.map((value) => requiredText(value, `${label} entry`));
    if (new Set(normalized).size !== normalized.length)
    {
        throw new Error(`${label} contains duplicates`);
    }
    return [...normalized].sort();
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
    return { commit: sourceState.commit, worktreeFingerprint: sourceState.worktreeFingerprint };
}

function validateIdentity(value, label)
{
    const normalized = requiredText(value, label);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(normalized))
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

function normalizeRepositoryPath(value, label)
{
    const normalized = requiredText(value, label).replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || normalized === '.' || normalized.split('/').includes('..'))
    {
        throw new Error(`${label} must be a repository-relative path`);
    }
    return normalized;
}

function fileDigest(repositoryRoot, relativePath)
{
    const file = path.resolve(repositoryRoot, relativePath);
    if (!file.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`) || !fs.statSync(file).isFile())
    {
        throw new Error(`cross-stack artifact is missing or invalid: ${relativePath}`);
    }
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function validateCrossStackOwnershipRegistry(registry)
{
    if (registry?.schema !== crossStackOwnershipSchema || registry.tierId !== 'cross-stack-contract')
    {
        throw new Error('unexpected cross-stack ownership registry identity');
    }
    if (!Array.isArray(registry.assertions) || registry.assertions.length === 0)
    {
        throw new Error('cross-stack ownership registry requires assertions');
    }
    const assertions = registry.assertions.map((entry, index) => ({
        id: requiredText(entry?.id, `assertions[${index}].id`),
        legacyCommand: requiredText(entry?.legacyCommand, `assertions[${index}].legacyCommand`),
        kind: entry?.kind,
        canonicalOwner: requiredText(entry?.canonicalOwner, `assertions[${index}].canonicalOwner`),
        sourceTestId: requiredText(entry?.sourceTestId, `assertions[${index}].sourceTestId`),
        coverageIds: sortedUnique(entry?.coverageIds, `assertions[${index}].coverageIds`),
        artifactPaths: sortedUnique(entry?.artifactPaths, `assertions[${index}].artifactPaths`)
            .map((artifactPath) => normalizeRepositoryPath(artifactPath, `assertions[${index}].artifactPaths`))
    })).sort((left, right) => left.id.localeCompare(right.id));
    if (assertions.some((entry) => !['shared', 'unique'].includes(entry.kind)))
    {
        throw new Error('cross-stack assertion kind must be shared or unique');
    }
    for (const [field, values] of [
        ['assertion IDs', assertions.map((entry) => entry.id)],
        ['legacy commands', assertions.map((entry) => entry.legacyCommand)],
        ['source test IDs', assertions.map((entry) => entry.sourceTestId)]
    ])
    {
        if (new Set(values).size !== values.length)
        {
            throw new Error(`cross-stack ownership registry has duplicate ${field}`);
        }
    }
    for (const assertion of assertions)
    {
        if (assertion.kind === 'unique' && !assertion.canonicalOwner.startsWith('cross-stack-'))
        {
            throw new Error(`unique assertion ${assertion.id} must remain physically owned by cross-stack`);
        }
        if (assertion.kind === 'shared' && assertion.canonicalOwner.startsWith('cross-stack-'))
        {
            throw new Error(`shared assertion ${assertion.id} must use a non-cross-stack canonical owner`);
        }
    }
    return { schema: registry.schema, tierId: registry.tierId, assertions };
}

export function createCrossStackOwnerReceipt({
    registry,
    owner,
    repositoryRoot,
    sourceState,
    runId,
    namespace,
    outcome = 'Passed',
    generatedAt = new Date().toISOString()
})
{
    const validated = validateCrossStackOwnershipRegistry(registry);
    const ownerId = requiredText(owner, 'owner');
    const declarations = validated.assertions.filter((entry) => entry.canonicalOwner === ownerId);
    if (declarations.length === 0)
    {
        throw new Error(`cross-stack owner has no assertions: ${ownerId}`);
    }
    const artifactPaths = [...new Set(declarations.flatMap((entry) => entry.artifactPaths))].sort();
    const artifacts = artifactPaths.map((artifactPath) => ({
        id: `artifact:${artifactPath}`,
        path: artifactPath,
        digest: fileDigest(repositoryRoot, artifactPath)
    }));
    return sealProjectionDocument({
        schema: crossStackOwnerReceiptSchema,
        status: outcome === 'Passed' ? 'success' : 'failure',
        owner: ownerId,
        sourceState: validateSourceState(sourceState, 'owner sourceState'),
        runId: validateIdentity(runId, 'runId'),
        namespace: validateIdentity(namespace, 'namespace'),
        assertions: declarations.map((entry) => ({
            id: entry.id,
            sourceTestId: entry.sourceTestId,
            outcome,
            coverageIds: entry.coverageIds,
            artifactIds: entry.artifactPaths.map((artifactPath) => `artifact:${artifactPath}`).sort()
        })),
        artifacts,
        generatedAt: requiredText(generatedAt, 'generatedAt')
    });
}

function validateOwnerReceipt({ receipt, owner, declarations, repositoryRoot, sourceState, runId, namespace })
{
    if (receipt?.schema !== crossStackOwnerReceiptSchema || receipt.owner !== owner)
    {
        throw new Error(`cross-stack owner receipt identity mismatch: ${owner}`);
    }
    if (receipt.contentDigest !== projectionContentDigest(receipt))
    {
        throw new Error(`cross-stack owner receipt digest mismatch: ${owner}`);
    }
    if (receipt.status !== 'success')
    {
        throw new Error(`cross-stack owner receipt must be successful: ${owner}`);
    }
    if (JSON.stringify(receipt.sourceState) !== JSON.stringify(validateSourceState(sourceState, 'join sourceState'))
        || receipt.runId !== validateIdentity(runId, 'runId')
        || receipt.namespace !== validateIdentity(namespace, 'namespace'))
    {
        throw new Error(`cross-stack owner receipt source/run identity mismatch: ${owner}`);
    }
    const expectedIds = declarations.map((entry) => entry.id).sort();
    const actualIds = (receipt.assertions ?? []).map((entry) => entry.id).sort();
    if (new Set(actualIds).size !== actualIds.length || JSON.stringify(actualIds) !== JSON.stringify(expectedIds))
    {
        throw new Error(`cross-stack owner assertion set mismatch: ${owner}`);
    }
    const declarationById = new Map(declarations.map((entry) => [entry.id, entry]));
    for (const assertion of receipt.assertions)
    {
        const declaration = declarationById.get(assertion.id);
        if (assertion.outcome !== 'Passed'
            || assertion.sourceTestId !== declaration.sourceTestId
            || JSON.stringify(assertion.coverageIds) !== JSON.stringify(declaration.coverageIds))
        {
            throw new Error(`cross-stack assertion must have its declared Passed outcome: ${assertion.id}`);
        }
    }
    const expectedPaths = [...new Set(declarations.flatMap((entry) => entry.artifactPaths))].sort();
    const actualPaths = (receipt.artifacts ?? []).map((entry) => entry.path).sort();
    if (new Set(actualPaths).size !== actualPaths.length || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths))
    {
        throw new Error(`cross-stack owner artifact set mismatch: ${owner}`);
    }
    for (const artifact of receipt.artifacts)
    {
        if (artifact.id !== `artifact:${artifact.path}` || artifact.digest !== fileDigest(repositoryRoot, artifact.path))
        {
            throw new Error(`cross-stack artifact digest mismatch: ${artifact.path}`);
        }
    }
}

export function joinCrossStackReceipts({
    registry,
    ownerReceipts,
    repositoryRoot,
    sourceState,
    runId,
    namespace,
    generatedAt = new Date().toISOString()
})
{
    const validated = validateCrossStackOwnershipRegistry(registry);
    const expectedOwners = [...new Set(validated.assertions.map((entry) => entry.canonicalOwner))].sort();
    const receipts = [...(ownerReceipts ?? [])].sort((left, right) => String(left?.owner).localeCompare(String(right?.owner)));
    const actualOwners = receipts.map((entry) => entry?.owner);
    if (new Set(actualOwners).size !== actualOwners.length || JSON.stringify(actualOwners) !== JSON.stringify(expectedOwners))
    {
        throw new Error('cross-stack owner receipt set mismatch');
    }
    for (const owner of expectedOwners)
    {
        validateOwnerReceipt({
            receipt: receipts.find((entry) => entry.owner === owner),
            owner,
            declarations: validated.assertions.filter((entry) => entry.canonicalOwner === owner),
            repositoryRoot,
            sourceState,
            runId,
            namespace
        });
    }
    return sealProjectionDocument({
        schema: crossStackJoinReceiptSchema,
        status: 'success',
        tierId: validated.tierId,
        sourceState: validateSourceState(sourceState, 'join sourceState'),
        runId: validateIdentity(runId, 'runId'),
        namespace: validateIdentity(namespace, 'namespace'),
        assertions: validated.assertions.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            canonicalOwner: entry.canonicalOwner,
            sourceTestId: entry.sourceTestId,
            outcome: 'Passed'
        })),
        coverageIds: [...new Set(validated.assertions.flatMap((entry) => entry.coverageIds))].sort(),
        ownerReceipts: receipts.map((entry) => ({
            owner: entry.owner,
            path: `.tmp/test-results/cross-stack/${runId}/owners/${entry.owner}.json`,
            contentDigest: entry.contentDigest
        })),
        executionBoundary: {
            sharedCheckerLaunches: 0,
            joinedOwnerReceipts: receipts.length
        },
        generatedAt: requiredText(generatedAt, 'generatedAt')
    });
}
