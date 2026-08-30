#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
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
import {
    computeWasmProducerInputDescriptor,
    loadWasmProducerInputInventory,
    resolveWasmProducerInputFiles,
    wasmProducerInputInventoryPath
} from './frontend/wasm-producer-inputs.mjs';

export const generatedArtifactRelativePath = 'build/artifacts/wasm-release';
const manifestName = 'wasm-manifest.aeds';
const runtimeManifestName = 'aeds-runtime-manifest.json';
const checksumName = 'SHA256SUMS';
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmDockerfilePath = 'ops/docker/FsusBlog.Server.Dockerfile';

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

function readSource(root, relativePath, sourceOverrides)
{
    if (sourceOverrides.has(relativePath))
    {
        const value = sourceOverrides.get(relativePath);
        if (value === null)
        {
            fail(`WASM producer input is missing: ${relativePath}`);
        }
        return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    }
    return fs.readFileSync(path.join(root, relativePath));
}

function wasmBuilderStage(dockerfile)
{
    const start = dockerfile.indexOf('FROM fsusui-build-tools AS wasm-builder');
    const end = dockerfile.indexOf('FROM scratch AS wasm-artifact');
    if (start < 0 || end <= start)
    {
        fail('canonical WASM Dockerfile must contain exactly one bounded wasm-builder stage');
    }
    if (dockerfile.indexOf('FROM fsusui-build-tools AS wasm-builder', start + 1) >= 0)
    {
        fail('canonical WASM Dockerfile contains duplicate wasm-builder stages');
    }
    return dockerfile.slice(start, end);
}

function parseWasmBuilderCopies(stage)
{
    const copies = [];
    for (const rawLine of stage.split(/\r?\n/u))
    {
        const line = rawLine.trim();
        if (!line.startsWith('COPY ') || line.startsWith('COPY --from='))
        {
            continue;
        }
        const match = /^COPY (?<source>\S+) (?<destination>\S+)$/u.exec(line);
        if (!match)
        {
            fail(`wasm-builder COPY must use one explicit source and destination: ${line}`);
        }
        copies.push({ source: match.groups.source, destination: match.groups.destination });
    }
    return copies;
}

function inventoryKey(value)
{
    return `${value.source ?? value.path}\0${value.destination}`;
}

function coversInventoryPath(inputs, relativePath)
{
    return inputs.some((input) => input.kind === 'file'
        ? input.path === relativePath
        : relativePath.startsWith(input.path));
}

function discoverProducerScriptReads(root, inputs, sourceOverrides)
{
    const discovered = new Set();
    const visited = new Set();
    const visitModule = (relativePath) =>
    {
        if (visited.has(relativePath))
        {
            return;
        }
        visited.add(relativePath);
        discovered.add(relativePath);
        const source = readSource(root, relativePath, sourceOverrides).toString('utf8');
        const references = [
            ...source.matchAll(/(?:from\s+|import\s*)['"](?<path>\.{1,2}\/[^'"]+)['"]/gu),
            ...source.matchAll(/new URL\(['"](?<path>\.{1,2}\/[^'"]+)['"],\s*import\.meta\.url\)/gu)
        ];
        for (const reference of references)
        {
            const resolved = path.normalize(path.join(path.dirname(relativePath), reference.groups.path))
                .replaceAll(path.sep, '/');
            if (resolved.endsWith('.mjs') && coversInventoryPath(inputs, resolved))
            {
                visitModule(resolved);
            }
            else if (coversInventoryPath(inputs, resolved))
            {
                discovered.add(resolved);
            }
        }
    };
    visitModule('tools/frontend/ensure-wasm.mjs');
    visitModule('tools/frontend/wasm-producer-inputs.mjs');
    visitModule('tools/frontend/write-comment-privacy-prover-manifest.mjs');

    const buildScript = readSource(root, 'src/frontend/wasm/build.sh', sourceOverrides).toString('utf8');
    const repositoryReferences = buildScript.matchAll(
        /\$\{(?:REPOSITORY_ROOT|ROOT_DIR)\}\/(?:\.\.\/\.\.\/)?(?<path>tools\/(?:frontend|security)\/[A-Za-z0-9._-]+)/gu
    );
    for (const reference of repositoryReferences)
    {
        discovered.add(reference.groups.path);
    }
    const securityContract = readSource(
        root,
        'tools/security/comment-privacy-build-contract.mjs',
        sourceOverrides
    ).toString('utf8');
    for (const match of securityContract.matchAll(
        /['"](?<path>(?:security\/zk|config\/zk)\/[A-Za-z0-9._/-]+\.json)['"]/gu
    ))
    {
        discovered.add(match.groups.path);
    }
    discovered.add(wasmProducerInputInventoryPath);
    discovered.add('tools/frontend/install-wasm-codec-deps.sh');
    discovered.add('tools/frontend/ensure-cmake.sh');
    return discovered;
}

function assertExactKeys(value, expected, label)
{
    const actual = Object.keys(value ?? {}).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    {
        fail(`${label} keys must be exact; expected=${wanted.join(',')} actual=${actual.join(',')}`);
    }
}

export function validateWasmProducerInputClosure({
    repoRoot = defaultRepoRoot,
    sourceOverrides = new Map()
} = {})
{
    const root = path.resolve(repoRoot);
    const inventory = loadWasmProducerInputInventory({ repositoryRoot: root, sourceOverrides });
    assertExactKeys(inventory, [
        'schema',
        'producerStage',
        'compileCommand',
        'buildArguments',
        'inputs',
        'productionZkConditionalInputs'
    ], 'WASM producer inventory');
    if (inventory.schema !== 'fsusblog.wasm-producer-inputs.v1'
        || inventory.producerStage !== 'wasm-builder'
        || inventory.compileCommand !== 'bash ./wasm/build.sh')
    {
        fail('WASM producer inventory identity does not match the canonical producer');
    }
    if (!Array.isArray(inventory.inputs) || inventory.inputs.length === 0)
    {
        fail('WASM producer inventory inputs must be a non-empty array');
    }
    if (!Array.isArray(inventory.productionZkConditionalInputs))
    {
        fail('WASM producer production-ZK conditional inputs must be an array');
    }
    assertExactKeys(inventory.buildArguments, [
        'FSUSBLOG_WASM_CACHE_IDENTITY',
        'FSUSBLOG_WASM_IMAGE_CODEC_ENABLE',
        'FSUSBLOG_ZK_PRODUCTION_ENABLED',
        'VCPKG_COMMIT'
    ], 'WASM producer build arguments');
    const allowedTrees = new Set(['src/frontend/wasm/', 'tools/vcpkg-overlays/']);
    const inputKeys = new Set();
    const inputPaths = new Set();
    const expectedWasmExclusions = [
        '.artifacts',
        '.cmake',
        '.emscripten-cache',
        'build',
        'build-basic',
        'build-pow-relaxed',
        'build-pow-threads',
        'build-simd',
        'stage'
    ];
    for (const input of inventory.inputs)
    {
        const expectedKeys = ['path', 'destination', 'kind', 'phase'];
        if (input.path === 'src/frontend/wasm/')
        {
            expectedKeys.push('excludedTopLevelDirectories');
        }
        assertExactKeys(input, expectedKeys, `WASM producer input ${input.path ?? '<missing>'}`);
        if (!['dependencies', 'compile'].includes(input.phase))
        {
            fail(`WASM producer input has invalid phase: ${input.path}`);
        }
        if (input.kind === 'tree' && !allowedTrees.has(input.path))
        {
            fail(`WASM producer inventory contains an unverified broad directory: ${input.path}`);
        }
        if (input.kind !== 'tree' && input.kind !== 'file')
        {
            fail(`WASM producer input has invalid kind: ${input.path}`);
        }
        if (input.destination !== `/work/${input.path}`)
        {
            fail(`WASM producer input destination must preserve its repository path: ${input.path}`);
        }
        if ((input.kind === 'tree') !== input.path.endsWith('/'))
        {
            fail(`WASM producer input kind/path shape mismatch: ${input.path}`);
        }
        if (input.path === 'src/frontend/wasm/'
            && JSON.stringify(input.excludedTopLevelDirectories) !== JSON.stringify(expectedWasmExclusions))
        {
            fail('WASM producer source-tree exclusions must match generated Docker context directories exactly');
        }
        if (inputPaths.has(input.path))
        {
            fail(`WASM producer inventory copies an input more than once: ${input.path}`);
        }
        inputPaths.add(input.path);
        const key = inventoryKey(input);
        if (inputKeys.has(key))
        {
            fail(`WASM producer inventory contains a duplicate COPY: ${input.path}`);
        }
        inputKeys.add(key);
    }
    resolveWasmProducerInputFiles({ repositoryRoot: root, sourceOverrides });

    const securityContractPath = 'tools/security/comment-privacy-build-contract.mjs';
    const securityContract = readSource(root, securityContractPath, sourceOverrides).toString('utf8');
    const artifactNamesMatch = /for \(const name of \[(?<names>[^\]]+)\]\)/u.exec(securityContract);
    if (!artifactNamesMatch)
    {
        fail('comment privacy build contract is missing the closed production artifact read list');
    }
    const artifactNames = [...artifactNamesMatch.groups.names.matchAll(/'(?<name>[a-z0-9_]+)'/gu)]
        .map((match) => match.groups.name);
    const trustedSetupManifest = 'security/zk/provenance/comment-v5-trusted-setup.manifest.json';
    const expectedConditionalKeys = [
        `${trustedSetupManifest}\0/phase2/transcript_path`,
        ...artifactNames.map((name) => `${trustedSetupManifest}\0/artifacts/${name}/path`)
    ].sort();
    const actualConditionalKeys = inventory.productionZkConditionalInputs.map((conditional) =>
    {
        assertExactKeys(conditional, ['manifest', 'jsonPointer'], 'WASM producer conditional input');
        return `${conditional.manifest}\0${conditional.jsonPointer}`;
    }).sort();
    if (actualConditionalKeys.length !== expectedConditionalKeys.length
        || actualConditionalKeys.some((key, index) => key !== expectedConditionalKeys[index]))
    {
        fail('WASM producer production-ZK conditional inventory does not match actual contract reads');
    }

    const dockerfile = readSource(root, wasmDockerfilePath, sourceOverrides).toString('utf8');
    const stage = wasmBuilderStage(dockerfile);
    const actualCopies = parseWasmBuilderCopies(stage);
    const actualKeys = actualCopies.map(inventoryKey);
    const expectedKeys = inventory.inputs.map(inventoryKey);
    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    const unregistered = actualKeys.filter((key) => !expectedKeys.includes(key));
    if (missing.length > 0 || unregistered.length > 0 || actualKeys.length !== expectedKeys.length)
    {
        fail(`WASM Docker COPY closure mismatch; missing=${missing.join(',') || '<none>'} unregistered=${unregistered.join(',') || '<none>'}`);
    }
    const dependencyRun = stage.indexOf('bash /work/tools/frontend/install-wasm-codec-deps.sh');
    const cmakeRun = stage.indexOf('bash /work/tools/frontend/ensure-cmake.sh');
    const compileRun = stage.indexOf(inventory.compileCommand);
    if (dependencyRun < 0 || cmakeRun <= dependencyRun || compileRun <= cmakeRun)
    {
        fail('WASM Docker producer phase ordering is incomplete');
    }
    for (const input of inventory.inputs)
    {
        const copyIndex = stage.indexOf(`COPY ${input.path} ${input.destination}`);
        const phaseBoundary = input.phase === 'dependencies' ? dependencyRun : cmakeRun;
        const valid = input.phase === 'dependencies'
            ? copyIndex >= 0 && copyIndex < phaseBoundary
            : copyIndex > phaseBoundary && copyIndex < compileRun;
        if (!valid)
        {
            fail(`WASM Docker producer COPY is outside its declared phase: ${input.path}`);
        }
    }
    for (const retired of [
        'COPY src/frontend/ /work/src/frontend/',
        'COPY tools/frontend/ /work/tools/frontend/',
        'COPY tools/frontend/ /tools/frontend/'
    ])
    {
        if (stage.includes(retired))
        {
            fail(`WASM Docker producer retains broad-copy compatibility path: ${retired}`);
        }
    }
    if (!stage.includes(inventory.compileCommand))
    {
        fail(`WASM Docker producer is missing canonical compile command: ${inventory.compileCommand}`);
    }
    for (const [name, expected] of Object.entries(inventory.buildArguments))
    {
        const pattern = new RegExp(`ARG ${name.replaceAll('$', '\\$&')}=${expected}(?:\\s|$)`, 'u');
        if (!pattern.test(dockerfile))
        {
            fail(`WASM Docker producer build argument drift: ${name}`);
        }
        if (!stage.includes(`\${${name}}`))
        {
            fail(`WASM Docker producer does not consume declared build argument: ${name}`);
        }
    }

    const discoveredReads = discoverProducerScriptReads(root, inventory.inputs, sourceOverrides);
    const missingReads = [...discoveredReads].filter((relativePath) => !coversInventoryPath(inventory.inputs, relativePath));
    if (missingReads.length > 0)
    {
        fail(`WASM producer reads unregistered repository inputs: ${missingReads.sort().join(', ')}`);
    }
    const exactFiles = inventory.inputs.filter((input) => input.kind === 'file').map((input) => input.path);
    const unreadFiles = exactFiles.filter((relativePath) => !discoveredReads.has(relativePath));
    if (unreadFiles.length > 0)
    {
        fail(`WASM producer inventory contains unread exact files: ${unreadFiles.join(', ')}`);
    }
    return {
        inputCount: inventory.inputs.length,
        fileCount: resolveWasmProducerInputFiles({ repositoryRoot: root, sourceOverrides }).length,
        copyCount: actualCopies.length
    };
}

export function computeWasmProducerCompileCacheKey({
    repoRoot = defaultRepoRoot,
    sourceOverrides = new Map(),
    buildArguments = {}
} = {})
{
    const root = path.resolve(repoRoot);
    validateWasmProducerInputClosure({ repoRoot: root, sourceOverrides });
    const inventory = loadWasmProducerInputInventory({ repositoryRoot: root, sourceOverrides });
    const resolvedArguments = { ...inventory.buildArguments, ...buildArguments };
    const productionZkEnabled = String(resolvedArguments.FSUSBLOG_ZK_PRODUCTION_ENABLED) === '1';
    const inputs = computeWasmProducerInputDescriptor({
        repositoryRoot: root,
        sourceOverrides,
        productionZkEnabled
    });
    const dockerfile = readSource(root, wasmDockerfilePath, sourceOverrides).toString('utf8');
    const toolStageStart = dockerfile.indexOf('FROM emscripten/emsdk:');
    const artifactStageStart = dockerfile.indexOf('FROM scratch AS wasm-artifact');
    if (toolStageStart < 0 || artifactStageStart <= toolStageStart)
    {
        fail('WASM Docker producer definition is incomplete');
    }
    const digest = createHash('sha256');
    digest.update(inputs.sourceHash);
    digest.update('\0');
    digest.update(dockerfile.slice(toolStageStart, artifactStageStart));
    digest.update('\0');
    digest.update(JSON.stringify(Object.fromEntries(Object.entries(resolvedArguments).sort())));
    return {
        cacheKey: `sha256:${digest.digest('hex')}`,
        inputTreeDigest: `sha256:${inputs.sourceHash}`,
        inputFiles: inputs.sourceFiles,
        buildArguments: resolvedArguments
    };
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
    const producerClosure = validateWasmProducerInputClosure({ repoRoot });
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
        artifactRelativePath: generatedArtifactRelativePath,
        producerClosure
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
      + ` producer-inputs=${ownership.producerClosure.fileCount} copies=${ownership.producerClosure.copyCount}`
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
