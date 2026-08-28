import { createHash } from 'node:crypto';

import {
    contentShapeBoundaryPlan,
    contentShapeCatalogDigest,
    readContentShapeAuthority,
    sha256,
    stableStringify,
    validateContentShapeAuthority
} from '../testing/content-shape-catalog.mjs';

const GENERATION_VERSION = 'unicode-boundary-v1';

function requireText(value, label)
{
    if (typeof value !== 'string' || value.length === 0)
    {
        throw new Error(`[content-shape-generator] ${label} is required`);
    }
    return value;
}

function seededToken(script, seed)
{
    const values = [...script.codePoints];
    if (values.length < 2 || ['bidi', 'combining', 'emoji-zwj', 'zero-width'].includes(script.id))
    {
        return String.fromCodePoint(...values);
    }
    const digest = createHash('sha256').update(String(seed), 'utf8').digest();
    const offset = digest.readUInt32BE(0) % values.length;
    return String.fromCodePoint(...values.slice(offset), ...values.slice(0, offset));
}

function utf16Units(text)
{
    return Buffer.from(text, 'utf16le').byteLength / 2;
}

function utf8Bytes(text)
{
    return Buffer.byteLength(text, 'utf8');
}

function scalarCount(text)
{
    let count = 0;
    for (const _scalar of text) count += 1;
    return count;
}

function graphemeCount(text)
{
    let count = 0;
    for (const _segment of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) count += 1;
    return count;
}

function repeatToUtf16Target(token, target)
{
    if (!Number.isSafeInteger(target) || target < 0)
    {
        throw new Error('[content-shape-generator] UTF-16 target must be a non-negative safe integer');
    }
    const units = utf16Units(token);
    if (units === 0) return 'a'.repeat(target);
    const repetitions = Math.floor(target / units);
    const remainder = target - (repetitions * units);
    return `${token.repeat(repetitions)}${'a'.repeat(remainder)}`;
}

function repeatToUtf8Target(token, target)
{
    if (!Number.isSafeInteger(target) || target < 0)
    {
        throw new Error('[content-shape-generator] UTF-8 target must be a non-negative safe integer');
    }
    const width = utf8Bytes(token);
    if (width === 0) return 'a'.repeat(target);
    const repetitions = Math.floor(target / width);
    let remainder = target - (repetitions * width);
    let suffix = '';
    for (const [bytes, value] of [[4, '\u{1f680}'], [3, '\u754c'], [2, '\u00e9'], [1, 'a']])
    {
        const count = Math.floor(remainder / bytes);
        suffix += value.repeat(count);
        remainder -= count * bytes;
    }
    if (remainder !== 0)
    {
        throw new Error(`[content-shape-generator] cannot satisfy UTF-8 byte target ${target}`);
    }
    return `${token.repeat(repetitions)}${suffix}`;
}

function applyProductionNormalization(text, field)
{
    return field.normalization === 'trim' ? text.trim() : text;
}

function applyShapeNormalization(text, shape)
{
    if (shape.normalizationForm === 'NFC') return text.normalize('NFC');
    if (shape.normalizationForm === 'NFKC') return text.normalize('NFKC');
    return text;
}

function statistics(text)
{
    const bytes = Buffer.from(text, 'utf8');
    return Object.freeze({
        unicodeScalarCount: scalarCount(text),
        graphemeCount: graphemeCount(text),
        utf16CodeUnitCount: utf16Units(text),
        utf8ByteCount: bytes.byteLength,
        contentDigest: sha256(bytes)
    });
}

function resolveTarget({ shape, boundaryCase })
{
    if (!boundaryCase)
    {
        return { dimension: 'utf16-code-units', value: shape.target.ordinaryUtf16Units, kind: 'ordinary' };
    }
    return {
        dimension: boundaryCase.dimension === 'characters' ? 'utf16-code-units' : 'utf8-bytes',
        value: boundaryCase.target,
        kind: boundaryCase.kind
    };
}

function fieldValidity(text, field)
{
    const characters = utf16Units(text);
    const bytes = utf8Bytes(text);
    const reasons = [];
    if (field.minCharacters != null && characters < field.minCharacters) reasons.push('characters-below-min');
    if (field.maxCharacters != null && characters > field.maxCharacters) reasons.push('characters-above-max');
    if (field.minUtf8Bytes != null && bytes < field.minUtf8Bytes) reasons.push('utf8-bytes-below-min');
    if (field.maxUtf8Bytes != null && bytes > field.maxUtf8Bytes) reasons.push('utf8-bytes-above-max');
    return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function generateContentShape({
    shapeId,
    fieldId,
    boundaryCaseId = null,
    fixedSeed = 'fsusblog-content-shape-v1',
    generationVersion = GENERATION_VERSION,
    authority = readContentShapeAuthority()
} = {})
{
    if (generationVersion !== GENERATION_VERSION || generationVersion !== authority.catalog.generationVersion)
    {
        throw new Error(`[content-shape-generator] unsupported generation version ${generationVersion}`);
    }
    const errors = validateContentShapeAuthority({ authority, scanGovernance: false });
    if (errors.length)
    {
        throw new Error(`[content-shape-generator] invalid authority: ${errors.join('; ')}`);
    }
    const shape = authority.catalog.shapes.find((item) => item.id === requireText(shapeId, 'shapeId'));
    if (!shape) throw new Error(`[content-shape-generator] unknown shape ${shapeId}`);
    const field = authority.fields.fields.find((item) => item.id === requireText(fieldId, 'fieldId'));
    if (!field) throw new Error(`[content-shape-generator] unknown field ${fieldId}`);
    if (!shape.applicableFields.includes(field.id))
    {
        throw new Error(`[content-shape-generator] shape ${shape.id} does not apply to ${field.id}`);
    }
    const boundaryCase = boundaryCaseId == null
        ? null
        : contentShapeBoundaryPlan(authority).cases.find((item) => item.id === boundaryCaseId);
    if (boundaryCaseId != null && (!boundaryCase || boundaryCase.fieldId !== field.id))
    {
        throw new Error(`[content-shape-generator] unknown or mismatched boundary case ${boundaryCaseId}`);
    }
    const script = authority.catalog.scriptClasses.find((item) => item.id === shape.scriptClasses[0]);
    const token = seededToken(script, shape.fixedSeedPolicy === 'required' ? fixedSeed : shape.id);
    const target = resolveTarget({ shape, boundaryCase });
    const exactText = target.dimension === 'utf8-bytes'
        ? repeatToUtf8Target(token, target.value)
        : repeatToUtf16Target(token, target.value);
    const productionText = applyProductionNormalization(exactText, field);
    const normalizedText = applyShapeNormalization(exactText, shape);
    const productionValidity = fieldValidity(productionText, field);
    const expectedValidity = shape.eligibility === 'positive' && productionValidity.valid;
    const body = {
        schema: 'fsusblog.generated-content-shape.v1',
        generationVersion,
        contentShapeCatalogDigest: contentShapeCatalogDigest(authority),
        shapeId: shape.id,
        shapeContentDigest: shape.contentDigest,
        fieldContractRef: field.sourceRef,
        fieldContractDigest: authority.fields.contentDigest,
        fieldId: field.id,
        boundaryCaseId: boundaryCase?.id ?? null,
        fixedSeed: shape.fixedSeedPolicy === 'required' ? String(fixedSeed) : null,
        eligibility: shape.eligibility,
        target,
        exactText,
        exactTextBytesBase64: Buffer.from(exactText, 'utf8').toString('base64'),
        statistics: statistics(exactText),
        productionNormalizedText: productionText,
        productionStatistics: statistics(productionText),
        requestedNormalizedText: normalizedText,
        requestedNormalizationStatistics: statistics(normalizedText),
        expectedDimensionValidity: boundaryCase?.expectedDimensionValidity ?? true,
        expectedValidity,
        expectedRejectionReasons: shape.eligibility === 'negative'
            ? Object.freeze(['negative-shape-eligibility'])
            : productionValidity.reasons
    };
    return Object.freeze({ ...body, outputDigest: sha256(stableStringify(body)) });
}

export function verifyGeneratedContentShape(document, { authority = readContentShapeAuthority() } = {})
{
    if (!document || typeof document !== 'object')
    {
        throw new Error('[content-shape-generator] generated document is required');
    }
    const regenerated = generateContentShape({
        shapeId: document.shapeId,
        fieldId: document.fieldId,
        boundaryCaseId: document.boundaryCaseId,
        fixedSeed: document.fixedSeed ?? 'ignored-by-shape',
        generationVersion: document.generationVersion,
        authority
    });
    if (stableStringify(document) !== stableStringify(regenerated))
    {
        throw new Error('[content-shape-generator] generated text/statistics/digest tamper detected');
    }
    return regenerated;
}

export function generateContentShapes(requests, { authority = readContentShapeAuthority() } = {})
{
    if (!Array.isArray(requests))
    {
        throw new Error('[content-shape-generator] requests must be an array');
    }
    return Object.freeze(requests.map((request) => generateContentShape({ ...request, authority })));
}

/** Yield bounded chunks without splitting a grapheme, surrogate pair, or ZWJ sequence. */
export function* contentShapeTextChunks(document, { maximumUtf8Bytes = 64 * 1024 } = {})
{
    if (!Number.isSafeInteger(maximumUtf8Bytes) || maximumUtf8Bytes < 4)
    {
        throw new Error('[content-shape-generator] maximumUtf8Bytes must be an integer of at least 4');
    }
    let chunk = '';
    let chunkBytes = 0;
    for (const segment of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(document.exactText))
    {
        const segmentBytes = utf8Bytes(segment.segment);
        if (segmentBytes > maximumUtf8Bytes)
        {
            throw new Error('[content-shape-generator] one grapheme exceeds the requested chunk boundary');
        }
        if (chunkBytes > 0 && chunkBytes + segmentBytes > maximumUtf8Bytes)
        {
            yield chunk;
            chunk = '';
            chunkBytes = 0;
        }
        chunk += segment.segment;
        chunkBytes += segmentBytes;
    }
    if (chunkBytes > 0) yield chunk;
}

export function contentShapeLogProjection(document)
{
    return Object.freeze({
        shapeId: document.shapeId,
        fieldId: document.fieldId,
        boundaryCaseId: document.boundaryCaseId,
        statistics: document.statistics,
        expectedValidity: document.expectedValidity,
        outputDigest: document.outputDigest
    });
}
