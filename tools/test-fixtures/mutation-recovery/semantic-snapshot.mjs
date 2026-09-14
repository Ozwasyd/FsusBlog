import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { validateFixtureReceipt } = await import(new URL('../receipt/fixture-receipt.mjs', import.meta.url));
const { catalogContentDigest, loadCanonicalMutationEnvelopeCatalog } = await import(new URL('../mutation-envelope-catalog.mjs', import.meta.url));
import {
    canonicalJson,
    digest,
    requireDigest,
    requireStableId,
    seal,
    verifySeal
} from './canonical.mjs';

export const semanticSnapshotSchema = 'fsusblog.fixture-semantic-snapshot.v1';
export const semanticDiffSchema = 'fsusblog.fixture-semantic-diff.v1';
export const snapshotRequestSchema = 'fsusblog.fixture-semantic-snapshot-request.v1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPolicyPath = path.join(root, 'config/testing/fixture-semantic-snapshot-policy.json');

function loadSnapshotPolicy()
{
    const policy = JSON.parse(fs.readFileSync(snapshotPolicyPath, 'utf8'));
    if (policy.schema !== 'fsusblog.fixture-semantic-snapshot-policy.v1'
      || policy.version !== 1
      || !Array.isArray(policy.fieldDispositions)
      || !Array.isArray(policy.recordKinds)
      || !Array.isArray(policy.nonownedSentinelDomains))
    {
        throw new Error('fixture semantic snapshot policy is invalid');
    }
    return policy;
}

export const fieldDispositions = Object.freeze([...loadSnapshotPolicy().fieldDispositions]);

const recordKinds = Object.freeze([...loadSnapshotPolicy().recordKinds]);

function exactIdentity(receipt)
{
    return {
        runId: receipt.executionIdentity.runId,
        namespace: receipt.executionIdentity.namespace,
        source: receipt.executionIdentity.source,
        serviceGeneration: receipt.executionIdentity.serviceGeneration,
        serviceIdentity: receipt.serviceIdentity
    };
}

export function buildSnapshotRequest({
    receipt,
    producerPlanDigest,
    mutationCatalog = loadCanonicalMutationEnvelopeCatalog(),
    provider,
    runtimeIdentity,
    temporalContextDigest,
    purpose
})
{
    validateFixtureReceipt(receipt, { requireVerified: true });
    requireDigest(producerPlanDigest, 'producerPlanDigest');
    requireDigest(runtimeIdentity?.digest, 'runtimeIdentity.digest');
    requireDigest(temporalContextDigest, 'temporalContextDigest');
    if (!mutationCatalog.providers.includes(provider))
    {
        throw new Error(`unknown snapshot provider ${provider}`);
    }
    if (!['baseline', 'mutated', 'reprepared'].includes(purpose))
    {
        throw new Error(`unknown snapshot purpose ${purpose}`);
    }
    const snapshotPolicy = loadSnapshotPolicy();
    return seal({
        schema: snapshotRequestSchema,
        purpose,
        provider,
        profileId: receipt.profileIdentity.profileId,
        fixtureReceiptDigest: receipt.receiptDigest,
        fixtureCatalogDigest: receipt.catalogDigest,
        mutationCatalogDigest: catalogContentDigest(mutationCatalog),
        snapshotPolicyDigest: digest(snapshotPolicy),
        producerPlanDigest,
        temporalContextDigest,
        identity: exactIdentity(receipt),
        runtimeIdentity
    });
}

function normalizeSecret(value, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.redacted !== true
      || !['absent', 'binary', 'string'].includes(value.type)
      || typeof value.present !== 'boolean')
    {
        throw new Error(`${label} secret-redacted value must expose only presence, type and digest`);
    }
    if (value.present)
    {
        requireDigest(value.digest, `${label}.digest`);
    }
    const keys = Object.keys(value).sort();
    const allowed = ['digest', 'present', 'redacted', 'type'];
    if (keys.some((key) => !allowed.includes(key)))
    {
        throw new Error(`${label} secret-redacted value contains plaintext or an unknown field`);
    }
    return {
        redacted: true,
        present: value.present,
        type: value.type,
        digest: value.present ? value.digest : null
    };
}

function normalizeField(field, label)
{
    const keys = Object.keys(field ?? {}).sort();
    if (keys.some((key) => !['disposition', 'name', 'semanticRole', 'value'].includes(key)))
    {
        throw new Error(`${label} has an unclassified field`);
    }
    const name = requireStableId(field?.name, `${label}.name`);
    if (!fieldDispositions.includes(field?.disposition))
    {
        throw new Error(`${label}.${name} has unknown field disposition`);
    }
    if (/(?:secret|token|password|cookie|authorization|protected-payload)/iu.test(name)
      && field.disposition !== 'secret-redacted')
    {
        throw new Error(`${label}.${name} protected field must be secret-redacted`);
    }
    if (field.disposition === 'semantic' && /(?:^|[-_.])(?:timestamp|time|at)(?:$|[-_.])/u.test(name)
      && !field.semanticRole)
    {
        throw new Error(`${label}.${name} semantic timestamp requires a #1730 semanticRole`);
    }
    let value = field.disposition === 'secret-redacted'
        ? normalizeSecret(field.value, `${label}.${name}`)
        : field.value;
    if (field.disposition === 'semantic' && field.semanticRole && typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value))
    {
        value = value.replace(/\.(\d*?[1-9])0+Z$/u, '.$1Z').replace(/\.0+Z$/u, 'Z');
    }
    return {
        name,
        disposition: field.disposition,
        semanticRole: field.semanticRole == null ? null : requireStableId(field.semanticRole, `${label}.${name}.semanticRole`),
        value
    };
}

function semanticFields(fields, label)
{
    if (!Array.isArray(fields))
    {
        throw new Error(`${label}.fields must be an array`);
    }
    const normalized = fields.map((field, index) => normalizeField(field, `${label}.fields[${index}]`));
    const names = normalized.map((field) => field.name);
    if (new Set(names).size !== names.length)
    {
        throw new Error(`${label}.fields contains duplicate names`);
    }
    return normalized
        .filter((field) => ['semantic', 'secret-redacted'].includes(field.disposition))
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeSemanticRecord(record, index = 0)
{
    const label = `records[${index}]`;
    if (!recordKinds.includes(record?.kind))
    {
        throw new Error(`${label}.kind is not closed`);
    }
    const domain = requireStableId(record.domain, `${label}.domain`);
    const role = requireStableId(record.role, `${label}.role`);
    const stableId = requireStableId(record.stableId, `${label}.stableId`);
    if (typeof record.owned !== 'boolean')
    {
        throw new Error(`${label}.owned must be boolean`);
    }
    const normalized = {
        kind: record.kind,
        domain,
        role,
        stableId,
        owned: record.owned,
        fields: semanticFields(record.fields, label)
    };
    if (record.kind === 'file')
    {
        if (typeof record.relativePath !== 'string' || record.relativePath.startsWith('/')
          || record.relativePath.split('/').includes('..'))
        {
            throw new Error(`${label}.relativePath must remain fixture-root relative`);
        }
        normalized.relativePath = record.relativePath;
        requireDigest(record.byteDigest, `${label}.byteDigest`);
        normalized.byteDigest = record.byteDigest;
        normalized.byteLength = Number(record.byteLength);
    }
    if (record.kind === 'redis-key')
    {
        if (!Number.isInteger(record.ttlMilliseconds) || record.ttlMilliseconds < -1)
        {
            throw new Error(`${label}.ttlMilliseconds must preserve exact TTL semantics`);
        }
        normalized.ttlMilliseconds = record.ttlMilliseconds;
        normalized.generation = requireStableId(record.generation, `${label}.generation`);
    }
    return normalized;
}

function recordKey(record)
{
    return `${record.owned ? 'owned' : 'sentinel'}:${record.kind}:${record.domain}:${record.role}:${record.stableId}`;
}

function semanticRecordDigest(record)
{
    return digest(record);
}

async function *asAsync(records)
{
    for (const record of records ?? [])
    {
        yield record;
    }
}

export async function createSemanticSnapshot({
    request,
    receipt,
    observe,
    shardSize = 2048,
    shardWriter = null,
    retainShards = true
})
{
    verifySeal(request, 'contentDigest', 'snapshot request');
    const snapshotPolicy = loadSnapshotPolicy();
    if (request.snapshotPolicyDigest !== digest(snapshotPolicy)
      || shardSize < 1 || shardSize > snapshotPolicy.maximumShardSize)
    {
        throw new Error('snapshot request policy is stale or shard size is outside policy');
    }
    validateFixtureReceipt(receipt, {
        requireVerified: true,
        expectedProfileId: request.profileId,
        expectedCatalogDigest: request.fixtureCatalogDigest
    });
    if (receipt.receiptDigest !== request.fixtureReceiptDigest
      || canonicalJson(exactIdentity(receipt)) !== canonicalJson(request.identity))
    {
        throw new Error('snapshot request no longer binds the current verified receipt identity');
    }
    if (typeof observe !== 'function')
    {
        throw new Error('snapshot requires the canonical live observer');
    }
    const observation = await observe(request);
    if (canonicalJson(observation?.runtimeIdentity) !== canonicalJson(request.runtimeIdentity)
      || observation?.serviceGeneration !== request.identity.serviceGeneration
      || canonicalJson(observation?.serviceIdentity) !== canonicalJson(request.identity.serviceIdentity))
    {
        throw new Error('DB/Redis/files/API observations are not from the request current runtime');
    }
    const iterator = observation.records?.[Symbol.asyncIterator]
        ? observation.records
        : asAsync(observation.records);
    const shards = [];
    const shardDescriptors = [];
    const mutationCatalog = loadCanonicalMutationEnvelopeCatalog();
    if (request.mutationCatalogDigest !== catalogContentDigest(mutationCatalog))
    {
        throw new Error('snapshot request mutation catalog is stale');
    }
    const ownedDomains = new Set(mutationCatalog.semanticDomains);
    const sentinelDomains = new Set(snapshotPolicy.nonownedSentinelDomains);
    let previousKey = null;
    let shard = [];
    let count = 0;
    async function emitShard()
    {
        shard.sort((left, right) => left.key.localeCompare(right.key));
        const sealedShard = seal({
            index: shardDescriptors.length,
            recordCount: shard.length,
            records: shard
        });
        if (shardWriter)
        {
            await shardWriter(sealedShard);
        }
        if (retainShards)
        {
            shards.push(sealedShard);
        }
        shardDescriptors.push({
            index: sealedShard.index,
            recordCount: sealedShard.recordCount,
            digest: sealedShard.contentDigest
        });
        shard = [];
    }
    for await (const rawRecord of iterator)
    {
        const record = normalizeSemanticRecord(rawRecord, count);
        if (record.owned ? !ownedDomains.has(record.domain) : !sentinelDomains.has(record.domain))
        {
            throw new Error(`snapshot record domain ${record.domain} is outside receipt profile ownership/sentinel policy`);
        }
        const key = recordKey(record);
        if (previousKey != null && key <= previousKey)
        {
            throw new Error(`snapshot contains duplicate or non-canonical semantic record ${key}`);
        }
        previousKey = key;
        shard.push({ key, digest: semanticRecordDigest(record), record });
        count += 1;
        if (shard.length >= shardSize)
        {
            await emitShard();
        }
    }
    if (shard.length > 0)
    {
        await emitShard();
    }
    const manifest = seal({
        schema: semanticSnapshotSchema,
        requestDigest: request.contentDigest,
        fixtureReceiptDigest: receipt.receiptDigest,
        profileId: request.profileId,
        purpose: request.purpose,
        runtimeIdentity: request.runtimeIdentity,
        serviceGeneration: request.identity.serviceGeneration,
        serviceIdentity: request.identity.serviceIdentity,
        recordCount: count,
        shardSize,
        shards: shardDescriptors,
        shardsExternallyStored: !retainShards
    });
    return Object.freeze({ manifest, shards: Object.freeze(shards) });
}

export function verifySemanticSnapshot(snapshot, request)
{
    verifySeal(request, 'contentDigest', 'snapshot request');
    verifySeal(snapshot?.manifest, 'contentDigest', 'semantic snapshot manifest');
    if (snapshot.manifest.requestDigest !== request.contentDigest
      || canonicalJson(snapshot.manifest.runtimeIdentity) !== canonicalJson(request.runtimeIdentity))
    {
        throw new Error('semantic snapshot identity mismatch');
    }
    if (snapshot.manifest.shardsExternallyStored && snapshot.shards.length === 0
      && snapshot.manifest.shards.length > 0)
    {
        throw new Error('semantic snapshot verifier requires independently re-read external shards');
    }
    const seen = new Set();
    let count = 0;
    for (const [index, shard] of (snapshot.shards ?? []).entries())
    {
        verifySeal(shard, 'contentDigest', `semantic snapshot shard ${index}`);
        const declared = snapshot.manifest.shards[index];
        if (!declared || declared.index !== index || declared.digest !== shard.contentDigest
          || declared.recordCount !== shard.records.length)
        {
            throw new Error(`semantic snapshot shard ${index} does not match manifest`);
        }
        for (const [recordIndex, item] of shard.records.entries())
        {
            const record = normalizeSemanticRecord(item.record, recordIndex);
            if (item.key !== recordKey(record) || item.digest !== semanticRecordDigest(record)
              || seen.has(item.key))
            {
                throw new Error(`semantic snapshot record ${item.key} is tampered or duplicated`);
            }
            seen.add(item.key);
            count += 1;
        }
    }
    if (count !== snapshot.manifest.recordCount
      || snapshot.shards.length !== snapshot.manifest.shards.length)
    {
        throw new Error('semantic snapshot inventory is incomplete');
    }
    return snapshot;
}

export async function verifyExternalSemanticSnapshot(snapshot, request, shardReader)
{
    if (!snapshot?.manifest?.shardsExternallyStored || typeof shardReader !== 'function')
    {
        throw new Error('external semantic snapshot requires its exact shard reader');
    }
    const shards = [];
    for (const descriptor of snapshot.manifest.shards)
    {
        const shard = await shardReader(descriptor);
        if (shard?.contentDigest !== descriptor.digest)
        {
            throw new Error(`external semantic snapshot shard ${descriptor.index} digest mismatch`);
        }
        shards.push(shard);
    }
    return verifySemanticSnapshot({ manifest: snapshot.manifest, shards }, request);
}

function recordMap(snapshot)
{
    return new Map(snapshot.shards.flatMap((shard) => shard.records.map((item) => [item.key, item])));
}

function changeDetails(before, after)
{
    if (!before)
    {
        return { kind: 'extra', afterDigest: after.digest };
    }
    if (!after)
    {
        return { kind: 'missing', beforeDigest: before.digest };
    }
    const beforeFields = new Map(before.record.fields.map((field) => [field.name, field]));
    const afterFields = new Map(after.record.fields.map((field) => [field.name, field]));
    const fieldChanges = [...new Set([...beforeFields.keys(), ...afterFields.keys()])].sort()
        .filter((field) => canonicalJson(beforeFields.get(field)) !== canonicalJson(afterFields.get(field)));
    const details = { kind: 'changed', beforeDigest: before.digest, afterDigest: after.digest, fieldChanges };
    if (before.record.kind === 'relation')
    {
        details.relationChanges = fieldChanges;
    }
    if (before.record.kind === 'redis-key')
    {
        details.ttlChanged = before.record.ttlMilliseconds !== after.record.ttlMilliseconds;
        details.generationChanged = before.record.generation !== after.record.generation;
    }
    if (before.record.kind === 'file')
    {
        details.byteChanged = before.record.byteDigest !== after.record.byteDigest;
    }
    if (before.record.kind === 'api-projection')
    {
        details.projectionChanges = fieldChanges;
    }
    return details;
}

function allowedSignatures(envelope)
{
    const result = [];
    for (const target of envelope?.allowedChanges?.entities ?? [])
    {
        for (const field of target.fields)
        {
            result.push(`entity:${target.domain}:${target.kind}:${field}`);
        }
    }
    for (const target of envelope?.allowedChanges?.redisKeys ?? [])
    {
        result.push(`redis-key:${target.domain}:${target.keyRole}`);
    }
    for (const target of envelope?.allowedChanges?.cacheEntries ?? [])
    {
        result.push(`redis-key:${target.domain}:${target.generationRole}`);
    }
    for (const target of envelope?.allowedChanges?.ownedFiles ?? [])
    {
        result.push(`file:${target.domain}:${target.role}`);
    }
    return new Set(result);
}

function changeIsAllowed(change, allowlist)
{
    const kind = change.recordKind;
    if (kind === 'entity')
    {
        if (['missing', 'extra'].includes(change.details.kind))
        {
            return [...allowlist].some((signature) =>
                signature.startsWith(`${kind}:${change.domain}:${change.role}:`));
        }
        return change.details.fieldChanges.length > 0
          && change.details.fieldChanges.every((field) => allowlist.has(`${kind}:${change.domain}:${change.role}:${field}`));
    }
    return allowlist.has(`${kind}:${change.domain}:${change.role}`);
}

export function compareSemanticSnapshots({ baseline, candidate, baselineRequest, candidateRequest, envelope = null })
{
    verifySemanticSnapshot(baseline, baselineRequest);
    verifySemanticSnapshot(candidate, candidateRequest);
    const identityMismatch = canonicalJson(baseline.manifest.runtimeIdentity)
      !== canonicalJson(candidate.manifest.runtimeIdentity)
      || baseline.manifest.serviceGeneration !== candidate.manifest.serviceGeneration
      || canonicalJson(baseline.manifest.serviceIdentity) !== canonicalJson(candidate.manifest.serviceIdentity);
    const before = recordMap(baseline);
    const after = recordMap(candidate);
    const changes = [];
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort())
    {
        const left = before.get(key);
        const right = after.get(key);
        if (left?.digest === right?.digest)
        {
            continue;
        }
        const record = left?.record ?? right.record;
        changes.push({
            key,
            owned: record.owned,
            recordKind: record.kind,
            domain: record.domain,
            role: record.role,
            details: changeDetails(left, right)
        });
    }
    const allowed = allowedSignatures(envelope);
    const expectedDrift = envelope == null ? [] : changes.filter((change) => change.owned && changeIsAllowed(change, allowed));
    const unexpectedDrift = envelope == null
        ? changes
        : changes.filter((change) => !change.owned || !changeIsAllowed(change, allowed));
    const reasons = [];
    if (identityMismatch)
    {
        reasons.push('runtime-or-service-identity-mismatch');
    }
    if (unexpectedDrift.length > 0)
    {
        reasons.push('unexpected-or-nonowned-drift');
    }
    if (envelope != null && expectedDrift.length === 0)
    {
        reasons.push('declared-target-not-mutated');
    }
    const body = {
        schema: semanticDiffSchema,
        baselineDigest: baseline.manifest.contentDigest,
        candidateDigest: candidate.manifest.contentDigest,
        envelopeDigest: envelope?.contentDigest ?? null,
        identityMismatch,
        expectedDrift,
        unexpectedDrift,
        missing: changes.filter((item) => item.details.kind === 'missing'),
        extra: changes.filter((item) => item.details.kind === 'extra'),
        fieldChanges: changes.filter((item) => item.details.fieldChanges?.length > 0),
        relationChanges: changes.filter((item) => item.details.relationChanges?.length > 0),
        versionChanges: changes.filter((item) => item.details.fieldChanges?.some((field) => /version/u.test(field))),
        ttlChanges: changes.filter((item) => item.details.ttlChanged),
        byteChanges: changes.filter((item) => item.details.byteChanged),
        projectionChanges: changes.filter((item) => item.details.projectionChanges?.length > 0),
        status: reasons.length === 0 ? 'verified' : 'failed',
        reasons
    };
    return seal(body);
}

export function verifySemanticDiff(diff, { requireExpectedDrift = false, requireExactRecovery = false } = {})
{
    verifySeal(diff, 'contentDigest', 'semantic diff');
    const expectedReasons = [];
    if (diff.identityMismatch)
    {
        expectedReasons.push('runtime-or-service-identity-mismatch');
    }
    if (diff.unexpectedDrift.length > 0)
    {
        expectedReasons.push('unexpected-or-nonowned-drift');
    }
    if (diff.envelopeDigest != null && diff.expectedDrift.length === 0)
    {
        expectedReasons.push('declared-target-not-mutated');
    }
    if (canonicalJson(diff.reasons) !== canonicalJson(expectedReasons)
      || diff.status !== (expectedReasons.length === 0 ? 'verified' : 'failed'))
    {
        throw new Error('semantic diff status/reasons do not match independently recomputed changes');
    }
    if (diff.identityMismatch)
    {
        throw new Error('semantic diff mixes runtime/service identities');
    }
    if (diff.unexpectedDrift.length > 0)
    {
        throw new Error('semantic diff contains unexpected or nonowned drift');
    }
    if (requireExpectedDrift && diff.expectedDrift.length === 0)
    {
        throw new Error('declared mutation target did not change');
    }
    if (requireExactRecovery && (diff.expectedDrift.length > 0 || diff.unexpectedDrift.length > 0))
    {
        throw new Error('reprepared semantic state does not exactly equal baseline');
    }
    return diff;
}
