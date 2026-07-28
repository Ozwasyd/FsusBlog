/* eslint-disable import-x/no-relative-parent-imports -- repository tool contract fixture */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';
import {
    classifyWasmReceiptFallback,
    createWasmBuildReceipt,
    stageWasmReceiptEnvelope,
    validateWasmBuildReceipt,
    validateWasmBuildReceiptEnvelope,
    wasmBuildProducerId,
    wasmBuildReceiptName,
    wasmBuildReceiptSchema,
    writeWasmReceiptChecksums
} from '../../tools/frontend/wasm-build-receipt.mjs';

const policyFiles = [
    'ops/docker/FsusBlog.Server.Dockerfile',
    'tools/build-final-image.sh',
    'tools/build-wasm-artifact.sh',
    'tools/check-wasm-artifact-ownership.mjs',
    'tools/frontend/ensure-wasm.mjs',
    'tools/frontend/wasm-build-receipt.mjs'
];

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function write(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
}

function sourceDigest(clientRoot, sourceFiles)
{
    const hash = createHash('sha256');
    for (const relativePath of sourceFiles)
    {
        hash.update(relativePath);
        hash.update('\0');
        hash.update(sha256(fs.readFileSync(path.join(clientRoot, relativePath))));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function directorySnapshot(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) =>
        {
            const file = path.join(directory, entry.name);
            const stat = fs.lstatSync(file, { bigint: true });
            return {
                name: entry.name,
                mode: Number(stat.mode),
                dev: stat.dev.toString(),
                ino: stat.ino.toString(),
                size: Number(stat.size),
                mtimeNs: stat.mtimeNs.toString(),
                ctimeNs: stat.ctimeNs.toString(),
                sha256: sha256(fs.readFileSync(file))
            };
        });
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-wasm-receipt-'));
    const clientRoot = path.join(root, 'src/frontend');
    const artifactDir = path.join(root, 'build/wasm');
    const sourceFiles = ['wasm/include/decoder.hpp', 'wasm/src/decoder.cpp'];
    for (const relativePath of policyFiles)
    {
        write(path.join(root, relativePath), `policy:${relativePath}\n`);
    }
    for (const relativePath of sourceFiles)
    {
        write(path.join(clientRoot, relativePath), `source:${relativePath}\n`);
    }
    const outputBody = Buffer.from('compiled-wasm-output\n');
    write(path.join(artifactDir, 'decoder.wasm'), outputBody);
    const manifest = {
        schemaVersion: 3,
        aedsAbi: 'fsusblog.aeds.v4',
        sourceHash: sourceDigest(clientRoot, sourceFiles),
        sourceFiles,
        outputFiles: ['decoder.wasm'],
        outputFileHashes: {
            'decoder.wasm': sha256(outputBody)
        }
    };
    write(path.join(artifactDir, 'wasm-manifest.aeds'), 'canonical manifest bytes\n');
    const contract = {
        schemaVersion: 3,
        aedsAbi: manifest.aedsAbi,
        buildModes: ['basic', 'simd'],
        productionZkEnabled: false,
        toolchain: {
            emscriptenVersion: '4.0.13',
            compilerVersion: 'clang-21',
            emsdkImage: 'emsdk@sha256:fixture'
        }
    };
    const env = {
        FSUSBLOG_TEST_SOURCE_COMMIT: 'a'.repeat(40),
        FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'source-fixture-v1',
        FSUSBLOG_TEST_RUN_ID: 'production-fresh-local',
        FSUSBLOG_ZK_PRODUCTION_ENABLED: '0'
    };
    return {
        root,
        clientRoot,
        artifactDir,
        manifest,
        contract,
        env,
        create(options = {})
        {
            return createWasmBuildReceipt({
                repositoryRoot: root,
                clientRoot,
                artifactDir,
                manifest,
                contract,
                env,
                buildCount: 1,
                ...options
            });
        },
        validate(options = {})
        {
            return validateWasmBuildReceipt({
                repositoryRoot: root,
                clientRoot,
                artifactDir,
                manifest,
                contract,
                env,
                ...options
            });
        },
        cleanup()
        {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

test('canonical producer seals one source-bound receipt and consumers perform no output hash traversal', (t) =>
{
    const value = fixture();
    t.after(value.cleanup);
    const receipt = value.create();
    const validation = value.validate();
    assert.equal(receipt.schema, wasmBuildReceiptSchema);
    assert.equal(receipt.producer.id, wasmBuildProducerId);
    assert.equal(receipt.producer.buildCount, 1);
    assert.equal(receipt.source.commit, 'a'.repeat(40));
    assert.equal(receipt.source.inputTreeDigest, `sha256:${value.manifest.sourceHash}`);
    assert.equal(receipt.outputs[0].size, fs.statSync(path.join(value.artifactDir, 'decoder.wasm')).size);
    assert.equal(receipt.artifactDigestTable.path, 'wasm-manifest.aeds');
    assert.equal(receipt.ownershipPolicy.id, 'wasm-artifact-ownership-policy');
    assert.match(receipt.contentDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(validation.evidence.validationMode, 'exact-immutable-identity');
    assert.equal(validation.evidence.sourceTreeTraversals, 0);
    assert.equal(validation.evidence.outputHashCount, 0);
    const checksumEvidence = writeWasmReceiptChecksums({
        artifactDir: value.artifactDir,
        manifest: value.manifest,
        contract: value.contract,
        env: value.env
    });
    assert.equal(checksumEvidence.outputHashReads, 0);
    assert.equal(checksumEvidence.fileCount, 3);
    const checksumNames = fs.readFileSync(path.join(value.artifactDir, 'SHA256SUMS'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.slice(line.indexOf('  ') + 2));
    assert.deepEqual(
        checksumNames.sort(),
        ['decoder.wasm', 'wasm-build-receipt.json', 'wasm-manifest.aeds']
    );
    assert.equal(validateWasmBuildReceiptEnvelope({
        artifactDir: value.artifactDir,
        manifest: value.manifest,
        contract: value.contract,
        env: value.env
    }).validationMode, 'artifact-envelope');
    const portable = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], {
        cwd: value.artifactDir,
        encoding: 'utf8'
    });
    assert.equal(portable.status, 0, portable.stderr || portable.stdout);
});

test('readonly source stages deterministic checksums before the outer immutable seal without source mutation', (t) =>
{
    const value = fixture();
    t.after(value.cleanup);
    fs.chmodSync(path.join(value.artifactDir, 'decoder.wasm'), 0o444);
    fs.chmodSync(path.join(value.artifactDir, 'wasm-manifest.aeds'), 0o444);
    value.create();
    writeWasmReceiptChecksums({
        artifactDir: value.artifactDir,
        manifest: value.manifest,
        contract: value.contract,
        env: value.env
    });
    fs.chmodSync(path.join(value.artifactDir, wasmBuildReceiptName), 0o444);
    fs.chmodSync(path.join(value.artifactDir, 'SHA256SUMS'), 0o444);
    const sourceBefore = directorySnapshot(value.artifactDir);
    const packageRoots = ['first', 'second'].map((name) => path.join(value.root, `package-${name}`));
    const outerReceipts = [];
    for (const packageRoot of packageRoots)
    {
        const destinationArtifactDir = path.join(packageRoot, 'payload/wasm');
        fs.mkdirSync(path.dirname(destinationArtifactDir), { recursive: true });
        const staged = stageWasmReceiptEnvelope({
            repositoryRoot: value.root,
            clientRoot: value.clientRoot,
            sourceArtifactDir: value.artifactDir,
            destinationArtifactDir,
            manifest: value.manifest,
            contract: value.contract,
            env: value.env
        });
        assert.equal(staged.sourceUnchanged, true);
        assert.equal(staged.destinationValidationMode, 'artifact-envelope');
        assert.notEqual(
            fs.statSync(path.join(destinationArtifactDir, 'SHA256SUMS')).ino,
            fs.statSync(path.join(value.artifactDir, 'SHA256SUMS')).ino
        );
        assert.notEqual(fs.statSync(path.join(destinationArtifactDir, 'SHA256SUMS')).mode & 0o200, 0);
        const portable = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], {
            cwd: destinationArtifactDir,
            encoding: 'utf8'
        });
        assert.equal(portable.status, 0, portable.stderr || portable.stdout);
        const outerReceipt = createProductionBuildReceipt({
            root: value.root,
            artifactRoot: packageRoot,
            sourceState: {
                commit: value.env.FSUSBLOG_TEST_SOURCE_COMMIT,
                worktreeFingerprint: 'b'.repeat(64)
            },
            producer: {
                workflow: 'Quality Gate',
                runId: 'readonly-source-fixture',
                runAttempt: 1,
                job: 'production-build-artifacts'
            },
            toolchain: {
                node: 'v24',
                npm: '11',
                dotnet: '10',
                vite: '8',
                vitest: '4',
                playwright: '1.58',
                emsdk: '4.0.13'
            },
            inputPaths: [policyFiles[0]],
            domains: [{ name: 'wasm', path: 'payload/wasm' }],
            build: {
                profile: 'production-release-fresh',
                command: 'tools/test/lanes/production-build-artifacts.sh',
                startedAt: '2026-01-01T00:00:00.000Z',
                finishedAt: '2026-01-01T00:00:01.000Z',
                durationMs: 1000
            },
            now: () => new Date('2026-01-01T00:00:01.000Z')
        });
        assert.equal(fs.statSync(path.join(destinationArtifactDir, 'SHA256SUMS')).mode & 0o222, 0);
        outerReceipts.push({
            contentDigest: outerReceipt.contentDigest,
            staged: directorySnapshot(destinationArtifactDir).map(({ name, sha256: fileDigest }) => ({
                name,
                sha256: fileDigest
            }))
        });
    }
    assert.deepEqual(outerReceipts[0], outerReceipts[1]);
    assert.deepEqual(directorySnapshot(value.artifactDir), sourceBefore);
});

test('portable image boundary reuses receipt checksums and detects copied-output tampering', (t) =>
{
    const value = fixture();
    t.after(value.cleanup);
    value.create();
    writeWasmReceiptChecksums({
        artifactDir: value.artifactDir,
        manifest: value.manifest,
        contract: value.contract,
        env: value.env
    });
    fs.appendFileSync(path.join(value.artifactDir, 'decoder.wasm'), 'tampered after seal\n');
    const portable = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], {
        cwd: value.artifactDir,
        encoding: 'utf8'
    });
    assert.notEqual(portable.status, 0);
    assert.match(`${portable.stdout}\n${portable.stderr}`, /FAILED/u);
});

test('producer rejects a stale input digest and a wrong output manifest hash', (t) =>
{
    const staleSource = fixture();
    const wrongOutput = fixture();
    t.after(() =>
    {
        staleSource.cleanup();
        wrongOutput.cleanup();
    });
    staleSource.manifest.sourceHash = '0'.repeat(64);
    assert.throws(() => staleSource.create(), /input tree digest/u);
    wrongOutput.manifest.outputFileHashes['decoder.wasm'] = '0'.repeat(64);
    assert.throws(() => wrongOutput.create(), /output hash does not match/u);
});

test('source, toolchain, build args and policy drift invalidate the receipt', async (t) =>
{
    const cases = [
        {
            name: 'source',
            mutate(value)
            {
                fs.appendFileSync(path.join(value.clientRoot, value.manifest.sourceFiles[0]), 'changed\n');
            },
            expected: /source .* identity changed/u
        },
        {
            name: 'toolchain',
            mutate(value)
            {
                value.contract.toolchain = { ...value.contract.toolchain, compilerVersion: 'clang-22' };
            },
            expected: /toolchain identity mismatch/u
        },
        {
            name: 'worktree fingerprint',
            mutate(value)
            {
                value.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT = 'different-worktree';
            },
            expected: /source identity mismatch: worktreeFingerprint/u
        },
        {
            name: 'build args',
            mutate(value)
            {
                value.env.FSUSBLOG_ZK_PRODUCTION_ENABLED = '1';
            },
            expected: /build args or features mismatch/u
        },
        {
            name: 'policy',
            mutate(value)
            {
                fs.appendFileSync(path.join(value.root, policyFiles[0]), 'changed\n');
            },
            expected: /ownership policy digest mismatch/u
        }
    ];
    for (const entry of cases)
    {
        await t.test(entry.name, () =>
        {
            const value = fixture();
            try
            {
                value.create();
                entry.mutate(value);
                assert.throws(() => value.validate(), entry.expected);
            }
            finally
            {
                value.cleanup();
            }
        });
    }
});

test('missing, tampered and symlink outputs fail closed without consumer rebuild', async (t) =>
{
    const cases = [
        {
            name: 'missing',
            mutate(value)
            {
                fs.unlinkSync(path.join(value.artifactDir, 'decoder.wasm'));
            },
            expected: /ENOENT|no such file/u
        },
        {
            name: 'tampered',
            mutate(value)
            {
                fs.appendFileSync(path.join(value.artifactDir, 'decoder.wasm'), 'tampered\n');
            },
            expected: /output table mismatch|output identity changed/u
        },
        {
            name: 'symlink',
            mutate(value)
            {
                const output = path.join(value.artifactDir, 'decoder.wasm');
                fs.unlinkSync(output);
                fs.symlinkSync(path.join(value.clientRoot, value.manifest.sourceFiles[0]), output);
            },
            expected: /regular non-symlink file/u
        },
        {
            name: 'unexpected output',
            mutate(value)
            {
                write(path.join(value.artifactDir, 'undeclared.wasm'), 'not in manifest\n');
            },
            expected: /artifact file set mismatch/u
        }
    ];
    for (const entry of cases)
    {
        await t.test(entry.name, () =>
        {
            const value = fixture();
            try
            {
                value.create();
                entry.mutate(value);
                assert.throws(() => value.validate(), entry.expected);
            }
            finally
            {
                value.cleanup();
            }
        });
    }
});

test('tampered manifest, receipt content and ambiguous receipt discovery fail closed', async (t) =>
{
    const cases = [
        {
            name: 'manifest',
            mutate(value)
            {
                fs.appendFileSync(path.join(value.artifactDir, 'wasm-manifest.aeds'), 'wrong manifest\n');
            },
            expected: /output manifest digest mismatch/u
        },
        {
            name: 'receipt content',
            mutate(value)
            {
                const file = path.join(value.artifactDir, wasmBuildReceiptName);
                const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
                receipt.producer.runId = 'forged';
                fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
            },
            expected: /content digest mismatch/u
        },
        {
            name: 'ambiguous',
            mutate(value)
            {
                write(path.join(value.artifactDir, 'shadow.wasm-build-receipt.json'), '{}\n');
            },
            expected: /receipt is ambiguous/u
        }
    ];
    for (const entry of cases)
    {
        await t.test(entry.name, () =>
        {
            const value = fixture();
            try
            {
                value.create();
                entry.mutate(value);
                assert.throws(() => value.validate(), entry.expected);
            }
            finally
            {
                value.cleanup();
            }
        });
    }
});

test('receipt symlink is rejected and fallback stays owned by the canonical producer', (t) =>
{
    const value = fixture();
    t.after(value.cleanup);
    value.create();
    const receiptFile = path.join(value.artifactDir, wasmBuildReceiptName);
    const target = path.join(value.artifactDir, 'receipt-copy.json');
    fs.renameSync(receiptFile, target);
    fs.symlinkSync(target, receiptFile);
    assert.throws(() => value.validate(), /regular non-symlink file|ambiguous/u);
    const fallback = classifyWasmReceiptFallback(new Error('output identity changed'));
    assert.deepEqual(fallback, {
        action: 'run-canonical-producer',
        reason: 'output identity changed',
        consumerMayRebuild: false
    });
});
