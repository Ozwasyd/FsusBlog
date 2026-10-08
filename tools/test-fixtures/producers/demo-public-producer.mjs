// fixture-catalog: producer development-demo
/** Development demo producer. It only calls the local fixture composition root. */

import { createHash } from 'node:crypto';

import { prepareDemoTemporalBinding } from './demo-temporal-binding.mjs';

const { requireCompleteTemporalEntityBinding, verifyObservedTemporalEntityBusinessFields } = await import(new URL('../temporal-business-fields.mjs', import.meta.url));
const { validateProducerReceipt } = await import(new URL("../receipt/index.mjs", import.meta.url));

const PRODUCER_ID = 'development-demo';
const STRATEGY = 'transaction-fixture';
const DEMO_VARIANT_ID = 'diagnostic.development.demo.dataset';

export function resolveDemoBackendUrl(context)
{
    return String(context.handles?.baseUrl ?? context.handles?.debugBackendUrl ?? process.env.FSUSBLOG_BASE_URL ?? '').replace(/\/+$/u, '');
}

function testSession(context)
{
    const input = `${context.namespace ?? 'local'}\n${context.runIdentity ?? 'default'}`;
    return `demo-${createHash('sha256').update(input).digest('hex').slice(0, 24)}`;
}

function normalizeObservations(raw)
{
    const database = raw?.database ?? raw?.Database;
    const redis = raw?.redis ?? raw?.Redis;
    const cache = raw?.cache ?? raw?.Cache;
    return {
        source: raw?.source ?? raw?.Source ?? 'service',
        database: database && {
            namespace: database.namespace ?? database.Namespace ?? null,
            schemaIdentity: database.schemaIdentity ?? database.SchemaIdentity ?? 'public',
            entities: (database.entities ?? database.Entities ?? []).map((item) => ({
                kind: item.kind ?? item.Kind,
                id: String(item.id ?? item.Id ?? ''),
                variantId: item.variantId ?? item.VariantId ?? null,
                owner: item.owner ?? item.Owner ?? null,
                owned: item.owned ?? item.Owned ?? true,
                postconditionId: item.postconditionId ?? item.PostconditionId ?? null,
                fields: item.fields ?? item.Fields ?? {}
            }))
        },
        redis: redis && { namespace: redis.namespace ?? redis.Namespace ?? null, keys: (redis.keys ?? redis.Keys ?? []).map((item) => ({ domain: item.domain ?? item.Domain, key: item.key ?? item.Key, present: item.present ?? item.Present, memberIds: item.memberIds ?? item.MemberIds ?? null })) },
        cache: cache && { namespace: cache.namespace ?? cache.Namespace ?? null, generation: cache.generation ?? cache.Generation ?? null, entries: (cache.entries ?? cache.Entries ?? []).map((item) => ({ domain: item.domain ?? item.Domain, endpoint: item.endpoint ?? item.Endpoint ?? null, matchesDb: item.matchesDb ?? item.MatchesDb, requireOwnedVisible: item.requireOwnedVisible ?? item.RequireOwnedVisible, visibleEntityIds: item.visibleEntityIds ?? item.VisibleEntityIds ?? null, searchToken: item.searchToken ?? item.SearchToken ?? null, searchHit: item.searchHit ?? item.SearchHit ?? false })) }
    };
}

export async function prepareDemoPublic(context, signal)
{
    const endpoint = resolveDemoBackendUrl(context);
    const secret = context.handles?.localDemoFixtureSecret ?? process.env.FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET ?? '';
    if (!endpoint)
    {
        throw new Error('demo-public requires handles.baseUrl; refusing local DB or shell fallback');
    }
    if (!secret)
    {
        throw new Error('demo-public composition root secret missing');
    }

    // Verify the original entity plan and all requested source fields before
    // cleanup or writes. Historical chronology conflicts remain refusals.
    const temporalBinding = context.temporalContext == null
        ? null
        : prepareDemoTemporalBinding(context);
    if (temporalBinding)
    {
        requireCompleteTemporalEntityBinding(temporalBinding.binding);
    }

    if (context.previousProducerReceipt != null)
    {
        const previous = validateProducerReceipt(context.previousProducerReceipt);
        const expectedRunId = context.runIdentity == null ? null : String(context.runIdentity);
        const expectedNamespace = context.namespace == null ? null : String(context.namespace);
        if (previous.producerId !== PRODUCER_ID ||
        previous.runId !== expectedRunId ||
        previous.namespace !== expectedNamespace ||
        previous.profileId !== context.profileIdentity?.profileId ||
        previous.fixtureCatalogDigest !== context.plan?.catalogDigest ||
        previous.expandedCapabilityDigest !== context.plan?.expandedCapabilityDigest)
        {
            throw new Error('demo-public previous ProducerReceipt does not match this exact run/profile/catalog');
        }
        await cleanupDemoPublic(context, previous, signal);
    }

    const response = await fetch(`${endpoint}/api/local/demo-fixture/prepare`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Fsus-Local-Demo-Fixture-Secret': secret,
            'X-Fsus-Test-Session': testSession(context)
        },
        body: JSON.stringify({
            namespace: context.namespace ?? null,
            runId: context.runIdentity ?? null,
            temporalContext: context.temporalContext ?? null,
            resolvedTemporalRoles: temporalBinding?.artifact ?? null
        }),
        signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
    {
        throw new Error(`demo-public composition root failed HTTP ${response.status}: ${payload?.detail ?? payload?.message ?? ''}`);
    }
    const observations = normalizeObservations(payload?.observations ?? payload?.Observations);
    if (!observations.database || !observations.redis || !observations.cache || observations.source !== 'service')
    {
        throw new Error('demo-public requires converged service database/redis/cache observations');
    }
    const temporalBusinessFields = payload?.temporalBusinessFields ?? payload?.TemporalBusinessFields;
    if (temporalBinding)
    {
        verifyObservedTemporalEntityBusinessFields(temporalBinding.binding, temporalBusinessFields);
    }
    if (context.namespace)
    {
        observations.database.namespace = context.namespace;
    }
    return {
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        implementation: 'src/backend/Services/Fixtures/DemoFixtureSeeder.cs',
        entityIdentities: (payload?.entityIdentities ?? payload?.EntityIdentities ?? []).map((item) => ({
            kind: String(item.kind ?? item.Kind),
            id: String(item.id ?? item.Id),
            handle: item.handle ?? item.Handle ?? null,
            variantId: item.variantId ?? item.VariantId ?? null,
            owner: item.owner ?? item.Owner ?? null,
            digest: item.digest ?? item.Digest ?? null
        })),
        observations,
        databaseObservation: observations.database,
        providedCapabilities: ['development.demo.dataset'],
        cleanupContract: { kind: 'receipt-exact-identities' },
        ...(temporalBinding ? { temporalBusinessFields } : {})
    };
}

export async function verifyDemoPublic(_context, result)
{
    if (_context.temporalContext != null)
    {
        const temporalBinding = prepareDemoTemporalBinding(_context);
        requireCompleteTemporalEntityBinding(temporalBinding.binding);
        verifyObservedTemporalEntityBusinessFields(temporalBinding.binding, result?.temporalBusinessFields);
    }
    const entities = result?.observations?.database?.entities ?? [];
    const required = ['article', 'comment', 'admin-principal', 'user'];
    const owners = new Set(entities.map((item) => item.owner).filter(Boolean));
    if (!result?.observations?.database ||
      !result?.observations?.cache?.entries?.every((item) => item.matchesDb === true) ||
      !required.every((kind) => entities.some((item) => item.kind === kind && item.owned)) ||
      entities.length === 0 ||
      entities.some((item) => item.variantId !== DEMO_VARIANT_ID || !item.owner) ||
      owners.size !== 1)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: 'demo-public observations missing owned canonical entities' };
    }
    return { ok: true, producerId: PRODUCER_ID, observations: result.observations, entityIdentities: result.entityIdentities };
}

export async function cleanupDemoPublic(_context, _receipt, _signal)
{
    const context = _context;
    const receipt = _receipt;
    const endpoint = resolveDemoBackendUrl(context);
    const secret = context.handles?.localDemoFixtureSecret ?? process.env.FSUSBLOG_LOCAL_DEMO_FIXTURE_SECRET ?? '';
    const entities = receipt?.entityIdentities
    ?? receipt?.producerReceipts?.find((item) => item.producerId === PRODUCER_ID)?.entityIdentities
    ?? [];
    if (!endpoint || !secret)
    {
        throw new Error('demo-public cleanup requires its protected composition root');
    }
    if (entities.length === 0)
    {
        throw new Error('demo-public cleanup requires receipt exact entity identities');
    }
    const owners = new Set(entities.map((item) => item.owner).filter(Boolean));
    if (owners.size !== 1 ||
      entities.some((item) => item.variantId !== DEMO_VARIANT_ID || !item.owner))
    {
        throw new Error('demo-public cleanup requires one exact owner and catalog variant');
    }
    const response = await fetch(`${endpoint}/api/local/demo-fixture/cleanup`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Fsus-Local-Demo-Fixture-Secret': secret,
            'X-Fsus-Test-Session': testSession(context)
        },
        body: JSON.stringify({ entityIdentities: entities }),
        signal: _signal
    });
    if (!response.ok)
    {
        throw new Error(`demo-public cleanup failed HTTP ${response.status}: ${await response.text()}`);
    }
}
