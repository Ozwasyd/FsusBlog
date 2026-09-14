import fs from 'node:fs';
import path from 'node:path';

const {validateFixtureReceipt} = await import(new URL('../receipt/fixture-receipt.mjs', import.meta.url));
const {catalogContentDigest, loadCanonicalMutationEnvelopeCatalog} = await import(new URL('../mutation-envelope-catalog.mjs', import.meta.url));
import { canonicalJson, digest, requireStableId, seal, verifySeal } from './canonical.mjs';
import {
    compareSemanticSnapshots,
    verifySemanticDiff,
    verifySemanticSnapshot
} from './semantic-snapshot.mjs';

export const mutationRequestSchema = 'fsusblog.fixture-mutation-request.v1';
export const mutationJournalSchema = 'fsusblog.fixture-mutation-journal.v1';

const databaseProviders = new Set(['postgresql', 'mysql', 'sqlite']);

function envelopeById(catalog, envelopeId)
{
    const envelope = catalog.envelopes.find((item) => item.envelopeId === envelopeId);
    if (!envelope)
    {
        throw new Error(`unknown mutation envelope ${envelopeId}`);
    }
    return envelope;
}

function snapshotRecords(snapshot)
{
    return snapshot.shards.flatMap((shard) => shard.records.map((item) => item.record));
}

function selectTargets(snapshot, envelope, provider)
{
    const records = snapshotRecords(snapshot);
    let targets;
    if (databaseProviders.has(provider))
    {
        targets = (envelope.semanticTargets.entities ?? []).map((target) =>
        {
            const matches = records.filter((record) => record.owned && record.kind === 'entity'
              && record.domain === target.domain && record.role === target.kind);
            if (matches.length !== 1)
            {
                throw new Error(`mutation target ${target.domain}/${target.kind} is missing or ambiguous`);
            }
            const available = new Set(matches[0].fields.map((field) => field.name));
            if (target.fields.some((field) => !available.has(field)))
            {
                throw new Error(`mutation target ${target.domain}/${target.kind} field is missing`);
            }
            return { ...target, stableId: matches[0].stableId, beforeDigest: digest(matches[0]) };
        });
    }
    else if (provider === 'redis')
    {
        const semanticTargets = [
            ...(envelope.semanticTargets.redisKeys ?? []).map((item) => ({ ...item, role: item.keyRole })),
            ...(envelope.semanticTargets.cacheEntries ?? []).map((item) => ({ ...item, role: item.generationRole }))
        ];
        targets = semanticTargets.map((target) =>
        {
            const matches = records.filter((record) => record.owned && record.kind === 'redis-key'
              && record.domain === target.domain && record.role === target.role);
            if (matches.length !== 1)
            {
                throw new Error(`Redis mutation target ${target.domain}/${target.role} is missing or ambiguous`);
            }
            // eslint-disable-next-line no-useless-escape
            if (/[*?\[\]]/u.test(matches[0].stableId))
            {
                throw new Error('Redis mutation refuses wildcard target identity');
            }
            return {
                domain: target.domain,
                role: target.role,
                stableId: matches[0].stableId,
                ttlMilliseconds: matches[0].ttlMilliseconds,
                generation: matches[0].generation,
                beforeDigest: digest(matches[0])
            };
        });
    }
    else if (provider === 'filesystem')
    {
        targets = (envelope.semanticTargets.ownedFiles ?? []).map((target) =>
        {
            const matches = records.filter((record) => record.owned && record.kind === 'file'
              && record.domain === target.domain && record.role === target.role);
            if (matches.length !== 1)
            {
                throw new Error(`filesystem mutation target ${target.domain}/${target.role} is missing or ambiguous`);
            }
            return {
                ...target,
                stableId: matches[0].stableId,
                relativePath: matches[0].relativePath,
                beforeDigest: digest(matches[0])
            };
        });
    }
    else
    {
        throw new Error(`unknown mutation provider ${provider}`);
    }
    if (targets.length === 0)
    {
        throw new Error(`envelope ${envelope.envelopeId} has no ${provider} target`);
    }
    return targets;
}

export function buildMutationRequest({
    receipt,
    baseline,
    baselineRequest,
    envelopeId,
    provider,
    attemptId,
    catalog = loadCanonicalMutationEnvelopeCatalog()
})
{
    validateFixtureReceipt(receipt, { requireVerified: true });
    verifySemanticSnapshot(baseline, baselineRequest);
    const envelope = envelopeById(catalog, envelopeId);
    if (baseline.manifest.fixtureReceiptDigest !== receipt.receiptDigest
      || baseline.manifest.purpose !== 'baseline')
    {
        throw new Error('mutation requires the verified pre-mutation snapshot');
    }
    if (!envelope.targetProfileIds.includes(receipt.profileIdentity.profileId))
    {
        throw new Error('mutation envelope does not target the current profile');
    }
    if (envelope.providerSupport[provider] !== true)
    {
        throw new Error(`provider ${provider} is unsupported for ${envelopeId}`);
    }
    const targets = selectTargets(baseline, envelope, provider);
    return seal({
        schema: mutationRequestSchema,
        attemptId: requireStableId(attemptId, 'attemptId'),
        runId: receipt.executionIdentity.runId,
        namespace: receipt.executionIdentity.namespace,
        profileId: receipt.profileIdentity.profileId,
        source: receipt.executionIdentity.source,
        serviceGeneration: receipt.executionIdentity.serviceGeneration,
        serviceIdentity: receipt.serviceIdentity,
        runtimeIdentity: baseline.manifest.runtimeIdentity,
        receiptDigest: receipt.receiptDigest,
        snapshotDigest: baseline.manifest.contentDigest,
        catalogDigest: catalogContentDigest(catalog),
        envelopeId,
        envelopeDigest: envelope.contentDigest,
        mutationKind: envelope.mutationKind,
        provider,
        targets
    });
}

function validateAdapterPort(port, provider)
{
    if (!port || typeof port.applyMutation !== 'function'
      || typeof port.restoreMutation !== 'function'
      || typeof port.recoverInterruptedAttempt !== 'function'
      || typeof port.verifyIdentity !== 'function')
    {
        throw new Error(`${provider} mutation adapter port is incomplete`);
    }
}

function assertFilesystemConfinement(port, targets)
{
    if (typeof port.fixtureRootRealPath !== 'string' || !path.isAbsolute(port.fixtureRootRealPath))
    {
        throw new Error('filesystem adapter requires the canonical fixture root realpath');
    }
    for (const target of targets)
    {
        const resolved = path.resolve(port.fixtureRootRealPath, target.relativePath);
        const relative = path.relative(port.fixtureRootRealPath, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        {
            throw new Error('filesystem mutation target escapes or aliases fixture root');
        }
        const actual = port.realPath(target.relativePath);
        if (actual !== resolved)
        {
            throw new Error('filesystem mutation target has a symlink, junction or reparse escape');
        }
    }
}

export async function applyFixtureMutation({
    request,
    baseline,
    baselineRequest,
    envelope,
    port,
    observeMutated
})
{
    verifySeal(request, 'contentDigest', 'mutation request');
    verifySemanticSnapshot(baseline, baselineRequest);
    validateAdapterPort(port, request.provider);
    if (request.snapshotDigest !== baseline.manifest.contentDigest
      || request.envelopeDigest !== envelope.contentDigest)
    {
        throw new Error('mutation request snapshot or envelope is stale');
    }
    await port.verifyIdentity({
        runId: request.runId,
        namespace: request.namespace,
        source: request.source,
        serviceGeneration: request.serviceGeneration,
        serviceIdentity: request.serviceIdentity,
        runtimeIdentity: request.runtimeIdentity
    });
    if (request.provider === 'filesystem')
    {
        assertFilesystemConfinement(port, request.targets);
    }
    if (request.provider === 'redis'
      // eslint-disable-next-line no-useless-escape
      && request.targets.some((target) => /[*?\[\]]/u.test(String(target.stableId))))
    {
        throw new Error('Redis mutation refuses wildcard target identity');
    }
    let application;
    try
    {
        application = await port.applyMutation({
            attemptId: request.attemptId,
            requestDigest: request.contentDigest,
            operationId: request.mutationKind,
            targets: request.targets
        });
    }
    catch (error)
    {
        try
        {
            await port.recoverInterruptedAttempt({
                attemptId: request.attemptId,
                requestDigest: request.contentDigest
            });
        }
        catch (recoveryError)
        {
            error.recoveryObligation = {
                attemptId: request.attemptId,
                requestDigest: request.contentDigest,
                reason: recoveryError.message
            };
        }
        throw new Error(`mutation adapter failed before journal commit: ${error.message}`, { cause: error });
    }
    if (application?.duplicateApplied === true)
    {
        throw new Error('mutation adapter did not return an exact recoverable single-attempt result');
    }
    if (!application || application.requestDigest !== request.contentDigest
      || typeof application.recoveryRef !== 'string'
      || !/^recovery:[a-z0-9][a-z0-9._-]*$/u.test(application.recoveryRef)
      || (application.transactionRef != null
        && !/^transaction:[a-z0-9][a-z0-9._-]*$/u.test(application.transactionRef)))
    {
        await port.recoverInterruptedAttempt({
            attemptId: request.attemptId,
            requestDigest: request.contentDigest
        });
        throw new Error('mutation adapter did not return an exact recoverable single-attempt result');
    }
    let mutated;
    let diff;
    try
    {
        mutated = await observeMutated();
        diff = compareSemanticSnapshots({
            baseline,
            candidate: mutated.snapshot,
            baselineRequest,
            candidateRequest: mutated.request,
            envelope
        });
        verifySemanticDiff(diff, { requireExpectedDrift: true });
    }
    catch (error)
    {
        await port.restoreMutation({
            attemptId: request.attemptId,
            requestDigest: request.contentDigest,
            recoveryRef: application.recoveryRef
        });
        throw error;
    }
    return seal({
        schema: mutationJournalSchema,
        attemptId: request.attemptId,
        requestDigest: request.contentDigest,
        envelopeId: request.envelopeId,
        envelopeDigest: request.envelopeDigest,
        provider: request.provider,
        targetRefs: request.targets.map((target) => ({
            domain: target.domain,
            stableIdDigest: digest(target.stableId),
            beforeDigest: target.beforeDigest
        })),
        transactionRef: application.transactionRef ?? null,
        recoveryRef: application.recoveryRef,
        mutatedSnapshotDigest: mutated.snapshot.manifest.contentDigest,
        semanticDiffDigest: diff.contentDigest,
        status: 'expected-drift-verified',
        reasons: []
    });
}

export function writeMutationJournal(file, journal)
{
    verifySeal(journal, 'contentDigest', 'mutation journal');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try
    {
        fs.writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
    return file;
}

export function readMutationJournal(file)
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    {
        throw new Error('mutation journal must be a private regular append-only artifact');
    }
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    return verifySeal(journal, 'contentDigest', 'mutation journal');
}

export async function verifyMutationJournal({ journal, request, port, mutated, mutatedRequest, baseline, baselineRequest, envelope })
{
    verifySeal(journal, 'contentDigest', 'mutation journal');
    verifySeal(request, 'contentDigest', 'mutation request');
    if (journal.requestDigest !== request.contentDigest
      || journal.envelopeDigest !== envelope.contentDigest
      || journal.mutatedSnapshotDigest !== mutated.manifest.contentDigest)
    {
        throw new Error('mutation journal identity mismatch');
    }
    await port.verifyIdentity({
        runId: request.runId,
        namespace: request.namespace,
        source: request.source,
        serviceGeneration: request.serviceGeneration,
        serviceIdentity: request.serviceIdentity,
        runtimeIdentity: request.runtimeIdentity
    });
    const diff = compareSemanticSnapshots({
        baseline,
        candidate: mutated,
        baselineRequest,
        candidateRequest: mutatedRequest,
        envelope
    });
    verifySemanticDiff(diff, { requireExpectedDrift: true });
    if (diff.contentDigest !== journal.semanticDiffDigest)
    {
        throw new Error('mutation journal does not bind independently recomputed state');
    }
    return journal;
}

export async function restoreFixtureMutation({ journal, request, port })
{
    verifySeal(journal, 'contentDigest', 'mutation journal');
    if (journal.requestDigest !== request.contentDigest)
    {
        throw new Error('cannot restore a mutation from another request');
    }
    return port.restoreMutation({
        attemptId: request.attemptId,
        requestDigest: request.contentDigest,
        recoveryRef: journal.recoveryRef
    });
}

export function mutationRequestIdentity(request)
{
    return digest(canonicalJson(request));
}
