#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = process.cwd();
const wasmRoot = join(clientRoot, 'wasm');
const publicWasmRoot = join(clientRoot, 'public', 'wasm');
const manifestPath = join(publicWasmRoot, 'wasm-manifest.aeds');
const dependencyInstallerPath = fileURLToPath(new URL('./install-wasm-codec-deps.sh', import.meta.url));
const buildScriptPath = join(wasmRoot, 'build.sh');
const schemaVersion = 2;
const buildModes = ['basic', 'simd', 'relaxed', 'threads'];
const requiredOutputFiles = [
  'aeds_decoder.js',
  'aeds_decoder.wasm',
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
  'search_simd.wasm'
];
const ignoredWasmDirectories = new Set([
  '.artifacts',
  '.cmake',
  '.emscripten-cache',
  'build',
  'build-basic',
  'build-pow-relaxed',
  'build-pow-threads',
  'build-simd'
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

async function computeSourceDescriptor() {
  const wasmFiles = await walkFiles(wasmRoot);
  const sourceFiles = [
    ...wasmFiles,
    dependencyInstallerPath
  ].sort((left, right) => left.localeCompare(right));

  const hash = createHash('sha256');
  const manifestSourceFiles = [];

  for (const sourceFile of sourceFiles) {
    const relativePath = relative(clientRoot, sourceFile).replaceAll('\\', '/');
    const contentHash = await sha256File(sourceFile);
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

async function createManifest({ builtAtUtc }) {
  const sourceDescriptor = await computeSourceDescriptor();
  const outputFileHashes = {};

  for (const outputFile of requiredOutputFiles) {
    outputFileHashes[outputFile] = await sha256File(join(publicWasmRoot, outputFile));
  }

  return {
    schemaVersion,
    builtAtUtc,
    buildModes,
    buildScript: relative(clientRoot, buildScriptPath).replaceAll('\\', '/'),
    dependencyInstaller: relative(clientRoot, dependencyInstallerPath).replaceAll('\\', '/'),
    sourceHash: sourceDescriptor.sourceHash,
    sourceFiles: sourceDescriptor.sourceFiles,
    outputFiles: requiredOutputFiles,
    outputFileHashes
  };
}

async function writeManifest() {
  await mkdir(publicWasmRoot, { recursive: true });
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

  const manifest = await createManifest({ builtAtUtc: new Date().toISOString() });
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

  for (const outputFile of requiredOutputFiles) {
    const outputPath = join(publicWasmRoot, outputFile);
    if (!await exists(outputPath)) {
      return { fresh: false, reason: `missing output ${outputFile}` };
    }
  }

  const expected = await createManifest({ builtAtUtc: manifest.builtAtUtc ?? new Date().toISOString() });
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
    const outputPath = join(publicWasmRoot, outputFile);
    if (typeof outputFileHashes[outputFile] !== 'string' || outputFileHashes[outputFile].length === 0) {
      return { fresh: false, reason: `missing output hash ${outputFile}` };
    }

    const actualHash = await sha256File(outputPath);
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ensure-wasm] fatal: ${message}`);
  process.exit(1);
});
