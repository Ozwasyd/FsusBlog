// fixture-catalog: producer public-content
/**
 * Deterministic public-content producer (#1712).
 *
 * Strategy: transaction-fixture only.
 * Data is materialised through the test-only backend composition root
 * (LocalPublicContentFixture → IPublicContentFixtureSeeder → domain ports).
 *
 * Forbidden paths deleted from discover-playwright-fixtures:
 *  - env article discovery
 *  - admin/public HTTP API seed
 *  - Node direct DB SQL
 *  - local constructed article fallback
 *  - warning-and-continue on cache miss
 */

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { projectFixtureIds } = await import(new URL("../receipt/projection.mjs", import.meta.url));

import { repositoryRoot } from './spawn-helper.mjs';

const STRATEGY = 'transaction-fixture';
const PRODUCER_ID = 'public-content';

const COVER_ASSETS = Object.freeze([
    'acceptance-cover-primary.svg',
    'acceptance-cover-focus.svg',
    'acceptance-cover-hot.svg'
]);

/**
 * Deterministic capability plan derived only from the orchestrator profile slice.
 * Never invents capabilities from process.env.
 */
export function buildPublicContentPlan(capabilities = [])
{
    const sorted = [...new Set((capabilities ?? []).map((item) => String(item)).filter(Boolean))].sort();
    const has = (id) => sorted.includes(id);
    if (has('public.empty') && sorted.some((id) => id !== 'public.empty'))
    {
        throw new Error('public.empty cannot mix with other public capabilities');
    }

    const publishedCount = has('public.article.published') || has('public.home.featured-hot') || has('public.search.indexed')
        ? 3
        : 0;

    return Object.freeze({
        strategy: STRATEGY,
        producerId: PRODUCER_ID,
        enforceVariantEvidence: true,
        capabilities: Object.freeze(sorted),
        mode: has('public.empty')
            ? 'public-empty'
            : (has('public.article.draft') || has('public.article.scheduled') || has('public.article.archived') || has('public.article.deleted')
        ? 'public-content-lifecycle'
        : 'public-minimal'),
        publishedArticleCount: publishedCount,
        requireCoverMix: publishedCount > 0,
        requireTaxonomy: has('public.taxonomy.category-tag') || publishedCount > 0,
        requireFeaturedHot: has('public.home.featured-hot'),
        requireSearch: has('public.search.indexed'),
        requireRevisionHistory: has('public.article.revision-history'),
        requireMultipleRevisions: has('public.article.multiple-revisions'),
        requireMultiplePublications: has('public.article.multiple-publications'),
        lifecycle: Object.freeze({
            draft: has('public.article.draft'),
            scheduled: has('public.article.scheduled'),
            archived: has('public.article.archived'),
            deleted: has('public.article.deleted')
        }),
        empty: has('public.empty')
    });
}

function assertNoStrategyEnv()
{
    const banned = [
        'FSUSBLOG_FIXTURE_PRODUCER_STRATEGY',
        'FSUSBLOG_PUBLIC_FIXTURE_STRATEGY',
        'FSUSBLOG_FORCE_DIRECT_DB_SEED',
        'FSUSBLOG_FIXTURE_STRATEGY',
        'FSUSBLOG_PUBLIC_FIXTURE_MODE'
    ];
    for (const key of banned)
    {
        if (process.env[key])
        {
            throw new Error(`producer strategy/env override ${key} is forbidden`);
        }
    }
}

function profileCapabilities(context)
{
    const fromPlan = context?.plan?.capabilities;
    if (Array.isArray(fromPlan) && fromPlan.length)
    {
        return fromPlan.filter((id) => String(id).startsWith('public.'));
    }
    return [];
}

/**
 * Prepare public content via injected domain-port adapter or local composition-root HTTP.
 */
export async function preparePublicContent(context, signal)
{
    assertNoStrategyEnv();
    if (signal?.aborted)
    {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }

    const capabilities = profileCapabilities(context);
    if (capabilities.length === 0)
    {
        throw new Error('public-content producer invoked with zero public capabilities');
    }
    const plan = buildPublicContentPlan(capabilities);
    const selectedVariants = context.variantPlan?.variants ?? [];
    const nonCanonical = selectedVariants.filter((item) => item.validityClass !== 'canonical-positive');
    if (nonCanonical.length)
    {
        if (nonCanonical.length !== selectedVariants.length)
        {
            throw new Error('public-content cannot mix canonical and non-canonical fixture variants');
        }
        return prepareNonCanonicalPublicContent(context, nonCanonical);
    }

    // Cover assets for featured/hot (static fixtures only — not data authority).
    await materializeCoverAssets(context).catch(() => undefined);

    const adapter = context.handles?.publicContentAdapter;
    let raw;
    if (adapter && typeof adapter.prepare === 'function')
    {
        raw = await adapter.prepare({ ...context, plan }, signal);
    }
    else
    {
        raw = await invokeLocalCompositionRoot(context, plan, signal);
    }

    if (!raw || typeof raw !== 'object')
    {
        throw new Error('public-content composition root returned empty result');
    }
    if (raw.strategy && raw.strategy !== STRATEGY)
    {
        throw new Error(`public-content strategy cannot fallback (got ${raw.strategy})`);
    }
    if (raw.fallback === true || raw.localConstructed === true || raw.warningOnly === true)
    {
        throw new Error('public-content forbids fallback/local-constructed/warning-only results');
    }
    if (!raw.observations?.database || !raw.observations?.redis || !raw.observations?.cache)
    {
        throw new Error('public-content prepare missing database/redis/cache observations');
    }
    if (raw.observations.source === 'local-fallback' || raw.observations.fallback === true)
    {
        throw new Error('public-content observations cannot be local-fallback');
    }

    // Fail closed on incomplete published set for non-empty modes.
    if (!plan.empty)
    {
        const published = (raw.observations.database.entities ?? []).filter((item) => item.kind === 'article'
      && String(item.fields?.status ?? '') === 'published'
      && item.fields?.deleted !== true);
        if (plan.publishedArticleCount > 0 && published.length < plan.publishedArticleCount)
        {
            throw new Error(
                `public-minimal requires exactly ${plan.publishedArticleCount} published articles; observed ${published.length}`
            );
        }
        if (plan.requireCoverMix)
        {
            const withCover = published.filter((item) => item.fields?.hasCover === true || String(item.fields?.coverImageUrl ?? '').trim());
            const withoutCover = published.filter((item) => !(item.fields?.hasCover === true || String(item.fields?.coverImageUrl ?? '').trim()));
            if (withCover.length < 1 || withoutCover.length < 1)
            {
                throw new Error('public-minimal requires at least one cover and one no-cover published article');
            }
        }
    }

    const observations = normalizeObservations(raw.observations ?? raw.Observations, context);
    assertVariantSemantics(observations.database?.entities ?? [], context);
    const temporalObservation = raw.temporalObservation ?? raw.TemporalObservation ?? null;
    if (context.temporalContext && !temporalObservation)
    {
        throw new Error('public-content backend did not return a temporal actual observation');
    }
    // Stamp execution namespace onto observations so receipt merge never sees a mismatch.
    const ns = context?.namespace ?? context?.plan?.executionIdentity?.namespace ?? null;
    if (ns)
    {
        if (observations.database)
        {
            observations.database.namespace = ns;
        }
        if (observations.redis)
        {
            observations.redis.namespace = ns;
        }
        if (observations.cache)
        {
            observations.cache.namespace = ns;
        }
    }

    return {
        producerId: PRODUCER_ID,
        enforceVariantEvidence: true,
        strategy: STRATEGY,
        implementation: adapter
            ? 'injected-publicContentAdapter'
            : 'src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs',
        plan,
        variantIds: Object.freeze(context.variantPlan.variants.map((item) => item.id).sort()),
        producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest,
        entityIdentities: normalizeEntityIdentities(
            raw.entityIdentities ?? raw.EntityIdentities,
            context,
            observations.database?.entities ?? []
        ),
        observations,
        databaseObservation: observations.database,
        redisObservation: observations.redis,
        cacheObservation: observations.cache,
        projection: raw.projection ?? raw.Projection ?? null,
        providedCapabilities: plan.capabilities,
        variantEvidence: buildPublicVariantEvidence(observations, context),
        postconditions: [],
        cleanupContract: { kind: 'owned-namespace', ownerPrefix: buildOwnerPrefix(context) },
        ...(temporalObservation ? { temporalObservation } : {})
    };
}

function buildPublicVariantEvidence(observations, context)
{
    const entities = observations.database?.entities ?? [];
    const articleIds = entities.filter((item) => item.kind === 'article').map((item) => String(item.id));
    return Object.freeze({
        variants: Object.freeze((context.variantPlan?.variants ?? []).map((variant) =>
        {
            const direct = entities.filter((item) => item.variantId === variant.id).map((item) => String(item.id));
            // A public projection/revision/search capability is observed against the
            // same live article rows; receipt still carries the variant-specific proof.
            const entityIds = direct.length ? direct : (variant.capabilityId.startsWith('public.') ? articleIds : []);
            return Object.freeze({
                variantId: variant.id,
                source: 'live-service',
                entityIds: Object.freeze(entityIds),
                emptyVerified: variant.capabilityId === 'public.empty' && entities.length === 0,
                expectedBoundary: variant.expectedBoundary
            });
        }))
    });
}

/**
 * Legacy and negative fixtures have no write fallback. Their owner must supply a
 * dedicated boundary adapter with live evidence; this prevents capability-only
 * relabelling of canonical rows while #1713/#1718 own their concrete generators.
 */
async function prepareNonCanonicalPublicContent(context, variants)
{
    const adapter = context.handles?.publicContentVariantAdapter;
    if (!adapter || typeof adapter.prepare !== 'function')
    {
        throw new Error('non-canonical public-content fixture requires a dedicated variant adapter');
    }
    const evidence = await adapter.prepare({ context, variants: Object.freeze([...variants]) });
    if (!evidence || typeof evidence !== 'object' || evidence.source !== 'live-service')
    {
        throw new Error('non-canonical public-content variant adapter requires live-service evidence');
    }
    for (const variant of variants)
    {
        const item = evidence.variants?.find((candidate) => candidate?.variantId === variant.id);
        if (!item)
        {
            throw new Error(`non-canonical variant ${variant.id} has no dedicated evidence`);
        }
        if (variant.validityClass === 'negative-invalid'
      && (item.rejected !== true
        || item.injectedSentinelId !== variant.injectedSentinelId
        || item.injectedSentinelValue !== variant.injectedSentinelValue
        || !Array.isArray(item.invariantIds)
        || item.invariantIds.length !== 1
        || item.invariantIds[0] !== variant.expectedInvariantId))
        {
            throw new Error(`negative variant ${variant.id} requires exact rejected invariant ${variant.expectedInvariantId}`);
        }
        if (variant.validityClass === 'migration-legacy'
      && (!Array.isArray(item.entityIdentities) || item.entityIdentities.length === 0))
        {
            throw new Error(`migration variant ${variant.id} requires observed legacy entities`);
        }
    }
    return Object.freeze({
        producerId: PRODUCER_ID,
        strategy: STRATEGY,
        implementation: 'dedicated-public-content-variant-adapter',
        variantIds: Object.freeze(variants.map((item) => item.id).sort()),
        producerVariantPlanDigest: context.variantPlan.producerVariantPlanDigest,
        entityIdentities: Object.freeze(evidence.variants.flatMap((item) => item.entityIdentities ?? [])),
        observations: evidence.observations ?? null,
        providedCapabilities: Object.freeze(variants.map((item) => item.capabilityId).sort()),
        variantEvidence: evidence
    });
}

export async function verifyPublicContent(context, producerReceipt)
{
    assertNoStrategyEnv();
    if (!producerReceipt?.observations && !producerReceipt?.databaseObservation)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: 'missing observations' };
    }
    if (producerReceipt.strategy && producerReceipt.strategy !== STRATEGY)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: 'strategy drift' };
    }
    if (producerReceipt.fallback || producerReceipt.localConstructed || producerReceipt.warningOnly)
    {
        return { ok: false, producerId: PRODUCER_ID, reason: 'fallback/warning evidence rejected' };
    }

    // Optional live revalidation adapter (fail closed on false).
    const adapter = context.handles?.publicContentAdapter;
    if (adapter && typeof adapter.verify === 'function')
    {
        const result = await adapter.verify(context, producerReceipt);
        if (result?.ok === false)
        {
            return { ok: false, producerId: PRODUCER_ID, reason: result.reason ?? 'adapter verify failed' };
        }
    }

    return {
        ok: true,
        producerId: PRODUCER_ID,
        observations: producerReceipt.observations,
        databaseObservation: producerReceipt.databaseObservation ?? producerReceipt.observations?.database,
        redisObservation: producerReceipt.redisObservation ?? producerReceipt.observations?.redis,
        cacheObservation: producerReceipt.cacheObservation ?? producerReceipt.observations?.cache,
        entityIdentities: producerReceipt.entityIdentities
    };
}

export async function cleanupPublicContent(context, receipt, signal)
{
    assertNoStrategyEnv();
    if (signal?.aborted)
    {
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    }
    const adapter = context.handles?.publicContentAdapter;
    if (adapter && typeof adapter.cleanup === 'function')
    {
        await adapter.cleanup(context, receipt, signal);
    }
    // Namespace-owned DB drop is owned by outer bootstrap; producer only cleans owned rows when adapter provided.
}

/**
 * Write narrow ID projection (not authoritative receipt) from a verified FixtureReceipt.
 */
export function writePublicIdProjectionFromReceipt(receipt, outputPath, { catalogs } = {})
{
    const projection = projectFixtureIds(receipt, { catalogs, requireVerified: true });
    // Legacy TSV public.aeds is not authoritative and not written as compat reader input.
    // Consumers must use fixture-id-projection.v1 JSON.
    return { projection, outputPath };
}

export async function writePublicIdProjectionFile(receipt, outputPath, options = {})
{
    const { projection } = writePublicIdProjectionFromReceipt(receipt, outputPath, options);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(projection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return projection;
}

function buildOwnerPrefix(context)
{
    const ns = context?.namespace ?? context?.plan?.executionIdentity?.namespace ?? 'local';
    const run = String(context?.runIdentity ?? context?.plan?.executionIdentity?.runId ?? 'run')
        .replace(/[^a-zA-Z0-9_-]/gu, '')
        .slice(0, 24) || 'run';
    return `fxpc:${ns}:${run}`;
}

async function materializeCoverAssets(context)
{
    const fixtureRoot = context.handles?.fixtureRoot
    ?? process.env.FSUSBLOG_FIXTURE_ROOT
    ?? path.join(repositoryRoot, '.tmp', 'fixtures', context?.namespace ?? 'local');
    const assetDir = path.join(fixtureRoot, 'assets');
    const sourceDir = path.join(repositoryRoot, 'src', 'frontend', 'public', 'fixtures');
    await mkdir(assetDir, { recursive: true });
    await Promise.all(COVER_ASSETS.map(async (name) =>
    {
        await copyFile(path.join(sourceDir, name), path.join(assetDir, name)).catch(() => undefined);
    }));
}

async function invokeLocalCompositionRoot(context, plan, signal)
{
    const baseUrl = String(
        context.handles?.baseUrl
    ?? context.handles?.debugBackendUrl
    ?? process.env.FSUSBLOG_BASE_URL
    ?? ''
    ).replace(/\/+$/u, '');
    if (!baseUrl)
    {
        throw new Error(
            'public-content transaction-fixture requires handles.baseUrl (or injected publicContentAdapter); refusing env discovery'
        );
    }

    const secret = context.handles?.localPublicContentFixtureSecret
    ?? context.handles?.localAuthFixtureSecret
    ?? process.env.FSUSBLOG_LOCAL_PUBLIC_CONTENT_FIXTURE_SECRET
    ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET
    ?? '';
    if (!secret)
    {
        throw new Error('public-content composition root secret missing (handles.localPublicContentFixtureSecret)');
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? new Error('aborted'));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try
    {
        const response = await fetch(`${baseUrl}/api/local/public-content-fixture/prepare`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Fsus-Local-Public-Content-Fixture-Secret': secret,
                'X-Fsus-Local-Auth-Fixture-Secret': secret,
                'X-Fsus-Test-Namespace': String(context.namespace ?? ''),
                'X-Fsus-Test-Run-Id': String(context.runIdentity ?? '')
            },
            body: JSON.stringify({
                capabilities: plan.capabilities,
                namespace: context.namespace ?? null,
                runId: context.runIdentity ?? null,
                temporalContext: context.temporalContext ?? null
            }),
            signal: controller.signal
        });
        const text = await response.text();
        let payload = null;
        try
        {
            payload = text ? JSON.parse(text) : null;
        }
        catch
        {
            payload = null;
        }
        if (!response.ok)
        {
            const detail = payload?.detail ?? payload?.title ?? payload?.message ?? text.slice(0, 400);
            throw new Error(`public-content composition root failed HTTP ${response.status}: ${detail}`);
        }
        return normalizeCompositionPayload(payload, context);
    }
    finally
    {
        signal?.removeEventListener?.('abort', onAbort);
    }
}

function normalizeCompositionPayload(payload, context)
{
    if (!payload || typeof payload !== 'object')
    {
        return payload;
    }
    // Accept both camelCase (default System.Text.Json) and PascalCase.
    const observations = payload.observations ?? payload.Observations;
    const entityIdentities = payload.entityIdentities ?? payload.EntityIdentities ?? [];
    return {
        strategy: payload.strategy ?? payload.Strategy ?? STRATEGY,
        mode: payload.mode ?? payload.Mode,
        entityIdentities,
        observations: normalizeObservations(observations, context),
        projection: payload.projection ?? payload.Projection ?? null,
        providedCapabilities: payload.providedCapabilities ?? payload.ProvidedCapabilities ?? [],
        temporalObservation: payload.temporalObservation ?? payload.TemporalObservation ?? null
    };
}

function resolveEntityVariantId(item, context)
{
    const explicit = item.variantId ?? item.VariantId ?? null;
    const hint = item.capabilityHint ?? item.CapabilityHint ?? item.postconditionId ?? item.PostconditionId ?? null;
    const variants = context?.variantPlan?.variants ?? [];
    const matches = explicit
        ? variants.filter((variant) => variant.id === explicit)
        : variants.filter((variant) => variant.capabilityId === hint || variant.postconditionIds.includes(hint));
    if (matches.length !== 1)
    {
        throw new Error(`public-content entity ${item.id ?? item.Id ?? '<missing>'} must map to exactly one typed fixture variant`);
    }
    return matches[0].id;
}

/** The catalog is a data-validity contract, not a receipt label. */
function assertVariantSemantics(entities, context)
{
    const variants = new Map((context?.variantPlan?.variants ?? []).map((item) => [item.id, item]));
    const sentinels = new Map((context?.catalogs?.variant?.sentinels ?? []).map((item) => [item.id, item.value]));
    for (const entity of entities)
    {
        const variantId = entity.variantId;
        const variant = variants.get(variantId);
        if (!variant)
        {
            throw new Error(`public-content entity ${entity.id ?? '<missing>'} has no typed fixture variant`);
        }
        const serializedFields = JSON.stringify(entity.fields ?? {});
        if (variant.validityClass === 'canonical-positive')
        {
            for (const sentinelId of variant.forbiddenSentinelIds ?? [])
            {
                const value = sentinels.get(sentinelId);
                if (value && serializedFields.includes(value))
                {
                    throw new Error(`canonical-positive entity ${entity.id ?? '<missing>'} contains forbidden sentinel ${sentinelId}`);
                }
            }
        }
        if (variant.validityClass !== 'canonical-positive')
        {
            throw new Error(`public-content canonical writer cannot claim non-canonical variant ${variantId}`);
        }
    }
}

function normalizeEntityIdentities(items, context, observedEntities)
{
    return (items ?? []).map((item) => ({
        kind: String(item.kind ?? item.Kind ?? 'other'),
        id: String(item.id ?? item.Id ?? ''),
        handle: item.handle ?? item.Handle ?? null,
        variantId: resolveEntityVariantId(
            (observedEntities ?? []).find((entity) => String(entity.id) === String(item.id ?? item.Id ?? '')
        && String(entity.kind) === String(item.kind ?? item.Kind ?? 'other')) ?? item,
            context
        )
    })).filter((item) => item.id);
}

function normalizeObservations(raw, context)
{
    if (!raw || typeof raw !== 'object')
    {
        return { source: 'service', database: null, redis: null, cache: null };
    }
    const database = raw.database ?? raw.Database;
    const redis = raw.redis ?? raw.Redis;
    const cache = raw.cache ?? raw.Cache;
    return {
        source: raw.source ?? raw.Source ?? 'service',
        database: database
            ? {
        namespace: database.namespace ?? database.Namespace ?? null,
        schemaIdentity: database.schemaIdentity ?? database.SchemaIdentity ?? 'public',
        entities: (database.entities ?? database.Entities ?? []).map((entity) => ({
          kind: entity.kind ?? entity.Kind,
          id: String(entity.id ?? entity.Id ?? ''),
          owned: entity.owned ?? entity.Owned ?? true,
          capabilityHint: entity.capabilityHint ?? entity.CapabilityHint ?? null,
          variantId: resolveEntityVariantId(entity, context),
          projection: entity.projection ?? entity.Projection ?? null,
          postconditionId: entity.postconditionId ?? entity.PostconditionId ?? null,
          fields: entity.fields ?? entity.Fields ?? {}
        }))
      }
            : null,
        redis: redis
            ? {
        namespace: redis.namespace ?? redis.Namespace ?? null,
        keys: (redis.keys ?? redis.Keys ?? []).map((key) => ({
          domain: key.domain ?? key.Domain ?? 'redis.cache.public',
          key: key.key ?? key.Key,
          present: key.present ?? key.Present ?? false,
          memberIds: key.memberIds ?? key.MemberIds ?? null
        }))
      }
            : null,
        cache: cache
            ? {
        namespace: cache.namespace ?? cache.Namespace ?? null,
        generation: cache.generation ?? cache.Generation ?? null,
        entries: (cache.entries ?? cache.Entries ?? []).map((entry) => ({
          domain: entry.domain ?? entry.Domain ?? 'redis.cache.public',
          endpoint: entry.endpoint ?? entry.Endpoint ?? null,
          matchesDb: entry.matchesDb ?? entry.MatchesDb ?? false,
          requireOwnedVisible: entry.requireOwnedVisible ?? entry.RequireOwnedVisible ?? false,
          visibleEntityIds: entry.visibleEntityIds ?? entry.VisibleEntityIds ?? null,
          searchToken: entry.searchToken ?? entry.SearchToken ?? null,
          searchHit: entry.searchHit ?? entry.SearchHit ?? false
        }))
      }
            : null
    };
}

export const publicContentProducerMeta = Object.freeze({
    id: PRODUCER_ID,
    strategy: STRATEGY,
    implementation: path.relative(
        repositoryRoot,
        fileURLToPath(import.meta.url)
    )
});
