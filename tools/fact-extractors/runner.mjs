import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
    computeConsumedInputDigests,
    digestPath,
    sealSourceIdentity,
    validateBuildIdentity
} from './identity.mjs';
import { digestValue } from './lib/canonicalize.mjs';
import {
    buildReceipt,
    loadReceiptFromFile,
    semanticDigestFromReceipt,
    validateReceipt
} from './receipt.mjs';
import {
    getExtractor,
    importExtractorModule,
    loadRegistry,
    root,
    validateOwnershipAgainstBehaviorCatalog,
    validateRegistry
} from './registry.mjs';

const fail = (message) =>
{
    throw new Error(`[fact-extractor-runner] ${message}`);
};

function cacheDirectory(repositoryRoot)
{
    return path.join(repositoryRoot, '.tmp', 'fact-observation-receipts');
}

function cachePath(repositoryRoot, cacheKey)
{
    return path.join(cacheDirectory(repositoryRoot), `${cacheKey}.json`);
}

export function computeExecutionCacheKey({
    extractorId,
    registryDigest,
    extractorDigest,
    consumedInputDigests,
    sourceCommit,
    worktreeFingerprint,
    buildIdentity
})
{
    return digestValue({
        extractorId,
        registryDigest,
        extractorDigest,
        consumedInputDigests,
        sourceCommit,
        worktreeFingerprint,
        buildIdentity
    });
}

function normalizeExtractorResult(result, extractor)
{
    if (result == null || typeof result !== 'object' || Array.isArray(result))
    {
        fail(`${extractor.id} extract() must return an object`);
    }
    const status = result.status;
    const failureReasons = Array.isArray(result.failureReasons) ? result.failureReasons.map(String) : [];
    const observations = result.observations;
    if (status === 'warning' || status === 'partial' || status === 'unknown')
    {
        fail(`${extractor.id} returned non-admitted status ${status}`);
    }
    if (Object.hasOwn(result, 'warning') || Object.hasOwn(result, 'warnings') || Object.hasOwn(result, 'partial'))
    {
        fail(`${extractor.id} must not emit warning/partial fields`);
    }
    if (status === 'ok')
    {
        if (failureReasons.length > 0)
        {
            fail(`${extractor.id} status=ok with failureReasons`);
        }
        if (observations == null || typeof observations !== 'object' || Object.keys(observations).length === 0)
        {
            fail(`${extractor.id} empty observations cannot be status=ok`);
        }
        return { status: 'ok', failureReasons: [], observations };
    }
    if (status === 'failed')
    {
        if (failureReasons.length === 0)
        {
            fail(`${extractor.id} status=failed without failureReasons`);
        }
        return {
            status: 'failed',
            failureReasons,
            observations: observations && typeof observations === 'object' ? observations : {}
        };
    }
    fail(`${extractor.id} extract() status must be ok or failed`);
}

/**
 * Execute one extractor and produce a source-bound FactObservationReceipt.
 * Cache optimizes execution only; it is never fact authority.
 */
export async function runExtractor({
    extractorId,
    repositoryRoot = root,
    registry = loadRegistry(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json')),
    buildIdentity = null,
    buildReceiptPath = null,
    useCache = true,
    cacheRoot = null
} = {})
{
    const { digest: registryDigest } = validateRegistry(registry, repositoryRoot);
    const extractor = getExtractor(registry, extractorId);
    const identity = sealSourceIdentity(repositoryRoot);
    const normalizedBuildIdentity = validateBuildIdentity(buildIdentity, extractor.requiredBuildArtifact, {
        repositoryRoot,
        receiptPath: buildReceiptPath,
        expectedSourceIdentity: identity
    });

    if (extractor.hermeticPolicy === 'exact-build-receipt' && normalizedBuildIdentity == null)
    {
        fail(`${extractorId} requires exact build receipt identity`);
    }

    const consumedInputDigests = computeConsumedInputDigests(repositoryRoot, extractor.consumedInputs);
    const extractorDigest = digestPath(repositoryRoot, extractor.entrypoint);
    const cacheKey = computeExecutionCacheKey({
        extractorId,
        registryDigest,
        extractorDigest,
        consumedInputDigests,
        sourceCommit: identity.sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint,
        buildIdentity: normalizedBuildIdentity
    });

    const cacheDir = cacheRoot ?? cacheDirectory(repositoryRoot);
    const cachedFile = path.join(cacheDir, `${cacheKey}.json`);
    if (useCache && existsSync(cachedFile))
    {
        const cached = loadReceiptFromFile(cachedFile);
        try
        {
            validateReceipt(cached, {
                repositoryRoot,
                expectedSourceCommit: identity.sourceCommit,
                expectedWorktreeFingerprint: identity.worktreeFingerprint,
                expectedRegistryDigest: registryDigest,
                expectedInputDigests: consumedInputDigests
            });
            if (cached.extractorId !== extractorId)
            {
                fail('cache entry extractorId mismatch');
            }
            if (cached.extractorDigest !== extractorDigest)
            {
                fail('cache entry extractorDigest mismatch');
            }
            if (digestValue(cached.buildIdentity) !== digestValue(normalizedBuildIdentity))
            {
                fail('cache entry buildIdentity mismatch');
            }
            return { receipt: cached, cacheHit: true, cacheKey };
        }
        catch (error)
        {
            // Input or worktree drift: refuse stale authority, recompute.
            if (!String(error.message).includes('mismatch') && !String(error.message).includes('rejected'))
            {
                throw error;
            }
        }
    }

    const module = await importExtractorModule(repositoryRoot, extractor.entrypoint);
    const raw = await module.extract({
        repositoryRoot,
        extractor,
        consumedInputDigests,
        buildIdentity: normalizedBuildIdentity,
        sourceCommit: identity.sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint
    });
    const normalized = normalizeExtractorResult(raw, extractor);

    const receipt = buildReceipt({
        extractorId: extractor.id,
        behaviorIds: extractor.ownedBehaviorIds,
        sourceCommit: identity.sourceCommit,
        worktreeFingerprint: identity.worktreeFingerprint,
        buildIdentity: normalizedBuildIdentity,
        extractorDigest,
        registryDigest,
        consumedInputDigests,
        observations: normalized.observations,
        status: normalized.status,
        failureReasons: normalized.failureReasons
    });

    if (useCache)
    {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cachedFile, `${JSON.stringify(receipt, null, 2)}\n`);
    }

    return { receipt, cacheHit: false, cacheKey };
}

export async function runAllExtractors(options = {})
{
    const repositoryRoot = options.repositoryRoot ?? root;
    const registry = options.registry ?? loadRegistry(path.join(repositoryRoot, 'config/contracts/behavior-fact-extractors.json'));
    validateOwnershipAgainstBehaviorCatalog(registry, options.catalog, repositoryRoot);
    const receipts = [];
    for (const extractor of registry.extractors)
    {
        const result = await runExtractor({
            ...options,
            extractorId: extractor.id,
            repositoryRoot,
            registry
        });
        receipts.push(result);
    }
    return receipts;
}

export function assertDeterministicSemanticDigest(firstReceipt, secondReceipt)
{
    const first = semanticDigestFromReceipt(firstReceipt);
    const second = semanticDigestFromReceipt(secondReceipt);
    if (first !== second)
    {
        fail(`semantic digests diverged for identical inputs: ${first} vs ${second}`);
    }
    return first;
}

export { cachePath, cacheDirectory };
