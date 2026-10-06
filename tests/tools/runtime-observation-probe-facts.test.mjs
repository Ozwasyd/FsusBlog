import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const { digestValue } = await import(new URL('../../tools/fact-extractors/lib/canonicalize.mjs', import.meta.url));
const probe = await import(new URL('../../tools/test-evidence/runtime-observation-probe-facts.mjs', import.meta.url));
const { projectPreparedPublicIds } = await import(new URL('../../tools/test-fixtures/receipt/projection.mjs', import.meta.url));

const sha = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (value) => `sha256:${digestValue(value)}`;
const expectedReleaseId = '20260905120000-aaaaaaaaaaaa';
const verifySession = (facts) => probe.verifyFacts('session-cookie-runtime', facts, { expectedReleaseId });
const verifyCache = (facts) => probe.verifyFacts('cache-search-outbox-convergence', facts, { expectedReleaseId });

function sessionFacts()
{
    const hash = sha('a'.repeat(64));
    const database = { refreshtokenhash: hash, idleexpiresat: '2026-09-05T13:00:00Z',
        absoluteexpiresat: '2026-09-06T13:00:00Z', duration_policy: 'observed-policy' };
    const expiry = { accessTokenExp: 1788613200, issuedAt: 1788609600,
        idleExpiresAt: database.idleexpiresat, absoluteExpiresAt: database.absoluteexpiresat,
        durationPolicy: database.duration_policy };
    const token = sha('observed-token');
    return {
        schema: 'fsusblog.session-cookie-runtime-probe-facts.v1', coherent: true,
        database: { projection: database, sessionDigest: digest(database), sessionIdDigest: token,
            refreshTokenHashDigest: hash },
        credential: { presentedRefreshHashDigest: hash, storedRefreshHashDigest: hash, matches: true },
        storage: { projection: { surface: 'postgresql-session-storage', refreshTokenHashDigest: hash } },
        authContext: { digest: token, jwtMatches: true },
        jwt: { projection: { exp: expiry.accessTokenExp, iat: expiry.issuedAt },
            tokenDigest: token, claimsDigest: token, sessionMatches: true },
        cookie: { digest: token, sessionMatches: true },
        expiry: { projection: expiry, ordered: true, digest: digest({ accessTokenExp: expiry.accessTokenExp,
            idleExpiresAt: expiry.idleExpiresAt, absoluteExpiresAt: expiry.absoluteExpiresAt,
            durationPolicy: expiry.durationPolicy }) },
        revision: { digest: token, current: true }, device: { digest: token, matches: true },
        service: { digest: token, currentSessionMatches: true, status: { me: 200, sessions: 200 },
            releaseIds: [expectedReleaseId, expectedReleaseId] },
        modeOutcomes: {
            positive: { caseId: 'current-session-coherence', status: 200, passed: true, releaseId: expectedReleaseId },
            negative: { caseId: 'replaced-session-refresh-denied', status: 401, passed: true, releaseId: expectedReleaseId },
            failure: { caseId: 'revoked-session-refresh-denied', revokeStatus: 204, refreshStatus: 401,
                passed: true, releaseIds: [expectedReleaseId, expectedReleaseId] }
        }
    };
}

function cacheFacts()
{
    const hash = sha('observed');
    return { schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
        terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
        events: [{ id: 1, status: 'processed', last_error: null }], edges: { eventTypes: ['published'] },
        authorityCoordinate: { articleIdDigest: hash, mutationIdDigest: hash },
        generation: { value: '0011', valueDigest: sha('0011'), present: true },
        query: { containsMarker: true, releaseId: expectedReleaseId,
            releaseScopedPath: `/release-derived/${expectedReleaseId}/search/index.bin`, searchIndexDigest: hash },
        readModel: { visible: true, projectionDigest: hash, detailDigest: hash, detailTitleDigest: hash },
        output: { containsMarker: true, navigationDigest: hash, envelopeDigest: hash } };
}

function resealExpiry(facts)
{
    const expiry = facts.expiry.projection;
    facts.expiry.digest = digest({ accessTokenExp: expiry.accessTokenExp,
        idleExpiresAt: expiry.idleExpiresAt, absoluteExpiresAt: expiry.absoluteExpiresAt,
        durationPolicy: expiry.durationPolicy });
}

test('pure probe replay accepts coherent retained credential, expiry and generation relationships', () =>
{
    assert.doesNotThrow(() => verifySession(sessionFacts()));
    assert.doesNotThrow(() => verifyCache(cacheFacts()));
});

test('session replay rejects contradictory credential projections even with matches true', () =>
{
    for (const mutate of [
        (facts) =>
        {
            facts.credential.presentedRefreshHashDigest = sha('different');
        },
        (facts) =>
        {
            facts.credential.storedRefreshHashDigest = sha('different');
        },
        (facts) =>
        {
            facts.database.refreshTokenHashDigest = sha('different');
        },
        (facts) =>
        {
            facts.database.projection.refreshtokenhash = sha('different');
        },
        (facts) =>
        {
            facts.storage.projection.refreshTokenHashDigest = sha('different');
        },
        (facts) =>
        {
            delete facts.storage.projection.refreshTokenHashDigest;
        }
    ])
    {
        const facts = sessionFacts();
        mutate(facts);
        assert.throws(() => verifySession(facts), /credential projections/);
    }
});

test('session replay recomputes original expiry ordering and exact JWT and DB projection bindings', () =>
{
    for (const mutate of [
        (facts) =>
        {
            facts.expiry.projection.accessTokenExp = facts.expiry.projection.issuedAt;
        },
        (facts) =>
        {
            facts.expiry.projection.absoluteExpiresAt = '2026-09-04T00:00:00Z';
        },
        (facts) =>
        {
            facts.expiry.projection.accessTokenExp = null;
        },
        (facts) =>
        {
            facts.expiry.projection.issuedAt = '';
        },
        (facts) =>
        {
            facts.expiry.projection.idleExpiresAt = 'invalid';
        },
        (facts) =>
        {
            facts.jwt.projection.exp += 1;
        },
        (facts) =>
        {
            facts.jwt.projection.iat += 1;
        },
        (facts) =>
        {
            facts.database.projection.idleexpiresat = '2026-09-05T14:00:00Z';
        },
        (facts) =>
        {
            facts.database.projection.absoluteexpiresat = '2026-09-07T13:00:00Z';
        },
        (facts) =>
        {
            facts.database.projection.duration_policy = 'other';
        },
        (facts) =>
        {
            facts.expiry.digest = sha('different');
        }
    ])
    {
        const facts = sessionFacts();
        mutate(facts);
        assert.throws(() => verifySession(facts), /expiry projections/);
    }
});

test('session ordering rejects coordinated retained projection changes without imposing a new token lifetime policy', () =>
{
    const expired = sessionFacts();
    expired.expiry.projection.accessTokenExp = expired.expiry.projection.issuedAt;
    expired.jwt.projection.exp = expired.expiry.projection.accessTokenExp;
    resealExpiry(expired);
    assert.throws(() => verifySession(expired), /expiry projections/);
    const reversed = sessionFacts();
    reversed.expiry.projection.absoluteExpiresAt = '2026-09-04T00:00:00Z';
    reversed.database.projection.absoluteexpiresat = reversed.expiry.projection.absoluteExpiresAt;
    resealExpiry(reversed);
    assert.throws(() => verifySession(reversed), /expiry projections/);
    const equalDatabaseBounds = sessionFacts();
    equalDatabaseBounds.expiry.projection.absoluteExpiresAt = equalDatabaseBounds.expiry.projection.idleExpiresAt;
    equalDatabaseBounds.database.projection.absoluteexpiresat = equalDatabaseBounds.expiry.projection.absoluteExpiresAt;
    resealExpiry(equalDatabaseBounds);
    assert.doesNotThrow(() => verifySession(equalDatabaseBounds));
    const laterToken = sessionFacts();
    laterToken.expiry.projection.accessTokenExp = 4102444800;
    laterToken.jwt.projection.exp = laterToken.expiry.projection.accessTokenExp;
    resealExpiry(laterToken);
    assert.doesNotThrow(() => verifySession(laterToken));
});

test('cache replay derives generation digest from exact observed bytes without numeric normalization', () =>
{
    for (const mutate of [
        (facts) =>
        {
            facts.generation.valueDigest = sha('11');
        },
        (facts) =>
        {
            facts.generation.value = '11';
        },
        (facts) =>
        {
            facts.generation.value = '';
        },
        (facts) =>
        {
            delete facts.generation.value;
        },
        (facts) =>
        {
            facts.generation.present = false;
        }
    ])
    {
        const facts = cacheFacts();
        mutate(facts);
        assert.throws(() => verifyCache(facts), /cache\/search\/outbox/);
    }
});

test('refresh hash projection canonicalizes only valid hexadecimal casing before digesting', () =>
{
    assert.equal(typeof probe.refreshHashDigest, 'function');
    assert.equal(probe.refreshHashDigest('aB'.repeat(32)), sha('ab'.repeat(32)));
    assert.equal(probe.refreshHashDigest('AB'.repeat(32)), probe.refreshHashDigest('ab'.repeat(32)));
    assert.notEqual(probe.refreshHashDigest('ab'.repeat(32)), probe.refreshHashDigest('ac'.repeat(32)));
    for (const value of [null, '', 'ab', ` ${'ab'.repeat(32)}`, 'gg'.repeat(32)])
    {
        assert.throws(() => probe.refreshHashDigest(value), /refresh hash/);
    }
});

const verifyFacts = probe.verifyFacts;
const runId = 'runtime-observation-test';
const commit = 'a'.repeat(40);
const fingerprint = 'b'.repeat(64);

function routeFacts(prepared, prepareStateDigest, releaseId)
{
    const projection = projectPreparedPublicIds(prepared);
    const value = (id, status, typedKind, hash, overrides = {}) =>
    {
        const entry = {
            id,
            role: 'fixture-role',
            expectation: 'typed-semantic-result',
            status,
            headers: {},
            bodyDigest: digest(hash),
            byteLength: 1,
            typedPayloadDigest: digest(hash),
            typedKind,
            typedEntityId: null,
            typedTitleDigest: null,
            typedCode: null,
            typedCategory: null,
            typedStatusCode: null,
            typedMessageDigest: null,
            decodeError: null,
            ...overrides
        };
        entry.requestObservation = { method: 'GET', url: `http://127.0.0.1/fixture/${id}` };
        entry.typedPayloadProjection = typedKind === 'typed-error' ? { code: entry.typedCode,
      category: entry.typedCategory, statusCode: entry.typedStatusCode, messageDigest: entry.typedMessageDigest } : null;
        return entry;
    };
    return {
        schema: 'fsusblog.route-response-error-probe-facts.v1',
        fixtureAuthority: {
            prepareStateDigest,
            projectionDigest: projection.projectionDigest,
            articleIdDigest: sha(projection.articleId),
            articleTitleDigest: sha(projection.articleTitle),
            searchCanaryDigest: sha(projection.searchKeyword)
        },
        cases: [
            value('public-visible-first-read', 200, 'payload', '1', {
                headers: { 'content-type': 'application/octet-stream', 'x-fsus-frame-version': '2',
                    'x-fsus-generation': '1', 'x-fsus-release-id': releaseId, etag: '"fixture-etag"' },
                typedEntityId: Number(projection.articleId), typedTitleDigest: sha(projection.articleTitle)
            }),
            value('public-visible-cache-revalidation', 304, 'payload', '2', {
                headers: { etag: '"fixture-etag"' }
            }),
            value('public-missing-typed-error', 404, 'typed-error', '3', {
                typedCode: 2, typedCategory: 4, typedStatusCode: 404, typedMessageDigest: sha('article_not_found')
            }),
            value('anonymous-auth-denied', 401, 'typed-error', '4', {
                typedCode: 4, typedCategory: 2, typedStatusCode: 401, typedMessageDigest: digest('4')
            }),
            value('user-self-visible', 200, 'payload', '5'),
            value('user-admin-denied', 403, 'typed-error', '6', {
                typedCode: 5, typedCategory: 3, typedStatusCode: 403, typedMessageDigest: digest('6')
            }),
            value('admin-list-visible', 200, 'payload', '7')
        ],
        coherent: true
    };
}


test('route probe facts reject partial and mismatched semantic relations', () =>
{
    const prepared = {
        schema: 'fsusblog.fixture-prepare-state.v1', terminalState: 'prepared',
        plan: { profileIdentity: { profileId: 'acceptance-representative' }, executionIdentity: {
            runId, namespace: runId, sourceIdentity: { commit, worktreeFingerprint: fingerprint }
        }, catalogDigest: digest('c') },
        producerOutputs: { 'public-content': {
            producerId: 'public-content', strategy: 'transaction-fixture', producerVariantPlanDigest: digest('d'),
            variantIds: ['canonical.public.article.published'], entityIdentities: [
                { kind: 'article', id: '11' }, { kind: 'category', id: '12' }, { kind: 'tag', id: '13' }
            ], observations: { source: 'service', database: {}, redis: {}, cache: {} },
            projection: { articleId: '11', articleTitle: 'Current article', categoryId: '12', tagId: '13', searchKeyword: 'CURRENT_BODY' }
        } }
    };
    const expectedReleaseId = '20260830123456-aaaaaaaaaaaa';
    const partial = routeFacts(prepared, digest('e'), expectedReleaseId);
    partial.cases.pop();
    assert.throws(() => verifyFacts('route-response-error', partial, { expectedReleaseId }), /exact real request closure/u);

    const mismatched = routeFacts(prepared, digest('e'), expectedReleaseId);
    mismatched.cases.find((entry) => entry.id === 'user-admin-denied').status = 200;
    assert.throws(() => verifyFacts('route-response-error', mismatched, { expectedReleaseId }), /role\/auth\/visibility\/cache relations/u);

    for (const mutate of [
        (facts) =>
        {
            facts.cases[0].typedEntityId = 99;
        },
        (facts) =>
        {
            facts.cases[0].typedTitleDigest = digest('f');
        },
        (facts) =>
        {
            delete facts.cases[0].headers['x-fsus-frame-version'];
        },
        (facts) =>
        {
            facts.cases[1].headers.etag = '"stale-etag"';
        },
        (facts) =>
        {
            facts.cases[2].typedCode = 3;
        },
        (facts) =>
        {
            facts.cases[3].typedPayloadDigest = null;
        }
    ])
    {
        const stale = routeFacts(prepared, digest('e'), expectedReleaseId);
        mutate(stale);
        assert.throws(() => verifyFacts('route-response-error', stale, { expectedReleaseId }), /role\/auth\/visibility\/cache relations/u);
    }
});


test('cache and session probe facts reject partial terminal relations', () =>
{
    assert.throws(() => verifyFacts('cache-search-outbox-convergence', {
        schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
        terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
        events: [], query: { containsMarker: true }, readModel: { visible: true }, output: { containsMarker: true }
    }), /stale or partial/u);
    assert.throws(() => verifyFacts('session-cookie-runtime', {
        schema: 'fsusblog.session-cookie-runtime-probe-facts.v1', coherent: true,
        credential: { matches: true }, authContext: { jwtMatches: true }, jwt: { sessionMatches: true },
        cookie: { sessionMatches: true }, expiry: { ordered: true }, revision: { current: true },
        device: { matches: true }, service: { currentSessionMatches: true, status: { me: 200, sessions: 200 } }
    }), /DB\/JWT\/cookie\/service relations/u);
});


test('cache facts reject wrong release paths, duplicate events, and unsealed generations', () =>
{
    const expectedReleaseId = '20260830123456-aaaaaaaaaaaa';
    const facts = {
        schema: 'fsusblog.cache-search-outbox-probe-facts.v1', coherent: true,
        terminal: { state: 'converged', processedEvents: 1, poisonEvents: 0 },
        events: [{ id: 1, status: 'processed', last_error: null }],
        edges: { eventTypes: ['article-published'] },
        authorityCoordinate: { articleIdDigest: digest('1'), mutationIdDigest: digest('2') },
        generation: { value: '3', valueDigest: sha('3'), present: true },
        query: {
            searchIndexDigest: digest('4'),
            releaseScopedPath: `/release-derived/${expectedReleaseId}/search/index.bin`,
            releaseId: expectedReleaseId,
            containsMarker: true
        },
        readModel: {
            projectionDigest: digest('5'), detailDigest: digest('6'),
            detailTitleDigest: digest('7'), visible: true
        },
        output: { navigationDigest: digest('8'), envelopeDigest: digest('9'), containsMarker: true }
    };
    assert.doesNotThrow(() => verifyFacts('cache-search-outbox-convergence', facts, { expectedReleaseId }));
    for (const mutate of [
        (value) =>
        {
            value.query.releaseScopedPath = '/release-derived/other/search/index.bin';
        },
        (value) =>
        {
            value.terminal.processedEvents = 2;
            value.events.push(structuredClone(value.events[0]));
            value.edges.eventTypes.push('article-published');
        },
        (value) =>
        {
            value.generation.present = false;
        }
    ])
    {
        const changed = structuredClone(facts);
        mutate(changed);
        assert.throws(() => verifyFacts('cache-search-outbox-convergence', changed, { expectedReleaseId }),
            /stale or partial/u);
    }
});


test('session facts require distinct positive, negative, and revoked-session failure outcomes', () =>
{
    const expectedReleaseId = '20260830123456-aaaaaaaaaaaa';
    const facts = sessionFacts();
    facts.service.releaseIds = [expectedReleaseId, expectedReleaseId];
    facts.modeOutcomes.positive.releaseId = expectedReleaseId;
    facts.modeOutcomes.negative.releaseId = expectedReleaseId;
    facts.modeOutcomes.failure.releaseIds = [expectedReleaseId, expectedReleaseId];

    assert.doesNotThrow(() => verifyFacts('session-cookie-runtime', facts, { expectedReleaseId }));
    for (const mode of ['positive', 'negative', 'failure'])
    {
        const changed = structuredClone(facts);
        changed.modeOutcomes[mode].passed = false;
        assert.throws(() => verifyFacts('session-cookie-runtime', changed, { expectedReleaseId }),
            /DB\/JWT\/cookie\/service relations/u);
    }
});
