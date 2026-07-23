import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAudioArtifactFromPackets } from '../contracts/perception-character-v3-artifacts.mjs';
import { contract } from '../contracts/perception-character-v3-reference.mjs';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const spokenAtlasPath = path.join(root, 'src/shared/Contracts/Validation/Security/perception-character-v3-spoken-atlas.json');
const opusSourcePath = path.join(root, 'tools/security/perception-character-v3-opus.c');
let encoderDirectory;
let encoderPath;
let spokenAtlas;

const digest = value => createHash('sha256').update(value).digest('hex');

export function buildSpokenPcm(answer)
{
    spokenAtlas ??= JSON.parse(fs.readFileSync(spokenAtlasPath, 'utf8'));
    if (spokenAtlas.schema !== 'fsus.perception-character.spoken-atlas.v1' || spokenAtlas.sampleRate !== 12000 || spokenAtlas.channels !== 1)
        throw new Error('spoken atlas contract is invalid');
    const parts = [];
    for (const symbol of answer)
    {
        const unit = spokenAtlas.units[symbol];
        if (!unit) throw new Error(`spoken atlas unit is missing: ${symbol}`);
        const source = Buffer.from(unit.pcm16Base64, 'base64');
        if (source.length !== unit.sampleCount * 2 || digest(source) !== unit.sha256)
            throw new Error(`spoken atlas unit is corrupt: ${symbol}`);
        const upsampled = Buffer.alloc(unit.sampleCount * 8);
        for (let index = 0; index < unit.sampleCount * 4; index += 1)
        {
            const position = index / 4;
            const left = Math.floor(position);
            const right = Math.min(unit.sampleCount - 1, left + 1);
            const fraction = position - left;
            const sample = Math.round(source.readInt16LE(left * 2) * (1 - fraction) + source.readInt16LE(right * 2) * fraction);
            upsampled.writeInt16LE(sample, index * 2);
        }
        parts.push(upsampled, Buffer.alloc(5760 * 2));
    }
    const pcm = Buffer.concat(parts);
    const padded = Buffer.alloc(Math.ceil(pcm.length / (960 * 2)) * 960 * 2);
    pcm.copy(padded);
    pcm.fill(0);
    return padded;
}

function ensureEncoder()
{
    if (encoderPath) return encoderPath;
    encoderDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-v3-opus-'));
    encoderPath = path.join(encoderDirectory, 'encode-opus');
    const compiled = spawnSync(process.env.CC ?? 'cc', [opusSourcePath, '-O2', '-std=c11', '-o', encoderPath, '-Wl,-l:libopus.so.0'], { encoding: 'utf8' });
    if (compiled.error || compiled.status !== 0)
        throw new Error(`repository Opus encoder build failed: ${compiled.error?.message ?? compiled.stderr ?? compiled.stdout}`);
    return encoderPath;
}

export function encodeAudioArtifact(answer)
{
    const prefix = randomUUID();
    const pcm = buildSpokenPcm(answer);
    try
    {
        const executable = ensureEncoder();
        const pcmPath = path.join(encoderDirectory, `${prefix}.pcm`);
        const packetsPath = path.join(encoderDirectory, `${prefix}.packets`);
        fs.writeFileSync(pcmPath, pcm, { mode: 0o600 });
        const encoded = spawnSync(executable, [pcmPath, packetsPath], { encoding: 'utf8' });
        if (encoded.error || encoded.status !== 0)
            throw new Error(`repository Opus encoder failed: ${encoded.error?.message ?? encoded.stderr ?? encoded.stdout ?? encoded.status}`);
        const bytes = fs.readFileSync(packetsPath);
        const packets = [];
        for (let offset = 0; offset < bytes.length;)
        {
            if (offset > bytes.length - 2) throw new Error('Opus packet stream is truncated');
            const length = bytes.readUInt16LE(offset);
            offset += 2;
            if (length === 0 || offset > bytes.length - length) throw new Error('Opus packet stream is invalid');
            packets.push(Buffer.from(bytes.subarray(offset, offset + length)));
            offset += length;
        }
        return buildAudioArtifactFromPackets(contract, packets, randomBytes(4));
    }
    finally
    {
        pcm.fill(0);
        if (encoderDirectory)
            for (const extension of ['pcm', 'packets']) fs.rmSync(path.join(encoderDirectory, `${prefix}.${extension}`), { force: true });
    }
}

export function disposeAudioEncoder()
{
    if (encoderDirectory) fs.rmSync(encoderDirectory, { recursive: true, force: true });
    encoderDirectory = undefined;
    encoderPath = undefined;
}

export function validateVisualArtifact(artifact)
{
    if (artifact.length > contract.media.visual.maximumBytes || !artifact.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        artifact.readUInt32BE(8) !== 13 || artifact.toString('ascii', 12, 16) !== 'IHDR' ||
        artifact.readUInt32BE(16) !== contract.raster.physicalWidth || artifact.readUInt32BE(20) !== contract.raster.physicalHeight ||
        artifact[24] !== contract.media.visual.bitDepth || artifact[25] !== contract.media.visual.colorType || artifact[28] !== 0)
        throw new Error('visual artifact contract mismatch');
}

function oggCrc(bytes)
{
    let crc = 0;
    for (let index = 0; index < bytes.length; index += 1)
    {
        const value = index >= 22 && index <= 25 ? 0 : bytes[index];
        crc ^= value << 24;
        for (let bit = 0; bit < 8; bit += 1)
            crc = ((crc << 1) ^ ((crc & 0x80000000) === 0 ? 0 : 0x04c11db7)) >>> 0;
    }
    return crc;
}

export function validateAudioArtifact(artifact)
{
    if (artifact.length > contract.media.audio.maximumBytes) throw new Error('audio artifact exceeds hard limit');
    let offset = 0, sequence = 0, pageCount = 0;
    let serial, previousGranule = 0n, sawEos = false;
    while (offset < artifact.length)
    {
        if (offset > artifact.length - 27 || artifact.toString('ascii', offset, offset + 4) !== 'OggS' || artifact[offset + 4] !== 0)
            throw new Error('audio Ogg page header is invalid');
        const segmentCount = artifact[offset + 26];
        if (offset > artifact.length - 27 - segmentCount) throw new Error('audio Ogg lacing table is truncated');
        let bodyLength = 0;
        for (let index = 0; index < segmentCount; index += 1) bodyLength += artifact[offset + 27 + index];
        const length = 27 + segmentCount + bodyLength;
        if (offset > artifact.length - length) throw new Error('audio Ogg page body is truncated');
        const page = artifact.subarray(offset, offset + length);
        const pageSerial = page.readUInt32LE(14), granule = page.readBigUInt64LE(6);
        if ((serial !== undefined && pageSerial !== serial) || page.readUInt32LE(18) !== sequence || granule < previousGranule || page.readUInt32LE(22) !== oggCrc(page))
            throw new Error('audio Ogg page integrity is invalid');
        serial ??= pageSerial;
        previousGranule = granule;
        const body = page.subarray(27 + segmentCount);
        if (pageCount === 0 && (page[5] !== 2 || body.toString('ascii', 0, 8) !== 'OpusHead' || body.length !== 19 ||
            body[9] !== 1 || body.readUInt16LE(10) !== contract.media.audio.preSkip || body.readUInt32LE(12) !== contract.media.audio.inputSampleRate ||
            body.readInt16LE(16) !== contract.media.audio.outputGainQ8 || body[18] !== contract.media.audio.mappingFamily))
            throw new Error('audio OpusHead contract mismatch');
        if (pageCount === 1 && body.toString('ascii', 0, 8) !== 'OpusTags') throw new Error('audio OpusTags contract mismatch');
        if (pageCount >= 2 && (body.length === 0 || granule === 0n)) throw new Error('audio packet page is invalid');
        sawEos = pageCount >= 2 && (page[5] & 4) !== 0;
        offset += length;
        sequence += 1;
        pageCount += 1;
    }
    if (pageCount < 3 || !sawEos) throw new Error('audio Ogg stream is incomplete');
}
