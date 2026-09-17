#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const clientRoot = process.cwd();
const repoRoot = resolve(clientRoot, '../..');
const wasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT || resolve(clientRoot, 'public/wasm'));
const outputPath = resolve(repoRoot, '.tmp/perf/pow-wasm.json');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const outputBytes = 2048;

const engines = [
    { kind: 'basic', engine: 'SCALAR-BASIC' },
    { kind: 'simd', engine: 'SIMD-128' },
    { kind: 'relaxed', engine: 'RELAXED-SIMD' },
    { kind: 'threads', engine: 'THREADS-SIMD-ASSET' }
];

const salt = process.env.FSUSBLOG_POW_BENCH_SALT || '0123456789abcdef0123456789abcdef';
const fp = process.env.FSUSBLOG_POW_BENCH_FP || '0123456789abcdef0123456789abcdef';
const difficulties = (process.env.FSUSBLOG_POW_BENCH_DIFFICULTIES || '16,20')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 32);
const samplesPerDifficulty = Math.max(1, Number(process.env.FSUSBLOG_POW_BENCH_SAMPLES || 3));

function hasLeadingDifficulty(hash, difficulty)
{
    const fullBytes = Math.floor(difficulty / 8);
    for (let i = 0; i < fullBytes; i += 1)
    {
        if (hash[i] !== 0)
        {
            return false;
        }
    }

    const remainingBits = difficulty % 8;
    return remainingBits === 0 || (hash[fullBytes] >> (8 - remainingBits)) === 0;
}

function verifyNonce(nonce, difficulty)
{
    const hash = createHash('sha256').update(`${salt}:${nonce}:${fp}`, 'utf8').digest();
    return hasLeadingDifficulty(hash, difficulty);
}

function percentile(values, rank)
{
    if (values.length === 0)
    {
        return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * rank));
    return sorted[index];
}

async function loadEngine(kind)
{
    const jsPath = resolve(wasmRoot, `fsus_pow_${kind}.js`);
    const wasmPath = resolve(wasmRoot, `fsus_pow_${kind}.wasm`);
    if (!existsSync(jsPath) || !existsSync(wasmPath))
    {
        return null;
    }

    const moduleRef = await import(pathToFileURL(jsPath).href);
    const factory = moduleRef.default ?? moduleRef.createPowModule;
    if (typeof factory !== 'function')
    {
        throw new Error(`missing createPowModule factory for ${kind}`);
    }

    const wasmBinary = await readFile(wasmPath);
    return factory({ wasmBinary });
}

function writeCString(module, value)
{
    const bytes = encoder.encode(value);
    const ptr = module._malloc(bytes.length + 1);
    module.HEAPU8.set(bytes, ptr);
    module.HEAPU8[ptr + bytes.length] = 0;
    return ptr;
}

function readCString(module, ptr, maxLength)
{
    let end = ptr;
    const limit = ptr + maxLength;
    while (end < limit && module.HEAPU8[end] !== 0)
    {
        end += 1;
    }
    return decoder.decode(module.HEAPU8.subarray(ptr, end));
}

function solve(module, difficulty, startNonce = 0, step = 1)
{
    const saltPtr = writeCString(module, salt);
    const fpPtr = writeCString(module, fp);
    const outputPtr = module._malloc(outputBytes);

    try
    {
        const startedAt = performance.now();
        const length = startNonce === 0 && step === 1
            ? module._solve_pow_c(saltPtr, fpPtr, difficulty, outputPtr, outputBytes)
            : module._solve_pow_range_c(saltPtr, fpPtr, difficulty, startNonce, step, outputPtr, outputBytes);
        const durationMs = performance.now() - startedAt;
        if (length < 0)
        {
            throw new Error(`solver returned ${length}`);
        }

        const nonce = readCString(module, outputPtr, Math.min(length + 1, outputBytes));
        if (!verifyNonce(nonce, difficulty))
        {
            throw new Error(`invalid nonce for difficulty ${difficulty}: ${nonce}`);
        }

        return { nonce, durationMs };
    }
    finally
    {
        module._free(outputPtr);
        module._free(fpPtr);
        module._free(saltPtr);
    }
}

async function benchEngine(engine)
{
    const module = await loadEngine(engine.kind);
    if (!module)
    {
        return {
            ...engine,
            available: false,
            samples: []
        };
    }

    solve(module, 1);
    const samples = [];

    for (const difficulty of difficulties)
    {
        for (let i = 0; i < samplesPerDifficulty; i += 1)
        {
            const result = solve(module, difficulty);
            const candidates = Math.max(1, Number(result.nonce) + 1);
            samples.push({
                difficulty,
                nonce: result.nonce,
                durationMs: Number(result.durationMs.toFixed(3)),
                hashesPerSecond: Number((candidates / (result.durationMs / 1000)).toFixed(2))
            });
        }
    }

    const rangeSmoke = solve(module, difficulties[0] ?? 16, 1, 4);
    const durations = samples.map((sample) => sample.durationMs);
    return {
        ...engine,
        available: true,
        p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
        p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
        medianHashesPerSecond: Number(percentile(samples.map((sample) => sample.hashesPerSecond), 0.5).toFixed(2)),
        rangeSmoke: {
            nonce: rangeSmoke.nonce,
            durationMs: Number(rangeSmoke.durationMs.toFixed(3)),
            step: 4
        },
        samples
    };
}

const results = [];
for (const engine of engines)
{
    results.push(await benchEngine(engine));
}

const payload = {
    generatedAtUtc: new Date().toISOString(),
    salt,
    fp,
    difficulties,
    samplesPerDifficulty,
    note: 'THREADS-SIMD-ASSET measures the wasm asset. Browser worker-sharded latency depends on crossOriginIsolated and hardwareConcurrency.',
    results
};

await mkdir(resolve(repoRoot, '.tmp/perf'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`[bench-pow-wasm] wrote ${outputPath}`);
for (const result of results)
{
    if (result.available)
    {
        console.log(`[bench-pow-wasm] ${result.engine}: p50=${result.p50Ms}ms p95=${result.p95Ms}ms median=${result.medianHashesPerSecond} h/s`);
    }
    else
    {
        console.log(`[bench-pow-wasm] ${result.engine}: unavailable`);
    }
}
