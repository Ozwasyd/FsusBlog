import { createHash, createHmac } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

import {
    contract,
    encodeVisualArtifact,
    rasterize,
    sampleAnswer
} from '../contracts/perception-character-v3-reference.mjs';
import {
    disposeAudioEncoder,
    encodeAudioArtifact,
    validateAudioArtifact,
    validateVisualArtifact
} from './perception-character-v3-pool-media.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

function deterministicReader(domain, index)
{
    const key = createHash('sha256').update(`fsus-v3-corpus/${domain}/${index}`).digest();
    let available = Buffer.alloc(0);
    let counter = 0;
    return () =>
    {
        if (available.length === 0)
        {
            const block = Buffer.alloc(4);
            block.writeUInt32BE(counter++);
            available = createHmac('sha256', key)
                .update('fsus.perception-character.corpus.v1\0', 'ascii')
                .update(block)
                .digest();
        }
        const value = available.subarray(0, 1);
        available = available.subarray(1);
        return value;
    };
}

function answerFor(domain, index)
{
    return sampleAnswer(deterministicReader(domain, index));
}

function seedFor(domain, index)
{
    return createHash('sha256')
        .update(`fsus.perception-character.corpus.${domain}.v1\0`, 'ascii')
        .update(String(index), 'ascii')
        .digest();
}

function validatePngChunks(artifact)
{
    const types = [];
    let offset = 8;
    while (offset < artifact.length)
    {
        if (offset > artifact.length - 12)
            throw new Error('PNG chunk is truncated');
        const length = artifact.readUInt32BE(offset);
        const type = artifact.toString('ascii', offset + 4, offset + 8);
        if (offset > artifact.length - 12 - length)
            throw new Error('PNG chunk body is truncated');
        types.push(type);
        offset += 12 + length;
    }
    if (offset !== artifact.length
        || types.join(',') !== 'IHDR,IDAT,IEND')
    {
        throw new Error(`PNG metadata/chunk set is not canonical: ${types.join(',')}`);
    }
}

function recognizeFixedBaseline(pixels)
{
    const rowsBySymbol = contract.raster.glyphAtlasBaseRows;
    const symbols = [...contract.answer.alphabet];
    const guesses = [];
    let originX = contract.raster.layout.firstOriginX;
    for (let position = 0; position < contract.answer.length; position += 1)
    {
        const centerX = originX + contract.raster.layout.centerOffsetX;
        const centerY = contract.raster.layout.centerY;
        let winner = symbols[0];
        let winnerScore = Number.POSITIVE_INFINITY;
        for (const symbol of symbols)
        {
            const rows = rowsBySymbol[symbol];
            let score = 0;
            for (let row = 0; row < rows.length; row += 1)
            {
                for (let column = 0; column < rows[row].length; column += 1)
                {
                    const x = Math.max(0, Math.min(
                        contract.raster.physicalWidth - 1,
                        Math.round(centerX + (column - 2) * contract.raster.glyphScalePixels)
                    ));
                    const y = Math.max(0, Math.min(
                        contract.raster.physicalHeight - 1,
                        Math.round(centerY + (row - 3) * contract.raster.glyphScalePixels)
                    ));
                    const expectedDark = rows[row][column] === '1';
                    const observed = pixels[y * contract.raster.physicalWidth + x];
                    score += expectedDark ? observed : 255 - observed;
                }
            }
            if (score < winnerScore)
            {
                winner = symbol;
                winnerScore = score;
            }
        }
        guesses.push(winner);
        originX += contract.raster.layout.advancePixels - 10;
    }
    return guesses.join('');
}

function emptyPositionCounts()
{
    return Array.from({ length: contract.answer.length }, () =>
        Object.fromEntries([...contract.answer.alphabet].map(symbol => [symbol, 0])));
}

function countAnswer(positionCounts, answer)
{
    for (let position = 0; position < answer.length; position += 1)
        positionCounts[position][answer[position]] += 1;
}

function visualCorpus({ start, count })
{
    const sizes = [];
    const hashes = [];
    const fixtures = [];
    const positionCounts = emptyPositionCounts();
    let recognizerExactMatches = 0;
    for (let offset = 0; offset < count; offset += 1)
    {
        const index = start + offset;
        const answer = answerFor('visual-answer', index);
        const seed = seedFor('visual-artifact', index);
        const pixels = rasterize(answer, seed);
        const artifact = encodeVisualArtifact(pixels, seed);
        validateVisualArtifact(artifact);
        validatePngChunks(artifact);
        countAnswer(positionCounts, answer);
        if (recognizeFixedBaseline(pixels) === answer)
            recognizerExactMatches += 1;
        const artifactDigest = digest(artifact);
        sizes.push(artifact.length);
        hashes.push(artifactDigest);
        if (index < workerData.fixtureCount)
        {
            fixtures.push({
                name: `visual-${String(index).padStart(5, '0')}.png`,
                sha256: artifactDigest,
                bytesBase64: artifact.toString('base64')
            });
        }
        pixels.fill(0);
    }
    return {
        sizes,
        hashes,
        fixtures,
        positionCounts,
        recognizerExactMatches
    };
}

function audioCorpus({ start, count })
{
    const sizes = [];
    const hashes = [];
    const fixtures = [];
    const positionCounts = emptyPositionCounts();
    for (let offset = 0; offset < count; offset += 1)
    {
        const index = start + offset;
        const answer = answerFor('audio-answer', index);
        const serialSeed = seedFor('audio-serial', index).subarray(0, 4);
        const artifact = encodeAudioArtifact(answer, {
            serialSeed,
            temporaryId: `corpus-${index}`
        });
        validateAudioArtifact(artifact);
        const printable = artifact.toString('latin1');
        if (printable.includes(answer)
            || /entry(?:Id)?|answer|seed|filesystem|\/home\/|[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9-]{23}/iu.test(printable))
        {
            throw new Error('audio artifact exposes reusable identity or generator material');
        }
        countAnswer(positionCounts, answer);
        const artifactDigest = digest(artifact);
        sizes.push(artifact.length);
        hashes.push(artifactDigest);
        if (index < workerData.fixtureCount)
        {
            fixtures.push({
                name: `audio-${String(index).padStart(5, '0')}.ogg`,
                sha256: artifactDigest,
                bytesBase64: artifact.toString('base64')
            });
        }
    }
    return {
        sizes,
        hashes,
        fixtures,
        positionCounts
    };
}

try
{
    const result = {
        visual: visualCorpus(workerData.visual),
        audio: audioCorpus(workerData.audio)
    };
    parentPort.postMessage(result);
}
finally
{
    disposeAudioEncoder();
}
