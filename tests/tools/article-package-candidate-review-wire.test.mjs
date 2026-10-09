import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    articlePackageCandidateReviewReservedFrames,
    decodeArticlePackageCandidateReviewRequest,
    decodeArticlePackageCandidateReviewResponse,
    decodeCorrelatedArticlePackageCandidateReviewResponse,
    encodeArticlePackageCandidateReviewRequest
} from '../../src/frontend/src/codecs/binary/articlePackageCandidateReviewWire.ts';

const requestLiteral = '{"requestId":"wire-read","archiveBytes":"AQ==","requestedMode":"CreateNew","callerPolicyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","callerPermissionContextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","createdAtUtc":"2026-10-09T01:02:03Z","expiresAtUtc":"2026-10-10T01:02:03Z","requestedTargets":null,"pageIndex":0,"pageSize":50,"expectedPlanDigest":null,"expectedContext":null}';
const responseLiteral = '{"requestId":"wire-read","review":{"candidateStatus":"finite_bytes_validated","summary":{"articleCount":1,"fileCount":3,"schemaVersion":1,"canonicalHashVersion":1,"propertySchemaVersion":1,"packageBytesDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","manifestSemanticDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","checksumComponentDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"requestedMode":"CreateNew","policyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAtUtc":"2026-10-09T01:02:03.0000000Z","expiresAtUtc":"2026-10-10T01:02:03.0000000Z","intervalStatus":"caller_interval_current","planDigest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","pageIndex":0,"pageSize":50,"totalTargets":1,"targets":[{"portableArticle":"article:11111111-1111-1111-1111-111111111111","requiresNewIdentity":true,"requestedTargetArticleId":null,"expectedTargetRevision":null}],"requiredAuthorities":["archive_intake","complete_package_schema","canonical_source_and_property_provenance","fsusui_syntax_dependencies","persisted_relation_and_embed_plan","frozen_public_projection_retention","asset_and_dependency_resolution","rights_responsibility_taxonomy_privacy","current_actor_site_target_permissions","current_target_revision_and_identity","execution_qualification"],"executeDisabled":true,"executionReasonCode":"article_package_import_authority_unavailable"},"context":{"identity":"fsus-site:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lifecycleVersion":1,"generation":2,"mappingRevision":7,"scopeRevision":3}}';
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const parseRequest = value => decodeArticlePackageCandidateReviewRequest(bytes(value));
const parseResponse = value => decodeArticlePackageCandidateReviewResponse(bytes(value));
const invalid = { message: 'article_package_candidate_review_wire_invalid' };

function updateRequest(revision = '9223372036854775807')
{
    const request = JSON.parse(requestLiteral);
    request.requestedMode = 'UpdateRequested';
    request.requestedTargets = [{ portableArticle: 'article:11111111-1111-1111-1111-111111111111', requestedTargetArticleId: 73, expectedTargetRevision: revision }];
    request.expectedPlanDigest = 'f'.repeat(64);
    request.expectedContext = JSON.parse(responseLiteral).context;
    return request;
}

function updateResponse(revision = '9223372036854775807')
{
    const response = JSON.parse(responseLiteral);
    response.review.requestedMode = 'UpdateRequested';
    Object.assign(response.review.targets[0], { requiresNewIdentity: false, requestedTargetArticleId: 73, expectedTargetRevision: revision });
    return response;
}

test('literal seed and projection retain refusal and exact correlation', () =>
{
    const request = parseRequest(requestLiteral);
    const response = decodeCorrelatedArticlePackageCandidateReviewResponse(bytes(responseLiteral), request, new AbortController().signal);
    assert.deepEqual(articlePackageCandidateReviewReservedFrames, { request: 288, response: 289 });
    assert.equal(response.review.executeDisabled, true);
    assert.equal(response.review.executionReasonCode, 'article_package_import_authority_unavailable');
    assert.deepEqual(decodeArticlePackageCandidateReviewRequest(encodeArticlePackageCandidateReviewRequest(request)), request);
});

test('request closed shape rejects duplicates missing null wrong primitives and unsafe numbers', () =>
{
    for (const [property, value] of [
        ['requestId', null], ['pageSize', 0], ['pageSize', 51], ['pageSize', '50'], ['pageIndex', 9007199254740992],
        ['requestedMode', 'Execute'], ['archiveBytes', 'AR=='], ['archiveBytes', 'AQ== '], ['callerPolicyDigest', 'A'.repeat(64)],
        ['createdAtUtc', '2026-02-30T01:02:03Z'], ['createdAtUtc', '2026-10-09T01:02:03+00:00'],
        ['createdAtUtc', '2026-10-09T24:00:00Z'], ['expiresAtUtc', '2026-10-09T01:02:03Z'], ['expectedPlanDigest', 'f'.repeat(64)],
        ['createdAtUtc', '2026-10-09T01:02:03Z\n'], ['callerPolicyDigest', 'a'.repeat(64) + '\n']
    ])
    {
        assert.throws(() => parseRequest({ ...JSON.parse(requestLiteral), [property]: value }), invalid);
    }
    for (const raw of ['1.0', '1e0', '-0', '9007199254740993'])
    {
        assert.throws(() => parseRequest(requestLiteral.replace('"pageIndex":0', '"pageIndex":' + raw)), invalid);
    }
    assert.throws(() => parseRequest(requestLiteral.replace('"pageSize":50', '"pageSize":50,"pageSize":50')), invalid);
    assert.throws(() => parseRequest(requestLiteral.replace('"pageSize":50,', '')), invalid);
    assert.throws(() => parseRequest({ ...JSON.parse(requestLiteral), adminSession: 'private-canary' }), invalid);
    assert.throws(() => parseRequest(requestLiteral.replace('"pageSize":50', '"pageSize":50,"page\\u0053ize":50')), invalid);
});

test('every nested response level rejects unknown duplicate missing and required null members', () =>
{
    for (const select of [root => root, root => root.review, root => root.review.summary, root => root.review.targets[0], root => root.context])
    {
        const root = JSON.parse(responseLiteral);
        const selected = select(root);
        selected.privateSource = 'private-canary';
        assert.throws(() => parseResponse(root), invalid);
        delete selected.privateSource;
        const key = Object.keys(selected)[0];
        const member = JSON.stringify(key) + ':' + JSON.stringify(selected[key]);
        assert.throws(() => parseResponse(JSON.stringify(root).replace(member, member + ',' + member)), invalid);
        delete selected[key];
        assert.throws(() => parseResponse(root), invalid);
        selected[key] = null;
        assert.throws(() => parseResponse(root), invalid);
    }
    assert.throws(() => parseResponse(responseLiteral.replace('"generation":2', '"generation":true')), invalid);
    assert.throws(() => parseResponse(responseLiteral.replace('"executeDisabled":true', '"executeDisabled":false')), invalid);
    assert.throws(() => parseResponse(responseLiteral.replace('execution_qualification', 'execution_granted')), invalid);
    assert.throws(() => parseResponse(responseLiteral.replace('"totalTargets":1', '"totalTargets":2')), invalid);
});

test('nested targets preserve exact Int64 strings and reject numeric or noncanonical revisions', () =>
{
    const response = parseResponse(updateResponse());
    assert.equal(response.review.targets[0].expectedTargetRevision, '9223372036854775807');
    assert.equal(parseRequest(updateRequest()).requestedTargets[0].expectedTargetRevision, '9223372036854775807');
    for (const value of ['0', '01', '+1', '-1', '1.0', '9223372036854775808', '1\n', 73, null])
    {
        assert.throws(() => parseRequest(updateRequest(value)), invalid);
        assert.throws(() => parseResponse(updateResponse(value)), invalid);
    }
    const request = updateRequest('1');
    request.requestedTargets[0].privateScope = 'private-canary';
    assert.throws(() => parseRequest(request), invalid);
    delete request.requestedTargets[0].privateScope;
    request.requestedTargets.push({ ...request.requestedTargets[0] });
    assert.throws(() => parseRequest(request), invalid);
    const closedRequest = JSON.stringify(updateRequest('1'));
    assert.throws(() => parseRequest(closedRequest.replace('"generation":2', '"generation":2,"generation":2')), invalid);
    assert.throws(() => parseRequest(closedRequest.replace('"expectedTargetRevision":"1"', '"expectedTargetRevision":1')), invalid);
    const scoped = updateRequest('1');
    scoped.expectedContext.scope = 'private-canary';
    assert.throws(() => parseRequest(scoped), invalid);
});

test('archive requestId and complete frame budgets use original byte and UTF16 units', () =>
{
    const request = JSON.parse(requestLiteral);
    request.requestId = '😀'.repeat(64);
    request.archiveBytes = Buffer.alloc(524288).toString('base64');
    assert.equal(parseRequest(request).requestId.length, 128);
    request.requestId += '😀';
    assert.throws(() => parseRequest(request), invalid);
    request.requestId = 'wire-read';
    request.archiveBytes = Buffer.alloc(524289).toString('base64');
    assert.throws(() => parseRequest(request), invalid);
    const boundary = bytes(requestLiteral.padEnd(1048576 - 16, ' '));
    assert.equal(decodeArticlePackageCandidateReviewRequest(boundary).pageSize, 50);
    assert.throws(() => decodeArticlePackageCandidateReviewRequest(new Uint8Array([...boundary, 32])), invalid);
    assert.throws(() => parseRequest(requestLiteral.replace('wire-read', '\\ud800')), invalid);
    assert.throws(() => decodeArticlePackageCandidateReviewRequest(new Uint8Array([0xff])), invalid);
    assert.throws(() => parseRequest(requestLiteral.replace('wire-read', '\\u0085')), invalid);
});

test('requestedTargets budget and original target identity closure are finite', () =>
{
    const request = updateRequest('1');
    request.requestedTargets = Array.from({ length: 1000 }, (_, index) => ({
        portableArticle: 'article:' + (index + 1).toString(16).padStart(8, '0') + '-1111-1111-1111-111111111111',
        requestedTargetArticleId: index + 1,
        expectedTargetRevision: '1'
    }));
    assert.equal(parseRequest(request).requestedTargets.length, 1000);
    request.requestedTargets.push({ portableArticle: 'article:000003e9-1111-1111-1111-111111111111', requestedTargetArticleId: 1001, expectedTargetRevision: '1' });
    assert.throws(() => parseRequest(request), invalid);
    request.requestedTargets = [{ portableArticle: 'article:00000000-0000-0000-0000-000000000000', requestedTargetArticleId: 1, expectedTargetRevision: '1' }];
    assert.throws(() => parseRequest(request), invalid);
    request.requestedTargets[0].portableArticle = 'article:11111111-1111-1111-1111-111111111111\n';
    assert.throws(() => parseRequest(request), invalid);
});

test('correlation refuses old request plan context dates and changed target hints', () =>
{
    const request = parseRequest(updateRequest());
    const signal = new AbortController().signal;
    for (const mutate of [
        root => { root.requestId = 'late-read'; }, root => { root.review.planDigest = 'a'.repeat(64); },
        root => { root.context.generation = 3; }, root => { root.context.mappingRevision = 8; }, root => { root.context.scopeRevision = 4; },
        root => { root.review.createdAtUtc = '2026-10-09T01:02:03.0000001Z'; },
        root => { root.review.targets[0].requestedTargetArticleId = 74; }
    ])
    {
        const root = updateResponse();
        mutate(root);
        assert.throws(() => decodeCorrelatedArticlePackageCandidateReviewResponse(bytes(root), request, signal), invalid);
    }
    const cancelled = new AbortController();
    cancelled.abort();
    assert.throws(() => decodeCorrelatedArticlePackageCandidateReviewResponse(bytes(updateResponse()), request, cancelled.signal),
        { message: 'article_package_import_cancelled' });
});

test('private material and malformed UTF8 never enter accepted projection or error text', () =>
{
    for (const field of ['archiveBytes', 'title', 'source', 'scopes', 'credential', 'receipt'])
    {
        assert.throws(() => parseResponse({ ...JSON.parse(responseLiteral), [field]: 'private-canary' }), invalid);
    }
    assert.throws(() => parseResponse('private-canary'), invalid);
    assert.throws(() => parseResponse(responseLiteral.replace('"identity":"fsus-site:', '"identity":"https://private-canary/')), invalid);
});
