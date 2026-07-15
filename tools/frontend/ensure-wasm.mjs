#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = process.cwd();
const wasmRoot = join(clientRoot, 'wasm');
const publicWasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT || join(clientRoot, 'public', 'wasm'));
const manifestPath = join(publicWasmRoot, 'wasm-manifest.aeds');
const aedsRuntimeManifestPath = join(publicWasmRoot, 'aeds-runtime-manifest.json');
const dependencyInstallerPath = fileURLToPath(new URL('./install-wasm-codec-deps.sh', import.meta.url));
const cmakeBootstrapPath = fileURLToPath(new URL('./ensure-cmake.sh', import.meta.url));
const binaryenBootstrapPath = fileURLToPath(new URL('./ensure-binaryen.sh', import.meta.url));
const buildScriptPath = join(wasmRoot, 'build.sh');
const schemaVersion = 3;
const aedsAbi = 'fsusblog.aeds.v4';
const buildModes = ['basic', 'simd', 'relaxed', 'threads'];
const requiredOutputFiles = [
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
  'image_codec_basic.js',
  'image_codec_basic.wasm',
  'image_codec_simd.js',
  'image_codec_simd.wasm',
  'search_basic.js',
  'search_basic.wasm',
  'search_simd.js',
  'search_simd.wasm',
  'comment-privacy-prover.js',
  'comment-privacy-prover.zkey',
  'comment-privacy-prover.manifest.json',
  'comment_privacy_runtime.js',
  'comment_privacy_runtime.wasm'
];
const ignoredWasmDirectories = new Set([
  '.artifacts',
  '.cmake',
  '.emscripten-cache',
  'build',
  'build-basic',
  'build-pow-relaxed',
  'build-pow-threads',
  'build-simd',
  'stage'
]);

function log(message) {
  console.log(`[ensure-wasm] ${message}`);
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (currentDir === rootDir && ignoredWasmDirectories.has(entry.name)) {
        continue;
      }

      files.push(...await walkFiles(rootDir, absolutePath));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function sha256File(path) {
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
} = {}) {
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

async function mapWithDynamicConcurrency(items, mapper) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  const workerCount = resolveEnsureWasmHashWorkers({ itemCount: items.length });
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function computeSourceDescriptor() {
  const wasmFiles = await walkFiles(wasmRoot);
  const sourceFiles = [
    ...wasmFiles,
    dependencyInstallerPath,
    cmakeBootstrapPath,
    binaryenBootstrapPath
  ].sort((left, right) => left.localeCompare(right));

  const descriptors = await mapWithDynamicConcurrency(sourceFiles, async (sourceFile) => {
    const relativePath = relative(clientRoot, sourceFile).replaceAll('\\', '/');
    const contentHash = await sha256File(sourceFile);
    return { relativePath, contentHash };
  });
  const hash = createHash('sha256');
  const manifestSourceFiles = [];

  for (const { relativePath, contentHash } of descriptors) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(contentHash);
    hash.update('\0');
    manifestSourceFiles.push(relativePath);
  }

  return {
    sourceHash: hash.digest('hex'),
    sourceFiles: manifestSourceFiles
  };
}

async function readManifest() {
  if (!await exists(manifestPath)) {
    return null;
  }

  const raw = await readFile(manifestPath, 'utf8');
  return parseManifest(raw);
}

async function createManifest({ builtAtUtc, toolchain }) {
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

function resolveToolchain(recorded) {
  const toolchain = {
    emscriptenVersion: process.env.FSUSBLOG_WASM_TOOLCHAIN_EMSCRIPTEN || recorded?.emscriptenVersion || '',
    binaryenVersion: process.env.FSUSBLOG_WASM_TOOLCHAIN_BINARYEN || recorded?.binaryenVersion || '',
    cmakeVersion: process.env.FSUSBLOG_WASM_TOOLCHAIN_CMAKE || recorded?.cmakeVersion || '',
    vcpkgCommit: process.env.FSUSBLOG_WASM_TOOLCHAIN_VCPKG || recorded?.vcpkgCommit || '',
    emsdkImage: process.env.FSUSBLOG_WASM_TOOLCHAIN_EMSDK_IMAGE || recorded?.emsdkImage || ''
  };
  if (!isValidToolchain(toolchain)) {
    throw new Error('Wasm toolchain identity is incomplete; build.sh must supply pinned Emscripten, Binaryen, CMake, vcpkg, and emsdk image identities');
  }
  return toolchain;
}

function isValidToolchain(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value)
    && /^\d+\.\d+\.\d+$/u.test(String(value.emscriptenVersion ?? ''))
    && /^\d+$/u.test(String(value.binaryenVersion ?? ''))
    && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(value.cmakeVersion ?? ''))
    && /^[0-9a-f]{40}$/u.test(String(value.vcpkgCommit ?? ''))
    && /^emscripten\/emsdk:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/u.test(String(value.emsdkImage ?? ''))
  );
}

async function writeAedsRuntimeManifest(toolchain) {
  const tierFiles = {
    basic: ['aeds_decoder_basic.js', 'aeds_decoder_basic.wasm'],
    speed: ['aeds_decoder_speed.js', 'aeds_decoder_speed.wasm']
  };
  for (const files of Object.values(tierFiles)) {
    for (const file of files) {
      if (!await exists(join(publicWasmRoot, file))) {
        throw new Error(`cannot write AEDS runtime manifest because ${file} is missing`);
      }
    }
  }
  const [basicModuleHash, basicWasmHash, speedModuleHash, speedWasmHash] = await Promise.all([
    sha256File(join(publicWasmRoot, tierFiles.basic[0])),
    sha256File(join(publicWasmRoot, tierFiles.basic[1])),
    sha256File(join(publicWasmRoot, tierFiles.speed[0])),
    sha256File(join(publicWasmRoot, tierFiles.speed[1]))
  ]);
  const runtimeManifest = {
    schema: 'fsusblog.aeds-runtime.v1',
    abi: aedsAbi,
    maxFrameBytes: 8 * 1024 * 1024,
    workerModel: { instancesPerPage: 1, activeRequests: 2 },
    toolchain,
    tiers: {
      basic: {
        module: tierFiles.basic[0],
        wasm: tierFiles.basic[1],
        moduleSha256: basicModuleHash,
        wasmSha256: basicWasmHash,
        simd: false,
        lto: false,
        wasmOptValidated: false,
        initialMemoryBytes: 16 * 1024 * 1024,
        maximumMemoryBytes: 256 * 1024 * 1024,
        memoryGrowth: 'bounded'
      },
      speed: {
        module: tierFiles.speed[0],
        wasm: tierFiles.speed[1],
        moduleSha256: speedModuleHash,
        wasmSha256: speedWasmHash,
        simd: true,
        lto: true,
        wasmOptValidated: true,
        initialMemoryBytes: 64 * 1024 * 1024,
        maximumMemoryBytes: 64 * 1024 * 1024,
        memoryGrowth: 'disabled'
      }
    }
  };
  await writeFile(aedsRuntimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, 'utf8');
}

async function writeManifest() {
  await mkdir(publicWasmRoot, { recursive: true });
  const previousManifest = await readManifest();
  const toolchain = resolveToolchain(previousManifest?.toolchain);
  await writeAedsRuntimeManifest(toolchain);
  const missingOutputs = [];

  for (const outputFile of requiredOutputFiles) {
    const outputPath = join(publicWasmRoot, outputFile);
    if (!await exists(outputPath)) {
      missingOutputs.push(outputFile);
    }
  }

  if (missingOutputs.length > 0) {
    throw new Error(`cannot write wasm manifest because outputs are missing: ${missingOutputs.join(', ')}`);
  }

  const manifest = await createManifest({ builtAtUtc: new Date().toISOString(), toolchain });
  await writeFile(manifestPath, formatManifest(manifest), 'utf8');
  log(`wrote ${relative(clientRoot, manifestPath).replaceAll('\\', '/')}`);
}

function encodeManifestField(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64url');
}

function decodeManifestField(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function formatManifest(manifest) {
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

  for (const sourceFile of manifest.sourceFiles) {
    lines.push(`sourceFile\t${encodeManifestField(sourceFile)}`);
  }
  for (const outputFile of manifest.outputFiles) {
    lines.push(`outputFile\t${encodeManifestField(outputFile)}\t${encodeManifestField(manifest.outputFileHashes[outputFile] ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseManifest(raw) {
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

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [key, value = '', extra = ''] = trimmed.split('\t');
    switch (key) {
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
        try {
          manifest.toolchain = JSON.parse(decodeManifestField(value));
        } catch {
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

async function isFresh() {
  const manifest = await readManifest();
  if (!manifest) {
    return { fresh: false, reason: 'manifest missing' };
  }

  if (manifest.schemaVersion !== schemaVersion) {
    return { fresh: false, reason: `schema mismatch (${manifest.schemaVersion} != ${schemaVersion})` };
  }

  if (manifest.aedsAbi !== aedsAbi) {
    return { fresh: false, reason: `AEDS ABI mismatch (${manifest.aedsAbi || 'missing'} != ${aedsAbi})` };
  }
  if (!isValidToolchain(manifest.toolchain)) {
    return { fresh: false, reason: 'toolchain identity missing or mutable' };
  }

  for (const outputFile of requiredOutputFiles) {
    const outputPath = join(publicWasmRoot, outputFile);
    if (!await exists(outputPath)) {
      return { fresh: false, reason: `missing output ${outputFile}` };
    }
  }

  const expected = await createManifest({
    builtAtUtc: manifest.builtAtUtc ?? new Date().toISOString(),
    toolchain: manifest.toolchain
  });
  if (manifest.sourceHash !== expected.sourceHash) {
    return { fresh: false, reason: 'source hash changed' };
  }

  const actualOutputFiles = Array.isArray(manifest.outputFiles) ? manifest.outputFiles.slice().sort() : [];
  const expectedOutputFiles = requiredOutputFiles.slice().sort();
  if (actualOutputFiles.length !== expectedOutputFiles.length ||
      actualOutputFiles.some((value, index) => value !== expectedOutputFiles[index])) {
    return { fresh: false, reason: 'output file manifest mismatch' };
  }

  const outputFileHashes = manifest.outputFileHashes;
  if (!outputFileHashes || typeof outputFileHashes !== 'object' || Array.isArray(outputFileHashes)) {
    return { fresh: false, reason: 'output file hashes missing' };
  }

  for (const outputFile of requiredOutputFiles) {
    if (typeof outputFileHashes[outputFile] !== 'string' || outputFileHashes[outputFile].length === 0) {
      return { fresh: false, reason: `missing output hash ${outputFile}` };
    }

    const actualHash = expected.outputFileHashes[outputFile];
    if (actualHash !== outputFileHashes[outputFile]) {
      return { fresh: false, reason: `output hash changed: ${outputFile}` };
    }
  }

  return { fresh: true, reason: 'up to date' };
}

async function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['./wasm/build.sh'], {
      cwd: clientRoot,
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`wasm build failed with ${detail}`));
    });
  });
}

async function ensure() {
  const freshness = await isFresh();
  if (freshness.fresh) {
    log(`artifacts are ${freshness.reason}`);
    return;
  }

  log(`artifacts are stale: ${freshness.reason}`);
  if (!await exists(buildScriptPath)) {
    throw new Error(`missing wasm build script: ${relative(clientRoot, buildScriptPath)}`);
  }

  log('rebuilding wasm artifacts');
  await runBuild();

  const afterBuild = await isFresh();
  if (!afterBuild.fresh) {
    throw new Error(`wasm rebuild completed but artifacts are still stale: ${afterBuild.reason}`);
  }

  log('artifacts refreshed');
}

async function main() {
  const command = (process.argv[2] ?? 'ensure').trim();

  if (command === 'ensure') {
    await ensure();
    return;
  }

  if (command === 'write-manifest') {
    await writeManifest();
    return;
  }

  if (command === 'status') {
    const freshness = await isFresh();
    log(`${freshness.fresh ? 'fresh' : 'stale'}: ${freshness.reason}`);
    process.exitCode = freshness.fresh ? 0 : 1;
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ensure-wasm] fatal: ${message}`);
    process.exit(1);
  });
}

function requiredPositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a finite positive number, got ${String(value)}`);
  }
  return parsed;
}

function optionalPositiveNumber(env, names) {
  for (const name of names) {
    if (env[name] === undefined || String(env[name]).trim() === '') continue;
    return requiredPositiveNumber(env[name], name);
  }
  return null;
}
