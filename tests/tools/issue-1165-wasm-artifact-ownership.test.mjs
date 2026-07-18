import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkWasmArtifactOwnership,
  validateGeneratedPackageFreshness,
  validateGeneratedWasmPackage
} from '../../tools/check-wasm-artifact-ownership.mjs';
import {
  wasmArtifactContract,
  wasmToolchainContract
} from '../../tools/frontend/ensure-wasm.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendRoot = path.join(repoRoot, 'src/frontend');
const ensureWasmPath = path.join(repoRoot, 'tools/frontend/ensure-wasm.mjs');
const ownershipCheckerPath = path.join(repoRoot, 'tools/check-wasm-artifact-ownership.mjs');
const toolchain = { ...wasmToolchainContract };

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function encode(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

async function writeValidPackage() {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-issue-1165-'));
  const hashes = {};
  for (const outputFile of wasmArtifactContract.requiredOutputFiles) {
    if (outputFile === 'aeds-runtime-manifest.json') continue;
    const body = `fixture:${outputFile}\n`;
    await writeFile(path.join(artifactDir, outputFile), body);
    hashes[outputFile] = sha256(body);
  }

  const runtimeManifest = `${JSON.stringify({
    ...wasmArtifactContract.aedsRuntimeRoot,
    abi: wasmArtifactContract.aedsAbi,
    toolchain,
    tiers: {
      basic: {
        ...wasmArtifactContract.aedsRuntimeTiers.basic,
        moduleSha256: hashes[wasmArtifactContract.aedsRuntimeTiers.basic.module],
        wasmSha256: hashes[wasmArtifactContract.aedsRuntimeTiers.basic.wasm]
      },
      speed: {
        ...wasmArtifactContract.aedsRuntimeTiers.speed,
        moduleSha256: hashes[wasmArtifactContract.aedsRuntimeTiers.speed.module],
        wasmSha256: hashes[wasmArtifactContract.aedsRuntimeTiers.speed.wasm]
      }
    }
  })}\n`;
  await writeFile(path.join(artifactDir, 'aeds-runtime-manifest.json'), runtimeManifest);
  hashes['aeds-runtime-manifest.json'] = sha256(runtimeManifest);

  const manifest = [
    `schemaVersion\t${wasmArtifactContract.schemaVersion}`,
    `builtAtUtc\t${encode('2026-07-18T00:00:00.000Z')}`,
    `buildModes\t${wasmArtifactContract.buildModes.map(encode).join(',')}`,
    `buildScript\t${encode('wasm/build.sh')}`,
    `dependencyInstaller\t${encode('../../tools/frontend/install-wasm-codec-deps.sh')}`,
    `aedsAbi\t${encode(wasmArtifactContract.aedsAbi)}`,
    `toolchain\t${encode(JSON.stringify(toolchain))}`,
    `sourceHash\t${encode('b'.repeat(64))}`,
    ...wasmArtifactContract.requiredOutputFiles.map((outputFile) =>
      `outputFile\t${encode(outputFile)}\t${encode(hashes[outputFile])}`)
  ].join('\n') + '\n';
  await writeFile(path.join(artifactDir, 'wasm-manifest.aeds'), manifest);

  await rewriteChecksums(artifactDir);
  return artifactDir;
}

async function writeFreshSourcePackage() {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-issue-1165-fresh-'));
  for (const outputFile of wasmArtifactContract.requiredOutputFiles) {
    if (outputFile === 'aeds-runtime-manifest.json') continue;
    await writeFile(path.join(artifactDir, outputFile), `fresh-source-fixture:${outputFile}\n`);
  }

  const generated = spawnSync(process.execPath, [ensureWasmPath, 'write-manifest'], {
    cwd: frontendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_FRONTEND_WASM_ROOT: artifactDir,
      FSUSBLOG_WASM_TOOLCHAIN_EMSCRIPTEN: toolchain.emscriptenVersion,
      FSUSBLOG_WASM_TOOLCHAIN_BINARYEN: toolchain.binaryenVersion,
      FSUSBLOG_WASM_TOOLCHAIN_CMAKE: toolchain.cmakeVersion,
      FSUSBLOG_WASM_TOOLCHAIN_VCPKG: toolchain.vcpkgCommit,
      FSUSBLOG_WASM_TOOLCHAIN_EMSDK_IMAGE: toolchain.emsdkImage
    }
  });
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  await rewriteChecksums(artifactDir);
  return artifactDir;
}

async function rewriteChecksums(artifactDir) {
  const checksumFiles = [...wasmArtifactContract.requiredOutputFiles, 'wasm-manifest.aeds'].sort();
  const checksumLines = [];
  for (const checksumFile of checksumFiles) {
    const body = await readFile(path.join(artifactDir, checksumFile));
    checksumLines.push(`${sha256(body)}  ${checksumFile}`);
  }
  await writeFile(path.join(artifactDir, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
}

async function resealOuterOutputHash(artifactDir, outputFile) {
  const manifestPath = path.join(artifactDir, 'wasm-manifest.aeds');
  const manifest = await readFile(manifestPath, 'utf8');
  const encodedOutput = encode(outputFile);
  const outputHash = sha256(await readFile(path.join(artifactDir, outputFile)));
  const nextManifest = manifest.replace(
    new RegExp(`^outputFile\\t${encodedOutput}\\t[^\\r\\n]+$`, 'mu'),
    `outputFile\t${encodedOutput}\t${encode(outputHash)}`
  );
  assert.notEqual(nextManifest, manifest, `fixture manifest must contain ${outputFile}`);
  await writeFile(manifestPath, nextManifest);
  await rewriteChecksums(artifactDir);
}

async function tamperAndResealRuntimeManifest(artifactDir, mutate) {
  const runtimePath = path.join(artifactDir, 'aeds-runtime-manifest.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  mutate(runtime);
  await writeFile(runtimePath, `${JSON.stringify(runtime)}\n`);
  await resealOuterOutputHash(artifactDir, 'aeds-runtime-manifest.json');
}

test('Option B keeps the generated WASM release package outside Git', async () => {
  const result = await checkWasmArtifactOwnership({ repoRoot });
  assert.equal(result.ownership, 'generated-ci-output');
  assert.deepEqual(result.trackedPaths, []);
});

test('ensure-wasm exposes the current schema v3, ABI v4 and complete output contract', () => {
  assert.equal(wasmArtifactContract.schemaVersion, 3);
  assert.equal(wasmArtifactContract.aedsAbi, 'fsusblog.aeds.v4');
  assert.deepEqual(wasmArtifactContract.toolchain, wasmToolchainContract);
  assert.equal(wasmToolchainContract.emscriptenVersion, '4.0.13');
  assert.equal(wasmToolchainContract.binaryenVersion, '123');
  assert.equal(wasmToolchainContract.cmakeVersion, '4.3.3');
  assert.deepEqual(wasmArtifactContract.aedsRuntimeRoot, {
    schema: 'fsusblog.aeds-runtime.v1',
    maxFrameBytes: 8 * 1024 * 1024,
    workerModel: {
      instancesPerPage: 1,
      activeRequests: {
        source: 'runtime-logical-processors',
        minimum: 1,
        maximum: 8,
        logicalProcessorsPerRequest: 2
      }
    }
  });
  assert.deepEqual(wasmArtifactContract.aedsRuntimeTiers.speed, {
    module: 'aeds_decoder_speed.js',
    wasm: 'aeds_decoder_speed.wasm',
    wasmOptValidated: true,
    simd: true,
    lto: true,
    initialMemoryBytes: 64 * 1024 * 1024,
    maximumMemoryBytes: 64 * 1024 * 1024,
    memoryGrowth: 'disabled'
  });
  assert.ok(wasmArtifactContract.requiredOutputFiles.includes('aeds_decoder_basic.wasm'));
  assert.ok(wasmArtifactContract.requiredOutputFiles.includes('aeds_decoder_speed.wasm'));
  assert.ok(wasmArtifactContract.requiredOutputFiles.includes('aeds-runtime-manifest.json'));
  assert.ok(wasmArtifactContract.requiredOutputFiles.includes('comment-privacy-prover.zkey'));
  assert.equal(new Set(wasmArtifactContract.requiredOutputFiles).size,
    wasmArtifactContract.requiredOutputFiles.length);
});

test('generated package validator accepts an exact schema v3 package', async (t) => {
  const artifactDir = await writeValidPackage();
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const report = await validateGeneratedWasmPackage({ artifactDir });
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.aedsAbi, 'fsusblog.aeds.v4');
  assert.equal(report.outputCount, wasmArtifactContract.requiredOutputFiles.length);
});

test('fresh-source write-manifest output passes the release ownership gate end to end', async (t) => {
  const artifactDir = await writeFreshSourcePackage();
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const checked = spawnSync(process.execPath, [
    ownershipCheckerPath,
    '--require-generated',
    '--artifact-dir',
    artifactDir
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /schema=3 abi=fsusblog\.aeds\.v4 outputs=26/u);
});

test('generated package validator rejects stale schema and missing output files', async (t) => {
  const staleDir = await writeValidPackage();
  const missingDir = await writeValidPackage();
  t.after(() => Promise.all([
    rm(staleDir, { recursive: true, force: true }),
    rm(missingDir, { recursive: true, force: true })
  ]));

  const staleManifestPath = path.join(staleDir, 'wasm-manifest.aeds');
  const staleManifest = await readFile(staleManifestPath, 'utf8');
  await writeFile(staleManifestPath, staleManifest.replace(/^schemaVersion\t3$/mu, 'schemaVersion\t2'));
  await assert.rejects(
    validateGeneratedWasmPackage({ artifactDir: staleDir }),
    /schema mismatch \(2 != 3\)/u
  );

  await unlink(path.join(missingDir, 'aeds_decoder_speed.wasm'));
  await assert.rejects(
    validateGeneratedWasmPackage({ artifactDir: missingDir }),
    /package file set mismatch/u
  );
});

test('generated package validator rejects checksum tampering', async (t) => {
  const artifactDir = await writeValidPackage();
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const checksumPath = path.join(artifactDir, 'SHA256SUMS');
  const checksums = await readFile(checksumPath, 'utf8');
  await writeFile(checksumPath, checksums.replace(/^[0-9a-f]{64}/u, '0'.repeat(64)));
  await assert.rejects(
    validateGeneratedWasmPackage({ artifactDir }),
    /SHA256SUMS hash mismatch/u
  );
});

test('outer manifest and ensure-wasm status reject immutable-looking but wrong toolchain pins', async (t) => {
  const artifactDir = await writeValidPackage();
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const manifestPath = path.join(artifactDir, 'wasm-manifest.aeds');
  const manifest = await readFile(manifestPath, 'utf8');
  const wrongToolchain = { ...toolchain, emscriptenVersion: '4.0.12' };
  await writeFile(manifestPath, manifest.replace(
    `toolchain\t${encode(JSON.stringify(toolchain))}`,
    `toolchain\t${encode(JSON.stringify(wrongToolchain))}`
  ));

  await assert.rejects(
    validateGeneratedWasmPackage({ artifactDir }),
    /does not match the pinned release contract/u
  );
  assert.throws(
    () => validateGeneratedPackageFreshness({ repoRoot, artifactDir }),
    /toolchain identity does not match the pinned release contract/u
  );
});

test('validator rejects an outer/runtime toolchain mismatch even when package hashes are resealed', async (t) => {
  const artifactDir = await writeValidPackage();
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const runtimePath = path.join(artifactDir, 'aeds-runtime-manifest.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  runtime.toolchain = { ...runtime.toolchain, vcpkgCommit: 'c'.repeat(40) };
  await writeFile(runtimePath, `${JSON.stringify(runtime)}\n`);
  await resealOuterOutputHash(artifactDir, 'aeds-runtime-manifest.json');

  await assert.rejects(
    validateGeneratedWasmPackage({ artifactDir }),
    /runtime manifest toolchain does not match the outer pinned toolchain/u
  );
});

test('validators reject resealed runtime root and complete tier identity tampering', async (t) => {
  const cases = [
    {
      name: 'changed speed simd capability',
      mutate: (runtime) => { runtime.tiers.speed.simd = false; },
      expected: /speed tier identity is invalid/u
    },
    {
      name: 'changed basic initial memory',
      mutate: (runtime) => { runtime.tiers.basic.initialMemoryBytes += 1; },
      expected: /basic tier identity is invalid/u
    },
    {
      name: 'changed speed maximum memory',
      mutate: (runtime) => { runtime.tiers.speed.maximumMemoryBytes *= 2; },
      expected: /speed tier identity is invalid/u
    },
    {
      name: 'missing memory growth field',
      mutate: (runtime) => { delete runtime.tiers.basic.memoryGrowth; },
      expected: /basic tier identity is invalid/u
    },
    {
      name: 'changed root frame limit',
      mutate: (runtime) => { runtime.maxFrameBytes += 1; },
      expected: /maxFrameBytes does not match the release contract/u
    },
    {
      name: 'changed worker model',
      mutate: (runtime) => { runtime.workerModel.activeRequests.maximum += 1; },
      expected: /workerModel does not match the release contract/u
    },
    {
      name: 'extra root identity field',
      mutate: (runtime) => { runtime.uncontracted = true; },
      expected: /root identity is invalid/u
    },
    {
      name: 'extra tier identity field',
      mutate: (runtime) => { runtime.tiers.speed.uncontracted = true; },
      expected: /speed tier identity is invalid/u
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const artifactDir = await writeValidPackage();
      try {
        await tamperAndResealRuntimeManifest(artifactDir, fixture.mutate);
        await assert.rejects(
          validateGeneratedWasmPackage({ artifactDir }),
          fixture.expected
        );
        assert.throws(
          () => validateGeneratedPackageFreshness({ repoRoot, artifactDir }),
          fixture.expected
        );
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  }
});

test('validator rejects AEDS module tampering hidden behind resealed outer hashes', async (t) => {
  const artifactDir = await writeValidPackage();
  t.after(() => rm(artifactDir, { recursive: true, force: true }));

  const speedWasm = wasmArtifactContract.aedsRuntimeTiers.speed.wasm;
  await writeFile(path.join(artifactDir, speedWasm), 'tampered-speed-module\n');
  await resealOuterOutputHash(artifactDir, speedWasm);

  await assert.rejects(
    validateGeneratedWasmPackage({ artifactDir }),
    /runtime speed wasm hash mismatch/u
  );
});
