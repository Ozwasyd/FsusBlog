/* eslint-disable import-x/no-relative-parent-imports -- This contract test imports the canonical release manifest owner under test. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';



import { createCurrentActivationPlan, validateCurrentActivationPlan, verifyCurrentActivationArtifacts,
    beginCurrentActivationSwitch, failCurrentActivation, discardUnactivatedCandidate } from '../../tools/deployment/release-rollout-lib.mjs';
import { canonicalize, digestValue } from '../../tools/fact-extractors/lib/canonicalize.mjs';
import { RELEASE_ID_CONTRACT } from '../../tools/release/release-id.mjs';
import { releaseIdentityRosterArtifacts } from '../../tools/release/release-manifest-identity-contract.mjs';
import { signReleaseManifest, verifyReleaseManifestArtifacts } from '../../tools/release/release-manifest-signature-contract.mjs';
import {
    createReleaseManifest,
    deriveReleaseCandidateId,
    deriveReleaseManifestContentDigest,
    readCurrentSchemaReceiptReleaseBinding,
    readReleaseManifest,
    RELEASE_MANIFEST_SCHEMA,
    validateReleaseManifest,
    writeReleaseManifestAtomic
} from '../../tools/release/release-manifest.mjs';

import { createCurrentSchemaReleaseBindingFixture, createReleaseIdentityRosterFixture } from './support/release-readiness-test-helpers.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const releaseId = '20260711010101-0123456789ab';
const digest = `sha256:${'a'.repeat(64)}`;

function createInput(overrides = {})
{
    return {
        releaseId,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        imageRepository: 'ghcr.io/fsusblog/app',
        imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
        imageDigest: digest,
        registryDigestVerified: true,
        createdAtUtc: '2026-07-11T01:01:01.000Z',
        frontendManifestHash: `sha256:${'b'.repeat(64)}`,
        wasmArtifactHash: `sha256:${'c'.repeat(64)}`,
        currentSchema: createCurrentSchemaReleaseBindingFixture(),
        identity: createReleaseIdentityRosterFixture({ commitSha: '0123456789abcdef0123456789abcdef01234567', imageDigest: digest, frontendManifestHash: `sha256:${'b'.repeat(64)}`, wasmArtifactHash: `sha256:${'c'.repeat(64)}` }),
        dotnetVersion: '10.0.100',
        nodeVersion: 'v20.19.0',
        dockerVersion: '28.0.0',
        dockerfileDigest: `sha256:${'d'.repeat(64)}`,
        runtimeProfile: {
            id: 'throughput-musl',
            manifestDigest: `sha256:${'e'.repeat(64)}`,
            profileDigest: `sha256:${'f'.repeat(64)}`,
            baseImageFamily: 'musl',
            targetRuntime: 'linux-musl-x64',
            singleFile: true,
            readyToRun: false,
            tieredPgo: true,
            quickJitForLoops: true,
            serverGc: true,
            nativeAot: false,
            threadPoolMode: 'runtime-default',
            topologyMode: 'smt-visible'
        },
        target: 'final',
        ...overrides
    };
}

function createDeploymentFixture(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-deploy-fixture-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configDir = path.join(directory, 'zk-config');
    const secretDir = path.join(directory, 'zk-secret');
    const assetStore = path.join(directory, 'release-assets');
    const releaseAssetRoot = path.join(assetStore, 'releases', releaseId);
    const descriptorPath = path.join(releaseAssetRoot, 'spa-manifest-descriptor.json');
    const receiptPath = path.join(releaseAssetRoot, 'production-build-receipt.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(releaseAssetRoot, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(descriptorPath, '{}\n', { mode: 0o444 });
    fs.writeFileSync(receiptPath, '{}\n', { mode: 0o444 });
    fs.writeFileSync(path.join(configDir, 'trusted.json'), '{}\n');
    fs.writeFileSync(path.join(configDir, 'verifying.json'), '{}\n');
    fs.writeFileSync(path.join(configDir, 'comment.v5.vk'), 'verifying key\n');
    fs.writeFileSync(path.join(configDir, 'issuer-public.key'), 'issuer public\n');
    fs.writeFileSync(path.join(secretDir, 'issuer-private.key'), 'issuer private\n');
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const verifyingHash = hash(path.join(configDir, 'comment.v5.vk'));
    const issuerHash = hash(path.join(configDir, 'issuer-public.key'));
    const envFile = path.join(directory, '.env.production');
    fs.writeFileSync(envFile, [
        'EXTERNAL_DB_HOST=db',
        'EXTERNAL_REDIS_HOST=redis',
        'DB_USER=fsus',
        'DB_PASSWORD=database-password',
        'DB_NAME=fsusblog',
        'REDIS_PASSWORD=redis-password',
        'FSUSBLOG_RELEASE_ID=latest',
        'FSUSBLOG_RELEASE_CREATED_AT_UTC=1999-01-01T00:00:00.000Z',
        'FSUSBLOG_COMMIT_SHA=ffffffffffffffffffffffffffffffffffffffff',
        'FSUSBLOG_IMAGE_REF=ghcr.io/fsusblog/app:latest',
        `FSUSBLOG_IMAGE_DIGEST=sha256:${'f'.repeat(64)}`,
        'Jwt__SecretKey=0123456789abcdef0123456789abcdef',
        'Jwt__KeyVersion=v2-2026-07',
        'Jwt__RotationWindowDays=30',
        'SITE_BASEURL=https://example.com',
        'CORS_ALLOWED_HOSTS=https://example.com',
        'APP_ALLOWED_HOSTS=example.com',
        'FIDO2_SERVER_DOMAIN=example.com',
        'REVERSE_PROXY_KNOWN_PROXIES=127.0.0.1',
        'FSUSBLOG_SHARED_PUBLIC_ASSETS_VOLUME=fsusblog-public-assets-fixture',
        'FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME=fsusblog-data-protection-fixture',
        `FSUSBLOG_RELEASE_ASSET_STORE=${assetStore}`,
        'FSUSBLOG_ANONYMOUS_IDENTITY_MODE=1',
        'FSUSBLOG_ZK_PROD_ENABLED=true',
        'FSUSBLOG_ZK_TRUSTED_SETUP_VERIFIED=true',
        'FSUSBLOG_ZK_CREDENTIAL_READY=true',
        'FSUSBLOG_ZK_VERIFIER_ENABLED=true',
        'FSUSBLOG_ZK_CREDENTIAL_ISSUER_ENABLED=true',
        `FSUSBLOG_ZK_CONFIG_DIR=${configDir}`,
        `FSUSBLOG_ZK_SECRET_DIR=${secretDir}`,
        `FSUSBLOG_ZK_VERIFYING_KEY_HASH=${verifyingHash}`,
        'FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST=/app/config/zk/trusted.json',
        'FSUSBLOG_ZK_VERIFYING_KEY_MANIFEST=/app/config/zk/verifying.json',
        'FSUSBLOG_ZK_GROTH16_VERIFYING_KEY=/app/config/zk/comment.v5.vk',
        'FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_ID=issuer-v1',
        'FSUSBLOG_ZK_ISSUER_PUBLIC_KEY=/app/config/zk/issuer-public.key',
        'FSUSBLOG_ZK_ISSUER_PRIVATE_KEY=/app/secrets/zk/issuer-private.key',
        `FSUSBLOG_ZK_ISSUER_PUBLIC_KEY_HASH=${issuerHash}`
    ].join('\n') + '\n');
    const manifestFile = path.join(directory, 'release-manifest.json');
    writeReleaseManifestAtomic(manifestFile, createReleaseManifest(createInput()));
    return { directory, envFile, manifestFile, descriptorPath, receiptPath };
}

function deploymentEnvironment(overrides = {})
{
    const environment = { ...process.env };
    for (const key of [
        'FSUSBLOG_RELEASE_MANIFEST',
        'FSUSBLOG_RELEASE_ID',
        'FSUSBLOG_RELEASE_SLOT',
        'FSUSBLOG_COMMIT_SHA',
        'FSUSBLOG_IMAGE_REF',
        'FSUSBLOG_IMAGE_DIGEST',
        'FSUSBLOG_RELEASE_MANIFEST_HOST_PATH',
        'FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE'
    ])
    {
        delete environment[key];
    }
    return {
        ...environment,
        FSUSBLOG_INTERNAL_SLOT_OPERATION: '1',
        FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE: '20260710000000-aaaaaaaaaaaa',
        ...overrides
    };
}

test('manifest atomically binds commit image digest frontend wasm and toolchain', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-manifest-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, releaseId, 'release-manifest.json');
    const manifest = createReleaseManifest(createInput());

    writeReleaseManifestAtomic(file, manifest);
    const actual = readReleaseManifest(file, { expectedReleaseId: releaseId });

    assert.equal(actual.imageRef, `ghcr.io/fsusblog/app@${digest}`);
    assert.equal(actual.schema, 'fsusblog.release-manifest.v3');
    assert.equal(actual.schema, RELEASE_MANIFEST_SCHEMA);
    assert.equal(actual.imageTag, `ghcr.io/fsusblog/app:${releaseId}`);
    assert.equal(actual.frontendManifestHash, `sha256:${'b'.repeat(64)}`);
    assert.equal(actual.wasmArtifactHash, `sha256:${'c'.repeat(64)}`);
    assert.equal(actual.toolchain.dockerfileDigest, `sha256:${'d'.repeat(64)}`);
    assert.equal(actual.runtimeProfile.id, 'throughput-musl');
    assert.equal(actual.runtimeProfile.profileDigest, `sha256:${'f'.repeat(64)}`);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp-')), []);
});

test('manifest path is immutable and cannot be overwritten for the same release', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-immutable-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'release-manifest.json');
    const manifest = createReleaseManifest(createInput());
    writeReleaseManifestAtomic(file, manifest);
    const original = fs.readFileSync(file, 'utf8');

    assert.throws(
        () => writeReleaseManifestAtomic(file, createReleaseManifest(createInput())),
        error => error?.code === 'EEXIST'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), []);
});

test('manifest rejects mutable tags digest mismatches corruption and sensitive fields', () =>
{
    const valid = createReleaseManifest(createInput());
    const cases = [
        { ...valid, releaseId: 'latest', imageTag: 'ghcr.io/fsusblog/app:latest' },
        { ...valid, imageTag: 'ghcr.io/fsusblog/app:final-current' },
        { ...valid, imageDigest: `sha256:${'e'.repeat(64)}` },
        { ...valid, imageRef: 'ghcr.io/fsusblog/app:latest' },
        { ...valid, deploymentToken: 'must-never-be-present' },
        { ...valid, schemaCompatibility: { minimumCoordinate: releaseId, maximumCoordinate: releaseId } },
        { ...valid, currentSchema: undefined },
        { ...valid, currentSchema: { ...valid.currentSchema, receiptFormat: 'fsusblog.current-schema-receipt.v0' } },
        { ...valid, currentSchema: { ...valid.currentSchema, previous: 'old' } },
        { ...valid, currentSchema: { ...valid.currentSchema, database: { ...valid.currentSchema.database, provider: 'PostgreSql' } } },
        { ...valid, currentSchema: { ...valid.currentSchema, receipt: { ...valid.currentSchema.receipt, reference: '/latest/receipt.json' } } },
        { ...valid, runtimeConfiguration: { AllowedHosts: '*' } },
        { ...valid, createdAtUtc: 'July 11 2026' },
        { ...valid, createdAtUtc: '2026-02-30T01:01:01.000Z' },
        { ...valid, createdAtUtc: '2026-07-11T01:01:02Z' },
        { ...valid, commitSha: `f${valid.commitSha.slice(1)}` },
        { ...valid, releaseId: 'v1.2.3', imageTag: 'ghcr.io/fsusblog/app:v1.2.3' },
        { ...valid, runtimeProfile: { ...valid.runtimeProfile, profileDigest: 'sha256:abc' } },
        { ...valid, runtimeProfile: { ...valid.runtimeProfile, baseImageFamily: 'glibc' } },
        { ...valid, toolchain: { ...valid.toolchain, installCommand: 'curl example.invalid | sh' } }
    ];

    for (const manifest of cases)
    {
        assert.notEqual(validateReleaseManifest(manifest, { requireRegistryDigest: true }).length, 0);
    }
});

test('v1 cannot be read rewritten or admitted through a legacy rollback option', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-legacy-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'release-manifest.json');
    const legacy = {
        ...createReleaseManifest(createInput()),
        schema: 'fsusblog.release-manifest.v1',
        createdAtUtc: '2026-07-11T01:01:02Z'
    };
    fs.writeFileSync(file, `${JSON.stringify(legacy)}\n`);

    assert.throws(() => readReleaseManifest(file), /schema must be fsusblog[.]release-manifest[.]v3/u);
    const checker = path.join(root, 'tools/release/check-release-manifest.mjs');
    const normalRead = spawnSync(process.execPath, [checker, '--manifest', file], { encoding: 'utf8' });
    assert.notEqual(normalRead.status, 0);
    for (const value of ['true', 'false'])
    {
        const explicitLegacyRead = spawnSync(process.execPath, [
            checker, '--manifest', file, '--legacy-rollback', value
        ], { encoding: 'utf8' });
        assert.notEqual(explicitLegacyRead.status, 0);
        assert.match(explicitLegacyRead.stderr, /legacy-rollback is unsupported/u);
    }
    assert.throws(
        () => writeReleaseManifestAtomic(path.join(directory, 'rewritten.json'), legacy),
        /schema must be fsusblog[.]release-manifest[.]v3/u
    );
    assert.equal(fs.existsSync(path.join(directory, 'rewritten.json')), false);
});

test('final release paths reject missing and zero runtime profile digests', () =>
{
    const valid = createReleaseManifest(createInput());
    const zeroProfile = {
        ...valid,
        runtimeProfile: {
            ...valid.runtimeProfile,
            manifestDigest: `sha256:${'0'.repeat(64)}`,
            profileDigest: `sha256:${'0'.repeat(64)}`
        }
    };
    const errors = validateReleaseManifest(zeroProfile, {
        requireRegistryDigest: true,
        requireConcreteRuntimeProfile: true
    });
    assert.ok(errors.some((error) => error.includes('manifestDigest must not be the zero digest')));
    assert.ok(errors.some((error) => error.includes('profileDigest must not be the zero digest')));
    assert.throws(
        () => createReleaseManifest(createInput({ runtimeProfile: undefined })),
        /must not be the zero digest/u
    );
});

test('manifest creator CLI writes the same digest-bound schema consumed by deploy', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const manifestFile = path.join(directory, releaseId, 'release-manifest.json');
    const input = createInput();
    const receiptFile = path.join(directory, 'synthetic-schema-projection.json');
    // Byte-binding input only: the canonical C# codec rejects this incomplete
    // unit document, so it cannot be mistaken for native verification evidence.
    const receiptProjection = {
        format: input.currentSchema.receiptFormat,
        status: 'verified-current',
        contentDigest: input.currentSchema.receiptContentDigest,
        target: input.currentSchema.target,
        database: input.currentSchema.database,
        actualSchemaDigest: input.currentSchema.actualSchemaDigest
    };
    fs.writeFileSync(receiptFile, JSON.stringify(receiptProjection));
    const receiptSha256 = crypto.createHash('sha256').update(fs.readFileSync(receiptFile)).digest('hex');
    const rosterFile = path.join(directory, 'identity-roster.json');
    fs.writeFileSync(rosterFile, JSON.stringify(input.identity));
    const result = spawnSync(process.execPath, [
        path.join(root, 'tools/release/create-release-manifest.mjs'),
        '--output', manifestFile,
        '--release-id', input.releaseId,
        '--commit-sha', input.commitSha,
        '--image-repository', input.imageRepository,
        '--image-tag', input.imageTag,
        '--image-digest', input.imageDigest,
        '--frontend-manifest-hash', input.frontendManifestHash,
        '--wasm-artifact-hash', input.wasmArtifactHash,
        '--identity-roster', rosterFile,
        '--identity-roster-sha256', crypto.createHash('sha256').update(fs.readFileSync(rosterFile)).digest('hex'),
        '--current-schema-receipt', receiptFile,
        '--current-schema-receipt-sha256', receiptSha256,
        '--dotnet-version', input.dotnetVersion,
        '--node-version', input.nodeVersion,
        '--docker-version', input.dockerVersion,
        '--dockerfile-digest', input.dockerfileDigest,
        '--runtime-profile-id', input.runtimeProfile.id,
        '--runtime-profile-manifest-digest', input.runtimeProfile.manifestDigest,
        '--runtime-profile-digest', input.runtimeProfile.profileDigest,
        '--runtime-base-family', input.runtimeProfile.baseImageFamily,
        '--target-runtime', input.runtimeProfile.targetRuntime,
        '--publish-single-file', String(input.runtimeProfile.singleFile),
        '--publish-ready-to-run', String(input.runtimeProfile.readyToRun),
        '--tiered-pgo', String(input.runtimeProfile.tieredPgo),
        '--quick-jit-for-loops', String(input.runtimeProfile.quickJitForLoops),
        '--server-gc', String(input.runtimeProfile.serverGc),
        '--native-aot', String(input.runtimeProfile.nativeAot),
        '--thread-pool-mode', input.runtimeProfile.threadPoolMode,
        '--topology-mode', input.runtimeProfile.topologyMode,
        '--created-at-utc', input.createdAtUtc
    ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: deploymentEnvironment() });

    assert.equal(result.status, 0, result.stderr);
    const actual = readReleaseManifest(manifestFile, {
        expectedReleaseId: releaseId,
        expectedImageRef: `ghcr.io/fsusblog/app@${digest}`
    });
    assert.equal(actual.commitSha, input.commitSha);
    assert.equal(actual.imageDigest, digest);
    assert.equal(actual.registryDigestVerified, true);
});

test('production build preflight rejects mutable aliases and ambiguous modes before Docker runs', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-build-preflight-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binDir = path.join(directory, 'bin');
    const dockerMarker = path.join(directory, 'docker-called');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env bash\ntouch "${dockerMarker}"\nexit 97\n`, { mode: 0o755 });
    const baseEnv = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GITHUB_PACKAGES_TOKEN: 'fixture-token',
        FSUSBLOG_COMMIT_SHA: createInput().commitSha,
        FSUSBLOG_RELEASE_ID: releaseId,
        FSUSBLOG_RELEASE_CREATED_AT_UTC: createInput().createdAtUtc,
        FSUSBLOG_FINAL_IMAGE_REPOSITORY: 'fsusblogapp',
        FSUSBLOG_FINAL_IMAGE_TARGET: 'final',
        FSUSBLOG_FINAL_PUSH: '1',
        FSUSBLOG_FINAL_LOCAL_ONLY: '0',
        FSUSBLOG_FINAL_SKIP_WASM: '1',
        FSUSBLOG_CURRENT_SCHEMA_RECEIPT: createInput().currentSchema.receipt.reference,
        FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256: createInput().currentSchema.receipt.sha256
    };
    const cases = [
        [{ FSUSBLOG_RELEASE_ID: 'latest' }, /does not match the canonical release identity snapshot/u],
        [{ FSUSBLOG_FINAL_IMAGE_REPOSITORY: 'ghcr.io/fsusblog/app:latest' }, /must be an untagged lowercase repository/u],
        [{ FSUSBLOG_FINAL_PUSH: '1', FSUSBLOG_FINAL_LOCAL_ONLY: '1' }, /set exactly one/u]
    ];

    for (const [overrides, expected] of cases)
    {
        fs.rmSync(dockerMarker, { force: true });
        const result = spawnSync('bash', [path.join(root, 'tools/build-final-image.sh')], {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000,
            env: { ...baseEnv, ...overrides }
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
        assert.equal(fs.existsSync(dockerMarker), false);
    }
});

test('production build generates one immutable release id when the caller omits it', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-build-generated-id-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binDir = path.join(directory, 'bin');
    const dockerArgs = path.join(directory, 'docker-args.txt');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
        path.join(binDir, 'docker'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${dockerArgs}"\nexit 97\n`,
        { mode: 0o755 }
    );
    fs.writeFileSync(
        path.join(binDir, 'node'),
        `#!/usr/bin/env bash\nif [[ "\${1:-}" == *check-wasm-artifact-ownership.mjs || "\${1:-}" == *wasm-build-receipt.mjs ]]; then exit 0; fi\nexec "${process.execPath}" "$@"\n`,
        { mode: 0o755 }
    );
    const commit = createInput().commitSha;
    const environment = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GITHUB_PACKAGES_TOKEN: 'fixture-token',
        FSUSBLOG_COMMIT_SHA: commit,
        FSUSBLOG_RELEASE_CREATED_AT_UTC: createInput().createdAtUtc,
        FSUSBLOG_FINAL_IMAGE_REPOSITORY: 'fsusblogapp',
        FSUSBLOG_FINAL_IMAGE_TARGET: 'final',
        FSUSBLOG_FINAL_PUSH: '0',
        FSUSBLOG_FINAL_LOCAL_ONLY: '1',
        FSUSBLOG_FINAL_SKIP_WASM: '1',
        FSUSBLOG_CURRENT_SCHEMA_RECEIPT: createInput().currentSchema.receipt.reference,
        FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256: createInput().currentSchema.receipt.sha256
    };
    delete environment.FSUSBLOG_RELEASE_ID;
    delete environment.FSUSBLOG_FINAL_IMAGE_TAG;

    const result = spawnSync('bash', [path.join(root, 'tools/build-final-image.sh')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: environment
    });

    assert.equal(result.status, 97, result.stderr);
    const invocation = fs.readFileSync(dockerArgs, 'utf8');
    const generated = invocation.match(/FSUSBLOG_RELEASE_ID=(\d{14}-[0-9a-f]{12})/u)?.[1];
    assert.ok(generated);
    assert.equal(generated.endsWith(`-${commit.slice(0, 12)}`), true);
    assert.match(invocation, /FSUSBLOG_RELEASE_CREATED_AT_UTC=2026-07-11T01:01:01Z/u);
    assert.match(invocation, /org[.]opencontainers[.]image[.]created=2026-07-11T01:01:01Z/u);
    assert.match(invocation, new RegExp(`(?:^| )-t fsusblogapp:${generated}(?: |$)`, 'u'));
    assert.match(result.stdout, new RegExp(`building immutable image fsusblogapp:${generated} for release ${generated}`, 'u'));
});

test('deploy input checker emits exact release slot digest and rollback target', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-input-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const manifestFile = path.join(directory, 'release-manifest.json');
    writeReleaseManifestAtomic(manifestFile, createReleaseManifest(createInput()));

    const result = spawnSync(process.execPath, [
        path.join(root, 'tools/release/check-release-manifest.mjs'),
        '--manifest', manifestFile,
        '--release-id', releaseId,
        '--image-ref', `ghcr.io/fsusblog/app@${digest}`,
        '--slot', 'candidate'
    ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: deploymentEnvironment() });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.releaseId, releaseId);
    assert.equal(output.slot, 'candidate');
    assert.equal(output.imageDigest, digest);
    assert.equal(output.rollbackTarget, releaseId);
});

test('deploy input checker blocks missing identity digest mismatch mutable tag and damaged JSON', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-input-negative-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const checker = path.join(root, 'tools/release/check-release-manifest.mjs');
    const valid = createReleaseManifest(createInput());
    const cases = [
        ['missing-release.json', { ...valid, releaseId: '', imageTag: 'ghcr.io/fsusblog/app:' }, []],
        ['mutable-tag.json', { ...valid, imageTag: 'ghcr.io/fsusblog/app:final-current' }, []],
        ['digest-mismatch.json', valid, ['--image-digest', `sha256:${'e'.repeat(64)}`]],
        ['damaged.json', '{"schema":', []]
    ];

    for (const [name, contents, extraArgs] of cases)
    {
        const manifestFile = path.join(directory, name);
        fs.writeFileSync(manifestFile, typeof contents === 'string' ? contents : `${JSON.stringify(contents)}\n`);
        const result = spawnSync(process.execPath, [checker, '--manifest', manifestFile, ...extraArgs], {
            cwd: root,
            encoding: 'utf8',
            timeout: 10_000
        });
        assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
        assert.match(result.stderr, /\[check-release-manifest\]/u);
    }
});

test('production dry-run reports immutable release slot digest and rollback before no-build deploy', (t) =>
{
    const { envFile, manifestFile, descriptorPath, receiptPath } = createDeploymentFixture(t);

    const result = spawnSync('bash', [
        path.join(root, 'tools/deploy-production.sh'),
        '--env-file', envFile,
        '--release-manifest', manifestFile,
        '--release-id', releaseId,
        '--image-ref', `ghcr.io/fsusblog/app@${digest}`,
        '--spa-manifest-descriptor', descriptorPath,
        '--production-build-receipt', receiptPath,
        '--slot', 'green',
        '--dry-run'
    ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: deploymentEnvironment() });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`release=${releaseId} slot=green digest=${digest}`));
    assert.match(result.stdout, /rollbackTarget=20260711010101-0123456789ab/u);
    assert.match(result.stdout, /dry-run command: docker pull ghcr\.io\/fsusblog\/app@sha256/u);
    assert.match(result.stdout, /verify pulled image digest and OCI release labels/u);
    assert.match(result.stdout, /up -d --no-build --pull always/u);
    assert.doesNotMatch(result.stdout, /build-final-image\.sh/u);
});

test('production deploy rejects a pulled digest or OCI release label that disagrees with manifest', (t) =>
{
    const {
        directory,
        envFile,
        manifestFile,
        descriptorPath,
        receiptPath
    } = createDeploymentFixture(t);
    const binDir = path.join(directory, 'bin');
    fs.mkdirSync(binDir);
    const fakeDocker = path.join(binDir, 'docker');
    fs.writeFileSync(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "pull" ]]; then exit 0; fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  case "\${5:-}" in
    *RepoDigests*) printf '%s\\n' "\${FAKE_REPO_DIGESTS:-}" ;;
    *image.version*) printf '%s\\n' "\${FAKE_RELEASE_LABEL:-}" ;;
    *image.created*) printf '%s\\n' "\${FAKE_CREATED_LABEL:-}" ;;
    *image.revision*) printf '%s\\n' "\${FAKE_COMMIT_LABEL:-}" ;;
    *) exit 41 ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then exit 0; fi
exit 42
`, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const baseArgs = [
        path.join(root, 'tools/deploy-production.sh'),
        '--env-file', envFile,
        '--release-manifest', manifestFile,
        '--spa-manifest-descriptor', descriptorPath,
        '--production-build-receipt', receiptPath,
        '--slot', 'green',
        '--skip-up'
    ];
    const baseEnv = deploymentEnvironment({
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_REPO_DIGESTS: `ghcr.io/fsusblog/app@${digest}`,
        FAKE_RELEASE_LABEL: releaseId,
        FAKE_CREATED_LABEL: '2026-07-11T01:01:01.000Z',
        FAKE_COMMIT_LABEL: createInput().commitSha
    });

    const digestMismatch = spawnSync('bash', baseArgs, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...baseEnv, FAKE_REPO_DIGESTS: `ghcr.io/fsusblog/app@sha256:${'e'.repeat(64)}` }
    });
    assert.notEqual(digestMismatch.status, 0);
    assert.match(digestMismatch.stderr, /pulled image digest does not match release manifest/u);

    const labelMismatch = spawnSync('bash', baseArgs, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...baseEnv, FAKE_RELEASE_LABEL: '20260711020202-deadbeefcafe' }
    });
    assert.notEqual(labelMismatch.status, 0);
    assert.match(labelMismatch.stderr, /pulled image release label does not match manifest/u);

    const createdMismatch = spawnSync('bash', baseArgs, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...baseEnv, FAKE_CREATED_LABEL: '2026-07-11T01:01:02Z' }
    });
    assert.notEqual(createdMismatch.status, 0);
    assert.match(createdMismatch.stderr, /pulled image created label does not match manifest/u);
});

test('current receipt byte binding refuses missing drifted oversized linked and non-current artifacts', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-schema-bytes-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binding = createCurrentSchemaReleaseBindingFixture();
    const source = binding.receipt.reference;
    const expected = binding.receipt.sha256;
    assert.deepEqual(readCurrentSchemaReceiptReleaseBinding(source, expected), binding);
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(source, '0'.repeat(64)), /digest mismatch/u);
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding('relative-receipt.json', expected), /canonical path/u);
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(path.join(directory, 'missing.json'), expected), /ENOENT/u);

    const link = path.join(directory, 'symlink.json');
    fs.symlinkSync(source, link);
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(link, expected), /canonical regular file/u);
    const hardLink = path.join(directory, 'hardlink.json');
    const localCopy = path.join(directory, 'local-copy.json');
    fs.copyFileSync(source, localCopy);
    fs.linkSync(localCopy, hardLink);
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(hardLink, expected), /canonical regular file/u);
    fs.unlinkSync(hardLink);

    const large = path.join(directory, 'oversized.json');
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(large, expected), /bounded canonical/u);
    const empty = path.join(directory, 'empty.json');
    fs.writeFileSync(empty, '');
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(empty, expected), /bounded canonical/u);

    const rejected = path.join(directory, 'rejected-unit-projection.json');
    const projection = JSON.parse(fs.readFileSync(source, 'utf8'));
    fs.writeFileSync(rejected, JSON.stringify({ ...projection, status: 'rejected' }));
    const rejectedDigest = crypto.createHash('sha256').update(fs.readFileSync(rejected)).digest('hex');
    assert.throws(() => readCurrentSchemaReceiptReleaseBinding(rejected, rejectedDigest), /format\/status/u);
    assert.deepEqual(readCurrentSchemaReceiptReleaseBinding(source, expected), binding);
});

test('current schema projection drift and removed window arguments fail before deployment or manifest publication', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-schema-projection-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const valid = createReleaseManifest(createInput());
    assert.throws(() => createReleaseManifest(createInput({ schemaMinimumCoordinate: releaseId })), /unsupported/u);
    assert.throws(() => createReleaseManifest(createInput({ schemaMaximumCoordinate: releaseId })), /unsupported/u);
    const file = path.join(directory, 'release-manifest.json');
    for (const mutation of [
        { ...valid.currentSchema, receiptContentDigest: 'f'.repeat(64) },
        { ...valid.currentSchema, actualSchemaDigest: 'f'.repeat(64) },
        { ...valid.currentSchema, target: { ...valid.currentSchema.target, sourceDigest: 'f'.repeat(64) } },
        { ...valid.currentSchema, database: { ...valid.currentSchema.database, provider: 1 } },
        { ...valid.currentSchema, database: { ...valid.currentSchema.database, databaseId: 'another-database' } }
    ])
    {
        const resealed = { ...valid, currentSchema: mutation };
        resealed.candidateId = deriveReleaseCandidateId(resealed);
        resealed.contentDigest = deriveReleaseManifestContentDigest(resealed);
        fs.writeFileSync(file, JSON.stringify(resealed));
        const result = spawnSync(process.execPath, [path.join(root, 'tools/release/check-release-manifest.mjs'),
            '--manifest', file], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /differs from explicit receipt bytes/u);
    }
    const receiptOnly = spawnSync(process.execPath, [path.join(root, 'tools/release/check-release-manifest.mjs'),
        '--receipt-byte-binding', 'true',
        '--current-schema-receipt', valid.currentSchema.receipt.reference,
        '--current-schema-receipt-sha256', valid.currentSchema.receipt.sha256], { encoding: 'utf8' });
    assert.equal(receiptOnly.status, 0, receiptOnly.stderr);
    assert.equal(JSON.parse(receiptOnly.stdout).qualificationEligible, false);
    assert.equal(JSON.parse(receiptOnly.stdout).status, 'byte-bound');
});


test('candidate identity follows content while manifest sealing binds deployment labels and artifact references', () =>
{
    const input = createInput();
    const manifest = createReleaseManifest(input);
    const relocated = createReleaseManifest({ ...input,
        currentSchema: { ...input.currentSchema, receipt: { ...input.currentSchema.receipt,
            reference: '/isolated-other-location/current-schema.json' } },
        createdAtUtc: '2026-07-11T01:01:02.000Z',
        releaseId: '20260711010102-0123456789ab',
        imageTag: 'ghcr.io/fsusblog/app:20260711010102-0123456789ab' });
    assert.equal(relocated.candidateId, manifest.candidateId);
    assert.notEqual(relocated.contentDigest, manifest.contentDigest);
    assert.throws(() => createReleaseManifest({ ...input, candidateId: manifest.candidateId }), /computed/u);
    assert.throws(() => createReleaseManifest({ ...input, contentDigest: manifest.contentDigest }), /computed/u);
    for (const change of [
        value =>
        {
            value.imageDigest = `sha256:${'1'.repeat(64)}`;
            value.imageRef = `${value.imageRepository}@${value.imageDigest}`;
        },
        value =>
        {
            value.frontendManifestHash = `sha256:${'2'.repeat(64)}`;
        },
        value =>
        {
            value.wasmArtifactHash = `sha256:${'3'.repeat(64)}`;
        },
        value =>
        {
            value.currentSchema.target.contentDigest = '4'.repeat(64);
        },
        value =>
        {
            value.currentSchema.receipt.sha256 = '5'.repeat(64);
        },
        value =>
        {
            value.currentSchema.database.databaseId = 'other-database';
        },
        value =>
        {
            value.runtimeProfile.profileDigest = `sha256:${'6'.repeat(64)}`;
        },
        value =>
        {
            value.toolchain.dotnetVersion = 'different-build-toolchain';
        },
        value =>
        {
            value.releaseId = '20260711010102-0123456789ab';
            value.createdAtUtc = '2026-07-11T01:01:02.000Z';
            value.imageTag = `${value.imageRepository}:${value.releaseId}`;
        }
    ])
    {
        const mutated = structuredClone(manifest);
        change(mutated);
        assert.ok(validateReleaseManifest(mutated).some(error => /contentDigest/u.test(error)));
    }
    for (const alias of ['slot', 'directory', 'timestamp', 'releaseAlias', 'previous', 'minimum', 'maximum', 'range'])
    {
        assert.ok(validateReleaseManifest({ ...manifest, [alias]: 'green' }).some(error => /not allowed/u.test(error)));
    }
});


test('closed identity roster binds one current build and rejects missing range mixed and alias identities', () =>
{
    const original = createReleaseManifest(createInput());
    for (const mutation of [
        manifest =>
        {
            delete manifest.identity;
        },
        manifest =>
        {
            manifest.identity.frontend.buildId = 'other-build';
        },
        manifest =>
        {
            manifest.identity.backend.imageDigest = `sha256:${'9'.repeat(64)}`;
        },
        manifest =>
        {
            manifest.identity.source.commitSha = '9'.repeat(40);
        },
        manifest =>
        {
            manifest.identity.contracts.wasmAbi.minimum = '1';
        },
        manifest =>
        {
            manifest.identity.contracts.aeds.version = '>=1';
        },
        manifest =>
        {
            manifest.identity.serviceWorker.previousNamespace = 'old';
        },
        manifest =>
        {
            manifest.identity.runtime.config.artifact.reference = '/artifacts/latest/config.json';
        },
        manifest =>
        {
            manifest.identity.signing.algorithm = 'none';
        },
        manifest =>
        {
            delete manifest.identity.provenance;
        }
    ])
    {
        const changed = structuredClone(original);
        mutation(changed);
        changed.candidateId = deriveReleaseCandidateId(changed);
        changed.contentDigest = deriveReleaseManifestContentDigest(changed);
        assert.ok(validateReleaseManifest(changed).length > 0);
    }
    for (const key of ['aeds', 'protocol', 'wasmAbi', 'notification'])
    {
        const changed = structuredClone(original);
        changed.identity.contracts[key].artifact.sha256 = `sha256:${'9'.repeat(64)}`;
        assert.notEqual(deriveReleaseCandidateId(changed), original.candidateId);
    }
    const moved = structuredClone(original);
    moved.identity.frontend.assetManifest.reference = '/other/artifacts/assets.json';
    assert.equal(deriveReleaseCandidateId(moved), original.candidateId);
    assert.notEqual(deriveReleaseManifestContentDigest(moved), original.contentDigest);
});


function signingFixture(context)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-signature-source-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const input = createInput();
    function writeArtifact(artifact, bytes)
    {
        const reference = path.join(directory, path.basename(artifact.reference));
        fs.writeFileSync(reference, bytes);
        artifact.reference = reference;
        artifact.sha256 = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    }
    function populate(value)
    {
        if (value && typeof value === 'object')
        {
            if (Object.hasOwn(value, 'reference'))
            {
                writeArtifact(value, Buffer.from(`source-only artifact ${value.reference}`));
            }
            else
            {
                for (const nested of Object.values(value))
                {
                    populate(nested);
                }
            }
        }
    }
    populate(input.identity);
    const assetBytes = Buffer.from('source-only-js');
    fs.mkdirSync(path.join(directory, 'assets'));
    fs.writeFileSync(path.join(directory, 'assets/current.js'), assetBytes);
    const inventory = { schema: 'fsusblog.release-assets.v1', releaseId: input.releaseId, slot: 'blue',
        frontendBuildId: input.releaseId, compatibilityFile: null, files: [{ path: 'assets/current.js',
            sha256: `sha256:${crypto.createHash('sha256').update(assetBytes).digest('hex')}`, bytes: assetBytes.length, class: 'immutable-static',
            releaseUrl: `/release-assets/${input.releaseId}/assets/current.js`, cacheControl: 'public,max-age=31536000,immutable' }] };
    writeArtifact(input.identity.frontend.assetManifest, Buffer.from(canonicalize(inventory)));
    writeArtifact(input.identity.signing.publicKey, publicKey.export({ type: 'spki', format: 'pem' }));
    const policy = { schema: 'fsusblog.release-signing-trust.v1', version: input.identity.signing.trustPolicy.version,
        allowedKeys: [{ keyId: input.identity.signing.keyId, algorithm: 'ed25519', publicKeySha256: input.identity.signing.publicKey.sha256 }] };
    writeArtifact(input.identity.signing.trustPolicy.artifact, Buffer.from(canonicalize(policy)));
    input.frontendManifestHash = input.identity.frontend.buildManifest.sha256;
    input.wasmArtifactHash = input.identity.frontend.wasmArtifact.sha256;
    const unsigned = createReleaseManifest(input);
    const manifest = signReleaseManifest(unsigned, privateKey);
    const options = { manifest, releaseIdContract: RELEASE_ID_CONTRACT,
        trustPolicyReference: input.identity.signing.trustPolicy.artifact.reference,
        trustPolicySha256: input.identity.signing.trustPolicy.artifact.sha256,
        readBytes: reference => fs.readFileSync(reference) };
    return { directory, privateKey, unsigned, manifest, options };
}

test('real ephemeral Ed25519 signatures bind current artifacts and independent trust without native qualification', context =>
{
    const fixture = signingFixture(context);
    const result = verifyReleaseManifestArtifacts(fixture.options);
    assert.equal(result.signatureVerified, true);
    assert.equal(result.nativeClaimEligible, false);
    assert.equal(result.actualDatabaseObserved, false);
    assert.equal(result.candidateId, fixture.manifest.candidateId);
    assert.equal(result.currentAssets[0].mediaType, 'text/javascript');
    assert.equal(result.artifacts.length, releaseIdentityRosterArtifacts(fixture.manifest.identity).length + 1);
    assert.deepEqual(verifyReleaseManifestArtifacts(fixture.options), result);
    const manifestFile = path.join(fixture.directory, 'manifest.json');
    writeReleaseManifestAtomic(manifestFile, fixture.manifest);
    const checked = spawnSync(process.execPath, [path.join(root, 'tools/release/check-release-manifest.mjs'),
        '--manifest', manifestFile, '--verify-artifacts', 'true', '--trust-policy', fixture.options.trustPolicyReference,
        '--trust-policy-sha256', fixture.options.trustPolicySha256], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).qualificationEligible, false);
    assert.equal(JSON.parse(checked.stdout).candidateId, fixture.manifest.candidateId);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, manifest: fixture.unsigned }), /unsigned/u);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, trustPolicyReference: undefined }), /independent trust/u);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, trustPolicySha256: `sha256:${'9'.repeat(64)}` }), /independent trust/u);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, readBytes: () => Buffer.from('tampered') }), /byte digest/u);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, readBytes: () =>
    {
        throw new Error('missing artifact');
    } }), /missing artifact/u);
    const changedSignature = Buffer.from(fixture.manifest.signature, 'base64');
    changedSignature[0] ^= 1;
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, manifest: {
        ...fixture.manifest, signature: changedSignature.toString('base64') } }), /signature verification/u);
    assert.throws(() => signReleaseManifest(fixture.unsigned, crypto.generateKeyPairSync('ed25519').privateKey), /bound public key/u);
    const other = structuredClone(fixture.manifest);
    other.identity.serviceWorker.version = 'other-current-version';
    other.candidateId = deriveReleaseCandidateId(other);
    other.contentDigest = deriveReleaseManifestContentDigest(other);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, manifest: other }), /signature verification/u);
    const wrongReceipt = structuredClone(fixture.unsigned);
    wrongReceipt.currentSchema.receiptContentDigest = '9'.repeat(64);
    wrongReceipt.candidateId = deriveReleaseCandidateId(wrongReceipt);
    wrongReceipt.contentDigest = deriveReleaseManifestContentDigest(wrongReceipt);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options,
        manifest: signReleaseManifest(wrongReceipt, fixture.privateKey) }), /receipt byte projection mismatch/u);
    const policyFile = fixture.options.trustPolicyReference;
    const before = fs.readFileSync(policyFile);
    fs.writeFileSync(policyFile, 'not the admitted policy');
    assert.throws(() => verifyReleaseManifestArtifacts(fixture.options), /byte digest/u);
    fs.writeFileSync(policyFile, before);
    assert.deepEqual(verifyReleaseManifestArtifacts(fixture.options), result);
});


test('signature authority rejects coherent resealing of unadmitted duplicate and open trust policies', context =>
{
    const fixture = signingFixture(context);
    const originalPolicy = JSON.parse(fs.readFileSync(fixture.options.trustPolicyReference));
    for (const alter of [
        policy =>
        {
            policy.allowedKeys[0].keyId = 'unadmitted-key';
        },
        policy =>
        {
            policy.allowedKeys.push({ ...policy.allowedKeys[0] });
        },
        policy =>
        {
            policy.maximumVersion = 'future';
        },
        policy =>
        {
            policy.allowedKeys[0].algorithm = 'none';
        }
    ])
    {
        const policy = structuredClone(originalPolicy);
        alter(policy);
        const bytes = Buffer.from(canonicalize(policy));
        fs.writeFileSync(fixture.options.trustPolicyReference, bytes);
        const changed = structuredClone(fixture.unsigned);
        const sha256 = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
        changed.identity.signing.trustPolicy.artifact.sha256 = sha256;
        changed.candidateId = deriveReleaseCandidateId(changed);
        changed.contentDigest = deriveReleaseManifestContentDigest(changed);
        const signed = signReleaseManifest(changed, fixture.privateKey);
        assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, manifest: signed,
            trustPolicySha256: sha256 }), /trust/u);
    }
    const duplicateBytes = Buffer.from(`{"version":"shadow",${canonicalize(originalPolicy).slice(1)}`);
    fs.writeFileSync(fixture.options.trustPolicyReference, duplicateBytes);
    const duplicate = structuredClone(fixture.unsigned);
    const duplicateSha = `sha256:${crypto.createHash('sha256').update(duplicateBytes).digest('hex')}`;
    duplicate.identity.signing.trustPolicy.artifact.sha256 = duplicateSha;
    duplicate.candidateId = deriveReleaseCandidateId(duplicate);
    duplicate.contentDigest = deriveReleaseManifestContentDigest(duplicate);
    assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options,
        manifest: signReleaseManifest(duplicate, fixture.privateKey), trustPolicySha256: duplicateSha }), /canonical JSON/u);
});


test('atomic candidate plan verifies exact signed bytes and preserves active identity when native admission is unavailable', context =>
{
    const fixture = signingFixture(context);
    const manifestFile = path.join(fixture.directory, 'activation-manifest.json');
    writeReleaseManifestAtomic(manifestFile, fixture.manifest);
    const activeBefore = { candidateId: `sha256:${'8'.repeat(64)}`, manifestContentDigest: `sha256:${'9'.repeat(64)}` };
    const prepared = createCurrentActivationPlan({ manifest: fixture.manifest, manifestReference: manifestFile,
        manifestSha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex')}`,
        activeBefore, releaseIdContract: RELEASE_ID_CONTRACT });
    const verified = verifyCurrentActivationArtifacts(prepared, fixture.options);
    assert.equal(verified.plan.phase, 'verified');
    assert.equal(verified.evidence.nativeClaimEligible, false);
    assert.deepEqual(verified.plan.currentActive, activeBefore);
    assert.deepEqual(verifyCurrentActivationArtifacts(verified.plan, fixture.options), verified);
    assert.throws(() => beginCurrentActivationSwitch(verified.plan, fixture.options), /native_current_schema_admission_bridge_unconfigured/u);
    assert.deepEqual(verified.plan.currentActive, activeBefore);
    const failed = failCurrentActivation(verified.plan, fixture.manifest, 'native_admission_unconfigured');
    assert.equal(failed.phase, 'failed-before-switch');
    const discarded = discardUnactivatedCandidate(failed, fixture.manifest);
    assert.equal(discarded.phase, 'rollback-to-unactivated-candidate');
    assert.deepEqual(discarded.currentActive, activeBefore);
    assert.throws(() => verifyCurrentActivationArtifacts(discarded, fixture.options), /failed or activated/u);
    for (const mutate of [
        plan =>
        {
            plan.phase = 'http-healthy';
        },
        plan =>
        {
            plan.nativeAdmission.claimEligible = true;
        },
        plan =>
        {
            plan.currentActive.candidateId = fixture.manifest.candidateId;
        },
        plan =>
        {
            plan.closure.frontendManifestHash = `sha256:${'7'.repeat(64)}`;
        },
        plan =>
        {
            plan.closure.identity.contracts.wasmAbi.version = 'other-abi';
        },
        plan =>
        {
            plan.manifest.reference = '/artifacts/latest/manifest.json';
        },
        plan =>
        {
            plan.previousFrontend = 'old';
        },
        plan =>
        {
            plan.failurePolicy.afterSwitch = 'keep-old-backend';
        }
    ])
    {
        const changed = structuredClone(prepared);
        mutate(changed);
        assert.throws(() => validateCurrentActivationPlan(changed, fixture.manifest), /current activation/u);
    }
    // Value-model recovery only: no native grant or real gateway switch occurred.
    const modelOnlyActive = structuredClone(prepared);
    modelOnlyActive.phase = 'active';
    modelOnlyActive.currentActive = { candidateId: fixture.manifest.candidateId, manifestContentDigest: fixture.manifest.contentDigest };
    delete modelOnlyActive.contentDigest;
    modelOnlyActive.contentDigest = `sha256:${digestValue(modelOnlyActive)}`;
    const requiresRestore = failCurrentActivation(modelOnlyActive, fixture.manifest, 'health_failed');
    assert.equal(requiresRestore.phase, 'restore-required');
    assert.throws(() => discardUnactivatedCandidate(requiresRestore, fixture.manifest), /unactivated failed/u);
    assert.throws(() => beginCurrentActivationSwitch(modelOnlyActive, fixture.options), /failed or activated/u);
    assert.throws(() => failCurrentActivation(failed, fixture.manifest, 'repeated_failure'), /already terminal/u);
    const planFile = path.join(fixture.directory, 'activation-plan.json');
    const createPlan = spawnSync(process.execPath, [path.join(root, 'tools/deployment/rollout-state.mjs'),
        'create-current-activation-plan', '--state', planFile, '--manifest', manifestFile,
        '--manifest-sha256', prepared.manifest.sha256, '--active-candidate', activeBefore.candidateId,
        '--active-manifest-digest', activeBefore.manifestContentDigest], { encoding: 'utf8' });
    assert.equal(createPlan.status, 0, createPlan.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(planFile)), prepared);
    const planSha = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(planFile)).digest('hex')}`;
    const checker = spawnSync(process.execPath, [path.join(root, 'tools/release/check-release-manifest.mjs'),
        '--manifest', manifestFile, '--verify-artifacts', 'true', '--activation-preflight', 'true',
        '--activation-plan', planFile, '--activation-plan-sha256', planSha,
        '--trust-policy', fixture.options.trustPolicyReference, '--trust-policy-sha256', fixture.options.trustPolicySha256], { encoding: 'utf8' });
    assert.notEqual(checker.status, 0);
    assert.match(checker.stderr, /native_current_schema_admission_bridge_unconfigured/u);
    const rolloutSource = fs.readFileSync(path.join(root, 'tools/deployment/release-rollout.sh'), 'utf8');
    const switchBody = rolloutSource.slice(rolloutSource.indexOf('StageGatewaySwitch()'), rolloutSource.indexOf('MarkGatewaySwitch()'));
    assert.ok(switchBody.indexOf('--activation-preflight true') < switchBody.indexOf('gateway-switch.sh'));
});


test('creator signs with owned pinned key bytes and refuses key drift and handwritten signature publication', context =>
{
    const fixture = signingFixture(context);
    const keyFile = path.join(fixture.directory, 'owned-private-key.pem');
    fs.writeFileSync(keyFile, fixture.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const keySha = crypto.createHash('sha256').update(fs.readFileSync(keyFile)).digest('hex');
    const rosterFile = path.join(fixture.directory, 'identity-roster.json');
    fs.writeFileSync(rosterFile, JSON.stringify(fixture.manifest.identity));
    const manifest = fixture.manifest;
    const args = ['--release-id', manifest.releaseId, '--created-at-utc', manifest.createdAtUtc, '--commit-sha', manifest.commitSha,
        '--image-repository', manifest.imageRepository, '--image-tag', manifest.imageTag, '--image-digest', manifest.imageDigest,
        '--frontend-manifest-hash', manifest.frontendManifestHash, '--wasm-artifact-hash', manifest.wasmArtifactHash,
        '--identity-roster', rosterFile, '--identity-roster-sha256', crypto.createHash('sha256').update(fs.readFileSync(rosterFile)).digest('hex'),
        '--current-schema-receipt', manifest.currentSchema.receipt.reference, '--current-schema-receipt-sha256', manifest.currentSchema.receipt.sha256,
        '--dotnet-version', manifest.toolchain.dotnetVersion, '--node-version', manifest.toolchain.nodeVersion,
        '--docker-version', manifest.toolchain.dockerVersion, '--dockerfile-digest', manifest.toolchain.dockerfileDigest];
    const names = { id: 'runtime-profile-id', manifestDigest: 'runtime-profile-manifest-digest', profileDigest: 'runtime-profile-digest',
        baseImageFamily: 'runtime-base-family', targetRuntime: 'target-runtime', singleFile: 'publish-single-file', readyToRun: 'publish-ready-to-run',
        tieredPgo: 'tiered-pgo', quickJitForLoops: 'quick-jit-for-loops', serverGc: 'server-gc', nativeAot: 'native-aot',
        threadPoolMode: 'thread-pool-mode', topologyMode: 'topology-mode' };
    for (const [key, flag] of Object.entries(names))
    {
        args.push(`--${flag}`, String(manifest.runtimeProfile[key]));
    }
    const signedFile = path.join(fixture.directory, 'signed-created-manifest.json');
    const signingArgs = ['--signing-key', keyFile, '--signing-key-sha256', keySha,
        '--trust-policy', fixture.options.trustPolicyReference, '--trust-policy-sha256', fixture.options.trustPolicySha256];
    const created = spawnSync(process.execPath, [path.join(root, 'tools/release/create-release-manifest.mjs'),
        ...args, '--output', signedFile, ...signingArgs], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).signatureStatus, 'signed-artifacts-verified');
    assert.equal(JSON.parse(created.stdout).qualificationEligible, false);
    assert.deepEqual(readReleaseManifest(signedFile), fixture.manifest);
    const rejectedFile = path.join(fixture.directory, 'refused-manifest.json');
    for (const invalid of [
        ['--signature', fixture.manifest.signature],
        ['--signing-key', keyFile, '--signing-key-sha256', '9'.repeat(64),
            '--trust-policy', fixture.options.trustPolicyReference, '--trust-policy-sha256', fixture.options.trustPolicySha256],
        ['--signing-key', keyFile]
    ])
    {
        const rejected = spawnSync(process.execPath, [path.join(root, 'tools/release/create-release-manifest.mjs'),
            ...args, '--output', rejectedFile, ...invalid], { encoding: 'utf8' });
        assert.notEqual(rejected.status, 0);
        assert.equal(fs.existsSync(rejectedFile), false);
    }
});


test('Vite build manifest and full release asset inventory have distinct closed artifact bindings', () =>
{
    const manifest = createReleaseManifest(createInput());
    assert.notEqual(manifest.identity.frontend.buildManifest.sha256, manifest.identity.frontend.assetManifest.sha256);
    assert.deepEqual(validateReleaseManifest(manifest), []);
    const inventoryChanged = structuredClone(manifest);
    inventoryChanged.identity.frontend.assetManifest.sha256 = `sha256:${'9'.repeat(64)}`;
    assert.notEqual(deriveReleaseCandidateId(inventoryChanged), manifest.candidateId);
    inventoryChanged.candidateId = deriveReleaseCandidateId(inventoryChanged);
    inventoryChanged.contentDigest = deriveReleaseManifestContentDigest(inventoryChanged);
    assert.deepEqual(validateReleaseManifest(inventoryChanged), []);
    for (const mutation of [value =>
    {
        delete value.identity.frontend.buildManifest;
    }, value =>
    {
        value.identity.frontend.buildManifest.sha256 = value.identity.frontend.assetManifest.sha256;
    }])
    {
        const changed = structuredClone(manifest);
        mutation(changed);
        changed.candidateId = deriveReleaseCandidateId(changed);
        changed.contentDigest = deriveReleaseManifestContentDigest(changed);
        assert.ok(validateReleaseManifest(changed).length > 0);
    }
});


test('signed current inventory rejects coherent stale aliases private paths and asset byte drift', context =>
{
    const fixture = signingFixture(context);
    const reference = fixture.manifest.identity.frontend.assetManifest.reference;
    const originalBytes = fs.readFileSync(reference);
    const original = JSON.parse(originalBytes);
    for (const mutation of [value =>
    {
        value.releaseId = '20260711010101-999999999999';
    }, value =>
    {
        value.compatibilityFile = 'release-compatibility.json';
    }, value =>
    {
        value.files.push(structuredClone(value.files[0]));
    }, value =>
    {
        value.files[0].releaseUrl = '/assets/current.js';
    }, value =>
    {
        value.files[0].path = 'api/session.json';
        value.files[0].releaseUrl = `/release-assets/${value.releaseId}/api/session.json`;
    }, value =>
    {
        value.files[0].path = 'assets/%2e%2e/current.js';
    }, value =>
    {
        value.files[0].bytes += 1;
    }, value =>
    {
        value.files[0].sha256 = `sha256:${'3'.repeat(64)}`;
    }, value =>
    {
        value.files[0].unknown = 'not-admitted';
    }])
    {
        const inventory = structuredClone(original);
        mutation(inventory);
        const bytes = Buffer.from(canonicalize(inventory));
        fs.writeFileSync(reference, bytes);
        const manifest = structuredClone(fixture.unsigned);
        manifest.identity.frontend.assetManifest.sha256 = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
        manifest.candidateId = deriveReleaseCandidateId(manifest);
        manifest.contentDigest = deriveReleaseManifestContentDigest(manifest);
        const signed = signReleaseManifest(manifest, fixture.privateKey);
        assert.throws(() => verifyReleaseManifestArtifacts({ ...fixture.options, manifest: signed }), /current.*inventory/u);
    }
    fs.writeFileSync(reference, originalBytes);
    fs.writeFileSync(path.join(fixture.directory, 'assets/current.js'), 'tampered-current');
    assert.throws(() => verifyReleaseManifestArtifacts(fixture.options), /inventory asset byte digest or size/u);
});
