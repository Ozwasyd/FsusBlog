import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
    contentShapeLogProjection,
    contentShapeTextChunks,
    generateContentShape,
    generateContentShapes,
    verifyGeneratedContentShape
} from '../../tools/test-fixtures/content-shape-generator.mjs';
import {
    contentShapeBoundaryPlan,
    readContentShapeAuthority
} from '../../tools/testing/content-shape-catalog.mjs';

test('all Unicode classes generate deterministic exact bytes and statistics', () =>
{
    const authority = readContentShapeAuthority();
    for (const shape of authority.catalog.shapes)
    {
        const first = generateContentShape({ shapeId: shape.id, fieldId: 'article.body', fixedSeed: 'fixed-17', authority });
        const second = generateContentShape({ shapeId: shape.id, fieldId: 'article.body', fixedSeed: 'fixed-17', authority });
        assert.deepEqual(first, second, shape.id);
        assert.equal(Buffer.from(first.exactTextBytesBase64, 'base64').toString('utf8'), first.exactText);
        assert.equal(Buffer.byteLength(first.exactText, 'utf8'), first.statistics.utf8ByteCount);
        assert.equal(Buffer.from(first.exactText, 'utf16le').byteLength / 2, first.statistics.utf16CodeUnitCount);
        assert.deepEqual(verifyGeneratedContentShape(first, { authority }), first);
        const log = contentShapeLogProjection(first);
        assert.equal(Object.hasOwn(log, 'exactText'), false);
        assert.equal(Object.hasOwn(log, 'exactTextBytesBase64'), false);
    }
});

test('character and byte boundary plans are separate and exact', () =>
{
    const authority = readContentShapeAuthority();
    const commentField = authority.fields.fields.find((field) => field.id === 'comment.content');
    for (const boundary of contentShapeBoundaryPlan(authority).cases)
    {
        const shapeId = boundary.dimension === 'characters' ? 'script.latin-basic' : 'script.zh-hans';
        const generated = generateContentShape({
            shapeId,
            fieldId: boundary.fieldId,
            boundaryCaseId: boundary.id,
            fixedSeed: 'boundary',
            authority
        });
        const actual = boundary.dimension === 'characters'
            ? generated.productionStatistics.utf16CodeUnitCount
            : generated.productionStatistics.utf8ByteCount;
        assert.equal(actual, boundary.target, boundary.id);
        assert.equal(generated.expectedDimensionValidity, boundary.kind !== 'max-plus-one-negative');
    }

    const asciiCharacters = generateContentShape({
        shapeId: 'script.latin-basic', fieldId: 'comment.content',
        boundaryCaseId: 'comment.content.characters.max'
    });
    assert.equal(asciiCharacters.statistics.utf16CodeUnitCount, commentField.maxCharacters);
    assert.equal(asciiCharacters.statistics.utf8ByteCount, commentField.maxCharacters);
    assert.equal(asciiCharacters.expectedValidity, true);
    const tooManyCharacters = generateContentShape({
        shapeId: 'script.latin-basic', fieldId: 'comment.content',
        boundaryCaseId: 'comment.content.characters.max-plus-one-negative'
    });
    assert.equal(tooManyCharacters.expectedValidity, false);
    const multibyte = generateContentShape({
        shapeId: 'script.zh-hans', fieldId: 'comment.content',
        boundaryCaseId: 'comment.content.utf8-bytes.max'
    });
    assert.equal(multibyte.statistics.utf8ByteCount, commentField.maxUtf8Bytes);
    assert.notEqual(multibyte.statistics.utf16CodeUnitCount, commentField.maxUtf8Bytes);
});

test('normalization and sequence classes preserve valid Unicode boundaries', () =>
{
    const combining = generateContentShape({ shapeId: 'script.combining', fieldId: 'article.body', fixedSeed: 'n' });
    assert.notEqual(combining.statistics.contentDigest, combining.requestedNormalizationStatistics.contentDigest);
    assert.equal(combining.requestedNormalizedText.normalize('NFC'), combining.requestedNormalizedText);

    const fullwidth = generateContentShape({ shapeId: 'script.fullwidth', fieldId: 'article.body', fixedSeed: 'n' });
    assert.notEqual(fullwidth.exactText, fullwidth.requestedNormalizedText);
    assert.equal(fullwidth.requestedNormalizedText.normalize('NFKC'), fullwidth.requestedNormalizedText);

    const emoji = generateContentShape({ shapeId: 'script.emoji-zwj', fieldId: 'article.body', fixedSeed: 'n' });
    assert.match(emoji.exactText, /\u{1f469}\u200d\u{1f4bb}/u);
    const negativeBidi = generateContentShape({ shapeId: 'negative.bidi', fieldId: 'comment.content' });
    const negativeZeroWidth = generateContentShape({ shapeId: 'negative.zero-width', fieldId: 'comment.content' });
    assert.equal(negativeBidi.expectedValidity, false);
    assert.equal(negativeZeroWidth.expectedValidity, false);
    assert.match(negativeBidi.exactText, /\u202e/u);
    assert.match(negativeZeroWidth.exactText, /\u200b/u);
});

test('fixed seed controls only deterministic internal ordering', () =>
{
    const first = generateContentShape({ shapeId: 'script.mixed-script', fieldId: 'article.body', fixedSeed: 'seed-a' });
    const repeat = generateContentShape({ shapeId: 'script.mixed-script', fieldId: 'article.body', fixedSeed: 'seed-a' });
    const changed = generateContentShape({ shapeId: 'script.mixed-script', fieldId: 'article.body', fixedSeed: 'seed-z' });
    assert.equal(first.outputDigest, repeat.outputDigest);
    assert.notEqual(first.exactText, changed.exactText);
});

test('independent verifier rejects text, statistics, and digest tamper', () =>
{
    const generated = generateContentShape({ shapeId: 'script.zh-hant', fieldId: 'article.title', fixedSeed: 'tamper' });
    for (const mutation of [
        { ...generated, exactText: `${generated.exactText}x` },
        { ...generated, statistics: { ...generated.statistics, utf8ByteCount: generated.statistics.utf8ByteCount + 1 } },
        { ...generated, outputDigest: `sha256:${'0'.repeat(64)}` }
    ])
    {
        assert.throws(() => verifyGeneratedContentShape(mutation), /tamper detected/u);
    }
});

test('zero, one, one thousand shapes and a 200k body stay bounded', () =>
{
    const started = performance.now();
    const bodyField = readContentShapeAuthority().fields.fields.find((field) => field.id === 'article.body');
    const empty = generateContentShapes([]);
    assert.deepEqual(empty, []);
    const [one] = generateContentShapes([{ shapeId: 'script.long-unbroken-token', fieldId: 'article.body' }]);
    assert.equal(one.statistics.utf16CodeUnitCount, 512);
    const thousand = generateContentShapes(Array.from({ length: 1000 }, (_, index) => ({
        shapeId: 'script.latin-basic', fieldId: 'article.title', fixedSeed: `shape-${index}`
    })));
    assert.equal(thousand.length, 1000);
    const body = generateContentShape({
        shapeId: 'script.long-unbroken-token',
        fieldId: 'article.body',
        boundaryCaseId: 'article.body.characters.max'
    });
    assert.equal(body.statistics.utf16CodeUnitCount, bodyField.maxCharacters);
    const chunks = [...contentShapeTextChunks(body, { maximumUtf8Bytes: 4096 })];
    assert.equal(chunks.join(''), body.exactText);
    assert.equal(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 4096), true);
    assert.ok(performance.now() - started < 15000, 'bounded generation should complete within 15 seconds');
});
