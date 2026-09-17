#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contractPath = path.join(
    repositoryRoot,
    'src/shared/Contracts/Validation/Security/perception-character-v3-contract.json'
);
const releaseTargetPath = path.join(
    repositoryRoot,
    'src/shared/Contracts/Validation/Security/perception-character-v3-release-target.json'
);
const workerPath = new URL('./perception-character-v3-corpus-worker.mjs', import.meta.url);
const schema = 'fsusblog.security.perception-character-v3-release-corpus.v1';
const visualReleaseMinimum = 10_000;
const audioReleaseMinimum = 2_000;
const fixtureCount = 6;

function parse(argv)
{
    const options = {
        profile: 'release',
        visual: visualReleaseMinimum,
        audio: audioReleaseMinimum,
        workers: Math.max(1, Math.min(os.availableParallelism(), 8))
    };
    while (argv.length > 0)
    {
        const name = argv.shift();
        const value = argv.shift();
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument ${name ?? '<missing>'}`);
        }
        options[name.slice(2)] = value;
    }
    for (const field of ['visual', 'audio', 'workers'])
    {
        options[field] = Number(options[field]);
        if (!Number.isSafeInteger(options[field]) || options[field] <= 0)
        {
            throw new Error(`--${field} must be a positive integer`);
        }
    }
    if (!['release', 'fixture'].includes(options.profile))
    {
        throw new Error('--profile must be release or fixture');
    }
    if (!options.output)
    {
        throw new Error('--output is required');
    }
    if (options.profile === 'release'
        && (options.visual < visualReleaseMinimum || options.audio < audioReleaseMinimum))
    {
        throw new Error(`release corpus requires at least ${visualReleaseMinimum} visual and ${audioReleaseMinimum} audio artifacts`);
    }
    return options;
}

function split(total, workers, index)
{
    const base = Math.floor(total / workers);
    const remainder = total % workers;
    const count = base + (index < remainder ? 1 : 0);
    const start = index * base + Math.min(index, remainder);
    return { start, count };
}

function runWorker(data)
{
    return new Promise((resolve, reject) =>
    {
        const worker = new Worker(workerPath, { workerData: data });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', code =>
        {
            if (code !== 0)
            {
                reject(new Error(`corpus worker exited with ${code}`));
            }
        });
    });
}

function mergePositionCounts(target, source)
{
    for (let position = 0; position < source.length; position += 1)
    {
        for (const [symbol, count] of Object.entries(source[position]))
        {
            target[position][symbol] += count;
        }
    }
}

function percentile(values, ratio)
{
    return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function statistics(values)
{
    values.sort((left, right) => left - right);
    return {
        minimumBytes: values[0],
        p50Bytes: percentile(values, 0.50),
        p95Bytes: percentile(values, 0.95),
        maximumBytes: values.at(-1)
    };
}

function chiSquared(positionCounts)
{
    return positionCounts.map(counts =>
    {
        const values = Object.values(counts);
        const expected = values.reduce((sum, value) => sum + value, 0) / values.length;
        return values.reduce((sum, observed) => sum + ((observed - expected) ** 2 / expected), 0);
    });
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function writeJson(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

async function main()
{
    const options = parse(process.argv.slice(2));
    const outputRoot = path.resolve(options.output);
    const reviewRoot = path.join(outputRoot, 'review');
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(reviewRoot, { recursive: true, mode: 0o700 });
    const workerCount = Math.min(options.workers, options.visual, options.audio);
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker({
        visual: split(options.visual, workerCount, index),
        audio: split(options.audio, workerCount, index),
        fixtureCount
    })));

    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const releaseTarget = JSON.parse(fs.readFileSync(releaseTargetPath, 'utf8'));
    const emptyCounts = () => Array.from(
        { length: contract.answer.length },
        () => Object.fromEntries([...contract.answer.alphabet].map(symbol => [symbol, 0]))
    );
    const visualPositionCounts = emptyCounts();
    const audioPositionCounts = emptyCounts();
    const visualSizes = [];
    const audioSizes = [];
    const visualHashes = [];
    const audioHashes = [];
    const fixtures = [];
    let recognizerExactMatches = 0;
    for (const result of results)
    {
        visualSizes.push(...result.visual.sizes);
        audioSizes.push(...result.audio.sizes);
        visualHashes.push(...result.visual.hashes);
        audioHashes.push(...result.audio.hashes);
        fixtures.push(...result.visual.fixtures, ...result.audio.fixtures);
        mergePositionCounts(visualPositionCounts, result.visual.positionCounts);
        mergePositionCounts(audioPositionCounts, result.audio.positionCounts);
        recognizerExactMatches += result.visual.recognizerExactMatches;
    }
    for (const fixture of fixtures.sort((left, right) => left.name.localeCompare(right.name)))
    {
        const bytes = Buffer.from(fixture.bytesBase64, 'base64');
        if (sha256(bytes) !== fixture.sha256)
        {
            throw new Error(`review fixture digest mismatch: ${fixture.name}`);
        }
        fs.writeFileSync(path.join(reviewRoot, fixture.name), bytes, { mode: 0o600 });
        delete fixture.bytesBase64;
    }

    const visualUnique = new Set(visualHashes).size;
    const audioUnique = new Set(audioHashes).size;
    const visualStatistics = statistics(visualSizes);
    const audioStatistics = statistics(audioSizes);
    const visualBias = chiSquared(visualPositionCounts);
    const audioBias = chiSquared(audioPositionCounts);
    const recognizerExactSolveRate = recognizerExactMatches / options.visual;
    const checks = {
        visualCount: options.visual >= (options.profile === 'release' ? visualReleaseMinimum : 1),
        audioCount: options.audio >= (options.profile === 'release' ? audioReleaseMinimum : 1),
        visualUnique: visualUnique === options.visual,
        audioUnique: audioUnique === options.audio,
        visualP50: visualStatistics.p50Bytes <= 20 * 1024,
        visualP95: visualStatistics.p95Bytes <= 28 * 1024,
        visualMaximum: visualStatistics.maximumBytes <= 32 * 1024,
        audioP95: audioStatistics.p95Bytes <= 40 * 1024,
        audioMaximum: audioStatistics.maximumBytes <= 48 * 1024,
        visualPositionBias: visualBias.every(value => value < 52.62),
        audioPositionBias: audioBias.every(value => value < 52.62),
        fixedBaselineRecognizer: recognizerExactSolveRate <= 0.02
    };
    const report = {
        schema,
        profile: options.profile,
        releaseEligible: options.profile === 'release',
        contractDigest: sha256(fs.readFileSync(contractPath)),
        releaseTargetFingerprint: releaseTarget.targetFingerprint,
        aedsSchemaFingerprint: releaseTarget.aedsSchemaFingerprint,
        corpusDigest: sha256([...visualHashes, ...audioHashes].sort().join('\n')),
        durationMs: Date.now() - startedAt,
        workers: workerCount,
        visual: {
            count: options.visual,
            uniqueHashes: visualUnique,
            ...visualStatistics,
            positionChiSquared: visualBias,
            fixedBaselineRecognizer: {
                exactMatches: recognizerExactMatches,
                exactSolveRate: recognizerExactSolveRate,
                approvedMaximum: 0.02
            }
        },
        audio: {
            count: options.audio,
            uniqueHashes: audioUnique,
            ...audioStatistics,
            positionChiSquared: audioBias
        },
        reviewFixtures: fixtures.map(({ name, sha256: digestValue }) => ({
            path: `review/${name}`,
            sha256: digestValue
        })),
        checks,
        status: Object.values(checks).every(Boolean) ? 'passed' : 'failed'
    };
    writeJson(path.join(outputRoot, 'perception-character-v3-corpus-report.json'), report);
    process.stdout.write(`${JSON.stringify({
        status: report.status,
        visual: report.visual,
        audio: report.audio,
        durationMs: report.durationMs
    })}\n`);
    if (report.status !== 'passed')
    {
        process.exitCode = 1;
    }
}

await main();
