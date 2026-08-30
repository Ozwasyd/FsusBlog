#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    commentPrivacyBuildContract,
    productionZkRequested
} from '../security/comment-privacy-build-contract.mjs';

import {
    classifyWasmReceiptFallback,
    createWasmBuildReceipt,
    validateWasmBuildReceipt,
    wasmBuildReceiptName
} from './wasm-build-receipt.mjs';
import { computeWasmProducerInputDescriptor } from './wasm-producer-inputs.mjs';

const clientRoot = process.cwd();
const wasmRoot = join(clientRoot, 'wasm');
const publicWasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT || join(clientRoot, 'public', 'wasm'));
const manifestPath = join(publicWasmRoot, 'wasm-manifest.aeds');
const aedsRuntimeManifestPath = join(publicWasmRoot, 'aeds-runtime-manifest.json');
const wasmBuildReceiptPath = join(publicWasmRoot, wasmBuildReceiptName);
const dependencyInstallerPath = fileURLToPath(new URL('./install-wasm-codec-deps.sh', import.meta.url));
const buildScriptPath = join(wasmRoot, 'build.sh');
export const wasmToolchainContract = Object.freeze({
    emscriptenVersion: '6.0.0',
    binaryenVersion: '123',
    cmakeVersion: '4.3.3',
    vcpkgCommit: 'eae1680538b86f962455c27abca2aad0dc304a4d',
    emsdkImage: 'emscripten/emsdk:6.0.0@sha256:9eed2e47b4206928b22f99d2917013ad5462d777bb24cb546a652729896badd8'
});
const imageCodecEnabled = ['ON', '1', 'TRUE'].includes(
    String(process.env.FSUSBLOG_WASM_IMAGE_CODEC_ENABLE || 'ON').toUpperCase()
);
const alwaysRequiredOutputFiles = Object.freeze([
    'aeds_decoder_basic.js',
    'aeds_decoder_basic.wasm',
    'aeds_decoder_speed.js',
    'aeds_decoder_speed.wasm',
    'aeds-runtime-manifest.json',
    'fsus_pow_basic.js',
    'fsus_pow_basic.wasm',
    'fsus_pow_simd.js',
    'fsus_pow_simd.wasm',
    'fsus_pow_relaxed.js',
    'fsus_pow_relaxed.wasm',
    'fsus_pow_threads.js',
    'fsus_pow_threads.wasm',
    ...(imageCodecEnabled ? [
        'image_codec_basic.js',
        'image_codec_basic.wasm',
        'image_codec_simd.js',
        'image_codec_simd.wasm'
    ] : []),
    'search_basic.js',
    'search_basic.wasm',
    'search_simd.js',
    'search_simd.wasm',
    'comment-privacy-prover.js',
    'comment_privacy_runtime.js',
    'comment_privacy_runtime.wasm'
]);

export function resolveWasmRequiredOutputFiles(env = process.env)
{
    return Object.freeze([
        ...alwaysRequiredOutputFiles,
        ...(productionZkRequested(env) ? commentPrivacyBuildContract.productionOutputs : [])
    ]);
}

export const wasmArtifactContract = Object.freeze({
    schemaVersion: 3,
    aedsAbi: 'fsusblog.aeds.v4',
    buildModes: Object.freeze(['basic', 'simd', 'relaxed', 'threads']),
    toolchain: wasmToolchainContract,
    aedsRuntimeRoot: Object.freeze({
        schema: 'fsusblog.aeds-runtime.v1',
        maxFrameBytes: 8 * 1024 * 1024,
        workerModel: Object.freeze({
            instancesPerPage: 1,
            activeRequests: Object.freeze({
                source: 'runtime-logical-processors',
                minimum: 1,
                maximum: 8,
                logicalProcessorsPerRequest: 2
            })
        })
    }),
    aedsRuntimeTiers: Object.freeze({
        basic: Object.freeze({
            module: 'aeds_decoder_basic.js',
            wasm: 'aeds_decoder_basic.wasm',
            wasmOptValidated: false,
            simd: false,
            lto: false,
            initialMemoryBytes: 16 * 1024 * 1024,
            maximumMemoryBytes: 256 * 1024 * 1024,
            memoryGrowth: 'bounded'
        }),
        speed: Object.freeze({
            module: 'aeds_decoder_speed.js',
            wasm: 'aeds_decoder_speed.wasm',
            wasmOptValidated: true,
            simd: true,
            lto: true,
            initialMemoryBytes: 64 * 1024 * 1024,
            maximumMemoryBytes: 64 * 1024 * 1024,
            memoryGrowth: 'disabled'
        })
    }),
    productionZkEnabled: productionZkRequested(),
    requiredOutputFiles: resolveWasmRequiredOutputFiles()
});
const {
    schemaVersion,
    aedsAbi,
    buildModes,
    requiredOutputFiles
} = wasmArtifactContract;

function log(message)
{
    console.log(`[ensure-wasm] ${message}`);
}

async function exists(path)
{
    try
    {
        await access(path, fsConstants.F_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

async function sha256File(path)
{
    const hash = createHash('sha256');
    hash.update(await readFile(path));
    return hash.digest('hex');
}

export function resolveEnsureWasmHashWorkers({
    env = process.env,
    itemCount = Number.POSITIVE_INFINITY,
    availableCpu = os.availableParallelism?.() ?? os.cpus().length,
    freeMemoryBytes = os.freemem(),
    totalMemoryBytes = os.totalmem()
} = {})
{
    const hostCpu = Math.max(1, Math.floor(requiredPositiveNumber(availableCpu, 'available CPU')));
    const cpuGrant = optionalPositiveNumber(env, [
        'FSUSBLOG_STEP_CPU_BUDGET',
        'FSUSBLOG_BUNDLE_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_BUDGET'
    ]);
    const memoryGrantGiB = optionalPositiveNumber(env, [
        'FSUSBLOG_STEP_MEMORY_GIB',
        'FSUSBLOG_BUNDLE_MEMORY_GIB'
    ]);
    const schedulerManaged = cpuGrant !== null || memoryGrantGiB !== null;
    const cpuCap = Math.max(1, Math.floor(Math.min(hostCpu, cpuGrant ?? hostCpu)));
    const hostTotalMemoryBytes = requiredPositiveNumber(totalMemoryBytes, 'total memory');
    const hostFreeMemoryBytes = requiredPositiveNumber(freeMemoryBytes, 'free memory');
    const hostMemoryPerCpu = hostTotalMemoryBytes / hostCpu;
    const memoryCap = schedulerManaged
        ? cpuCap
        : Math.max(1, Math.floor(hostFreeMemoryBytes / hostMemoryPerCpu));
    const finiteItemCount = Number.isFinite(itemCount)
        ? Math.max(1, Math.floor(requiredPositiveNumber(itemCount, 'hash item count')))
        : Number.POSITIVE_INFINITY;
    return Math.max(1, Math.min(cpuCap, memoryCap, finiteItemCount));
}

async function mapWithDynamicConcurrency(items, mapper)
{
    if (items.length === 0)
    {
        return [];
    }
    const results = new Array(items.length);
    const workerCount = resolveEnsureWasmHashWorkers({ itemCount: items.length });
    let nextIndex = 0;
    await Promise.all(Array.from({ length: workerCount }, async () =>
    {
        while (nextIndex < items.length)
        {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(items[index], index);
        }
    }));
    return results;
}

async function computeSourceDescriptor()
{
    const repositoryRoot = resolve(process.env.FSUSBLOG_REPOSITORY_ROOT || resolve(clientRoot, '../..'));
    const descriptor = computeWasmProducerInputDescriptor({
        repositoryRoot,
        productionZkEnabled: productionZkRequested()
    });
    return {
        sourceHash: descriptor.sourceHash,
        sourceFiles: descriptor.sourceFiles.map((sourceFile) =>
            relative(clientRoot, join(repositoryRoot, sourceFile)).replaceAll('\\', '/'))
    };
}

async function readManifest()
{
    if (!await exists(manifestPath))
    {
        return null;
    }

    const raw = await readFile(manifestPath, 'utf8');
    return parseWasmManifest(raw);
}

async function createManifest({ builtAtUtc, toolchain })
{
    const sourceDescriptor = await computeSourceDescriptor();
    const outputHashes = await mapWithDynamicConcurrency(requiredOutputFiles, (outputFile) =>
        sha256File(join(publicWasmRoot, outputFile)));
    const outputFileHashes = Object.fromEntries(requiredOutputFiles.map((outputFile, index) =>
        [outputFile, outputHashes[index]]));

    return {
        schemaVersion,
        builtAtUtc,
        buildModes,
        buildScript: relative(clientRoot, buildScriptPath).replaceAll('\\', '/'),
        dependencyInstaller: relative(clientRoot, dependencyInstallerPath).replaceAll('\\', '/'),
        aedsAbi,
        toolchain,
        sourceHash: sourceDescriptor.sourceHash,
        sourceFiles: sourceDescriptor.sourceFiles,
        outputFiles: requiredOutputFiles,
        outputFileHashes
    };
}

function resolveToolchain(recorded)
{
    const toolchain = {
        emscriptenVersion: process.env.FSUSBLOG_WASM_TOOLCHAIN_EMSCRIPTEN || recorded?.emscriptenVersion || '',
        binaryenVersion: process.env.FSUSBLOG_WASM_TOOLCHAIN_BINARYEN || recorded?.binaryenVersion || '',
        cmakeVersion: process.env.FSUSBLOG_WASM_TOOLCHAIN_CMAKE || recorded?.cmakeVersion || '',
        vcpkgCommit: process.env.FSUSBLOG_WASM_TOOLCHAIN_VCPKG || recorded?.vcpkgCommit || '',
        emsdkImage: process.env.FSUSBLOG_WASM_TOOLCHAIN_EMSDK_IMAGE || recorded?.emsdkImage || ''
    };
    if (!matchesWasmToolchainContract(toolchain))
    {
        const mismatches = Object.entries(wasmToolchainContract)
            .filter(([name, expected]) => toolchain[name] !== expected)
            .map(([name, expected]) => `${name}=${toolchain[name] || 'missing'} (expected ${expected})`);
        throw new Error(`Wasm toolchain identity does not match the pinned release contract: ${mismatches.join(', ')}`);
    }
    return { ...wasmToolchainContract };
}

export function matchesWasmToolchainContract(value)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const actualKeys = Object.keys(value).sort();
    const expectedKeys = Object.keys(wasmToolchainContract).sort();
    return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => value[key] === wasmToolchainContract[key]);
}

async function writeAedsRuntimeManifest(toolchain)
{
    for (const tier of Object.values(wasmArtifactContract.aedsRuntimeTiers))
    {
        for (const file of [tier.module, tier.wasm])
        {
            if (!await exists(join(publicWasmRoot, file)))
            {
                throw new Error(`cannot write AEDS runtime manifest because ${file} is missing`);
            }
        }
    }
    const tiers = Object.fromEntries(await Promise.all(
        Object.entries(wasmArtifactContract.aedsRuntimeTiers).map(async ([tierName, tier]) => [
            tierName,
            {
                ...tier,
                moduleSha256: await sha256File(join(publicWasmRoot, tier.module)),
                wasmSha256: await sha256File(join(publicWasmRoot, tier.wasm))
            }
        ])
    ));
    const runtimeManifest = {
        ...wasmArtifactContract.aedsRuntimeRoot,
        abi: aedsAbi,
        toolchain,
        tiers
    };
    await writeFile(aedsRuntimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8');
}

async function writeManifest()
{
    await mkdir(publicWasmRoot, { recursive: true });
    const previousManifest = await readManifest();
    const toolchain = resolveToolchain(previousManifest?.toolchain);
    await writeAedsRuntimeManifest(toolchain);
    const missingOutputs = [];

    for (const outputFile of requiredOutputFiles)
    {
        const outputPath = join(publicWasmRoot, outputFile);
        if (!await exists(outputPath))
        {
            missingOutputs.push(outputFile);
        }
    }

    if (missingOutputs.length > 0)
    {
        throw new Error(`cannot write wasm manifest because outputs are missing: ${missingOutputs.join(', ')}`);
    }

    const manifest = await createManifest({ builtAtUtc: new Date().toISOString(), toolchain });
    await writeFile(manifestPath, formatManifest(manifest), 'utf8');
    if (process.env.FSUSBLOG_WASM_SKIP_RECEIPT !== '1')
    {
        createWasmBuildReceipt({
            repositoryRoot: resolve(process.env.FSUSBLOG_REPOSITORY_ROOT || resolve(clientRoot, '../..')),
            clientRoot,
            artifactDir: publicWasmRoot,
            manifest,
            contract: wasmArtifactContract,
            buildCount: Number(process.env.FSUSBLOG_WASM_PRODUCER_BUILD_COUNT || 1),
            trustProducerValidation: true
        });
    }
    log(`wrote ${relative(clientRoot, manifestPath).replaceAll('\\', '/')}`);
}

function encodeManifestField(value)
{
    return Buffer.from(String(value ?? ''), 'utf8').toString('base64url');
}

function decodeManifestField(value)
{
    return Buffer.from(value, 'base64url').toString('utf8');
}

function formatManifest(manifest)
{
    const lines = [
        `schemaVersion\t${manifest.schemaVersion}`,
        `builtAtUtc\t${encodeManifestField(manifest.builtAtUtc)}`,
        `buildModes\t${manifest.buildModes.map(encodeManifestField).join(',')}`,
        `buildScript\t${encodeManifestField(manifest.buildScript)}`,
        `dependencyInstaller\t${encodeManifestField(manifest.dependencyInstaller)}`,
        `aedsAbi\t${encodeManifestField(manifest.aedsAbi)}`,
        `toolchain\t${encodeManifestField(JSON.stringify(manifest.toolchain))}`,
        `sourceHash\t${encodeManifestField(manifest.sourceHash)}`
    ];

    for (const sourceFile of manifest.sourceFiles)
    {
        lines.push(`sourceFile\t${encodeManifestField(sourceFile)}`);
    }
    for (const outputFile of manifest.outputFiles)
    {
        lines.push(`outputFile\t${encodeManifestField(outputFile)}\t${encodeManifestField(manifest.outputFileHashes[outputFile] ?? '')}`);
    }
    return `${lines.join('\n')}\n`;
}

export function parseWasmManifest(raw)
{
    const manifest = {
        schemaVersion: 0,
        builtAtUtc: '',
        buildModes: [],
        buildScript: '',
        dependencyInstaller: '',
        aedsAbi: '',
        toolchain: null,
        sourceHash: '',
        sourceFiles: [],
        outputFiles: [],
        outputFileHashes: {}
    };

    for (const line of raw.split(/\r?\n/u))
    {
        const trimmed = line.trim();
        if (!trimmed)
        {
            continue;
        }

        const [key, value = '', extra = ''] = trimmed.split('\t');
        switch (key)
        {
            case 'schemaVersion':
                manifest.schemaVersion = Number(value);
                break;
            case 'builtAtUtc':
                manifest.builtAtUtc = decodeManifestField(value);
                break;
            case 'buildModes':
                manifest.buildModes = value ? value.split(',').map(decodeManifestField) : [];
                break;
            case 'buildScript':
                manifest.buildScript = decodeManifestField(value);
                break;
            case 'dependencyInstaller':
                manifest.dependencyInstaller = decodeManifestField(value);
                break;
            case 'aedsAbi':
                manifest.aedsAbi = decodeManifestField(value);
                break;
            case 'toolchain':
                try
                {
                    manifest.toolchain = JSON.parse(decodeManifestField(value));
                }
                catch
                {
                    manifest.toolchain = null;
                }
                break;
            case 'sourceHash':
                manifest.sourceHash = decodeManifestField(value);
                break;
            case 'sourceFile':
                manifest.sourceFiles.push(decodeManifestField(value));
                break;
            case 'outputFile': {
                const outputFile = decodeManifestField(value);
                manifest.outputFiles.push(outputFile);
                manifest.outputFileHashes[outputFile] = decodeManifestField(extra);
                break;
            }
            default:
                break;
        }
    }

    return manifest;
}

function sameExactIdentity(actual, expected)
{
    if (Object.is(actual, expected))
    {
        return true;
    }
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object'
      || Array.isArray(actual) !== Array.isArray(expected))
    {
        return false;
    }
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => sameExactIdentity(actual[key], expected[key]));
}

export function validateAedsRuntimeManifestIdentity(runtimeManifest, outerToolchain)
{
    if (!runtimeManifest || typeof runtimeManifest !== 'object' || Array.isArray(runtimeManifest))
    {
        return 'AEDS runtime root identity is invalid';
    }
    const rootContract = wasmArtifactContract.aedsRuntimeRoot;
    const expectedRootKeys = [...Object.keys(rootContract), 'abi', 'toolchain', 'tiers'].sort();
    const actualRootKeys = Object.keys(runtimeManifest).sort();
    if (!sameExactIdentity(actualRootKeys, expectedRootKeys))
    {
        return 'AEDS runtime root identity is invalid';
    }
    if (runtimeManifest.schema !== rootContract.schema)
    {
        return `AEDS runtime schema mismatch (${runtimeManifest.schema || 'missing'})`;
    }
    if (runtimeManifest.abi !== aedsAbi)
    {
        return `AEDS runtime ABI mismatch (${runtimeManifest.abi || 'missing'} != ${aedsAbi})`;
    }
    if (runtimeManifest.maxFrameBytes !== rootContract.maxFrameBytes)
    {
        return 'AEDS runtime maxFrameBytes does not match the release contract';
    }
    if (!sameExactIdentity(runtimeManifest.workerModel, rootContract.workerModel))
    {
        return 'AEDS runtime workerModel does not match the release contract';
    }
    if (!matchesWasmToolchainContract(runtimeManifest.toolchain)
      || !sameExactIdentity(runtimeManifest.toolchain, outerToolchain))
    {
        return 'AEDS runtime manifest toolchain does not match the outer pinned toolchain';
    }
    if (!runtimeManifest.tiers || typeof runtimeManifest.tiers !== 'object'
      || Array.isArray(runtimeManifest.tiers)
      || !sameExactIdentity(
          Object.keys(runtimeManifest.tiers).sort(),
          Object.keys(wasmArtifactContract.aedsRuntimeTiers).sort()
      ))
    {
        return 'AEDS runtime tier set does not match the release contract';
    }
    for (const [tierName, expectedTier] of Object.entries(wasmArtifactContract.aedsRuntimeTiers))
    {
        const actualTier = runtimeManifest.tiers[tierName];
        const expectedTierKeys = [...Object.keys(expectedTier), 'moduleSha256', 'wasmSha256'].sort();
        if (!actualTier || typeof actualTier !== 'object' || Array.isArray(actualTier)
        || !sameExactIdentity(Object.keys(actualTier).sort(), expectedTierKeys))
        {
            return `AEDS runtime ${tierName} tier identity is invalid`;
        }
        for (const [field, expectedValue] of Object.entries(expectedTier))
        {
            if (!sameExactIdentity(actualTier[field], expectedValue))
            {
                return `AEDS runtime ${tierName} tier identity is invalid`;
            }
        }
    }
    return null;
}

async function validateAedsRuntimeManifest(outerToolchain)
{
    let runtimeManifest;
    try
    {
        runtimeManifest = JSON.parse(await readFile(aedsRuntimeManifestPath, 'utf8'));
    }
    catch (error)
    {
        return `AEDS runtime manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const identityError = validateAedsRuntimeManifestIdentity(runtimeManifest, outerToolchain);
    if (identityError)
    {
        return identityError;
    }

    for (const [tierName, expected] of Object.entries(wasmArtifactContract.aedsRuntimeTiers))
    {
        const tier = runtimeManifest.tiers?.[tierName];
        const [moduleHash, wasmHash] = await Promise.all([
            sha256File(join(publicWasmRoot, expected.module)),
            sha256File(join(publicWasmRoot, expected.wasm))
        ]);
        if (tier.moduleSha256 !== moduleHash)
        {
            return `AEDS runtime ${tierName} module hash changed`;
        }
        if (tier.wasmSha256 !== wasmHash)
        {
            return `AEDS runtime ${tierName} wasm hash changed`;
        }
    }
    return null;
}

async function isFresh()
{
    const manifest = await readManifest();
    if (!manifest)
    {
        return { fresh: false, reason: 'manifest missing' };
    }

    if (manifest.schemaVersion !== schemaVersion)
    {
        return { fresh: false, reason: `schema mismatch (${manifest.schemaVersion} != ${schemaVersion})` };
    }

    if (manifest.aedsAbi !== aedsAbi)
    {
        return { fresh: false, reason: `AEDS ABI mismatch (${manifest.aedsAbi || 'missing'} != ${aedsAbi})` };
    }
    if (!matchesWasmToolchainContract(manifest.toolchain))
    {
        return { fresh: false, reason: 'toolchain identity does not match the pinned release contract' };
    }

    for (const outputFile of requiredOutputFiles)
    {
        const outputPath = join(publicWasmRoot, outputFile);
        if (!await exists(outputPath))
        {
            return { fresh: false, reason: `missing output ${outputFile}` };
        }
    }

    const runtimeManifestError = await validateAedsRuntimeManifest(manifest.toolchain);
    if (runtimeManifestError)
    {
        return { fresh: false, reason: runtimeManifestError };
    }

    const expected = await createManifest({
        builtAtUtc: manifest.builtAtUtc ?? new Date().toISOString(),
        toolchain: manifest.toolchain
    });
    if (manifest.sourceHash !== expected.sourceHash)
    {
        return { fresh: false, reason: 'source hash changed' };
    }

    const actualOutputFiles = Array.isArray(manifest.outputFiles) ? manifest.outputFiles.slice().sort() : [];
    const expectedOutputFiles = requiredOutputFiles.slice().sort();
    if (actualOutputFiles.length !== expectedOutputFiles.length ||
      actualOutputFiles.some((value, index) => value !== expectedOutputFiles[index]))
    {
        return { fresh: false, reason: 'output file manifest mismatch' };
    }

    const outputFileHashes = manifest.outputFileHashes;
    if (!outputFileHashes || typeof outputFileHashes !== 'object' || Array.isArray(outputFileHashes))
    {
        return { fresh: false, reason: 'output file hashes missing' };
    }

    for (const outputFile of requiredOutputFiles)
    {
        if (typeof outputFileHashes[outputFile] !== 'string' || outputFileHashes[outputFile].length === 0)
        {
            return { fresh: false, reason: `missing output hash ${outputFile}` };
        }

        const actualHash = expected.outputFileHashes[outputFile];
        if (actualHash !== outputFileHashes[outputFile])
        {
            return { fresh: false, reason: `output hash changed: ${outputFile}` };
        }
    }

    return { fresh: true, reason: 'up to date' };
}

async function validateReceipt()
{
    if (!await exists(wasmBuildReceiptPath))
    {
        throw new Error('WASM build receipt is missing');
    }
    const manifest = await readManifest();
    if (!manifest)
    {
        throw new Error('manifest missing');
    }
    return validateWasmBuildReceipt({
        repositoryRoot: resolve(clientRoot, '../..'),
        clientRoot,
        artifactDir: publicWasmRoot,
        receiptFile: wasmBuildReceiptPath,
        manifest,
        contract: wasmArtifactContract
    });
}

async function runBuild()
{
    return new Promise((resolve, reject) =>
    {
        const bashExecutable = process.env.FSUSBLOG_BASH?.trim() || 'bash';
        const child = spawn(bashExecutable, ['./wasm/build.sh'], {
            cwd: clientRoot,
            stdio: 'inherit',
            env: process.env
        });

        child.on('error', reject);
        child.on('exit', (code, signal) =>
        {
            if (code === 0)
            {
                resolve();
                return;
            }

            const detail = signal ? `signal ${signal}` : `exit code ${code}`;
            reject(new Error(`wasm build failed with ${detail}`));
        });
    });
}

async function ensure()
{
    try
    {
        const validation = await validateReceipt();
        log(`artifacts are receipt-bound (${validation.evidence.validationMode})`);
        return;
    }
    catch (error)
    {
        const fallback = classifyWasmReceiptFallback(error);
        log(`receipt fallback=${fallback.action}: ${fallback.reason}`);
    }

    const freshness = await isFresh();
    if (freshness.fresh)
    {
        const manifest = await readManifest();
        createWasmBuildReceipt({
            repositoryRoot: resolve(clientRoot, '../..'),
            clientRoot,
            artifactDir: publicWasmRoot,
            manifest,
            contract: wasmArtifactContract,
            buildCount: 0,
            trustProducerValidation: true
        });
        log(`artifacts are ${freshness.reason}; sealed ${wasmBuildReceiptName}`);
        return;
    }

    log(`artifacts are stale: ${freshness.reason}`);
    if (!await exists(buildScriptPath))
    {
        throw new Error(`missing wasm build script: ${relative(clientRoot, buildScriptPath)}`);
    }

    log('rebuilding wasm artifacts');
    await runBuild();

    const afterBuild = await isFresh();
    if (!afterBuild.fresh)
    {
        throw new Error(`wasm rebuild completed but artifacts are still stale: ${afterBuild.reason}`);
    }

    const manifest = await readManifest();
    createWasmBuildReceipt({
        repositoryRoot: resolve(clientRoot, '../..'),
        clientRoot,
        artifactDir: publicWasmRoot,
        manifest,
        contract: wasmArtifactContract,
        buildCount: 1,
        trustProducerValidation: true
    });
    log('artifacts refreshed');
}

async function main()
{
    const command = (process.argv[2] ?? 'ensure').trim();

    if (command === 'ensure')
    {
        await ensure();
        return;
    }

    if (command === 'write-manifest')
    {
        await writeManifest();
        return;
    }

    if (command === 'status')
    {
        try
        {
            const validation = await validateReceipt();
            log(`fresh: receipt-bound ${validation.receipt.contentDigest}`);
        }
        catch (error)
        {
            log(`stale: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
        return;
    }

    if (command === 'full-status')
    {
        const freshness = await isFresh();
        log(`${freshness.fresh ? 'fresh' : 'stale'}: ${freshness.reason}`);
        process.exitCode = freshness.fresh ? 0 : 1;
        return;
    }

    throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ensure-wasm] fatal: ${message}`);
        process.exit(1);
    });
}

function requiredPositiveNumber(value, name)
{
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
    {
        throw new Error(`${name} must be a finite positive number, got ${String(value)}`);
    }
    return parsed;
}

function optionalPositiveNumber(env, names)
{
    for (const name of names)
    {
        if (env[name] === undefined || String(env[name]).trim() === '')
        {
            continue;
        }
        return requiredPositiveNumber(env[name], name);
    }
    return null;
}
