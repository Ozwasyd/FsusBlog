#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const privacyPrebuildProducerSchema = 'fsusblog.privacy-zk-canonical-producer.v1';
export const privacyPrebuildProjectionSchema = 'fsusblog.privacy-zk-prebuild-projection.v1';

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function privacyPrebuildDigest(value)
{
    const payload = { ...value };
    delete payload.contentDigest;
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')}`;
}

export function createPrivacyPrebuildProducerReceipt({ producerId, runId, sourceState, assertions, artifacts })
{
    const receipt = {
        schema: privacyPrebuildProducerSchema,
        status: 'success',
        producerId,
        runId,
        sourceState,
        assertions: [...assertions].sort((left, right) => left.id.localeCompare(right.id)),
        artifacts: [...artifacts].sort((left, right) => left.id.localeCompare(right.id))
    };
    return { ...receipt, contentDigest: privacyPrebuildDigest(receipt) };
}

function requireSourceState(actual, expected)
{
    if (!/^[a-f0-9]{40}$/u.test(String(actual?.commit ?? ''))
      || !/^[a-f0-9]{64}$/u.test(String(actual?.worktreeFingerprint ?? '')))
    {
        throw new Error('producer source state is invalid');
    }
    if (actual.commit !== expected?.commit || actual.worktreeFingerprint !== expected?.worktreeFingerprint)
    {
        throw new Error('producer source state mismatch');
    }
}

function unique(values, label)
{
    if (new Set(values).size !== values.length)
    {
        throw new Error(`duplicate ${label}`);
    }
}

function sha256File(file)
{
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function validateRegistry(registry)
{
    if (registry?.schema !== 'fsusblog.privacy-zk-prebuild-ownership.v1')
    {
        throw new Error('invalid Privacy/ZK prebuild ownership registry schema');
    }
    const entries = [...(registry.uniqueAssertions ?? []), ...(registry.sharedAssertions ?? [])];
    const ids = entries.map(entry => String(entry?.id ?? ''));
    if (ids.some(id => !id))
    {
        throw new Error('assertion ownership ID must be non-empty');
    }
    unique(ids, 'assertion ownership');
    for (const entry of registry.uniqueAssertions ?? [])
    {
        if (entry.owner !== 'privacy-zk-prebuild')
        {
            throw new Error(`unique assertion ${entry.id} has a non-Privacy owner`);
        }
    }
    for (const entry of registry.sharedAssertions ?? [])
    {
        if (!entry.owner || entry.owner === 'privacy-zk-prebuild')
        {
            throw new Error(`shared assertion ${entry.id} has no canonical owner`);
        }
        if (!Array.isArray(entry.requiredAssertionIds) || entry.requiredAssertionIds.length === 0)
        {
            throw new Error(`shared assertion ${entry.id} has no required assertion IDs`);
        }
        unique(entry.requiredAssertionIds, `required assertion ID in ${entry.id}`);
    }
    return entries;
}

function validateProducer({ producer, declaration, receiptPath, sourceState, runId, repositoryRoot })
{
    if (!producer)
    {
        throw new Error(`missing producer receipt: ${declaration.owner}`);
    }
    if (producer.schema !== privacyPrebuildProducerSchema || producer.status !== 'success')
    {
        throw new Error(`invalid producer receipt: ${declaration.owner}`);
    }
    if (producer.producerId !== declaration.owner || producer.runId !== runId)
    {
        throw new Error(`producer identity or run mismatch: ${declaration.owner}`);
    }
    requireSourceState(producer.sourceState, sourceState);
    if (producer.contentDigest !== privacyPrebuildDigest(producer))
    {
        throw new Error(`producer content digest mismatch: ${declaration.owner}`);
    }
    const assertions = new Map((producer.assertions ?? []).map(assertion => [assertion.id, assertion]));
    unique((producer.assertions ?? []).map(assertion => assertion.id), `producer assertion in ${declaration.owner}`);
    for (const id of declaration.requiredAssertionIds)
    {
        const assertion = assertions.get(id);
        if (!assertion)
        {
            throw new Error(`producer ${declaration.owner} is missing required assertion: ${id}`);
        }
        if (assertion.outcome !== 'Passed')
        {
            throw new Error(`producer assertion did not pass: ${id}`);
        }
    }
    const artifacts = new Map((producer.artifacts ?? []).map(artifact => [artifact.id, artifact]));
    unique((producer.artifacts ?? []).map(artifact => artifact.id), `producer artifact in ${declaration.owner}`);
    for (const required of declaration.requiredArtifacts ?? [])
    {
        const artifact = artifacts.get(required.id);
        if (!artifact || artifact.path !== required.path)
        {
            throw new Error(`producer artifact is missing or has wrong path: ${required.id}`);
        }
        const absolute = path.resolve(repositoryRoot, artifact.path);
        const root = path.resolve(repositoryRoot);
        if (!absolute.startsWith(`${root}${path.sep}`) || !fs.statSync(absolute).isFile())
        {
            throw new Error(`producer artifact is invalid: ${required.id}`);
        }
        if (sha256File(absolute) !== artifact.digest)
        {
            throw new Error(`artifact digest mismatch: ${required.id}`);
        }
    }
    return {
        id: declaration.owner,
        receipt: receiptPath,
        receiptContentDigest: producer.contentDigest,
        assertionIds: [...declaration.requiredAssertionIds].sort(),
        artifactDigests: Object.fromEntries((declaration.requiredArtifacts ?? []).map(required =>
        {
            return [required.id, artifacts.get(required.id).digest];
        }).sort(([left], [right]) => left.localeCompare(right)))
    };
}

export function projectPrivacyZkPrebuild({
    registry,
    receipts,
    receiptPaths,
    sourceState,
    runId,
    uniqueOutcomes,
    repositoryRoot,
    generatedAt = new Date().toISOString()
})
{
    validateRegistry(registry);
    for (const declaration of registry.uniqueAssertions)
    {
        if (uniqueOutcomes.get(declaration.id) !== 'Passed')
        {
            throw new Error(`unique assertion did not pass: ${declaration.id}`);
        }
    }
    const producers = registry.sharedAssertions.map(declaration => validateProducer({
        producer: receipts.get(declaration.owner),
        declaration,
        receiptPath: receiptPaths.get(declaration.owner),
        sourceState,
        runId,
        repositoryRoot
    })).sort((left, right) => left.id.localeCompare(right.id));
    const assertionIds = [...registry.uniqueAssertions, ...registry.sharedAssertions].map(entry => entry.id).sort();
    const coverageIds = [...new Set([...registry.uniqueAssertions, ...registry.sharedAssertions]
        .flatMap(entry => entry.coverageIds ?? []))].sort();
    const receipt = {
        schema: privacyPrebuildProjectionSchema,
        status: 'success',
        stage: 'contract-prebuild',
        tierId: registry.tierId,
        runId,
        sourceState,
        assertionIds,
        uniqueAssertionIds: registry.uniqueAssertions.map(entry => entry.id).sort(),
        projectedAssertionIds: registry.sharedAssertions.map(entry => entry.id).sort(),
        coverageIds,
        producers,
        executionBoundary: {
            sharedCheckerLaunchCount: 0,
            debugBackendBuildCount: 0,
            dotnetTestLaunchCount: 0,
            vitestLaunchCount: 0
        },
        generatedAt
    };
    return { ...receipt, contentDigest: privacyPrebuildDigest(receipt) };
}
