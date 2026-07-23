import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildAudioArtifactVector as buildAudioArtifact,
    encodeVisualArtifact as encodeVisual
} from './perception-character-v3-artifacts.mjs';
import {
    switchRepresentation as switchStateRepresentation,
    transition as transitionState
} from './perception-character-v3-state-machine.mjs';
import {
    ascii,
    base64url,
    bytes32,
    clamp,
    clampByte,
    fixedBytesEqual,
    hex32,
    int64,
    requireKey as requireExactKey,
    sha256,
    uint16,
    utf8
} from './perception-character-v3-bytes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const contract = Object.freeze(JSON.parse(readFileSync(
    path.join(root, 'src/shared/Contracts/Validation/Security/perception-character-v3-contract.json'),
    'utf8'
)));

const asciiWhitespace = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);
const glyphRows = contract.raster.glyphAtlasBaseRows;
const variantOffsets = contract.raster.glyphVariantOffsets;

export function normalizeAnswer(value)
{
    let normalized = '';
    for (const character of String(value ?? ''))
    {
        const code = character.codePointAt(0);
        if (asciiWhitespace.has(code))
        {
            continue;
        }
        normalized += code >= 0x61 && code <= 0x7a
            ? String.fromCharCode(code - 0x20)
            : character;
    }
    return normalized.length === contract.answer.length
        && [...normalized].every((character) => contract.answer.alphabet.includes(character))
        ? normalized
        : null;
}

export function sampleAnswer(readBytes)
{
    let answer = '';
    while (answer.length < contract.answer.length)
    {
        const candidate = readBytes(1);
        if (!Buffer.isBuffer(candidate) || candidate.length !== 1)
        {
            throw new TypeError('readBytes must return exactly the requested number of bytes');
        }
        if (candidate[0] < contract.answer.rejectionByteLimitExclusive)
        {
            answer += contract.answer.alphabet[candidate[0] % contract.answer.alphabet.length];
        }
    }
    return answer;
}

export function encodeLP(fields)
{
    if (!Array.isArray(fields) || fields.length > 0xffff)
    {
        throw new RangeError('EncodeLP accepts at most 65535 fields');
    }
    const count = Buffer.alloc(2);
    count.writeUInt16BE(fields.length);
    const encoded = [count];
    for (const field of fields)
    {
        const bytes = Buffer.isBuffer(field) ? field : Buffer.from(field);
        if (bytes.length > 0xffffffff)
        {
            throw new RangeError('EncodeLP field exceeds uint32 length');
        }
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        encoded.push(length, bytes);
    }
    return Buffer.concat(encoded);
}

export function encodeAnswerMaterial(context, answer)
{
    const normalized = normalizeAnswer(answer);
    if (normalized === null)
    {
        throw new Error('answer normalization failed');
    }
    return encodeLP([
        utf8(contract.cryptography.answerDomain),
        Buffer.from([contract.version]),
        utf8(context.challengeId),
        utf8(context.envelopeId),
        utf8(context.action),
        utf8(context.routeKey),
        hex32(context.subjectHash),
        hex32(context.deviceBindingHash),
        utf8(context.policyVersion),
        hex32(context.artifactHash),
        ascii(context.representation),
        ascii(context.mediaType),
        uint16(context.physicalWidth),
        uint16(context.physicalHeight),
        uint16(context.displayWidth),
        uint16(context.displayHeight),
        ascii(normalized)
    ]);
}

export function computeAnswerTag(key, context, answer)
{
    requireKey(key);
    return createHmac('sha256', key).update(encodeAnswerMaterial(context, answer)).digest();
}

export function fixedTimeTagEquals(left, right)
{
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    const paddedLeft = Buffer.alloc(32);
    const paddedRight = Buffer.alloc(32);
    leftBytes.copy(paddedLeft, 0, 0, Math.min(leftBytes.length, 32));
    rightBytes.copy(paddedRight, 0, 0, Math.min(rightBytes.length, 32));
    return timingSafeEqual(paddedLeft, paddedRight)
        && leftBytes.length === 32
        && rightBytes.length === 32;
}

export function encodeAad(context)
{
    return encodeLP([
        ascii(contract.enum),
        ascii(contract.wireName),
        ascii(contract.algorithm),
        Buffer.from([contract.version]),
        utf8(context.challengeId),
        utf8(context.envelopeId),
        utf8(context.action),
        utf8(context.routeKey),
        hex32(context.artifactHash),
        ascii(context.representation),
        ascii(context.mediaType),
        uint16(context.physicalWidth),
        uint16(context.physicalHeight),
        uint16(context.displayWidth),
        uint16(context.displayHeight),
        int64(context.issuedAtUnixMs),
        int64(context.expiresAtUnixMs),
        ascii(context.tokenKeyVersion)
    ]);
}

export function encodeState(state)
{
    return encodeLP([
        bytes32(state.answerTag, 'answerTag'),
        hex32(state.artifactHash),
        ascii(state.mediaType),
        uint16(state.physicalWidth),
        uint16(state.physicalHeight),
        uint16(state.displayWidth),
        uint16(state.displayHeight),
        utf8(state.challengeId),
        utf8(state.envelopeId),
        utf8(state.action),
        utf8(state.routeKey),
        hex32(state.subjectHash),
        hex32(state.deviceBindingHash),
        hex32(state.clientIpBindingHash),
        utf8(state.policyVersion),
        Buffer.from([state.attemptBudget]),
        ascii(state.representation),
        int64(state.issuedAtUnixMs),
        int64(state.expiresAtUnixMs),
        ascii(state.tokenKeyVersion),
        ascii(state.answerKeyVersion)
    ]);
}

export function sealState(key, nonce, context, state)
{
    requireKey(key);
    const nonceBytes = Buffer.from(nonce);
    if (nonceBytes.length !== contract.cryptography.nonceBytes)
    {
        throw new Error('AES-GCM nonce must be 96 bits');
    }
    if (context.tokenKeyVersion !== state.tokenKeyVersion)
    {
        throw new Error('AAD and state token key versions differ');
    }
    const cipher = createCipheriv('aes-256-gcm', key, nonceBytes, {
        authTagLength: contract.cryptography.tagBytes
    });
    cipher.setAAD(encodeAad(context));
    const ciphertext = Buffer.concat([cipher.update(encodeState(state)), cipher.final()]);
    const keyVersion = ascii(context.tokenKeyVersion);
    const keyVersionLength = Buffer.alloc(2);
    keyVersionLength.writeUInt16BE(keyVersion.length);
    return base64url(Buffer.concat([
        Buffer.from([contract.version]),
        keyVersionLength,
        keyVersion,
        nonceBytes,
        ciphertext,
        cipher.getAuthTag()
    ]));
}

export function openStateBytes(key, token, context)
{
    requireKey(key);
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length < 1 + 2 + 1 + 12 + 16 || bytes[0] !== contract.version)
    {
        throw new Error('invalid token envelope');
    }
    const keyVersionLength = bytes.readUInt16BE(1);
    const nonceOffset = 3 + keyVersionLength;
    if (nonceOffset + 12 + 16 > bytes.length)
    {
        throw new Error('truncated token envelope');
    }
    const keyVersion = bytes.subarray(3, nonceOffset).toString('ascii');
    if (keyVersion !== context.tokenKeyVersion)
    {
        throw new Error('unknown token key version');
    }
    const nonce = bytes.subarray(nonceOffset, nonceOffset + 12);
    const tag = bytes.subarray(bytes.length - 16);
    const ciphertext = bytes.subarray(nonceOffset + 12, bytes.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(encodeAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function validateKeyRings({ tokenCurrent, tokenKeys, answerCurrent, answerKeys, environment = 'Production', allowTestVectors = false })
{
    for (const [label, current, ring] of [
        ['token', tokenCurrent, tokenKeys],
        ['answer', answerCurrent, answerKeys]
    ])
    {
        if (!current || !/^[A-Za-z0-9._-]{1,64}$/u.test(current))
        {
            throw new Error(`${label} current key version is missing or invalid`);
        }
        if (!ring || !Object.hasOwn(ring, current))
        {
            throw new Error(`${label} current key version is unknown`);
        }
        for (const [version, key] of Object.entries(ring))
        {
            if (!/^[A-Za-z0-9._-]{1,64}$/u.test(version))
            {
                throw new Error(`${label} key version is invalid`);
            }
            requireKey(key);
            const digest = sha256(key).toString('hex');
            if ((!allowTestVectors || environment !== 'Test') && testKeyDigests.has(digest))
            {
                throw new Error(`${label} key is a checked-in test vector`);
            }
        }
    }
    for (const tokenKey of Object.values(tokenKeys))
    {
        for (const answerKey of Object.values(answerKeys))
        {
            if (fixedBytesEqual(tokenKey, answerKey))
            {
                throw new Error('token and answer key material must be disjoint');
            }
        }
    }
    return true;
}

export function rasterize(answer, rasterSeed)
{
    const normalized = normalizeAnswer(answer);
    if (normalized === null)
    {
        throw new Error('raster answer is invalid');
    }
    const random = createDeterministicStream(rasterSeed);
    const { physicalWidth: width, physicalHeight: height } = contract.raster;
    const pixels = Buffer.alloc(width * height, 255);
    let originX = 39;
    for (let index = 0; index < normalized.length; index += 1)
    {
        const variant = random.integer(0, 5);
        const translationX = random.integer(-12, 12);
        const translationY = random.integer(-10, 10);
        const rotation = random.integer(-14, 14);
        const shear = random.integer(-18, 18) / 100;
        const scaleX = random.integer(90, 112) / 100;
        const scaleY = random.integer(92, 114) / 100;
        const baseline = random.integer(-8, 8);
        const overlap = index === normalized.length - 1 ? 0 : random.integer(4, 16);
        const gray = random.integer(0, 64);
        drawGlyph(pixels, width, height, normalized[index], variant, {
            centerX: originX + 26 + translationX,
            centerY: 72 + translationY + baseline,
            rotation,
            shear,
            scaleX,
            scaleY,
            gray
        });
        originX += 61 - overlap;
    }

    const curveCount = random.integer(2, 5);
    for (let index = 0; index < curveCount; index += 1)
    {
        drawCurve(pixels, width, height, {
            x0: random.integer(0, 72),
            y0: random.integer(12, 131),
            x1: random.integer(132, 252),
            y1: random.integer(0, 143),
            x2: random.integer(311, 383),
            y2: random.integer(12, 131),
            radius: random.integer(1, 3),
            gray: random.integer(32, 144)
        });
    }

    const occluderCount = random.integer(1, 3);
    for (let index = 0; index < occluderCount; index += 1)
    {
        drawOccluder(pixels, width, height, {
            x: random.integer(18, 365),
            y: random.integer(15, 128),
            width: random.integer(8, 28),
            height: random.integer(6, 20),
            gray: random.integer(72, 184)
        });
    }

    const lattice = Array.from({ length: 5 }, () => Array.from({ length: 9 }, () => ({
        x: random.integer(-7, 7),
        y: random.integer(-7, 7)
    })));
    const warped = Buffer.alloc(pixels.length);
    for (let y = 0; y < height; y += 1)
    {
        for (let x = 0; x < width; x += 1)
        {
            const displacement = bicubicDisplacement(lattice, x * 8 / (width - 1), y * 4 / (height - 1));
            warped[y * width + x] = bilinearGray(pixels, width, height, x - displacement.x, y - displacement.y);
        }
    }

    return warped;
}

export function encodeVisualArtifact(gray8, artifactSeed)
{
    return encodeVisual(contract, gray8, artifactSeed);
}

export function buildAudioArtifactVector(serialSeed)
{
    return buildAudioArtifact(contract, serialSeed);
}

export function atlasVariantBytes(character, variant)
{
    if (!contract.answer.alphabet.includes(character)
        || !Number.isInteger(variant)
        || variant < 0
        || variant >= contract.raster.glyphVariantsPerSymbol)
    {
        throw new Error('glyph atlas lookup is out of range');
    }
    return Buffer.from(glyphAtlas(character, variant).flat().map((value) => value ? 1 : 0));
}

export function transition(state, command)
{
    return transitionState(contract, state, command);
}

export function switchRepresentation(state, replacement)
{
    return switchStateRepresentation(contract, state, replacement);
}

export function buildVectors()
{
    const answerKey = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const tokenKey = Buffer.from('f0e0d0c0b0a09080706050403020100ff1e1d1c1b1a191817161514131211100', 'hex');
    const nonce = Buffer.from('000102030405060708090a0b', 'hex');
    const rasterSeed = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf', 'hex');
    const context = {
        challengeId: '018f47f0-7b5a-7cc1-8ea8-5d9ef1b18c7d',
        envelopeId: '018f47f0-7b5a-7cc2-9858-38dd997ac981',
        action: 'comment.create',
        routeKey: '/api/binary/comment',
        subjectHash: '11'.repeat(32),
        deviceBindingHash: '22'.repeat(32),
        clientIpBindingHash: '33'.repeat(32),
        policyVersion: 'risk-v3-2026-07-20',
        representation: 'visual',
        mediaType: contract.media.visual.mediaType,
        physicalWidth: contract.raster.physicalWidth,
        physicalHeight: contract.raster.physicalHeight,
        displayWidth: contract.raster.displayWidth,
        displayHeight: contract.raster.displayHeight,
        issuedAtUnixMs: 1784538000123,
        expiresAtUnixMs: 1784538120123,
        tokenKeyVersion: 'tk-2026-07'
    };
    const raster = rasterize('A7C9Q', rasterSeed);
    const visualArtifact = encodeVisualArtifact(raster, rasterSeed);
    const audioArtifact = buildAudioArtifactVector();
    const atlas = Buffer.concat([...contract.answer.alphabet].flatMap((character) =>
        Array.from({ length: contract.raster.glyphVariantsPerSymbol }, (_, variant) =>
            atlasVariantBytes(character, variant))));
    context.artifactHash = sha256(visualArtifact).toString('hex');
    const answerTag = computeAnswerTag(answerKey, context, ' a7\tC\n9q ');
    const state = {
        ...context,
        answerTag,
        attemptBudget: 2,
        representation: 'visual',
        answerKeyVersion: 'ak-2026-07'
    };
    const token = sealState(tokenKey, nonce, context, state);
    const boundary255 = Buffer.alloc(255, 0x61);
    const boundary256 = Buffer.alloc(256, 0x62);
    return {
        schema: 'fsusblog.security.perception-character-v3.test-vectors.v1',
        fixtureOnly: true,
        lp: {
            emptyHex: encodeLP([]).toString('hex'),
            emptyFieldHex: encodeLP([Buffer.alloc(0)]).toString('hex'),
            boundary255And256Sha256: sha256(encodeLP([boundary255, boundary256])).toString('hex'),
            reversedBoundaryFieldsSha256: sha256(encodeLP([boundary256, boundary255])).toString('hex')
        },
        answer: {
            sourceEscaped: ' a7\\tC\\n9q ',
            normalized: 'A7C9Q',
            materialHex: encodeAnswerMaterial(context, ' a7\tC\n9q ').toString('hex'),
            keyHex: answerKey.toString('hex'),
            tagHex: answerTag.toString('hex')
        },
        visual: {
            answer: 'A7C9Q',
            seedHex: rasterSeed.toString('hex'),
            mediaType: contract.media.visual.mediaType,
            byteLength: visualArtifact.length,
            artifactHashHex: context.artifactHash,
            artifactBase64: visualArtifact.toString('base64')
        },
        audio: {
            mediaType: contract.media.audio.mediaType,
            byteLength: audioArtifact.length,
            artifactHashHex: sha256(audioArtifact).toString('hex'),
            artifactBase64: audioArtifact.toString('base64')
        },
        atlas: {
            symbolCount: contract.answer.alphabet.length,
            variantsPerSymbol: contract.raster.glyphVariantsPerSymbol,
            bytesPerVariant: contract.raster.glyphAtlasWidth * contract.raster.glyphAtlasHeight,
            sha256: sha256(atlas).toString('hex')
        },
        state: {
            context,
            answerKeyVersion: state.answerKeyVersion,
            tokenKeyHex: tokenKey.toString('hex'),
            nonceHex: nonce.toString('hex'),
            plaintextHex: encodeState(state).toString('hex'),
            aadHex: encodeAad(context).toString('hex'),
            token
        }
    };
}

function drawGlyph(pixels, width, height, character, variant, transform)
{
    const atlas = glyphAtlas(character, variant);
    const radians = transform.rotation * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const radiusX = 54;
    const radiusY = 62;
    const left = Math.max(0, Math.floor(transform.centerX - radiusX));
    const right = Math.min(width - 1, Math.ceil(transform.centerX + radiusX));
    const top = Math.max(0, Math.floor(transform.centerY - radiusY));
    const bottom = Math.min(height - 1, Math.ceil(transform.centerY + radiusY));
    for (let y = top; y <= bottom; y += 1)
    {
        for (let x = left; x <= right; x += 1)
        {
            const translatedX = (x + 0.5) - transform.centerX;
            const translatedY = (y + 0.5) - transform.centerY;
            const shearedX = cosine * translatedX + sine * translatedY;
            const shearedY = -sine * translatedX + cosine * translatedY;
            const sourceY = shearedY / transform.scaleY;
            const sourceX = (shearedX - transform.shear * shearedY) / transform.scaleX;
            const column = Math.floor((sourceX + 35) / 10);
            const row = Math.floor((sourceY + 45) / 10);
            if (row >= 0 && row < 9 && column >= 0 && column < 7 && atlas[row][column])
            {
                const offset = y * width + x;
                pixels[offset] = Math.min(pixels[offset], transform.gray);
            }
        }
    }
}

function glyphAtlas(character, variant)
{
    const atlas = Array.from({ length: 9 }, () => Array(7).fill(false));
    const rows = glyphRows[character];
    for (let row = 0; row < rows.length; row += 1)
    {
        for (let column = 0; column < rows[row].length; column += 1)
        {
            if (rows[row][column] !== '1')
            {
                continue;
            }
            for (const [offsetX, offsetY] of variantOffsets[variant])
            {
                atlas[row + 1 + offsetY][column + 1 + offsetX] = true;
            }
        }
    }
    return atlas;
}

function drawCurve(pixels, width, height, curve)
{
    for (let step = 0; step <= 256; step += 1)
    {
        const t = step / 256;
        const inverse = 1 - t;
        const x = Math.round(inverse * inverse * curve.x0 + 2 * inverse * t * curve.x1 + t * t * curve.x2);
        const y = Math.round(inverse * inverse * curve.y0 + 2 * inverse * t * curve.y1 + t * t * curve.y2);
        stampCircle(pixels, width, height, x, y, curve.radius, curve.gray);
    }
}

function drawOccluder(pixels, width, height, occluder)
{
    const left = Math.max(0, Math.floor(occluder.x - occluder.width / 2));
    const right = Math.min(width - 1, Math.ceil(occluder.x + occluder.width / 2));
    const top = Math.max(0, Math.floor(occluder.y - occluder.height / 2));
    const bottom = Math.min(height - 1, Math.ceil(occluder.y + occluder.height / 2));
    for (let y = top; y <= bottom; y += 1)
    {
        for (let x = left; x <= right; x += 1)
        {
            const dx = (x - occluder.x) / (occluder.width / 2);
            const dy = (y - occluder.y) / (occluder.height / 2);
            if (dx * dx + dy * dy <= 1)
            {
                pixels[y * width + x] = Math.min(pixels[y * width + x], occluder.gray);
            }
        }
    }
}

function stampCircle(pixels, width, height, centerX, centerY, radius, gray)
{
    for (let y = centerY - radius; y <= centerY + radius; y += 1)
    {
        for (let x = centerX - radius; x <= centerX + radius; x += 1)
        {
            if (x >= 0 && x < width && y >= 0 && y < height
                && (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2)
            {
                pixels[y * width + x] = Math.min(pixels[y * width + x], gray);
            }
        }
    }
}

function bicubicDisplacement(lattice, x, y)
{
    const column = Math.floor(x);
    const row = Math.floor(y);
    const fractionX = x - column;
    const fractionY = y - row;
    const interpolateRows = (component) =>
    {
        const values = [];
        for (let offsetY = -1; offsetY <= 2; offsetY += 1)
        {
            const latticeRow = lattice[clamp(row + offsetY, 0, 4)];
            values.push(catmullRom(
                latticeRow[clamp(column - 1, 0, 8)][component],
                latticeRow[clamp(column, 0, 8)][component],
                latticeRow[clamp(column + 1, 0, 8)][component],
                latticeRow[clamp(column + 2, 0, 8)][component],
                fractionX
            ));
        }
        return catmullRom(values[0], values[1], values[2], values[3], fractionY);
    };
    return { x: interpolateRows('x'), y: interpolateRows('y') };
}

function catmullRom(p0, p1, p2, p3, t)
{
    return 0.5 * ((2 * p1)
        + (-p0 + p2) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
        + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

function bilinearGray(pixels, width, height, x, y)
{
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1)
    {
        return 255;
    }
    const left = Math.floor(x);
    const top = Math.floor(y);
    const right = Math.min(width - 1, left + 1);
    const bottom = Math.min(height - 1, top + 1);
    const fractionX = x - left;
    const fractionY = y - top;
    const topValue = pixels[top * width + left] * (1 - fractionX) + pixels[top * width + right] * fractionX;
    const bottomValue = pixels[bottom * width + left] * (1 - fractionX) + pixels[bottom * width + right] * fractionX;
    return clampByte(Math.floor(topValue * (1 - fractionY) + bottomValue * fractionY + 0.5));
}

function createDeterministicStream(seed)
{
    const key = bytes32(seed, 'rasterSeed');
    let counter = 0;
    let available = Buffer.alloc(0);
    return {
        integer(minimum, maximum)
        {
            const span = maximum - minimum + 1;
            const limit = Math.floor(0x100000000 / span) * span;
            while (true)
            {
                if (available.length < 4)
                {
                    const counterBytes = Buffer.alloc(4);
                    counterBytes.writeUInt32BE(counter);
                    counter += 1;
                    available = Buffer.concat([
                        available,
                        createHmac('sha256', key).update('fsus.perception-character.raster.v3\0').update(counterBytes).digest()
                    ]);
                }
                const candidate = available.readUInt32BE(0);
                available = available.subarray(4);
                if (candidate < limit)
                {
                    return minimum + candidate % span;
                }
            }
        }
    };
}

function requireKey(value)
{
    requireExactKey(contract, value);
}

const testKeyDigests = new Set([
    sha256(Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex')).toString('hex'),
    sha256(Buffer.from('f0e0d0c0b0a09080706050403020100ff1e1d1c1b1a191817161514131211100', 'hex')).toString('hex')
]);
