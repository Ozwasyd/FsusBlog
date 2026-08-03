#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const wasmBuildReceiptSchema = 'fsusblog.wasm-build-receipt.v1';
export const wasmBuildReceiptName = 'wasm-build-receipt.json';
export const wasmBuildProducerId = 'frontend-wasm-build';

const moduleFile = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(moduleFile), '../..');
const defaultClientRoot = path.join(defaultRepositoryRoot, 'src', 'frontend');
const policyFiles = Object.freeze([
    'ops/docker/FsusBlog.Server.Dockerfile',
    'tools/build-final-image.sh',
    'tools/build-wasm-artifact.sh',
    'tools/check-wasm-artifact-ownership.mjs',
    'tools/frontend/ensure-wasm.mjs',
    'tools/frontend/wasm-build-receipt.mjs'
]);

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function digest(value)
{
    return `sha256:${sha256(value)}`;
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function contentDigest(value)
{
    const content = { ...value };
    delete content.contentDigest;
    return digest(JSON.stringify(canonicalize(content)));
}

function normalizedRelative(root, value)
{
    return path.relative(root, value).replaceAll(path.sep, '/') || '.';
}

function requiredString(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} is required`);
    }
    return normalized;
}

function assertPlainObject(value, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function assertInside(root, value, label)
{
    const absolute = path.resolve(value);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} is outside the repository: ${absolute}`);
    }
    return absolute;
}

function fileIdentity(file, { expectedRoot, label })
{
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    const real = fs.realpathSync(file);
    assertInside(expectedRoot, real, label);
    return {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: Number(stat.mode),
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}

function sameIdentity(left, right)
{
    return JSON.stringify(left) === JSON.stringify(right);
}

function readJsonFile(file, label)
{
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error)
    {
        throw new Error(
            `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
        );
    }
}

function gitValue(repositoryRoot, args, fallback)
{
    const result = spawnSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8'
    });
    const value = result.status === 0 ? result.stdout.trim() : '';
    return value || fallback;
}

function currentSourceIdentity({ repositoryRoot, clientRoot, manifest, env })
{
    const commit = String(
        env.FSUSBLOG_TEST_SOURCE_COMMIT
        || env.FSUSBLOG_COMMIT_SHA
        || gitValue(repositoryRoot, ['rev-parse', 'HEAD'], 'uncommitted')
    ).trim();
    const worktreeFingerprint = String(
        env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
        || `wasm-source:${manifest.sourceHash}`
    ).trim();
    return {
        repositoryRoot: fs.realpathSync(repositoryRoot),
        clientRoot: normalizedRelative(repositoryRoot, clientRoot),
        commit,
        worktreeFingerprint,
        inputTreeDigest: `sha256:${manifest.sourceHash}`
    };
}

function currentBuildIdentity({ contract, env })
{
    return {
        modes: [...contract.buildModes],
        features: {
            productionZkEnabled: Boolean(contract.productionZkEnabled),
            aedsAbi: contract.aedsAbi
        },
        args: {
            FSUSBLOG_ZK_PRODUCTION_ENABLED: String(env.FSUSBLOG_ZK_PRODUCTION_ENABLED ?? '0')
        }
    };
}

function assertProducerBuildIdentity(contract, env)
{
    const requested = ['1', 'true', 'yes', 'on'].includes(
        String(env.FSUSBLOG_ZK_PRODUCTION_ENABLED ?? '0').trim().toLowerCase()
    );
    if (requested !== Boolean(contract.productionZkEnabled))
    {
        throw new Error('WASM build args do not match the resolved feature contract');
    }
}

function currentPolicyIdentity(repositoryRoot)
{
    const files = policyFiles.map((relativePath) =>
    {
        const absolute = assertInside(repositoryRoot, path.join(repositoryRoot, relativePath), 'WASM policy file');
        const bytes = fs.readFileSync(absolute);
        return {
            path: relativePath,
            sha256: digest(bytes)
        };
    });
    return {
        id: 'wasm-artifact-ownership-policy',
        files,
        digest: digest(JSON.stringify(files))
    };
}

function sourceEntries({ repositoryRoot, clientRoot, manifest })
{
    return manifest.sourceFiles.map((relativePath) =>
    {
        const absolute = assertInside(repositoryRoot, path.join(clientRoot, relativePath), 'WASM source');
        return {
            path: normalizedRelative(repositoryRoot, absolute),
            identity: fileIdentity(absolute, { expectedRoot: repositoryRoot, label: `WASM source ${relativePath}` })
        };
    });
}

function outputEntries({ artifactDir, manifest })
{
    return manifest.outputFiles.map((name) =>
    {
        if (path.basename(name) !== name)
        {
            throw new Error(`WASM output name is invalid: ${name}`);
        }
        const absolute = assertInside(artifactDir, path.join(artifactDir, name), 'WASM output');
        const identity = fileIdentity(absolute, { expectedRoot: artifactDir, label: `WASM output ${name}` });
        const recordedHash = requiredString(manifest.outputFileHashes?.[name], `WASM output hash ${name}`);
        if (!/^[0-9a-f]{64}$/u.test(recordedHash))
        {
            throw new Error(`WASM output hash is invalid: ${name}`);
        }
        return {
            name,
            size: identity.size,
            sha256: `sha256:${recordedHash}`,
            identity
        };
    });
}

function withoutFileIdentity(output)
{
    const value = { ...output };
    delete value.identity;
    return value;
}

function expectedReceiptCandidates(artifactDir)
{
    return fs.readdirSync(artifactDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter((name) => name === wasmBuildReceiptName || name.endsWith('.wasm-build-receipt.json'))
        .sort();
}

function assertUniqueReceipt(artifactDir, receiptFile)
{
    const candidates = expectedReceiptCandidates(artifactDir);
    if (candidates.length !== 1 || path.join(artifactDir, candidates[0]) !== receiptFile)
    {
        throw new Error(`WASM build receipt is ambiguous: ${candidates.join(', ') || '<missing>'}`);
    }
}

function assertArtifactFileSet(artifactDir, outputNames)
{
    const entries = fs.readdirSync(artifactDir, { withFileTypes: true });
    const expected = new Set([
        ...outputNames,
        'wasm-manifest.aeds',
        wasmBuildReceiptName,
        ...(entries.some((entry) => entry.name === 'SHA256SUMS') ? ['SHA256SUMS'] : [])
    ]);
    const actual = entries.map((entry) => entry.name);
    const unsupported = entries
        .filter((entry) => !entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name))
        .map((entry) => entry.name);
    if (unsupported.length > 0 || actual.length !== expected.size)
    {
        throw new Error(`WASM artifact file set mismatch: ${unsupported.join(', ') || actual.sort().join(', ')}`);
    }
}

function writeJsonAtomic(file, value)
{
    const parent = path.dirname(file);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    {
        throw new Error('WASM build receipt parent must be a regular directory');
    }
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    {
        throw new Error('WASM build receipt cannot overwrite a symlink');
    }
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
}

export function createWasmBuildReceipt({
    repositoryRoot: repositoryRootValue = defaultRepositoryRoot,
    clientRoot: clientRootValue = defaultClientRoot,
    artifactDir: artifactDirValue,
    manifest,
    contract,
    env = process.env,
    buildCount = 0,
    producerMetrics = {},
    trustProducerValidation = false
})
{
    const repositoryRoot = fs.realpathSync(path.resolve(repositoryRootValue));
    const clientRoot = fs.realpathSync(path.resolve(clientRootValue));
    assertInside(repositoryRoot, clientRoot, 'frontend root');
    const artifactDir = fs.realpathSync(path.resolve(artifactDirValue));
    assertPlainObject(manifest, 'WASM manifest');
    assertPlainObject(contract, 'WASM artifact contract');
    assertProducerBuildIdentity(contract, env);
    const manifestFile = path.join(artifactDir, 'wasm-manifest.aeds');
    const manifestBytes = fs.readFileSync(manifestFile);
    const outputs = outputEntries({ artifactDir, manifest });
    const policy = currentPolicyIdentity(repositoryRoot);
    const source = currentSourceIdentity({ repositoryRoot, clientRoot, manifest, env });
    const inputs = sourceEntries({ repositoryRoot, clientRoot, manifest });
    let verificationBytesRead = 0;
    if (!trustProducerValidation)
    {
        const descriptor = createHash('sha256');
        for (const relativePath of manifest.sourceFiles)
        {
            const absolute = assertInside(repositoryRoot, path.join(clientRoot, relativePath), 'WASM source');
            const bytes = fs.readFileSync(absolute);
            verificationBytesRead += bytes.byteLength;
            descriptor.update(relativePath);
            descriptor.update('\0');
            descriptor.update(sha256(bytes));
            descriptor.update('\0');
        }
        if (descriptor.digest('hex') !== manifest.sourceHash)
        {
            throw new Error('WASM input tree digest does not match the producer manifest');
        }
        for (const output of outputs)
        {
            const bytes = fs.readFileSync(path.join(artifactDir, output.name));
            verificationBytesRead += bytes.byteLength;
            if (digest(bytes) !== output.sha256)
            {
                throw new Error(`WASM output hash does not match the producer manifest: ${output.name}`);
            }
        }
    }
    const receipt = {
        schema: wasmBuildReceiptSchema,
        status: 'sealed',
        producer: {
            id: wasmBuildProducerId,
            runId: String(env.GITHUB_RUN_ID || env.FSUSBLOG_TEST_RUN_ID || `local-${source.commit}`),
            runAttempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
            buildCount: Number(buildCount)
        },
        source,
        toolchain: { ...contract.toolchain },
        build: currentBuildIdentity({ contract, env }),
        inputTree: {
            digest: source.inputTreeDigest,
            files: inputs
        },
        outputManifest: {
            path: 'wasm-manifest.aeds',
            schemaVersion: manifest.schemaVersion,
            sha256: digest(manifestBytes)
        },
        outputs,
        artifactDigestTable: {
            schema: 'fsusblog.wasm-output-manifest-digest-table.v1',
            path: 'wasm-manifest.aeds',
            contentDigest: digest(manifestBytes)
        },
        ownershipPolicy: policy,
        metrics: {
            wasmBuildCount: Number(buildCount),
            sourceTreeTraversals: Number(producerMetrics.sourceTreeTraversals ?? 1),
            outputHashCount: Number(producerMetrics.outputHashCount ?? outputs.length),
            bytesRead: Number(producerMetrics.bytesRead ?? (
                (verificationBytesRead > 0
                    ? verificationBytesRead
                    : inputs.reduce((total, input) => total + input.identity.size, 0)
                        + outputs.reduce((total, output) => total + output.size, 0))
                + manifestBytes.byteLength
                + policyFiles.reduce((total, relativePath) =>
                    total + fs.statSync(path.join(repositoryRoot, relativePath)).size, 0)
            ))
        },
        contentDigest: null
    };
    receipt.contentDigest = contentDigest(receipt);
    const receiptFile = path.join(artifactDir, wasmBuildReceiptName);
    writeJsonAtomic(receiptFile, receipt);
    return receipt;
}

function validateExactIdentity({ repositoryRoot, record, label })
{
    const absolute = assertInside(repositoryRoot, path.join(repositoryRoot, record.path), label);
    const actual = fileIdentity(absolute, { expectedRoot: repositoryRoot, label });
    if (!sameIdentity(actual, record.identity))
    {
        throw new Error(`${label} identity changed`);
    }
}

export function validateWasmBuildReceipt({
    repositoryRoot: repositoryRootValue = defaultRepositoryRoot,
    clientRoot: clientRootValue = defaultClientRoot,
    artifactDir: artifactDirValue,
    receiptFile: receiptFileValue,
    manifest,
    contract,
    env = process.env
})
{
    const repositoryRoot = fs.realpathSync(path.resolve(repositoryRootValue));
    const clientRoot = fs.realpathSync(path.resolve(clientRootValue));
    assertInside(repositoryRoot, clientRoot, 'frontend root');
    const artifactDir = fs.realpathSync(path.resolve(artifactDirValue));
    const receiptFile = path.resolve(receiptFileValue || path.join(artifactDir, wasmBuildReceiptName));
    assertInside(artifactDir, receiptFile, 'WASM build receipt');
    assertUniqueReceipt(artifactDir, receiptFile);
    const receipt = readJsonFile(receiptFile, 'WASM build receipt');
    if (receipt.schema !== wasmBuildReceiptSchema || receipt.status !== 'sealed')
    {
        throw new Error('WASM build receipt schema or status mismatch');
    }
    if (receipt.contentDigest !== contentDigest(receipt))
    {
        throw new Error('WASM build receipt content digest mismatch');
    }
    if (receipt.producer?.id !== wasmBuildProducerId
        || !Number.isInteger(receipt.producer?.buildCount)
        || receipt.producer.buildCount < 0
        || receipt.producer.buildCount > 1
        || !Number.isInteger(receipt.producer?.runAttempt)
        || receipt.producer.runAttempt < 1)
    {
        throw new Error('WASM build receipt producer identity is invalid');
    }
    const expectedSource = currentSourceIdentity({ repositoryRoot, clientRoot, manifest, env });
    for (const field of ['repositoryRoot', 'clientRoot', 'commit', 'worktreeFingerprint', 'inputTreeDigest'])
    {
        if (receipt.source?.[field] !== expectedSource[field])
        {
            throw new Error(`WASM build receipt source identity mismatch: ${field}`);
        }
    }
    if (receipt.inputTree?.digest !== expectedSource.inputTreeDigest)
    {
        throw new Error('WASM build receipt input tree digest mismatch');
    }
    const expectedSourcePaths = manifest.sourceFiles.map((relativePath) =>
        normalizedRelative(repositoryRoot, path.join(clientRoot, relativePath)));
    const actualSourcePaths = (receipt.inputTree?.files ?? []).map((source) => source.path);
    if (JSON.stringify(actualSourcePaths) !== JSON.stringify(expectedSourcePaths))
    {
        throw new Error('WASM build receipt source file set mismatch');
    }
    for (const source of receipt.inputTree?.files ?? [])
    {
        validateExactIdentity({ repositoryRoot, record: source, label: `WASM source ${source.path}` });
    }
    if (JSON.stringify(receipt.toolchain) !== JSON.stringify(contract.toolchain))
    {
        throw new Error('WASM build receipt toolchain identity mismatch');
    }
    if (JSON.stringify(receipt.build) !== JSON.stringify(currentBuildIdentity({ contract, env })))
    {
        throw new Error('WASM build receipt build args or features mismatch');
    }
    const expectedPolicy = currentPolicyIdentity(repositoryRoot);
    if (receipt.ownershipPolicy?.digest !== expectedPolicy.digest
        || JSON.stringify(receipt.ownershipPolicy?.files) !== JSON.stringify(expectedPolicy.files))
    {
        throw new Error('WASM build receipt ownership policy digest mismatch');
    }
    const manifestFile = path.join(artifactDir, 'wasm-manifest.aeds');
    const manifestDigest = digest(fs.readFileSync(manifestFile));
    if (receipt.outputManifest?.sha256 !== manifestDigest
        || receipt.artifactDigestTable?.contentDigest !== manifestDigest
        || receipt.artifactDigestTable?.path !== 'wasm-manifest.aeds')
    {
        throw new Error('WASM build receipt output manifest digest mismatch');
    }
    const expectedOutputs = outputEntries({ artifactDir, manifest });
    if (JSON.stringify(receipt.outputs?.map(withoutFileIdentity))
        !== JSON.stringify(expectedOutputs.map(withoutFileIdentity)))
    {
        throw new Error('WASM build receipt output table mismatch');
    }
    for (const output of receipt.outputs)
    {
        const absolute = path.join(artifactDir, output.name);
        const actual = fileIdentity(absolute, { expectedRoot: artifactDir, label: `WASM output ${output.name}` });
        if (!sameIdentity(actual, output.identity))
        {
            throw new Error(`WASM output identity changed: ${output.name}`);
        }
    }
    assertArtifactFileSet(artifactDir, manifest.outputFiles);
    return {
        receipt,
        evidence: {
            validationMode: 'exact-immutable-identity',
            sourceTreeTraversals: 0,
            outputHashCount: 0,
            bytesRead: fs.statSync(receiptFile).size + fs.statSync(manifestFile).size + policyFiles
                .reduce((total, relativePath) => total + fs.statSync(path.join(repositoryRoot, relativePath)).size, 0)
        }
    };
}

export function classifyWasmReceiptFallback(error)
{
    return {
        action: 'run-canonical-producer',
        reason: error instanceof Error ? error.message : String(error),
        consumerMayRebuild: false
    };
}

export function validateWasmBuildReceiptEnvelope({
    artifactDir: artifactDirValue,
    receiptFile: receiptFileValue,
    manifest,
    contract,
    env = process.env
})
{
    const artifactDir = fs.realpathSync(path.resolve(artifactDirValue));
    const receiptFile = path.resolve(receiptFileValue || path.join(artifactDir, wasmBuildReceiptName));
    assertInside(artifactDir, receiptFile, 'WASM build receipt');
    assertUniqueReceipt(artifactDir, receiptFile);
    const receipt = readJsonFile(receiptFile, 'WASM build receipt');
    if (receipt.schema !== wasmBuildReceiptSchema || receipt.status !== 'sealed'
        || receipt.producer?.id !== wasmBuildProducerId
        || !Number.isInteger(receipt.producer?.buildCount)
        || receipt.producer.buildCount < 0
        || receipt.producer.buildCount > 1)
    {
        throw new Error('WASM build receipt envelope identity is invalid');
    }
    if (receipt.contentDigest !== contentDigest(receipt))
    {
        throw new Error('WASM build receipt content digest mismatch');
    }
    if (JSON.stringify(receipt.toolchain) !== JSON.stringify(contract.toolchain)
        || JSON.stringify(receipt.build) !== JSON.stringify(currentBuildIdentity({ contract, env })))
    {
        throw new Error('WASM build receipt toolchain or build identity mismatch');
    }
    const expectedCommit = String(env.FSUSBLOG_COMMIT_SHA || env.FSUSBLOG_TEST_SOURCE_COMMIT || '').trim();
    if (expectedCommit && receipt.source?.commit !== expectedCommit)
    {
        throw new Error('WASM build receipt source commit mismatch');
    }
    const manifestFile = path.join(artifactDir, 'wasm-manifest.aeds');
    const manifestDigest = digest(fs.readFileSync(manifestFile));
    if (receipt.outputManifest?.sha256 !== manifestDigest
        || receipt.artifactDigestTable?.contentDigest !== manifestDigest)
    {
        throw new Error('WASM build receipt output manifest digest mismatch');
    }
    if (receipt.source?.inputTreeDigest !== `sha256:${manifest.sourceHash}`
        || receipt.inputTree?.digest !== `sha256:${manifest.sourceHash}`)
    {
        throw new Error('WASM build receipt input tree digest mismatch');
    }
    const expectedNames = [...manifest.outputFiles].sort();
    const actualNames = (receipt.outputs ?? []).map((output) => output.name).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    {
        throw new Error('WASM build receipt output set mismatch');
    }
    for (const output of receipt.outputs)
    {
        if (output.sha256 !== `sha256:${manifest.outputFileHashes?.[output.name]}`)
        {
            throw new Error(`WASM build receipt output digest mismatch: ${output.name}`);
        }
        const file = path.join(artifactDir, output.name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== output.size)
        {
            throw new Error(`WASM build receipt output envelope mismatch: ${output.name}`);
        }
    }
    assertArtifactFileSet(artifactDir, manifest.outputFiles);
    return { receipt, validationMode: 'artifact-envelope' };
}

export function writeWasmReceiptChecksums({
    artifactDir: artifactDirValue,
    receiptFile: receiptFileValue,
    manifest,
    contract,
    env = process.env
})
{
    const artifactDir = fs.realpathSync(path.resolve(artifactDirValue));
    const { receipt } = validateWasmBuildReceiptEnvelope({
        artifactDir,
        receiptFile: receiptFileValue,
        manifest,
        contract,
        env
    });
    const receiptFile = path.resolve(receiptFileValue || path.join(artifactDir, wasmBuildReceiptName));
    const lines = receipt.outputs.map((output) => `${output.sha256.slice('sha256:'.length)}  ${output.name}`);
    lines.push(`${receipt.outputManifest.sha256.slice('sha256:'.length)}  wasm-manifest.aeds`);
    lines.push(`${sha256(fs.readFileSync(receiptFile))}  ${wasmBuildReceiptName}`);
    fs.writeFileSync(path.join(artifactDir, 'SHA256SUMS'), `${lines.sort().join('\n')}\n`);
    return { fileCount: lines.length, outputHashReads: 0 };
}

function artifactDirectoryIdentity(artifactDir)
{
    const realArtifactDir = fs.realpathSync(artifactDir);
    return fs.readdirSync(realArtifactDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) =>
        {
            if (!entry.isFile() || entry.isSymbolicLink())
            {
                throw new Error(`WASM artifact staging requires regular files: ${entry.name}`);
            }
            return {
                name: entry.name,
                identity: fileIdentity(path.join(realArtifactDir, entry.name), {
                    expectedRoot: realArtifactDir,
                    label: `WASM artifact ${entry.name}`
                })
            };
        });
}

export function stageWasmReceiptEnvelope({
    repositoryRoot: repositoryRootValue = defaultRepositoryRoot,
    clientRoot: clientRootValue = defaultClientRoot,
    sourceArtifactDir: sourceArtifactDirValue,
    destinationArtifactDir: destinationArtifactDirValue,
    manifest,
    contract,
    env = process.env
})
{
    const repositoryRoot = fs.realpathSync(path.resolve(repositoryRootValue));
    const clientRoot = fs.realpathSync(path.resolve(clientRootValue));
    assertInside(repositoryRoot, clientRoot, 'frontend root');
    const sourceArtifactDir = fs.realpathSync(path.resolve(sourceArtifactDirValue));
    const destinationArtifactDir = path.resolve(destinationArtifactDirValue);
    if (destinationArtifactDir === sourceArtifactDir
        || destinationArtifactDir.startsWith(`${sourceArtifactDir}${path.sep}`)
        || sourceArtifactDir.startsWith(`${destinationArtifactDir}${path.sep}`))
    {
        throw new Error('WASM artifact staging source and destination must be disjoint');
    }
    if (fs.existsSync(destinationArtifactDir) || fs.lstatSync(path.dirname(destinationArtifactDir)).isSymbolicLink())
    {
        throw new Error(`WASM artifact staging destination already exists or has a symlink parent: ${destinationArtifactDir}`);
    }

    validateWasmBuildReceipt({
        repositoryRoot,
        clientRoot,
        artifactDir: sourceArtifactDir,
        manifest,
        contract,
        env
    });
    const sourceIdentity = artifactDirectoryIdentity(sourceArtifactDir);
    fs.mkdirSync(destinationArtifactDir);
    try
    {
        for (const entry of sourceIdentity)
        {
            if (entry.name === 'SHA256SUMS')
            {
                continue;
            }
            const source = path.join(sourceArtifactDir, entry.name);
            const destination = path.join(destinationArtifactDir, entry.name);
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
        }
        const checksumEvidence = writeWasmReceiptChecksums({
            artifactDir: destinationArtifactDir,
            manifest,
            contract,
            env
        });
        validateWasmBuildReceipt({
            repositoryRoot,
            clientRoot,
            artifactDir: sourceArtifactDir,
            manifest,
            contract,
            env
        });
        if (JSON.stringify(artifactDirectoryIdentity(sourceArtifactDir)) !== JSON.stringify(sourceIdentity))
        {
            throw new Error('WASM source artifact identity changed during payload staging');
        }
        const staged = validateWasmBuildReceiptEnvelope({
            artifactDir: destinationArtifactDir,
            manifest,
            contract,
            env
        });
        return {
            sourceValidationMode: 'exact-immutable-identity',
            destinationValidationMode: staged.validationMode,
            sourceUnchanged: true,
            stagedFileCount: artifactDirectoryIdentity(destinationArtifactDir).length,
            ...checksumEvidence
        };
    }
    catch (error)
    {
        fs.rmSync(destinationArtifactDir, { recursive: true, force: true });
        throw error;
    }
}

function parseCli(args)
{
    const options = {
        command: args.shift() || 'verify',
        repositoryRoot: defaultRepositoryRoot,
        clientRoot: defaultClientRoot,
        artifactDir: null,
        destinationArtifactDir: null,
        buildCount: 0,
        trustProducerValidation: false
    };
    while (args.length > 0)
    {
        const argument = args.shift();
        const value = args.shift();
        if (!value)
        {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--root')
        {
            options.repositoryRoot = path.resolve(value);
        }
        else if (argument === '--client-root')
        {
            options.clientRoot = path.resolve(value);
        }
        else if (argument === '--artifact-dir')
        {
            options.artifactDir = path.resolve(value);
        }
        else if (argument === '--destination-artifact-dir')
        {
            options.destinationArtifactDir = path.resolve(value);
        }
        else if (argument === '--build-count')
        {
            options.buildCount = Number(value);
        }
        else if (argument === '--trust-producer-validation')
        {
            options.trustProducerValidation = value === 'true';
        }
        else
        {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    if (!options.artifactDir)
    {
        throw new Error('--artifact-dir is required');
    }
    if (options.command === 'stage-envelope' && !options.destinationArtifactDir)
    {
        throw new Error('--destination-artifact-dir is required for stage-envelope');
    }
    return options;
}

async function main()
{
    const options = parseCli(process.argv.slice(2));
    const [{ parseWasmManifest, wasmArtifactContract }, manifestRaw] = await Promise.all([
        import('./ensure-wasm.mjs'),
        fs.promises.readFile(path.join(options.artifactDir, 'wasm-manifest.aeds'), 'utf8')
    ]);
    const manifest = parseWasmManifest(manifestRaw);
    if (options.command === 'create')
    {
        const receipt = createWasmBuildReceipt({
            ...options,
            manifest,
            contract: wasmArtifactContract,
            buildCount: options.buildCount,
            trustProducerValidation: options.trustProducerValidation
        });
        console.log(`[wasm-build-receipt] sealed ${receipt.contentDigest}`);
        return;
    }
    if (options.command !== 'verify')
    {
        if (options.command === 'stage-envelope')
        {
            const result = stageWasmReceiptEnvelope({
                ...options,
                sourceArtifactDir: options.artifactDir,
                manifest,
                contract: wasmArtifactContract
            });
            console.log(
                `[wasm-build-receipt] staged envelope files=${result.stagedFileCount}`
                + ` checksums=${result.fileCount}`
                + ` sourceUnchanged=${result.sourceUnchanged}`
                + ` destinationMode=${result.destinationValidationMode}`
            );
            return;
        }
        if (options.command === 'verify-envelope')
        {
            const result = validateWasmBuildReceiptEnvelope({
                ...options,
                manifest,
                contract: wasmArtifactContract
            });
            console.log(`[wasm-build-receipt] ok mode=${result.validationMode} outputs=${result.receipt.outputs.length}`);
            return;
        }
        if (options.command === 'write-checksums')
        {
            const result = writeWasmReceiptChecksums({
                ...options,
                manifest,
                contract: wasmArtifactContract
            });
            console.log(`[wasm-build-receipt] wrote checksums files=${result.fileCount} outputHashReads=${result.outputHashReads}`);
            return;
        }
        throw new Error(`unknown command: ${options.command}`);
    }
    const result = validateWasmBuildReceipt({
        ...options,
        manifest,
        contract: wasmArtifactContract
    });
    console.log(
        `[wasm-build-receipt] ok producer=${result.receipt.producer.id}`
        + ` buildCount=${result.receipt.producer.buildCount}`
        + ` outputs=${result.receipt.outputs.length}`
        + ` traversals=${result.evidence.sourceTreeTraversals}`
        + ` hashes=${result.evidence.outputHashCount}`
        + ` bytesRead=${result.evidence.bytesRead}`
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile)
{
    main().catch((error) =>
    {
        console.error(`[wasm-build-receipt] fatal: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
