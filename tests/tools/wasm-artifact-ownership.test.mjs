import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {checkWasmArtifactOwnership, computeWasmProducerCompileCacheKey, validateProductionWasmStagingContract, validateGeneratedPackageFreshness, validateGeneratedWasmPackage, validateWasmProducerInputClosure} = await import(new URL('../../tools/check-wasm-artifact-ownership.mjs', import.meta.url));
const {resolveWasmRequiredOutputFiles, wasmArtifactContract, wasmToolchainContract} = await import(new URL('../../tools/frontend/ensure-wasm.mjs', import.meta.url));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontendRoot = path.join(repoRoot, 'src/frontend');
const ensureWasmPath = path.join(repoRoot, 'tools/frontend/ensure-wasm.mjs');
const ownershipCheckerPath = path.join(repoRoot, 'tools/check-wasm-artifact-ownership.mjs');
const toolchain = { ...wasmToolchainContract };

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function encode(value)
{
    return Buffer.from(String(value), 'utf8').toString('base64url');
}

async function writeValidPackage()
{
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-wasm-artifact-ownership-'));
    const hashes = {};
    for (const outputFile of wasmArtifactContract.requiredOutputFiles)
    {
        if (outputFile === 'aeds-runtime-manifest.json')
        {
            continue;
        }
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

async function writeFreshSourcePackage()
{
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-wasm-artifact-ownership-fresh-'));
    for (const outputFile of wasmArtifactContract.requiredOutputFiles)
    {
        if (outputFile === 'aeds-runtime-manifest.json')
        {
            continue;
        }
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

async function rewriteChecksums(artifactDir)
{
    const checksumFiles = [...wasmArtifactContract.requiredOutputFiles, 'wasm-manifest.aeds'];
    try
    {
        await access(path.join(artifactDir, 'wasm-build-receipt.json'));
        checksumFiles.push('wasm-build-receipt.json');
    }
    catch
    {
    // Legacy fixture packages intentionally exercise the underlying manifest validator.
    }
    checksumFiles.sort();
    const checksumLines = [];
    for (const checksumFile of checksumFiles)
    {
        const body = await readFile(path.join(artifactDir, checksumFile));
        checksumLines.push(`${sha256(body)}  ${checksumFile}`);
    }
    await writeFile(path.join(artifactDir, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
}

async function resealOuterOutputHash(artifactDir, outputFile)
{
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

async function tamperAndResealRuntimeManifest(artifactDir, mutate)
{
    const runtimePath = path.join(artifactDir, 'aeds-runtime-manifest.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    mutate(runtime);
    await writeFile(runtimePath, `${JSON.stringify(runtime)}\n`);
    await resealOuterOutputHash(artifactDir, 'aeds-runtime-manifest.json');
}

test('Option B keeps the generated WASM release package outside Git', async () =>
{
    const result = await checkWasmArtifactOwnership({ repoRoot });
    assert.equal(result.ownership, 'generated-ci-output');
    assert.deepEqual(result.trackedPaths, []);
});

test('production staging contract rejects source mutation, stale checksums and seal-before-write ordering', async (t) =>
{
    const productionBuilder = await readFile(
        path.join(repoRoot, 'tools/test/lanes/production-build-artifacts.sh'),
        'utf8'
    );
    const receiptTool = await readFile(path.join(repoRoot, 'tools/frontend/wasm-build-receipt.mjs'), 'utf8');
    assert.doesNotThrow(() => validateProductionWasmStagingContract({ productionBuilder, receiptTool }));

    const cases = [
        {
            name: 'adopt source',
            productionBuilder: productionBuilder.replace(
                'node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" stage-envelope',
                'AdoptDirectory "$WASM_SOURCE" "$PAYLOAD_ROOT/wasm"\n'
          + '    node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" stage-envelope'
            ),
            receiptTool,
            expected: /must not adopt or move/u
        },
        {
            name: 'outer seal before checksum staging',
            productionBuilder: productionBuilder.replace(
                'node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" stage-envelope',
                'node "$ROOT_DIR/tools/ci/production-build-artifacts-cli.mjs" "${CREATE_ARGS[@]}"\n'
          + '    node "$ROOT_DIR/tools/frontend/wasm-build-receipt.mjs" stage-envelope'
            ),
            receiptTool,
            expected: /before the outer immutable artifact seal/u
        },
        {
            name: 'copy stale checksum',
            productionBuilder,
            receiptTool: receiptTool.replace(
                "if (entry.name === 'SHA256SUMS')",
                "if (entry.name === 'not-SHA256SUMS')"
            ),
            expected: /missing required ownership step/u
        },
        {
            name: 'chmod unseal',
            productionBuilder,
            receiptTool: receiptTool.replace(
                'const sourceIdentity = artifactDirectoryIdentity(sourceArtifactDir);',
                'const sourceIdentity = artifactDirectoryIdentity(sourceArtifactDir);\n'
          + '    fs.chmodSync(path.join(sourceArtifactDir, "SHA256SUMS"), 0o644);'
            ),
            expected: /must not chmod/u
        },
        {
            name: 'move source',
            productionBuilder,
            receiptTool: receiptTool.replace(
                'const sourceIdentity = artifactDirectoryIdentity(sourceArtifactDir);',
                'const sourceIdentity = artifactDirectoryIdentity(sourceArtifactDir);\n'
          + '    fs.renameSync(sourceArtifactDir, destinationArtifactDir);'
            ),
            expected: /without moving/u
        }
    ];
    for (const entry of cases)
    {
        await t.test(entry.name, () =>
        {
            assert.throws(
                () => validateProductionWasmStagingContract(entry),
                entry.expected
            );
        });
    }
});

test('ensure-wasm exposes the current schema v3, ABI v4 and complete output contract', () =>
{
    assert.equal(wasmArtifactContract.schemaVersion, 3);
    assert.equal(wasmArtifactContract.aedsAbi, 'fsusblog.aeds.v4');
    assert.deepEqual(wasmArtifactContract.toolchain, wasmToolchainContract);
    assert.equal(wasmToolchainContract.emscriptenVersion, '6.0.0');
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
    assert.equal(wasmArtifactContract.requiredOutputFiles.includes('comment-privacy-prover.zkey'), false);
    assert.ok(resolveWasmRequiredOutputFiles({ FSUSBLOG_ZK_PRODUCTION_ENABLED: '1' })
        .includes('comment-privacy-prover.zkey'));
    assert.equal(new Set(wasmArtifactContract.requiredOutputFiles).size,
        wasmArtifactContract.requiredOutputFiles.length);
});

test('generated package validator accepts an exact schema v3 package', async (t) =>
{
    const artifactDir = await writeValidPackage();
    t.after(() => rm(artifactDir, { recursive: true, force: true }));

    const report = await validateGeneratedWasmPackage({ artifactDir });
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.aedsAbi, 'fsusblog.aeds.v4');
    assert.equal(report.outputCount, wasmArtifactContract.requiredOutputFiles.length);
});

test('fresh-source write-manifest output passes the release ownership gate end to end', async (t) =>
{
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
    assert.match(checked.stdout,
        new RegExp(`schema=3 abi=fsusblog\\.aeds\\.v4 outputs=${wasmArtifactContract.requiredOutputFiles.length}`, 'u'));
});

test('generated package validator rejects stale schema and missing output files', async (t) =>
{
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

test('generated package validator rejects checksum tampering', async (t) =>
{
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

test('outer manifest and ensure-wasm status reject immutable-looking but wrong toolchain pins', async (t) =>
{
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

test('validator rejects an outer/runtime toolchain mismatch even when package hashes are resealed', async (t) =>
{
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

test('validators reject resealed runtime root and complete tier identity tampering', async (t) =>
{
    const cases = [
        {
            name: 'changed speed simd capability',
            mutate: (runtime) =>
            {
                runtime.tiers.speed.simd = false;
            },
            expected: /speed tier identity is invalid/u
        },
        {
            name: 'changed basic initial memory',
            mutate: (runtime) =>
            {
                runtime.tiers.basic.initialMemoryBytes += 1;
            },
            expected: /basic tier identity is invalid/u
        },
        {
            name: 'changed speed maximum memory',
            mutate: (runtime) =>
            {
                runtime.tiers.speed.maximumMemoryBytes *= 2;
            },
            expected: /speed tier identity is invalid/u
        },
        {
            name: 'missing memory growth field',
            mutate: (runtime) =>
            {
                delete runtime.tiers.basic.memoryGrowth;
            },
            expected: /basic tier identity is invalid/u
        },
        {
            name: 'changed root frame limit',
            mutate: (runtime) =>
            {
                runtime.maxFrameBytes += 1;
            },
            expected: /maxFrameBytes does not match the release contract/u
        },
        {
            name: 'changed worker model',
            mutate: (runtime) =>
            {
                runtime.workerModel.activeRequests.maximum += 1;
            },
            expected: /workerModel does not match the release contract/u
        },
        {
            name: 'extra root identity field',
            mutate: (runtime) =>
            {
                runtime.uncontracted = true;
            },
            expected: /root identity is invalid/u
        },
        {
            name: 'extra tier identity field',
            mutate: (runtime) =>
            {
                runtime.tiers.speed.uncontracted = true;
            },
            expected: /speed tier identity is invalid/u
        }
    ];

    for (const fixture of cases)
    {
        await t.test(fixture.name, async () =>
        {
            const artifactDir = await writeValidPackage();
            try
            {
                await tamperAndResealRuntimeManifest(artifactDir, fixture.mutate);
                await assert.rejects(
                    validateGeneratedWasmPackage({ artifactDir }),
                    fixture.expected
                );
                assert.throws(
                    () => validateGeneratedPackageFreshness({ repoRoot, artifactDir }),
                    fixture.expected
                );
            }
            finally
            {
                await rm(artifactDir, { recursive: true, force: true });
            }
        });
    }
});

test('validator rejects AEDS module tampering hidden behind resealed outer hashes', async (t) =>
{
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

test('canonical WASM Docker producer aligns all BuildKit cache mounts with actual build paths and single cache roots', async () =>
{
    const dockerfile = await readFile(path.join(repoRoot, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    const wasmBuilderStart = dockerfile.indexOf('FROM fsusui-build-tools AS wasm-builder');
    const wasmBuilderEnd = dockerfile.indexOf('FROM scratch AS wasm-artifact');
    assert.ok(wasmBuilderStart >= 0 && wasmBuilderEnd > wasmBuilderStart, 'wasm-builder stage must exist in Dockerfile');
    const wasmBuilderStage = dockerfile.slice(wasmBuilderStart, wasmBuilderEnd);

    const expectedCacheRoots = {
        FSUSBLOG_DEPENDENCY_CACHE_ROOT: '/.tmp/dependency-cache',
        FSUSBLOG_EM_CACHE: '/.cache/emscripten',
        EM_CACHE: '/.cache/emscripten',
        VCPKG_DOWNLOADS: '/.cache/vcpkg/downloads',
        VCPKG_DEFAULT_BINARY_CACHE: '/.cache/vcpkg/archives'
    };

    for (const [envVar, expectedPath] of Object.entries(expectedCacheRoots))
    {
        const pattern = new RegExp(`${envVar}=${expectedPath.replaceAll('/', '\\/')}(?:\\s|\\\\|$)`, 'u');
        assert.match(wasmBuilderStage, pattern, `wasm-builder stage must declare ${envVar}=${expectedPath}`);
    }

    const cacheIdentitySource = [
        `emsdk=${wasmToolchainContract.emsdkImage}`,
        `cmake=${wasmToolchainContract.cmakeVersion}`,
        `binaryen=version_${wasmToolchainContract.binaryenVersion}`,
        'triplet=wasm32-emscripten',
        'features=image-codec:on,libwebp,libavif'
    ].join(';');
    const expectedCacheIdentity = sha256(cacheIdentitySource);
    assert.match(
        wasmBuilderStage,
        new RegExp(`ARG FSUSBLOG_WASM_CACHE_IDENTITY=${expectedCacheIdentity}(?:\\s|$)`, 'u'),
        'the BuildKit cache identity must be derived from the pinned toolchain, triplet, and dependency features'
    );

    const expectedTargets = new Map([
        ['wasm-dependency', '/.tmp/dependency-cache'],
        ['emscripten', '/.cache/emscripten'],
        ['vcpkg-downloads', '/.cache/vcpkg/downloads'],
        ['vcpkg-archives', '/.cache/vcpkg/archives']
    ]);

    for (const [cacheOwner, target] of expectedTargets)
    {
        const expectedMount = `--mount=type=cache,id=fsusblog-${cacheOwner}-\${FSUSBLOG_WASM_CACHE_IDENTITY}-\${VCPKG_COMMIT},target=${target},sharing=locked`;
        assert.ok(
            wasmBuilderStage.includes(expectedMount),
            `wasm-builder stage must bind ${cacheOwner} to the pinned cache identity and exact target ${target}`
        );
    }

    assert.doesNotMatch(wasmBuilderStage, /target=\/work\/\.tmp/u, 'must not use misaligned /work/.tmp mount target');
    assert.doesNotMatch(wasmBuilderStage, /target=\/work\/\.cache/u, 'must not use misaligned /work/.cache mount target');

    const buildScript = await readFile(path.join(repoRoot, 'src/frontend/wasm/build.sh'), 'utf8');
    assert.match(buildScript, /FSUSBLOG_EM_CACHE/u, 'wasm build.sh must support FSUSBLOG_EM_CACHE');
    assert.match(buildScript, /EM_CACHE/u, 'wasm build.sh must support EM_CACHE');

    const ensureBinaryenScript = await readFile(path.join(repoRoot, 'tools/frontend/ensure-binaryen.sh'), 'utf8');
    assert.match(ensureBinaryenScript, /FSUSBLOG_DEPENDENCY_CACHE_ROOT/u, 'ensure-binaryen.sh must support FSUSBLOG_DEPENDENCY_CACHE_ROOT');

    const ensureCmakeScript = await readFile(path.join(repoRoot, 'tools/frontend/ensure-cmake.sh'), 'utf8');
    assert.match(ensureCmakeScript, /FSUSBLOG_DEPENDENCY_CACHE_ROOT/u, 'ensure-cmake.sh must support FSUSBLOG_DEPENDENCY_CACHE_ROOT');
});

test('canonical WASM Docker producer COPY closure is bidirectionally exact', () =>
{
    const result = validateWasmProducerInputClosure({ repoRoot });
    assert.equal(result.inputCount, result.copyCount);
    assert.ok(result.fileCount > result.inputCount);
});

test('WASM producer cache key ignores non-WASM frontend and documentation edits', () =>
{
    const baseline = computeWasmProducerCompileCacheKey({ repoRoot });
    for (const relativePath of [
        'src/frontend/src/components/ArticleCard.vue',
        'src/frontend/src/styles/article.css',
        'tests/frontend/unit/articleAdapter.test.ts',
        'docs/frontend/unrelated.md'
    ])
    {
        const changed = computeWasmProducerCompileCacheKey({
            repoRoot,
            sourceOverrides: new Map([[relativePath, 'unrelated edit\n']])
        });
        assert.equal(changed.cacheKey, baseline.cacheKey, relativePath);
        assert.equal(changed.inputTreeDigest, baseline.inputTreeDigest, relativePath);
    }
});

test('WASM source, helper, overlay and security inputs change cache and receipt input identity', async () =>
{
    const baseline = computeWasmProducerCompileCacheKey({ repoRoot });
    for (const relativePath of [
        'src/frontend/wasm/aeds/src/aeds_decode.cpp',
        'tools/frontend/ensure-binaryen.sh',
        'tools/vcpkg-overlays/libyuv/portfile.cmake',
        'security/zk/contracts/comment-v5-circuit.manifest.json',
        'config/zk/anonymous-comment-v5-verifying-key.manifest.json'
    ])
    {
        const current = await readFile(path.join(repoRoot, relativePath));
        const changed = computeWasmProducerCompileCacheKey({
            repoRoot,
            sourceOverrides: new Map([[relativePath, Buffer.concat([current, Buffer.from('\n')])]])
        });
        assert.notEqual(changed.cacheKey, baseline.cacheKey, relativePath);
        assert.notEqual(changed.inputTreeDigest, baseline.inputTreeDigest, relativePath);
    }

    for (const [name, value] of [
        ['VCPKG_COMMIT', '1'.repeat(40)],
        ['FSUSBLOG_WASM_CACHE_IDENTITY', '2'.repeat(64)],
        ['FSUSBLOG_WASM_IMAGE_CODEC_ENABLE', 'OFF']
    ])
    {
        const changed = computeWasmProducerCompileCacheKey({
            repoRoot,
            buildArguments: { [name]: value }
        });
        assert.notEqual(changed.cacheKey, baseline.cacheKey, name);
    }
});

test('WASM producer closure fails closed for missing or newly read unregistered inputs', async () =>
{
    assert.throws(
        () => validateWasmProducerInputClosure({
            repoRoot,
            sourceOverrides: new Map([['tools/frontend/ensure-binaryen.sh', null]])
        }),
        /input is missing/u
    );

    const buildScriptPath = 'src/frontend/wasm/build.sh';
    const buildScript = await readFile(path.join(repoRoot, buildScriptPath), 'utf8');
    assert.throws(
        () => validateWasmProducerInputClosure({
            repoRoot,
            sourceOverrides: new Map([[
                buildScriptPath,
                `${buildScript}\nnode "\${REPOSITORY_ROOT}/tools/frontend/bench-pow-wasm.mjs"\n`
            ]])
        }),
        /reads unregistered repository inputs: tools\/frontend\/bench-pow-wasm\.mjs/u
    );
});

test('WASM producer closure rejects unregistered Docker reads and broad inventory directories', async () =>
{
    const dockerfilePath = 'ops/docker/FsusBlog.Server.Dockerfile';
    const dockerfile = await readFile(path.join(repoRoot, dockerfilePath), 'utf8');
    assert.throws(
        () => validateWasmProducerInputClosure({
            repoRoot,
            sourceOverrides: new Map([[
                dockerfilePath,
                dockerfile.replace(
                    'COPY src/frontend/wasm/ /work/src/frontend/wasm/',
                    'COPY src/frontend/package.json /work/src/frontend/package.json\n'
                      + 'COPY src/frontend/wasm/ /work/src/frontend/wasm/'
                )
            ]])
        }),
        /unregistered=src\/frontend\/package\.json/u
    );

    const inventoryPath = 'ops/docker/wasm-producer-inputs.json';
    const inventory = JSON.parse(await readFile(path.join(repoRoot, inventoryPath), 'utf8'));
    inventory.inputs.push({
        path: 'src/frontend/',
        destination: '/work/src/frontend/',
        kind: 'tree',
        phase: 'compile'
    });
    assert.throws(
        () => validateWasmProducerInputClosure({
            repoRoot,
            sourceOverrides: new Map([[inventoryPath, `${JSON.stringify(inventory)}\n`]])
        }),
        /unverified broad directory/u
    );
});
