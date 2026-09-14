import assert from 'node:assert/strict';
import test from 'node:test';

import {
    decodeCommentArticleCursor,
    encodeCommentArticleCursor
} from '../../tools/data-scale/aeds-decoders.mjs';
import {
    verifyHttpPayloadProof
} from '../../tools/data-scale/semantic-proof.mjs';

const CANARIES = Object.freeze({
    article: {
        id: 1,
        title: 'data-scale:local:scale-m:article:1',
        searchToken: 'data-scale-search-1',
        publicStatus: 'published'
    },
    category: {
        id: 10,
        name: 'data-scale:local:scale-m:category:1'
    },
    tag: {
        id: 20,
        name: 'data-scale:local:scale-m:tag:1'
    },
    comment: {
        id: 100,
        articleId: 1,
        contentPrefix: 'data-scale:local:scale-m:comment:'
    }
});

function validDecodedResponses()
{
    return {
        articleList: {
            items: [
                { id: 1, title: 'data-scale:local:scale-m:article:1' },
                { id: 2, title: 'data-scale:local:scale-m:article:2' }
            ]
        },
        categoryList: {
            items: [
                { id: 10, name: 'data-scale:local:scale-m:category:1' }
            ]
        },
        tagList: {
            items: [
                { id: 20, name: 'data-scale:local:scale-m:tag:1' }
            ]
        },
        articleDetail: {
            id: 1,
            title: 'data-scale:local:scale-m:article:1',
            content: '# Article 1\nSearch token: data-scale-search-1\nBody'
        },
        commentCursor: {
            nextCursor: null,
            hasMore: false,
            count: 1,
            data: [
                {
                    id: '100',
                    rootId: '100',
                    isDeleted: false,
                    isEdited: false,
                    createTime: '2024-02-29T23:59:59.000Z',
                    content: 'data-scale:local:scale-m:comment:1:root',
                    replyCount: 0,
                    hasMoreReplies: false,
                    repliesPreview: []
                }
            ]
        }
    };
}

test('decodes valid article list and verifies canary article ID and title', () =>
{
    const responses = validDecodedResponses();
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'ok');
    assert.equal(proof.errors.length, 0);
    assert.ok(proof.assertionIds.includes('data-scale.http-payload.article-list'));
});

test('fails when HTTP 200 succeeds but article list is pre-seed stale payload (missing canary)', () =>
{
    const responses = validDecodedResponses();
    responses.articleList = {
        items: [
            { id: 999, title: 'old-preseed-article' }
        ]
    };
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((err) => err.includes('http_article_list_missing_canary')));
});

test('decodes valid category response and verifies canary category ID and name', () =>
{
    const responses = validDecodedResponses();
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'ok');
    assert.ok(proof.assertionIds.includes('data-scale.http-payload.category-list'));
});

test('fails when category response succeeds but lacks canary category', () =>
{
    const responses = validDecodedResponses();
    responses.categoryList = {
        items: [
            { id: 99, name: 'other-category' }
        ]
    };
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((err) => err.includes('http_category_list_missing_canary')));
});

test('decodes valid tag response and verifies canary tag ID and name', () =>
{
    const responses = validDecodedResponses();
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'ok');
    assert.ok(proof.assertionIds.includes('data-scale.http-payload.tag-list'));
});

test('fails when tag response succeeds but lacks canary tag', () =>
{
    const responses = validDecodedResponses();
    responses.tagList = {
        items: [
            { id: 99, name: 'other-tag' }
        ]
    };
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((err) => err.includes('http_tag_list_missing_canary')));
});

test('decodes valid article detail response and verifies canary body and search token', () =>
{
    const responses = validDecodedResponses();
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'ok');
    assert.ok(proof.assertionIds.includes('data-scale.http-payload.article-detail'));
});

test('fails when article detail response has wrong body or missing search token', () =>
{
    const responses = validDecodedResponses();
    responses.articleDetail = {
        id: 1,
        title: 'data-scale:local:scale-m:article:1',
        content: '# Article without search token'
    };
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((err) => err.includes('http_article_detail_missing_search_token')));
});

test('decodes valid comment article cursor and verifies canary comment', () =>
{
    const rawCommentData = {
        nextCursor: null,
        hasMore: false,
        count: 1,
        data: [{
            id: '100',
            rootId: '100',
            isDeleted: false,
            isEdited: false,
            createTime: '2024-02-29T23:59:59.000Z',
            content: 'data-scale:local:scale-m:comment:1:root',
            replyCount: 0,
            hasMoreReplies: false,
            repliesPreview: []
        }]
    };
    const binary = encodeCommentArticleCursor(rawCommentData);
    const decoded = decodeCommentArticleCursor(binary);
    assert.equal(decoded.count, 1);
    assert.equal(decoded.data[0].id, '100');

    const responses = validDecodedResponses();
    responses.commentCursor = decoded;
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'ok');
});

test('fails when comment cursor belongs to wrong article or lacks canary comment', () =>
{
    const responses = validDecodedResponses();
    responses.commentCursor = {
        nextCursor: null,
        hasMore: false,
        count: 1,
        data: [{
            id: '999',
            rootId: '999',
            content: 'unrelated-comment'
        }]
    };
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((err) => err.includes('http_comment_cursor_missing_canary')));
});

test('passes comment cursor check for scale-xs when seeded comments count is 0', () =>
{
    const responses = validDecodedResponses();
    responses.commentCursor = {
        nextCursor: null,
        hasMore: false,
        count: 0,
        data: []
    };
    const scaleXsCanaries = {
        ...CANARIES,
        comment: {
            id: null,
            articleId: 1,
            contentPrefix: 'data-scale:local:scale-xs:comment:'
        }
    };
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: scaleXsCanaries
    });
    assert.equal(proof.status, 'ok');
});

test('fails when frame type is correct but payload schema or content is corrupt', () =>
{
    const responses = validDecodedResponses();
    responses.articleList = 'not-an-object';
    const proof = verifyHttpPayloadProof({
        decodedResponses: responses,
        canaries: CANARIES
    });
    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((err) => err.includes('http_article_list_payload_shape_invalid')));
});
