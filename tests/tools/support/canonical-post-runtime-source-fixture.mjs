import { createHash } from 'node:crypto'

import { digestValue } from '../../../tools/fact-extractors/lib/canonicalize.mjs'
import { projectPreparedPublicIds } from '../../../tools/test-fixtures/receipt/prepared-public-projection-contract.mjs'
import { deriveProbeRawFacts, verifyFacts } from '../../../tools/test-evidence/runtime-observation-probe-facts.mjs'
import { buildRuntimeObservationProbeReceipt } from '../../../tools/test-evidence/runtime-observation-probe-receipt-contract.mjs'
import { buildAotSpaHydrationSourceBundle } from '../../../tools/test-evidence/aot-spa-hydration-source-contract.mjs'
import { normalizeAotSpaHydrationFacts } from '../../../tools/test-evidence/aot-spa-hydration-observed-facts.mjs'

const sha = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
const digest = value => `sha256:${digestValue(value)}`

/** Shared synthetic test source factory; the production builders remain the only envelope authority. */
export function createCanonicalProbeSourceFixture(classId, context, { producer, sourceState })
{
    const { facts } = createCanonicalProbeFixtureFacts(classId, {
        prepareState: context.fixture.value, prepareStateDigest: context.fixture.ref.contentDigest,
        releaseId: context.candidatePlan.value.candidate.releaseId
    })
    const identity = { ...sourceState, artifactDigest: digest(facts) }
    return { sourceState: identity, facts,
        upstream: buildRuntimeObservationProbeReceipt(classId, context, facts, { producer, sourceState: identity }) }
}

export function createCanonicalAotSourceFixture(options, buildReceipt)
{
    const normalized = normalizeAotSpaHydrationFacts(options.inputs, options.plan, buildReceipt, { readBytes: options.readBytes })
    return { normalized, upstream: buildAotSpaHydrationSourceBundle(options) }
}

/** Deliberately synthetic DOM observations; exercise the real normalizer, not a browser run. */
export function createCanonicalHydrationFixtureObservation(releaseId)
{
    const stableIdentity = { captured: true, appSame: true, shellSame: true, firstChildSame: true,
        childElementCountSame: true, hydrated: true, appCount: 1, shellCount: 1, violations: [] }
    return {
        schema: 'fsusblog.browser-contract-public-aot-observation.v1',
        fixture: { articleId: '42', articlePath: '/article/42', articleTitle: 'Current article' },
        response: { url: 'https://example.test/article/42', status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8', 'x-fsus-release-id': releaseId },
            serverHtml: '<!doctype html><html lang="zh-CN"><head><link rel="canonical" href="https://example.test/article/42"><script type="application/json" data-fsus-seo-head-model>{}</script></head><body><div id="app"><div id="fsus-aot-shell" data-public-hydration-kind="ArticleDetail"></div></div></body></html>' },
        direct: { route: '/article/42', canonicalPath: '/article/42', title: 'Current article', locale: 'zh-CN',
            hydrationKind: 'ArticleDetail', hydrated: true, appCount: 1, shellCount: 1,
            bootstrapText: '{"id":42}', resourceUrls: ['https://example.test/assets/app.js'] },
        spa: structuredClone(stableIdentity), history: structuredClone(stableIdentity), reload: structuredClone(stableIdentity)
    }
}

/** Synthetic observations for contract tests only; never runtime qualification evidence. */
export function createCanonicalPreparedFixture(sourceState)
{
    return {
        schema: 'fsusblog.fixture-prepare-state.v1', terminalState: 'prepared',
        plan: {
            profileIdentity: { profileId: sourceState.profileId },
            executionIdentity: { runId: sourceState.runId, namespace: sourceState.runId,
                sourceIdentity: { commit: sourceState.sourceCommit, worktreeFingerprint: sourceState.worktreeFingerprint } },
            catalogDigest: sha('fixture-catalog')
        },
        producerOutputs: { 'public-content': {
            producerId: 'public-content', strategy: 'transaction-fixture',
            producerVariantPlanDigest: sha('public-content-variant'), variantIds: ['canonical.public.article.published'],
            entityIdentities: [{ kind: 'article', id: '11' }, { kind: 'category', id: '12' }, { kind: 'tag', id: '13' }],
            observations: { source: 'service', database: { entities: [] }, redis: { keys: [] }, cache: { entries: [] } },
            projection: { articleId: '11', articleTitle: 'Current article', categoryId: '12', tagId: '13', searchKeyword: 'CURRENT_BODY' }
        } }
    }
}

function routeFacts(prepared, prepareStateDigest, releaseId)
{
    const projection = projectPreparedPublicIds(prepared)
    const response = (id, status, typedKind, overrides = {}) => {
        const value = { id, role: 'fixture-role', expectation: 'typed-semantic-result', status,
            headers: {}, bodyDigest: sha(id), byteLength: 1, typedPayloadDigest: sha(id), typedKind,
            typedEntityId: null, typedTitleDigest: null, typedCode: null, typedCategory: null,
            typedStatusCode: null, typedMessageDigest: null, decodeError: null, ...overrides }
        value.requestObservation = { method: 'GET', url: `http://127.0.0.1/fixture/${id}` }
        value.typedPayloadProjection = typedKind === 'typed-error'
            ? { code: value.typedCode, category: value.typedCategory, statusCode: value.typedStatusCode, messageDigest: value.typedMessageDigest }
            : null
        return value
    }
    return {
        schema: 'fsusblog.route-response-error-probe-facts.v1', coherent: true,
        fixtureAuthority: { prepareStateDigest, projectionDigest: projection.projectionDigest,
            articleIdDigest: sha(projection.articleId), articleTitleDigest: sha(projection.articleTitle),
            searchCanaryDigest: sha(projection.searchKeyword) },
        cases: [
            response('public-visible-first-read', 200, 'payload', {
                headers: { 'content-type': 'application/octet-stream', 'x-fsus-frame-version': '2',
                    'x-fsus-generation': '1', 'x-fsus-release-id': releaseId, etag: '"fixture-etag"' },
                typedEntityId: Number(projection.articleId), typedTitleDigest: sha(projection.articleTitle)
            }),
            response('public-visible-cache-revalidation', 304, 'payload', { headers: { etag: '"fixture-etag"' } }),
            response('public-missing-typed-error', 404, 'typed-error', {
                typedCode: 2, typedCategory: 4, typedStatusCode: 404, typedMessageDigest: sha('article_not_found')
            }),
            response('anonymous-auth-denied', 401, 'typed-error', {
                typedCode: 4, typedCategory: 2, typedStatusCode: 401, typedMessageDigest: sha('anonymous-denied')
            }),
            response('user-self-visible', 200, 'payload'),
            response('user-admin-denied', 403, 'typed-error', {
                typedCode: 5, typedCategory: 3, typedStatusCode: 403, typedMessageDigest: sha('admin-denied')
            }),
            response('admin-list-visible', 200, 'payload')
        ]
    }
}

function cacheFacts(releaseId)
{
    return {
        schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
        terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
        events: [{ id: 1, status: 'processed', last_error: null }],
        edges: { eventTypes: ['article-published'] },
        authorityCoordinate: { articleIdDigest: sha('11'), mutationIdDigest: sha('mutation-1') },
        generation: { value: '3', valueDigest: sha('3'), present: true },
        query: { searchIndexDigest: sha('search-index'), releaseScopedPath: `/release-derived/${releaseId}/search/index.bin`,
            releaseId, containsMarker: true, responseStatus: 200 },
        readModel: { projectionDigest: sha('projection'), detailDigest: sha('detail'),
            detailTitleDigest: sha('Current article'), visible: true, responseStatus: 200 },
        output: { navigationDigest: sha('navigation'), envelopeDigest: sha('envelope'), containsMarker: true, responseStatus: 200 }
    }
}

function sessionFacts(releaseId)
{
    const refreshDigest = sha('observed-refresh-hash')
    const expiry = { accessTokenExp: 200, issuedAt: 100, idleExpiresAt: '2026-09-08T00:00:00Z',
        absoluteExpiresAt: '2026-09-09T00:00:00Z', durationPolicy: 1 }
    const database = { id: sha('session-id'), refreshtokenhash: refreshDigest,
        idleexpiresat: expiry.idleExpiresAt, absoluteexpiresat: expiry.absoluteExpiresAt, duration_policy: expiry.durationPolicy }
    return {
        schema: 'fsusblog.session-cookie-runtime-probe-facts.v1', coherent: true,
        database: { sessionDigest: digest(database), sessionIdDigest: database.id,
            refreshTokenHashDigest: refreshDigest, projection: database },
        credential: { matches: true, presentedRefreshHashDigest: refreshDigest, storedRefreshHashDigest: refreshDigest },
        authContext: { jwtMatches: true, digest: sha('auth-context'), projection: { sessionId: database.id } },
        jwt: { sessionMatches: true, tokenDigest: sha('jwt-token'), claimsDigest: sha('jwt-claims'),
            projection: { exp: expiry.accessTokenExp, iat: expiry.issuedAt, sessionId: database.id } },
        cookie: { sessionMatches: true, digest: sha('cookie'), projection: { sessionId: database.id } },
        storage: { projection: { surface: 'postgresql-session-storage', refreshTokenHashDigest: refreshDigest } },
        expiry: { ordered: true, projection: expiry, digest: digest({ accessTokenExp: expiry.accessTokenExp,
            idleExpiresAt: expiry.idleExpiresAt, absoluteExpiresAt: expiry.absoluteExpiresAt, durationPolicy: expiry.durationPolicy }) },
        revision: { current: true, digest: sha('revision'), projection: { revision: 1 } },
        device: { matches: true, digest: sha('device'), projection: { deviceIdDigest: sha('device-id') } },
        service: { currentSessionMatches: true, status: { me: 200, sessions: 200 }, digest: sha('service'),
            releaseIds: [releaseId, releaseId], projection: { sessionId: database.id } },
        modeOutcomes: {
            positive: { caseId: 'current-session-coherence', status: 200, releaseId, passed: true },
            negative: { caseId: 'replaced-session-refresh-denied', status: 401, releaseId, passed: true },
            failure: { caseId: 'revoked-session-refresh-denied', revokeStatus: 200, refreshStatus: 403,
                releaseIds: [releaseId, releaseId], passed: true }
        }
    }
}

export function createCanonicalProbeFixtureFacts(classId, { prepareState, prepareStateDigest, releaseId })
{
    const facts = classId === 'route-response-error' ? routeFacts(prepareState, prepareStateDigest, releaseId)
        : classId === 'cache-search-outbox-convergence' ? cacheFacts(releaseId)
        : classId === 'session-cookie-runtime' ? sessionFacts(releaseId) : null
    if (!facts) throw new Error(`unsupported probe fixture class ${classId}`)
    const projection = projectPreparedPublicIds(prepareState)
    verifyFacts(classId, facts, { fixtureProjection: { ...projection, prepareStateDigest }, expectedReleaseId: releaseId })
    return { facts, rawFacts: deriveProbeRawFacts(classId, facts) }
}
