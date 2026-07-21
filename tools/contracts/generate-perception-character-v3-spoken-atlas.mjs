#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const regenerateSource = args.includes('--regenerate-source');
if (check && regenerateSource)
{
    throw new Error('--check and --regenerate-source cannot be combined');
}
const value = (name, fallback) =>
{
    const index = args.indexOf(name);
    if (index >= 0 && !args[index + 1])
    {
        throw new Error(`${name} requires a value`);
    }
    return resolve(index >= 0 ? args[index + 1] : fallback);
};
const sourcePath = value('--source', 'src/shared/Contracts/Validation/Security/perception-character-v3-spoken-atlas-source.json');
const sourceArtifactsPath = value('--source-artifacts', 'tests/fixtures/security/perception-character-v3-spoken-atlas-source-wav');
const outputPath = value('--output', 'src/shared/Contracts/Validation/Security/perception-character-v3-spoken-atlas.json');
const goldenPath = value('--golden', 'tests/fixtures/security/perception-character-v3-spoken-atlas-golden.json');
const espeak = args.includes('--espeak-ng') ? args[args.indexOf('--espeak-ng') + 1] : (process.env.ESPEAK_NG_BIN ?? 'espeak-ng');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = valueToSerialize => Buffer.from(`${JSON.stringify(valueToSerialize, null, 2)}\n`);
const serializeUnit = unit => `{ "symbol": ${JSON.stringify(unit.symbol)}, "spokenName": ${JSON.stringify(unit.spokenName)}, "ssml": ${JSON.stringify(unit.ssml)}, "sourceWavSha256": ${JSON.stringify(unit.sourceWavSha256)}, "pcmSha256": ${JSON.stringify(unit.pcmSha256)}, "sampleCount": ${unit.sampleCount} }`;
const serializeSource = sourceToSerialize => Buffer.from(`{\n  "schema": ${JSON.stringify(sourceToSerialize.schema)},\n  "alphabet": ${JSON.stringify(sourceToSerialize.alphabet)},\n  "generator": ${JSON.stringify(sourceToSerialize.generator, null, 2).replaceAll('\n', '\n  ')},\n  "units": [\n${sourceToSerialize.units.map(unit => `    ${serializeUnit(unit)}`).join(',\n')}\n  ]\n}\n`);
let sourceBytes = readFileSync(sourcePath);
let source = JSON.parse(sourceBytes);

function validateSourceIdentity(candidate)
{
    if (candidate.schema !== 'fsus.perception-character.spoken-atlas-source.v1'
    || candidate.units.map(unit => unit.symbol).join('') !== candidate.alphabet
    || new Set(candidate.units.map(unit => unit.symbol)).size !== candidate.units.length)
    {
        throw new Error('spoken atlas source manifest identity/order is invalid');
    }
}

function spawnOrThrow(command, commandArgs, label)
{
    const result = spawnSync(command, commandArgs, { encoding: 'utf8', env: process.env });
    if (result.error || result.status !== 0)
    {
        const detail = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? `exit ${result.status}`;
        throw new Error(`${label}: ${detail}`);
    }
    return result;
}

function readPcm16(path)
{
    const wav = readFileSync(path);
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    {
        throw new Error(`invalid WAV: ${path}`);
    }
    let offset = 12;
    let format;
    let data;
    while (offset + 8 <= wav.length)
    {
        const id = wav.toString('ascii', offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        if (offset + 8 + size > wav.length)
        {
            throw new Error(`truncated WAV chunk: ${path}`);
        }
        if (id === 'fmt ')
        {
            format = wav.subarray(offset + 8, offset + 8 + size);
        }
        if (id === 'data')
        {
            data = wav.subarray(offset + 8, offset + 8 + size);
        }
        offset += 8 + size + (size & 1);
    }
    if (!format || !data || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt16LE(14) !== 16)
    {
        throw new Error(`unsupported WAV: ${path}`);
    }
    const rate = format.readUInt32LE(4);
    const samples = Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2));
    let first = samples.findIndex(sample => Math.abs(sample) >= 180);
    let last = samples.length - 1;
    while (last >= 0 && Math.abs(samples[last]) < 180)
    {
        last--;
    }
    if (first < 0 || last <= first)
    {
        throw new Error(`silent WAV: ${path}`);
    }
    const pad = Math.round(rate * 0.04);
    return { rate, samples: samples.slice(Math.max(0, first - pad), Math.min(samples.length - 1, last + pad) + 1) };
}

function resample(sourceSamples, sourceRate, targetRate)
{
    const count = Math.round(sourceSamples.length * targetRate / sourceRate);
    const result = new Int16Array(count);
    for (let i = 0; i < count; i++)
    {
        const position = i * sourceRate / targetRate;
        const left = Math.min(sourceSamples.length - 1, Math.floor(position));
        const right = Math.min(sourceSamples.length - 1, left + 1);
        const fraction = position - left;
        result[i] = Math.round(sourceSamples[left] * (1 - fraction) + sourceSamples[right] * fraction);
    }
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
}

validateSourceIdentity(source);
if (regenerateSource)
{
    const version = spawnOrThrow(espeak, ['--version'], 'eSpeak NG is unavailable');
    const reportedVersion = `${version.stdout ?? ''}\n${version.stderr ?? ''}`.match(/text-to-speech:\s*([^\s]+)/)?.[1];
    if (reportedVersion !== source.generator.version)
    {
        throw new Error(`eSpeak NG version must be exactly ${source.generator.version}`);
    }
    mkdirSync(sourceArtifactsPath, { recursive: true });
    source = {
        ...source,
        units: source.units.map(unit =>
        {
            const wavPath = join(sourceArtifactsPath, `${unit.symbol}.wav`);
            const command = ['-m', '-v', source.generator.voice, '-s', `${source.generator.speed}`, '-p', `${source.generator.pitch}`, '-a', `${source.generator.amplitude}`, '-w', wavPath, unit.ssml];
            spawnOrThrow(espeak, command, `eSpeak NG failed for ${unit.symbol}`);
            const wav = readFileSync(wavPath);
            const decoded = readPcm16(wavPath);
            const pcm = resample(decoded.samples, decoded.rate, source.generator.targetSampleRate);
            return { ...unit, sourceWavSha256: sha256(wav), pcmSha256: sha256(pcm), sampleCount: pcm.length / 2 };
        })
    };
    sourceBytes = serializeSource(source);
    writeFileSync(sourcePath, sourceBytes);
}

const expectedArtifacts = source.units.map(unit => `${unit.symbol}.wav`).sort();
const actualArtifacts = readdirSync(sourceArtifactsPath).filter(name => !name.startsWith('.')).sort();
if (actualArtifacts.length !== expectedArtifacts.length || actualArtifacts.some((name, index) => name !== expectedArtifacts[index]))
{
    throw new Error(`spoken source artifact set is invalid: ${basename(sourceArtifactsPath)}`);
}

const units = {};
for (const unit of source.units)
{
    const wavPath = join(sourceArtifactsPath, `${unit.symbol}.wav`);
    const wav = readFileSync(wavPath);
    if (sha256(wav) !== unit.sourceWavSha256)
    {
        throw new Error(`source WAV hash mismatch for spoken unit ${unit.symbol}`);
    }
    const decoded = readPcm16(wavPath);
    const pcm = resample(decoded.samples, decoded.rate, source.generator.targetSampleRate);
    if (sha256(pcm) !== unit.pcmSha256 || pcm.length / 2 !== unit.sampleCount)
    {
        throw new Error(`PCM golden mismatch for spoken unit ${unit.symbol}`);
    }
    units[unit.symbol] = { spokenName: unit.spokenName, sampleCount: unit.sampleCount, sha256: unit.pcmSha256, pcm16Base64: pcm.toString('base64') };
}
const output = serialize({
    schema: 'fsus.perception-character.spoken-atlas.v1',
    sampleRate: source.generator.targetSampleRate,
    channels: 1,
    bitsPerSample: 16,
    generator: { name: source.generator.name, version: source.generator.version, voice: source.generator.voice, speed: source.generator.speed, pitch: source.generator.pitch, amplitude: source.generator.amplitude, mode: source.generator.mode },
    alphabet: source.alphabet,
    units
});

if (regenerateSource)
{
    writeFileSync(outputPath, output);
    writeFileSync(goldenPath, serialize({
        schema: 'fsus.perception-character.spoken-atlas-golden.v1',
        sourceManifestSha256: sha256(sourceBytes),
        outputSha256: sha256(output)
    }));
    process.stdout.write('[perception-character-v3] source WAV fixtures, manifest, atlas and goldens regenerated\n');
}
else
{
    const golden = JSON.parse(readFileSync(goldenPath));
    if (sha256(sourceBytes) !== golden.sourceManifestSha256)
    {
        throw new Error('spoken atlas source manifest hash does not match the independent golden manifest');
    }
    if (sha256(output) !== golden.outputSha256)
    {
        throw new Error('regenerated spoken atlas does not match the independent golden output hash');
    }
    if (check)
    {
        if (!output.equals(readFileSync(outputPath)))
        {
            throw new Error('checked-in spoken atlas is stale');
        }
        process.stdout.write('[perception-character-v3] offline source WAV, PCM and atlas goldens are in sync\n');
    }
    else
    {
        writeFileSync(outputPath, output);
    }
}
