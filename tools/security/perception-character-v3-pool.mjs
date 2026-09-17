#!/usr/bin/env node
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    randomUUID
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    contract,
    encodeLP,
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

const root = fileURLToPath(new URL('../..', import.meta.url));
const contractPath = path.join(root, 'src/shared/Contracts/Validation/Security/perception-character-v3-contract.json');
const schema = 'fsusblog.security.perception-character-v3.pool-manifest.v1';
const entrySchema = 'fsusblog.security.perception-character-v3.pool-entry.v1';

function parse(argv)
{
    const command = argv.shift();
    const options = {};
    while (argv.length > 0)
    {
        const key = argv.shift();
        if (!key?.startsWith('--') || argv.length === 0)
            throw new Error(`invalid argument: ${key ?? '<missing>'}`);
        options[key.slice(2)] = argv.shift();
    }
    if (!['generate', 'validate'].includes(command))
        throw new Error('usage: perception-character-v3-pool.mjs generate|validate --root <dir> --generation <id> --key-env <name> [--key-version <id> --visual <n> --audio <n>]');
    for (const required of ['root', 'generation', 'key-env'])
        if (!options[required]) throw new Error(`--${required} is required`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.generation))
        throw new Error('--generation is invalid');
    return { command, options };
}

function keyFromEnvironment(name)
{
    const encoded = process.env[name] ?? '';
    const key = /^[0-9a-f]{64}$/iu.test(encoded) ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error(`${name} must contain an externally supplied 256-bit key`);
    return key;
}

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function aad(generationId, contractDigest, entry)
{
    return Buffer.from([
        generationId,
        entry.entryId,
        contractDigest,
        entry.representation,
        entry.mediaType
    ].join('\0'), 'utf8');
}

function seal(plaintext, key, nonce, associatedData)
{
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(ciphertextAndTag, key, nonce, associatedData)
{
    if (ciphertextAndTag.length <= 16) throw new Error('pool record is truncated');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(ciphertextAndTag.subarray(-16));
    return Buffer.concat([decipher.update(ciphertextAndTag.subarray(0, -16)), decipher.final()]);
}

function artifactFor(representation, answer)
{
    if (representation === 'audio')
        return encodeAudioArtifact(answer);
    const seed = randomBytes(32);
    return encodeVisualArtifact(rasterize(answer, seed), seed);
}

function makeEntry(generationId, contractDigest, representation, key, offset)
{
    const answer = sampleAnswer(randomBytes);
    const artifact = artifactFor(representation, answer);
    const entry = {
        entryId: randomUUID(),
        representation,
        mediaType: representation === 'visual' ? contract.media.visual.mediaType : contract.media.audio.mediaType
    };
    const plaintext = encodeLP([
        Buffer.from(entrySchema, 'utf8'),
        Buffer.from(entry.entryId, 'utf8'),
        Buffer.from(generationId, 'utf8'),
        Buffer.from(entry.representation, 'ascii'),
        Buffer.from(entry.mediaType, 'ascii'),
        artifact,
        Buffer.from(digest(artifact), 'hex'),
        Buffer.from(answer, 'ascii'),
        Buffer.from(contractDigest, 'hex'),
        Buffer.from('repository-offline-generator', 'utf8')
    ]);
    const nonce = randomBytes(12);
    const record = seal(plaintext, key, nonce, aad(generationId, contractDigest, entry));
    plaintext.fill(0);
    return {
        record,
        manifest: {
            ...entry,
            offset,
            length: record.length,
            nonceBase64: nonce.toString('base64'),
            ciphertextSha256: digest(record),
            artifactBytes: artifact.length
        }
    };
}

function generate(options, key)
{
    const keyVersion = options['key-version'];
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(keyVersion ?? '')) throw new Error('--key-version is invalid');
    const counts = { visual: Number(options.visual ?? 0), audio: Number(options.audio ?? 0) };
    if (!Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0) || counts.visual + counts.audio === 0)
        throw new Error('visual/audio counts must be non-negative integers with at least one entry');
    const contractDigest = digest(fs.readFileSync(contractPath));
    const poolRoot = path.resolve(options.root);
    const generationRoot = path.join(poolRoot, options.generation);
    if (fs.existsSync(generationRoot)) throw new Error('generation already exists and is immutable');
    fs.mkdirSync(poolRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = path.join(poolRoot, `.${options.generation}.staging-${randomUUID()}`);
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
    try
    {
        const entries = [];
        const records = [];
        let offset = 0;
        for (const representation of ['visual', 'audio'])
            for (let index = 0; index < counts[representation]; index += 1)
            {
                const created = makeEntry(options.generation, contractDigest, representation, key, offset);
                entries.push(created.manifest);
                records.push(created.record);
                offset += created.record.length;
            }
        const pack = Buffer.concat(records);
        const manifest = {
            schema,
            generationId: options.generation,
            contractDigest,
            keyVersion,
            packFile: 'artifacts.pack',
            packSha256: digest(pack),
            entries
        };
        fs.writeFileSync(path.join(stagingRoot, 'artifacts.pack'), pack, { mode: 0o600 });
        fs.writeFileSync(path.join(stagingRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        validate({ ...options, 'key-version': keyVersion }, key, stagingRoot);
        fs.renameSync(stagingRoot, generationRoot);
        return manifest;
    }
    catch (error)
    {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
    }
}

function validate(options, key, ownedGenerationRoot)
{
    const generationRoot = ownedGenerationRoot ?? path.join(path.resolve(options.root), options.generation);
    const manifest = JSON.parse(fs.readFileSync(path.join(generationRoot, 'manifest.json'), 'utf8'));
    if (manifest.packFile !== 'artifacts.pack') throw new Error('manifest packfile name is invalid');
    const pack = fs.readFileSync(path.join(generationRoot, manifest.packFile));
    const errors = [];
    const ids = new Set();
    if (manifest.schema !== schema || manifest.generationId !== options.generation || manifest.contractDigest !== digest(fs.readFileSync(contractPath)))
        errors.push('manifest identity or contract digest mismatch');
    if (manifest.packSha256 !== digest(pack)) errors.push('pack digest mismatch');
    let expectedOffset = 0;
    for (const entry of manifest.entries ?? [])
    {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.entryId) ||
            entry.offset !== expectedOffset || !Number.isSafeInteger(entry.length) || entry.length <= 16 ||
            !Number.isSafeInteger(entry.artifactBytes) || entry.artifactBytes <= 0 ||
            Buffer.from(entry.nonceBase64 ?? '', 'base64').length !== 12)
            errors.push(`invalid compact index entry: ${entry.entryId}`);
        if (ids.has(entry.entryId)) errors.push(`duplicate entry id: ${entry.entryId}`);
        ids.add(entry.entryId);
        expectedOffset = entry.offset + entry.length;
        let decrypted;
        try
        {
            const record = pack.subarray(entry.offset, entry.offset + entry.length);
            if (record.length !== entry.length || digest(record) !== entry.ciphertextSha256)
                throw new Error('record bounds or digest mismatch');
            decrypted = open(record, key, Buffer.from(entry.nonceBase64, 'base64'),
                aad(manifest.generationId, manifest.contractDigest, entry));
            const fields = decodeLP(decrypted, 10);
            const plaintext = {
                schema: fields[0].toString('utf8'),
                entryId: fields[1].toString('utf8'),
                generationId: fields[2].toString('utf8'),
                representation: fields[3].toString('ascii'),
                mediaType: fields[4].toString('ascii'),
                artifact: fields[5],
                artifactHash: fields[6].toString('hex'),
                answer: fields[7],
                contractDigest: fields[8].toString('hex')
            };
            const artifact = plaintext.artifact;
            const maximum = entry.representation === 'visual' ? contract.media.visual.maximumBytes : contract.media.audio.maximumBytes;
            if (plaintext.schema !== entrySchema || plaintext.entryId !== entry.entryId ||
                plaintext.generationId !== manifest.generationId || plaintext.contractDigest !== manifest.contractDigest ||
                plaintext.representation !== entry.representation || plaintext.mediaType !== entry.mediaType ||
                artifact.length !== entry.artifactBytes || digest(artifact) !== plaintext.artifactHash ||
                plaintext.answer.length !== contract.answer.length ||
                [...plaintext.answer].some((value) => !contract.answer.alphabet.includes(String.fromCharCode(value))) || artifact.length > maximum)
                throw new Error('decrypted entry contract mismatch');
            if (entry.representation === 'visual') validateVisualArtifact(artifact);
            else if (entry.representation === 'audio') validateAudioArtifact(artifact);
            else throw new Error('entry representation is invalid');
        }
        catch (error)
        {
            errors.push(`${entry.entryId}: ${error.message}`);
        }
        finally
        {
            decrypted?.fill(0);
        }
    }
    if (expectedOffset !== pack.length) errors.push('compact index does not cover the pack exactly');
    if (errors.length > 0) throw new Error(errors.join('\n'));
    console.log(`[perception-v3-pool] valid generation=${manifest.generationId} entries=${manifest.entries.length} packBytes=${pack.length}`);
    return manifest;
}

function decodeLP(value, expected)
{
    const bytes = value;
    if (bytes.length < 2 || bytes.readUInt16BE(0) !== expected) throw new Error('pool plaintext field count is invalid');
    const fields = [];
    let offset = 2;
    for (let index = 0; index < expected; index += 1)
    {
        if (offset + 4 > bytes.length) throw new Error('pool plaintext is truncated');
        const length = bytes.readUInt32BE(offset);
        offset += 4;
        if (offset + length > bytes.length) throw new Error('pool plaintext field is truncated');
        fields.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    if (offset !== bytes.length) throw new Error('pool plaintext has trailing bytes');
    return fields;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? ''))
{
    const { command, options } = parse(process.argv.slice(2));
    const key = keyFromEnvironment(options['key-env']);
    try
    {
        if (command === 'generate') generate(options, key);
        else validate(options, key);
    }
    finally
    {
        key.fill(0);
        disposeAudioEncoder();
    }
}
