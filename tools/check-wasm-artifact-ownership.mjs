#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    matchesWasmToolchainContract,
    parseWasmManifest,
    validateAedsRuntimeManifestIdentity,
    wasmArtifactContract
} from './frontend/ensure-wasm.mjs';
import {
    validateWasmBuildReceipt,
    wasmBuildReceiptName
} from './frontend/wasm-build-receipt.mjs';

export const generatedArtifactRelativePath = 'build/artifacts/wasm-release';
const manifestName = 'wasm-manifest.aeds';
const runtimeManifestName = 'aeds-runtime-manifest.json';
const checksumName = 'SHA256SUMS';
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message)
{
    throw new Error(message);
}

function run(command, args, cwd)
{
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env: process.env
    });
    if (result.error)
    {
        fail(`${command} failed to start: ${result.error.message}`);
    }
    return result;
}

function nonEmptyLines(raw)
{
    return String(raw ?? '')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
}

function requireOrderedSubset(source, needles, label)
{
    let offset = -1;
    for (const needle of needles)
    {
        const next = source.indexOf(needle, offset + 1);
        if (next < 0)
        {
            fail(`${label} is missing required ownership step: ${needle}`);
        }
        offset = next;
    }
}

export function validateProductionWasmStagingContract({ productionBuilder, receiptTool })
{
    const stageCommand = 'tools/frontend/wasm-build-receipt.mjs" stage-envelope';
    const outerSealCommand = 'tools/ci/production-build-artifacts-cli.mjs" "${CREATE_ARGS[@]}"';
    const stageCommandIndex = productionBuilder.indexOf(stageCommand);
    const outerSealCommandIndex = productionBuilder.indexOf(outerSealCommand);
    requireOrderedSubset(productionBuilder, [
        'npm --prefix "$ROOT_DIR/src/frontend" run ensure:wasm',
        stageCommand,
        '--artifact-dir "$WASM_SOURCE"',
        '--destination-artifact-dir "$PAYLOAD_ROOT/wasm"',
        outerSealCommand
    ], 'tools/test/lanes/production-build-artifacts.sh');
    if (stageCommandIndex < 0 || outerSealCommandIndex < 0 || stageCommandIndex >= outerSealCommandIndex)
    {
        fail('production WASM checksum staging must complete before the outer immutable artifact seal');
    }
    if (/AdoptDirectory\s+"\$WASM_SOURCE"|\bmv\s+--?\s+"\$WASM_SOURCE"/u.test(productionBuilder))
    {
        fail('production WASM staging must not adopt or move the immutable source artifact');
    }

    const stageStart = receiptTool.indexOf('export function stageWasmReceiptEnvelope({');
    const stageEnd = receiptTool.indexOf('\nfunction parseCli', stageStart);
    if (stageStart < 0 || stageEnd < 0)
    {
        fail('tools/frontend/wasm-build-receipt.mjs is missing the bounded stageWasmReceiptEnvelope implementation');
    }
    const stageSource = receiptTool.slice(stageStart, stageEnd);
    requireOrderedSubset(stageSource, [
        'validateWasmBuildReceipt({',
        'const sourceIdentity = artifactDirectoryIdentity(sourceArtifactDir);',
        "if (entry.name === 'SHA256SUMS')",
        'continue;',
        'fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);',
        'writeWasmReceiptChecksums({',
        'validateWasmBuildReceipt({',
        'artifactDirectoryIdentity(sourceArtifactDir)'
    ], 'stageWasmReceiptEnvelope');
    if (stageSource.includes('fs.chmodSync('))
    {
        fail('stageWasmReceiptEnvelope must not chmod an immutable source or copied checksum');
    }
    if (stageSource.includes('fs.renameSync(') || stageSource.includes('fs.cpSync(sourceArtifactDir'))
    {
        fail('stageWasmReceiptEnvelope must copy declared files without moving or recursively copying the source artifact');
    }
}

export async function checkWasmArtifactOwnership({ repoRoot = defaultRepoRoot } = {})
{
    const tracked = run('git', ['ls-files', '--', generatedArtifactRelativePath], repoRoot);
    if (tracked.status !== 0)
    {
        fail(`unable to inspect tracked WASM artifacts: ${tracked.stderr.trim() || `git exit ${tracked.status}`}`);
    }
    const trackedPaths = nonEmptyLines(tracked.stdout);
    if (trackedPaths.length > 0)
    {
        fail(`generated WASM artifact package must not be tracked: ${trackedPaths.join(', ')}`);
    }

    const ignoredProbe = `${generatedArtifactRelativePath}/${manifestName}`;
    const ignored = run('git', ['check-ignore', '--no-index', '--quiet', '--', ignoredProbe], repoRoot);
    if (ignored.status !== 0)
    {
        fail(`${ignoredProbe} must remain ignored by Git`);
    }

    const dockerIgnore = await readFile(path.join(repoRoot, '.dockerignore'), 'utf8');
    const dockerRules = new Set(nonEmptyLines(dockerIgnore).filter((line) => !line.startsWith('#')));
    for (const rule of [
        '!build/artifacts/',
        '!build/artifacts/wasm-release/',
        '!build/artifacts/wasm-release/**'
    ])
    {
        if (!dockerRules.has(rule))
        {
            fail(`.dockerignore must expose the generated package to the final image context via ${rule}`);
        }
    }

    const artifactBuilder = await readFile(path.join(repoRoot, 'tools/build-wasm-artifact.sh'), 'utf8');
    requireOrderedSubset(artifactBuilder, [
        'tools/check-wasm-artifact-ownership.mjs',
        'docker build',
        '--target wasm-artifact',
        'tools/frontend/wasm-build-receipt.mjs" create',
        'tools/frontend/wasm-build-receipt.mjs" write-checksums',
        'tools/frontend/wasm-build-receipt.mjs" verify'
    ], 'tools/build-wasm-artifact.sh');

    const finalImageBuilder = await readFile(path.join(repoRoot, 'tools/build-final-image.sh'), 'utf8');
    for (const resumeNeedle of [
        'tools/check-wasm-artifact-ownership.mjs',
        'tools/frontend/wasm-build-receipt.mjs',
        'verify',
        '--artifact-dir "$ROOT_DIR/build/artifacts/wasm-release"'
    ])
    {
        if (!finalImageBuilder.includes(resumeNeedle))
        {
            fail(`tools/build-final-image.sh resume path is missing: ${resumeNeedle}`);
        }
    }
    requireOrderedSubset(finalImageBuilder, [
        '"$ROOT_DIR/tools/build-wasm-artifact.sh"',
        'docker build'
    ], 'tools/build-final-image.sh');

    const productionBuilder = await readFile(path.join(repoRoot, 'tools/test/lanes/production-build-artifacts.sh'), 'utf8');
    requireOrderedSubset(productionBuilder, [
        'tests/tools/wasm-artifact-ownership.test.mjs',
        'tools/check-wasm-artifact-ownership.mjs'
    ], 'tools/test/lanes/production-build-artifacts.sh');
    const receiptTool = await readFile(path.join(repoRoot, 'tools/frontend/wasm-build-receipt.mjs'), 'utf8');
    validateProductionWasmStagingContract({ productionBuilder, receiptTool });

    const dockerfile = await readFile(path.join(repoRoot, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8');
    requireOrderedSubset(dockerfile, [
        'COPY build/artifacts/wasm-release/ ./public/wasm/',
        'sha256sum -c SHA256SUMS',
        'wasm-build-receipt.mjs verify-envelope'
    ], 'ops/docker/FsusBlog.Server.Dockerfile');

    return {
        ownership: 'generated-ci-output',
        trackedPaths,
        artifactRelativePath: generatedArtifactRelativePath
    };
}

async function sha256(file)
{
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

function sameSortedValues(actual, expected)
{
    const left = [...actual].sort();
    const right = [...expected].sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseChecksums(raw)
{
    const checksums = new Map();
    for (const line of nonEmptyLines(raw))
    {
        const match = /^([0-9a-f]{64}) [ *]([^/][^\r\n]*)$/u.exec(line);
        if (!match || match[2].includes('..') || path.basename(match[2]) !== match[2])
        {
            fail(`invalid SHA256SUMS entry: ${line}`);
        }
        if (checksums.has(match[2]))
        {
            fail(`duplicate SHA256SUMS entry: ${match[2]}`);
        }
        checksums.set(match[2], match[1]);
    }
    return checksums;
}

export async function validateGeneratedWasmPackage({
    artifactDir,
    contract = wasmArtifactContract,
    repoRoot = defaultRepoRoot,
    requireReceipt = false
})
{
    const entries = await readdir(artifactDir, { withFileTypes: true });
    const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
    if (nonFiles.length > 0)
    {
        fail(`generated WASM package contains non-file entries: ${nonFiles.join(', ')}`);
    }

    const hasReceipt = entries.some((entry) => entry.name === wasmBuildReceiptName);
    if (requireReceipt && !hasReceipt)
    {
        fail('generated WASM package is missing the canonical build receipt');
    }
    const expectedFiles = [
        ...contract.requiredOutputFiles,
        manifestName,
        ...(hasReceipt ? [wasmBuildReceiptName] : []),
        checksumName
    ];
    const actualFiles = entries.map((entry) => entry.name);
    if (!sameSortedValues(actualFiles, expectedFiles))
    {
        fail(`generated WASM package file set mismatch; expected=${[...expectedFiles].sort().join(',')} actual=${[...actualFiles].sort().join(',')}`);
    }

    const manifest = parseWasmManifest(await readFile(path.join(artifactDir, manifestName), 'utf8'));
    if (manifest.schemaVersion !== contract.schemaVersion)
    {
        fail(`generated manifest schema mismatch (${manifest.schemaVersion} != ${contract.schemaVersion})`);
    }
    if (manifest.aedsAbi !== contract.aedsAbi)
    {
        fail(`generated manifest AEDS ABI mismatch (${manifest.aedsAbi || 'missing'} != ${contract.aedsAbi})`);
    }
    if (!matchesWasmToolchainContract(manifest.toolchain))
    {
        fail('generated manifest toolchain identity does not match the pinned release contract');
    }
    if (!sameSortedValues(manifest.outputFiles, contract.requiredOutputFiles))
    {
        fail('generated manifest outputFiles do not match the ensure-wasm contract');
    }
    if (!sameSortedValues(Object.keys(manifest.outputFileHashes ?? {}), contract.requiredOutputFiles))
    {
        fail('generated manifest outputFileHashes do not match the ensure-wasm contract');
    }

    for (const outputFile of contract.requiredOutputFiles)
    {
        const actualHash = await sha256(path.join(artifactDir, outputFile));
        if (manifest.outputFileHashes[outputFile] !== actualHash)
        {
            fail(`generated manifest output hash mismatch: ${outputFile}`);
        }
    }

    const runtimeManifest = JSON.parse(await readFile(path.join(artifactDir, runtimeManifestName), 'utf8'));
    const runtimeIdentityError = validateAedsRuntimeManifestIdentity(runtimeManifest, manifest.toolchain);
    if (runtimeIdentityError)
    {
        fail(`generated ${runtimeIdentityError}`);
    }
    for (const [tierName, expectedTier] of Object.entries(contract.aedsRuntimeTiers))
    {
        const actualTier = runtimeManifest.tiers?.[tierName];
        const [moduleHash, wasmHash] = await Promise.all([
            sha256(path.join(artifactDir, expectedTier.module)),
            sha256(path.join(artifactDir, expectedTier.wasm))
        ]);
        if (actualTier.moduleSha256 !== moduleHash)
        {
            fail(`generated AEDS runtime ${tierName} module hash mismatch`);
        }
        if (actualTier.wasmSha256 !== wasmHash)
        {
            fail(`generated AEDS runtime ${tierName} wasm hash mismatch`);
        }
    }

    const expectedChecksumFiles = [
        ...contract.requiredOutputFiles,
        manifestName,
        ...(hasReceipt ? [wasmBuildReceiptName] : [])
    ];
    const checksums = parseChecksums(await readFile(path.join(artifactDir, checksumName), 'utf8'));
    if (!sameSortedValues(checksums.keys(), expectedChecksumFiles))
    {
        fail('SHA256SUMS coverage does not match the generated WASM package');
    }
    for (const checksumFile of expectedChecksumFiles)
    {
        const actualHash = await sha256(path.join(artifactDir, checksumFile));
        if (checksums.get(checksumFile) !== actualHash)
        {
            fail(`SHA256SUMS hash mismatch: ${checksumFile}`);
        }
    }

    if (hasReceipt)
    {
        validateWasmBuildReceipt({
            repositoryRoot: repoRoot,
            clientRoot: path.join(repoRoot, 'src/frontend'),
            artifactDir,
            manifest,
            contract
        });
    }

    return {
        schemaVersion: manifest.schemaVersion,
        aedsAbi: manifest.aedsAbi,
        outputCount: contract.requiredOutputFiles.length,
        manifest
    };
}

export function validateGeneratedPackageFreshness({ repoRoot = defaultRepoRoot, artifactDir })
{
    const ensureWasm = path.join(repoRoot, 'tools/frontend/ensure-wasm.mjs');
    const result = spawnSync(process.execPath, [ensureWasm, 'full-status'], {
        cwd: path.join(repoRoot, 'src/frontend'),
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_FRONTEND_WASM_ROOT: artifactDir
        }
    });
    if (result.error)
    {
        fail(`ensure-wasm status failed to start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        fail(`generated WASM package is stale against ensure-wasm: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trim();
}

function parseArgs(args)
{
    const options = {
        repoRoot: defaultRepoRoot,
        artifactDir: null,
        requireGenerated: false
    };
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === '--require-generated')
        {
            options.requireGenerated = true;
            continue;
        }
        if (arg === '--repo-root' || arg === '--artifact-dir')
        {
            const value = args[index + 1];
            if (!value)
            {
                fail(`${arg} requires a value`);
            }
            index += 1;
            options[arg === '--repo-root' ? 'repoRoot' : 'artifactDir'] = path.resolve(value);
            continue;
        }
        fail(`unknown argument: ${arg}`);
    }
    options.artifactDir ??= path.join(options.repoRoot, generatedArtifactRelativePath);
    return options;
}

async function main()
{
    const options = parseArgs(process.argv.slice(2));
    const ownership = await checkWasmArtifactOwnership({ repoRoot: options.repoRoot });
    let generated = null;
    if (options.requireGenerated)
    {
        generated = await validateGeneratedWasmPackage({
            artifactDir: options.artifactDir,
            repoRoot: options.repoRoot,
            requireReceipt: true
        });
    }
    console.log(
        `[wasm-artifact-ownership] ok ownership=${ownership.ownership} tracked=${ownership.trackedPaths.length}`
      + (generated ? ` schema=${generated.schemaVersion} abi=${generated.aedsAbi} outputs=${generated.outputCount}` : '')
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(`[wasm-artifact-ownership] fatal: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
