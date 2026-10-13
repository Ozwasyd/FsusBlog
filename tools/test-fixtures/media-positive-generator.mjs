import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MEDIA_POSITIVE_SHAPE_IDS,
    loadMediaShapeCatalog,
    mediaContentDigest,
    stableMediaStringify,
    validateMediaShapeCatalog
} from './media-shape-catalog.mjs';
import { verifyDecodedMediaBytes } from './media-codec-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const generatorVersion = 'fsusblog.deterministic-media-generator.v1';
const jpegFixtures = Object.freeze({
    landscape: '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAEAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAwDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD54+FfwK/1P+j+navJpY/zOHJuINtT6n8O/Ar/AIlUX+j/AKV6UcfpufseF4g/dL3j/9k=',
    portrait: '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAGAAgDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5r+Ffwjsv3PKdu1eZSxkjDJs5q6H/2Q==',
});
const sourceFiles = Object.freeze({
    'webp-landscape': path.join(root, 'src/frontend/public/social/x-card.webp'),
    'webp-square': path.join(root, 'src/frontend/public/social/social-square.webp')
});

function expectedGeneratorSource(shape)
{
    if (shape.format === 'jpeg')
    {
        return 'pinned-synthetic-jpeg-pillow-12.3.0-v1';
    }
    if (shape.format === 'png')
    {
        return 'builtin-stored-deflate-png-v1';
    }
    if (shape.format === 'svg')
    {
        return 'builtin-safe-svg-v1';
    }
    if (shape.format === 'webp')
    {
        return `checked-in-${shape.id}-v1`;
    }
    throw new Error(`shape ${shape.id} has unsupported generator format`);
}

function sha256(value)
{
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function crc32(buffer)
{
    let crc = 0xffffffff;
    for (const byte of buffer)
    {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1)
        {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buffer)
{
    let a = 1;
    let b = 0;
    for (const byte of buffer)
    {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data)
{
    const name = Buffer.from(type, 'ascii');
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    name.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
    return result;
}

function storedZlib(raw)
{
    const blocks = [Buffer.from([0x78, 0x01])];
    for (let offset = 0; offset < raw.length;)
    {
        const length = Math.min(65535, raw.length - offset);
        const last = offset + length === raw.length;
        const header = Buffer.alloc(5);
        header[0] = last ? 1 : 0;
        header.writeUInt16LE(length, 1);
        header.writeUInt16LE((~length) & 0xffff, 3);
        blocks.push(header, raw.subarray(offset, offset + length));
        offset += length;
    }
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(adler32(raw));
    blocks.push(checksum);
    return Buffer.concat(blocks);
}

function generatePng(width, height, alpha)
{
    const channels = alpha ? 4 : 3;
    const raw = Buffer.alloc(height * (1 + width * channels));
    for (let y = 0; y < height; y += 1)
    {
        const row = y * (1 + width * channels);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1)
        {
            const pixel = row + 1 + x * channels;
            raw[pixel] = (x * 17 + y * 3) & 0xff;
            raw[pixel + 1] = (x * 5 + y * 19) & 0xff;
            raw[pixel + 2] = (x * 11 + y * 7) & 0xff;
            if (alpha)
            {
                raw[pixel + 3] = (x + y) % 3 === 0 ? 0x80 : 0xff;
            }
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = alpha ? 6 : 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', storedZlib(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function jpegSegments(bytes)
{
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
    {
        throw new Error('JPEG SOI/EOI is invalid');
    }
    const segments = [];
    let offset = 2;
    while (offset < bytes.length - 2)
    {
        if (bytes[offset] !== 0xff)
        {
            throw new Error('JPEG marker framing is invalid');
        }
        while (bytes[offset] === 0xff)
        {
            offset += 1;
        }
        const marker = bytes[offset];
        offset += 1;
        if (marker === 0xda)
        {
            const length = bytes.readUInt16BE(offset);
            segments.push({ marker, offset: offset - 2, dataOffset: offset + 2, length: length - 2 });
            return segments;
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7))
        {
            continue;
        }
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length)
        {
            throw new Error('JPEG segment length is invalid');
        }
        segments.push({ marker, offset: offset - 2, dataOffset: offset + 2, length: length - 2 });
        offset += length;
    }
    return segments;
}

function generateJpeg(width, height, orientation)
{
    const key = width === 12 && height === 8 && orientation === 1 ? 'landscape'
        : width === 8 && height === 6 && orientation === 6 ? 'portrait' : null;
    if (!key)
    {
        throw new Error('JPEG shape does not match a pinned synthetic fixture');
    }
    return Buffer.from(jpegFixtures[key], 'base64');
}

function generateSvg(width, height)
{
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#4f46e5"/><circle cx="${Math.floor(width / 2)}" cy="${Math.floor(height / 2)}" r="${Math.max(1, Math.floor(Math.min(width, height) / 4))}" fill="#f8fafc" fill-opacity=".75"/></svg>\n`, 'utf8');
}

function readPng(bytes)
{
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!bytes.subarray(0, 8).equals(signature))
    {
        throw new Error('PNG signature is invalid');
    }
    let offset = 8;
    let ihdr;
    let complete = false;
    while (offset < bytes.length)
    {
        if (offset + 12 > bytes.length)
        {
            throw new Error('PNG chunk framing is truncated');
        }
        const length = bytes.readUInt32BE(offset);
        if (offset + length + 12 > bytes.length)
        {
            throw new Error('PNG chunk payload is truncated');
        }
        const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length)))
        {
            throw new Error(`PNG ${type} CRC is invalid`);
        }
        if (type === 'IHDR')
        {
            ihdr = data;
        }
        if (type === 'IEND')
        {
            complete = true;
        }
        offset += length + 12;
    }
    if (!ihdr || !complete || offset !== bytes.length)
    {
        throw new Error('PNG structure is incomplete');
    }
    return { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), alpha: [4, 6].includes(ihdr[9]), orientation: 1 };
}

function readJpeg(bytes)
{
    const segments = jpegSegments(bytes);
    const sof = segments.find((item) => item.marker >= 0xc0 && item.marker <= 0xc3);
    if (!sof)
    {
        throw new Error('JPEG SOF is missing');
    }
    let orientation = 1;
    const exif = segments.find((item) => item.marker === 0xe1 && bytes.subarray(item.dataOffset, item.dataOffset + 6).toString('binary') === 'Exif\0\0');
    if (exif)
    {
        const tiff = bytes.subarray(exif.dataOffset + 6, exif.dataOffset + exif.length);
        const endian = tiff.subarray(0, 2).toString('ascii');
        if (tiff.length < 8 || !['II', 'MM'].includes(endian))
        {
            throw new Error('JPEG EXIF byte order is invalid');
        }
        const short = (offset) => endian === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
        const long = (offset) => endian === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
        const directory = long(4);
        if (short(2) !== 42 || directory + 2 > tiff.length)
        {
            throw new Error('JPEG EXIF directory is invalid');
        }
        const entries = short(directory);
        if (entries > 64 || directory + 2 + entries * 12 > tiff.length)
        {
            throw new Error('JPEG EXIF directory is truncated or over budget');
        }
        for (let entry = directory + 2; entry < directory + 2 + entries * 12; entry += 12)
        {
            if (short(entry) === 0x0112)
            {
                if (short(entry + 2) !== 3 || long(entry + 4) !== 1)
                {
                    throw new Error('JPEG EXIF orientation type is invalid');
                }
                orientation = short(entry + 8);
            }
        }
    }
    return { width: bytes.readUInt16BE(sof.dataOffset + 3), height: bytes.readUInt16BE(sof.dataOffset + 1), alpha: false, orientation };
}

function readWebp(bytes)
{
    if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length)
    {
        throw new Error('WebP RIFF framing is invalid');
    }
    let offset = 12;
    while (offset + 8 <= bytes.length)
    {
        const type = bytes.subarray(offset, offset + 4).toString('ascii');
        const length = bytes.readUInt32LE(offset + 4);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (data.length !== length)
        {
            throw new Error('WebP chunk is truncated');
        }
        if (type === 'VP8 ')
        {
            if (data.length < 10 || !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a])))
            {
                throw new Error('WebP VP8 frame header is invalid');
            }
            return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff, alpha: false, orientation: 1 };
        }
        if (type === 'VP8X')
        {
            return { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1, alpha: Boolean(data[0] & 0x10), orientation: 1 };
        }
        if (type === 'VP8L')
        {
            if (data[0] !== 0x2f)
            {
                throw new Error('WebP VP8L signature is invalid');
            }
            const packed = data.readUInt32LE(1);
            return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1, alpha: true, orientation: 1 };
        }
        offset += 8 + length + (length & 1);
    }
    throw new Error('WebP image chunk is missing');
}

function readSvg(bytes)
{
    const source = bytes.toString('utf8');
    if (!/^<svg\b/u.test(source) || /<(?:script|foreignObject)\b|(?:href|src)\s*=|<!DOCTYPE/iu.test(source))
    {
        throw new Error('SVG is not a safe minimal vector');
    }
    const viewBox = source.match(/\bviewBox="0 0 ([1-9][0-9]*) ([1-9][0-9]*)"/u);
    if (!viewBox)
    {
        throw new Error('SVG viewBox is missing');
    }
    return { width: Number(viewBox[1]), height: Number(viewBox[2]), alpha: true, orientation: 1 };
}

export function inspectMediaBytes(bytes, declaration)
{
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
    {
        throw new Error('media bytes must be non-empty');
    }
    if (bytes.length > 4 * 1024 * 1024)
    {
        throw new Error('media encoded byte budget exceeded');
    }
    let facts;
    switch (declaration.format)
    {
        case 'jpeg': facts = readJpeg(bytes);
            break;
        case 'png': facts = readPng(bytes);
            break;
        case 'svg': facts = readSvg(bytes);
            break;
        case 'webp': facts = readWebp(bytes);
            break;
        default: throw new Error(`unsupported media format ${declaration.format}`);
    }
    const expectedMimes = { jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp' };
    const expectedExtensions = { jpeg: ['.jpg', '.jpeg'], png: ['.png'], svg: ['.svg'], webp: ['.webp'] };
    if (declaration.mime !== expectedMimes[declaration.format] || !expectedExtensions[declaration.format].includes(declaration.extension))
    {
        throw new Error('media MIME or extension does not match decoded format');
    }
    if (facts.width > 8192 || facts.height > 8192 || facts.width * facts.height > 2_000_000)
    {
        throw new Error('media decoded dimensions budget exceeded');
    }
    const byteDigest = sha256(bytes);
    if (declaration.format !== 'svg')
    {
        const decoded = verifyDecodedMediaBytes(bytes);
        if (['format', 'width', 'height', 'alpha', 'orientation'].some((key) =>
            decoded[key] !== (key === 'format' ? declaration.format : facts[key])))
        {
            throw new Error('media decoded facts disagree with independent codec');
        }
        facts = { ...facts, codec: decoded.codec, pixelDigest: decoded.pixelDigest,
            orientedPixelDigest: decoded.orientedPixelDigest };
    }
    const decodedDigest = sha256(stableMediaStringify({ format: declaration.format, ...facts,
        ...(declaration.format === 'svg' ? { byteDigest } : {}) }));
    return Object.freeze({ format: declaration.format, mime: declaration.mime, extension: declaration.extension, ...facts, byteDigest, byteLength: bytes.length, decodedDigest });
}

export function generatePositiveMediaBytes(shape, catalog = loadMediaShapeCatalog())
{
    const errors = validateMediaShapeCatalog(catalog);
    if (errors.length)
    {
        throw new Error(errors.join('\n'));
    }
    const authoritativeShape = catalog.shapes.find((item) => item.id === shape.id);
    if (!authoritativeShape || stableMediaStringify(shape) !== stableMediaStringify(authoritativeShape))
    {
        throw new Error('positive generator requires the exact current catalog shape');
    }
    if (shape.validityClass !== 'canonical-positive')
    {
        throw new Error('positive generator rejects non-positive shapes');
    }
    if (shape.id === 'no-cover')
    {
        return null;
    }
    let bytes;
    let sourceId;
    if (shape.format === 'jpeg')
    {
        bytes = generateJpeg(shape.width, shape.height, shape.orientation);
        sourceId = expectedGeneratorSource(shape);
    }
    else if (shape.format === 'png')
    {
        bytes = generatePng(shape.width, shape.height, shape.alpha);
        sourceId = expectedGeneratorSource(shape);
    }
    else if (shape.format === 'svg')
    {
        bytes = generateSvg(shape.width, shape.height);
        sourceId = expectedGeneratorSource(shape);
    }
    else if (shape.format === 'webp')
    {
        bytes = fs.readFileSync(sourceFiles[shape.id]);
        sourceId = expectedGeneratorSource(shape);
    }
    else
    {
        throw new Error(`shape ${shape.id} has unsupported generator format`);
    }
    const facts = inspectMediaBytes(bytes, shape);
    if (facts.width !== shape.width || facts.height !== shape.height || facts.alpha !== shape.alpha || facts.orientation !== shape.orientation)
    {
        throw new Error(`shape ${shape.id} decoded facts do not match MediaShapeCatalog: expected ${shape.width}x${shape.height}/alpha=${shape.alpha}/orientation=${shape.orientation}, observed ${facts.width}x${facts.height}/alpha=${facts.alpha}/orientation=${facts.orientation}`);
    }
    return Object.freeze({ bytes, facts, sourceId, generatorVersion, inputDigest: sha256(stableMediaStringify(shape)) });
}

function sealReceipt(value)
{
    const receipt = structuredClone(value);
    receipt.contentDigest = mediaContentDigest(receipt);
    return receipt;
}

export function materializePositiveMedia({ store, catalog = loadMediaShapeCatalog(), shapeIds = MEDIA_POSITIVE_SHAPE_IDS, replicas = 1 })
{
    if (!Number.isInteger(replicas) || replicas < 0 || replicas > 1000)
    {
        throw new Error('media positive replica count must be between 0 and 1000');
    }
    const selected = shapeIds.map((id) => catalog.shapes.find((item) => item.id === id));
    if (selected.some((item) => !item) || new Set(shapeIds).size !== shapeIds.length)
    {
        throw new Error('media positive shape selection contains an unknown ID');
    }
    const receipts = [];
    const started = process.hrtime.bigint();
    for (let ordinal = 0; ordinal < replicas; ordinal += 1)
    {
        for (const shape of selected)
        {
            const generated = generatePositiveMediaBytes(shape, catalog);
            if (generated === null)
            {
                receipts.push(sealReceipt({
                    schema: 'fsusblog.media-positive-no-cover-receipt.v1',
                    catalogDigest: catalog.contentDigest,
                    shapeDigest: shape.contentDigest,
                    shapeId: shape.id,
                    validityClass: 'canonical-positive',
                    verificationStatus: 'verified',
                    assetId: null,
                    storageRef: null,
                    explicitNoCover: true,
                    mediaContentDigest: sha256(stableMediaStringify({ shapeId: shape.id, explicitNoCover: true }))
                }));
                continue;
            }
            const record = store.materialize({ shapeId: shape.id, extension: shape.extension, bytes: generated.bytes, metadata: generated.facts, ordinal });
            if (stableMediaStringify(record.metadata) !== stableMediaStringify(generated.facts))
            {
                throw new Error('canonical media asset metadata does not match verified codec facts');
            }
            receipts.push(sealReceipt({
                schema: 'fsusblog.media-positive-asset-receipt.v1',
                catalogDigest: catalog.contentDigest,
                shapeDigest: shape.contentDigest,
                validityClass: 'canonical-positive',
                verificationStatus: 'verified',
                materializationOwner: 'canonical-media-positive-generator',
                generator: { id: generatorVersion, sourceId: generated.sourceId, inputDigest: generated.inputDigest },
                shapeId: shape.id,
                assetId: record.assetId,
                storageRef: { storageClass: record.storageClass, storageKey: record.storageKey, ownerNamespace: record.ownerNamespace },
                format: generated.facts.format,
                mime: generated.facts.mime,
                extension: generated.facts.extension,
                dimensions: { width: generated.facts.width, height: generated.facts.height },
                orientation: generated.facts.orientation,
                alpha: generated.facts.alpha,
                byteDigest: generated.facts.byteDigest,
                byteLength: generated.facts.byteLength,
                decodedDigest: generated.facts.decodedDigest,
                decoder: generated.facts.codec ?? { semantic: 'safe-svg-source-v1' },
                pixelDigest: generated.facts.pixelDigest ?? null,
                orientedPixelDigest: generated.facts.orientedPixelDigest ?? null,
                mediaContentDigest: sha256(stableMediaStringify({ shapeId: shape.id, facts: generated.facts, generator: generated.sourceId })),
                status: record.status
            }));
        }
    }
    return Object.freeze({ receipts, durationMs: Number(process.hrtime.bigint() - started) / 1e6 });
}

export function verifyPositiveMediaReceipts({ receipts, store, catalog = loadMediaShapeCatalog() })
{
    const errors = [];
    let records;
    const catalogErrors = validateMediaShapeCatalog(catalog);
    if (catalogErrors.length)
    {
        return catalogErrors;
    }
    for (const receipt of receipts)
    {
        if (receipt.contentDigest !== mediaContentDigest(receipt))
        {
            errors.push(`positive receipt ${receipt.shapeId} content digest is invalid`);
            continue;
        }
        const shape = catalog.shapes.find((item) => item.id === receipt.shapeId);
        if (!shape || shape.validityClass !== 'canonical-positive')
        {
            errors.push(`positive receipt references unknown shape ${receipt.shapeId}`);
            continue;
        }
        if (receipt.catalogDigest !== catalog.contentDigest || receipt.shapeDigest !== shape.contentDigest)
        {
            errors.push(`positive receipt ${shape.id} catalog or shape identity is stale`);
        }
        if (shape.id === 'no-cover')
        {
            if (receipt.schema !== 'fsusblog.media-positive-no-cover-receipt.v1'
        || receipt.assetId !== null
        || receipt.storageRef !== null
        || receipt.explicitNoCover !== true
        || receipt.validityClass !== 'canonical-positive'
        || receipt.verificationStatus !== 'verified'
        || receipt.mediaContentDigest !== sha256(stableMediaStringify({ shapeId: shape.id, explicitNoCover: true })))
            {
                errors.push('no-cover receipt created an asset or default image');
            }
            continue;
        }
        try
        {
            if (receipt.schema !== 'fsusblog.media-positive-asset-receipt.v1'
        || receipt.validityClass !== 'canonical-positive'
        || receipt.verificationStatus !== 'verified'
        || receipt.materializationOwner !== 'canonical-media-positive-generator')
            {
                errors.push(`positive receipt ${shape.id} authority is invalid`);
            }
            if (receipt.generator?.id !== generatorVersion
        || receipt.generator?.sourceId !== expectedGeneratorSource(shape)
        || receipt.generator?.inputDigest !== sha256(stableMediaStringify(shape)))
            {
                errors.push(`positive receipt ${shape.id} generator identity or version is invalid`);
            }
            const bytes = store.read({ assetId: receipt.assetId, storageKey: receipt.storageRef?.storageKey, byteDigest: receipt.byteDigest });
            const facts = inspectMediaBytes(bytes, shape);
            if (stableMediaStringify(receipt.decoder) !== stableMediaStringify(facts.codec ?? { semantic: 'safe-svg-source-v1' })
                || receipt.pixelDigest !== (facts.pixelDigest ?? null)
                || receipt.orientedPixelDigest !== (facts.orientedPixelDigest ?? null))
            {
                errors.push(`positive receipt ${shape.id} decoder or pixel identity is invalid`);
            }
            for (const key of ['format', 'mime', 'extension', 'orientation', 'alpha', 'byteDigest', 'byteLength', 'decodedDigest'])
            {
                if (receipt[key] !== facts[key])
                {
                    errors.push(`positive receipt ${shape.id} ${key} is invalid`);
                }
            }
            if (receipt.dimensions?.width !== facts.width || receipt.dimensions?.height !== facts.height)
            {
                errors.push(`positive receipt ${shape.id} dimensions are invalid`);
            }
            if (!/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(receipt.assetId ?? ''))
            {
                errors.push(`positive receipt ${shape.id} AssetId is invalid`);
            }
            if (path.isAbsolute(receipt.storageRef?.storageKey ?? '') || String(receipt.storageRef?.storageKey).includes('..'))
            {
                errors.push(`positive receipt ${shape.id} storage ref is unsafe`);
            }
            if (receipt.mediaContentDigest !== sha256(stableMediaStringify({ shapeId: shape.id, facts, generator: expectedGeneratorSource(shape) })))
            {
                errors.push(`positive receipt ${shape.id} media content identity is invalid`);
            }
            records ??= new Map(store.receipt().records.map((item) => [item.assetId, item]));
            const record = records.get(receipt.assetId);
            if (!record
        || record.shapeId !== shape.id
        || record.storageKey !== receipt.storageRef?.storageKey
        || record.ownerNamespace !== receipt.storageRef?.ownerNamespace
        || record.byteDigest !== facts.byteDigest
        || record.byteLength !== facts.byteLength
        || stableMediaStringify(record.metadata) !== stableMediaStringify(facts))
            {
                errors.push(`positive receipt ${shape.id} canonical AssetId metadata is invalid`);
            }
        }
        catch (error)
        {
            errors.push(`positive receipt ${shape.id} failed independent verification: ${error.message}`);
        }
    }
    return errors;
}

export function scanPositiveMediaGeneratorGovernance({
    source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'),
    codecSource = fs.readFileSync(new URL('./media-codec-verifier.mjs', import.meta.url), 'utf8'),
    codecPythonSource = fs.readFileSync(new URL('./media-codec-verifier.py', import.meta.url), 'utf8'),
    additionalSources = []
} = {})
{
    const errors = [];
    if (!source.includes('verifyDecodedMediaBytes(bytes)'))
    {
        errors.push('canonical-generator: real independent decoded pixels are required');
    }
    if (!codecSource.includes("spawnSync('python3', [verifierFile]")
        || !codecSource.includes('timeout: 5000') || !codecSource.includes('maxBuffer: 8192')
        || !codecSource.includes("pillow: '12.3.0'")
        || !codecPythonSource.includes('"pillow": "12.3.0"')
        || !codecPythonSource.includes('image.load()')
        || !codecPythonSource.includes('width * height > 2_000_000'))
    {
        errors.push('canonical-codec: fixed decoder identity and byte/time/pixel bounds are required');
    }
    const sources = [
        ['canonical-generator', source.replace(/export function scanPositiveMediaGeneratorGovernance[\s\S]*$/u, '')],
        ...additionalSources
    ];
    for (const [name, inspected] of sources)
    {
        if (/\bfetch\s*\(|\b(?:import|require)\s*\([^)]*https?:\/\//u.test(inspected))
        {
            errors.push(`${name}: media generator cannot fetch remote bytes`);
        }
        if (/child_process|ImageMagick|sharp\s*\(|system-font|font-family/iu.test(inspected))
        {
            errors.push(`${name}: media generator cannot use ambient codecs or fonts`);
        }
        if (/wwwroot|PublicAssetRoot|writeFileSync\([^\n]*shape\.extension/iu.test(inspected))
        {
            errors.push(`${name}: media generator cannot write directly to a public path`);
        }
        if (/(?:<svg[^\n]*\.webp|format\s*:\s*['"]svg['"][^\n]{0,160}extension\s*:\s*['"]\.webp['"])/iu.test(inspected))
        {
            errors.push(`${name}: media generator cannot fake a raster extension or MIME`);
        }
        if (/default-cover|placeholder-asset|fallback-image/iu.test(inspected))
        {
            errors.push(`${name}: media generator cannot inject a default image`);
        }
        if (/\bfunction\s+(?:generateMedia|createAssetGenerator)\b/u.test(inspected))
        {
            errors.push(`${name}: media generator cannot define a second asset generator`);
        }
        if (name !== 'canonical-generator' && /\bfunction\s+verifyDecodedMediaBytes\b/u.test(inspected))
        {
            errors.push(`${name}: media generator cannot define a second codec verifier`);
        }
    }
    return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const errors = scanPositiveMediaGeneratorGovernance();
    if (errors.length)
    {
        process.stderr.write(`${errors.join('\n')}\n`);
        process.exitCode = 1;
    }
    else
    {
        process.stdout.write('positive media generator governance is valid\n');
    }
}
