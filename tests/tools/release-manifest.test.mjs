import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url';
import { createReleaseManifestValueContract } from '../../tools/release/release-manifest-value-contract.mjs';
import {
    createReleaseManifest,
    LEGACY_RELEASE_MANIFEST_RETIREMENT,
    readCurrentSchemaReleaseBinding,
    readReleaseManifest,
    readLegacyReleaseManifestV1,
    RELEASE_MANIFEST_SCHEMA,
    validateReleaseManifest,
    writeReleaseManifestAtomic
} from '../../tools/release/release-manifest.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const releaseId = '20260711010101-0123456789ab'
const digest = `sha256:${'a'.repeat(64)}`

function createInput(overrides = {}) {
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
        // Explicit reference metadata only: this fixture is not an issued receipt or database admission.
        currentSchema: {
            receipt: { reference: 'receipts/current-schema.json', sha256: '1'.repeat(64) },
            target: {
                modelVersion: 'current-model.v1', extractorVersion: 'extractor.v1', generatorVersion: 'generator.v1',
                sourceDigest: '2'.repeat(64), contentDigest: '3'.repeat(64)
            },
            database: { provider: 0, instanceId: 'fixture-instance', databaseId: 'fixture-database' },
            actualSchemaDigest: '4'.repeat(64)
        },
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
  }
}

function createDeploymentFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-deploy-fixture-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const configDir = path.join(directory, 'zk-config')
  const secretDir = path.join(directory, 'zk-secret')
  const assetStore = path.join(directory, 'release-assets')
  const releaseAssetRoot = path.join(assetStore, 'releases', releaseId)
  const descriptorPath = path.join(releaseAssetRoot, 'spa-manifest-descriptor.json')
  const receiptPath = path.join(releaseAssetRoot, 'production-build-receipt.json')
  fs.mkdirSync(configDir, { recursive: true })
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

function deploymentEnvironment(overrides = {}) {
  const environment = { ...process.env }
  for (const key of [
    'FSUSBLOG_RELEASE_MANIFEST',
    'FSUSBLOG_RELEASE_ID',
    'FSUSBLOG_RELEASE_SLOT',
    'FSUSBLOG_COMMIT_SHA',
    'FSUSBLOG_IMAGE_REF',
    'FSUSBLOG_IMAGE_DIGEST',
    'FSUSBLOG_RELEASE_MANIFEST_HOST_PATH',
    'FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE'
  ]) delete environment[key]
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
  const manifest = createReleaseManifest(createInput())

  writeReleaseManifestAtomic(file, manifest)
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
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp-')), [])
})

test('manifest path is immutable and cannot be overwritten for the same release', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-immutable-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'release-manifest.json')
  const manifest = createReleaseManifest(createInput())
  writeReleaseManifestAtomic(file, manifest)
    const original = fs.readFileSync(file, 'utf8');

    assert.throws(
        () => writeReleaseManifestAtomic(file, createReleaseManifest(createInput())),
        error => error?.code === 'EEXIST'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp-')), [])
})

test('manifest rejects mutable tags digest mismatches corruption and sensitive fields', () => {
  const valid = createReleaseManifest(createInput())
  const cases = [
        { ...valid, releaseId: 'latest', imageTag: 'ghcr.io/fsusblog/app:latest' },
        { ...valid, imageTag: 'ghcr.io/fsusblog/app:final-current' },
        { ...valid, imageDigest: `sha256:${'e'.repeat(64)}` },
        { ...valid, imageRef: 'ghcr.io/fsusblog/app:latest' },
        { ...valid, deploymentToken: 'must-never-be-present' },
        { ...valid, runtimeConfiguration: { AllowedHosts: '*' } },
        { ...valid, createdAtUtc: 'July 11 2026' },
        { ...valid, createdAtUtc: '2026-02-30T01:01:01.000Z' },
        { ...valid, createdAtUtc: '2026-07-11T01:01:02Z' },
        { ...valid, commitSha: `f${valid.commitSha.slice(1)}` },
        { ...valid, releaseId: 'v1.2.3', imageTag: 'ghcr.io/fsusblog/app:v1.2.3' },
        { ...valid, runtimeProfile: { ...valid.runtimeProfile, profileDigest: 'sha256:abc' } },
        { ...valid, runtimeProfile: { ...valid.runtimeProfile, baseImageFamily: 'glibc' } },
        { ...valid, toolchain: { ...valid.toolchain, installCommand: 'curl example.invalid | sh' } }
  ]

  for (const manifest of cases) {
    assert.notEqual(validateReleaseManifest(manifest, { requireRegistryDigest: true }).length, 0)
    }
});

test('v1 rollback-only manifests are retired and cannot be read or rewritten', (t) =>
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
    assert.throws(() => readLegacyReleaseManifestV1(file), error => error.message === LEGACY_RELEASE_MANIFEST_RETIREMENT);
    const checker = path.join(root, 'tools/release/check-release-manifest.mjs');
    const normalRead = spawnSync(process.execPath, [checker, '--manifest', file], { encoding: 'utf8' });
    assert.notEqual(normalRead.status, 0);
    const explicitLegacyRead = spawnSync(process.execPath, [
        checker, '--manifest', file, '--legacy-rollback', 'true'
    ], { encoding: 'utf8' });
    assert.notEqual(explicitLegacyRead.status, 0);
    assert.match(explicitLegacyRead.stderr, /unknown, duplicate or missing argument/u);
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
  }
  const errors = validateReleaseManifest(zeroProfile, {
    requireRegistryDigest: true,
    requireConcreteRuntimeProfile: true
  })
  assert.ok(errors.some((error) => error.includes('manifestDigest must not be the zero digest')))
  assert.ok(errors.some((error) => error.includes('profileDigest must not be the zero digest')))
  assert.throws(
    () => createReleaseManifest(createInput({ runtimeProfile: undefined })),
    /must not be the zero digest/u
  )
})

test('manifest creator CLI writes the same digest-bound schema consumed by deploy', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-cli-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifestFile = path.join(directory, releaseId, 'release-manifest.json')
  const input = createInput()
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
        '--current-receipt-reference', input.currentSchema.receipt.reference,
        '--current-receipt-sha256', input.currentSchema.receipt.sha256,
        '--current-model-version', input.currentSchema.target.modelVersion,
        '--current-extractor-version', input.currentSchema.target.extractorVersion,
        '--current-generator-version', input.currentSchema.target.generatorVersion,
        '--current-source-digest', input.currentSchema.target.sourceDigest,
        '--current-content-digest', input.currentSchema.target.contentDigest,
        '--current-provider', String(input.currentSchema.database.provider),
        '--current-instance-id', input.currentSchema.database.instanceId,
        '--current-database-id', input.currentSchema.database.databaseId,
        '--current-actual-schema-digest', input.currentSchema.actualSchemaDigest,
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
  ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: deploymentEnvironment() })

  assert.equal(result.status, 0, result.stderr)
  const actual = readReleaseManifest(manifestFile, {
    expectedReleaseId: releaseId,
    expectedImageRef: `ghcr.io/fsusblog/app@${digest}`
  })
  assert.equal(actual.commitSha, input.commitSha)
  assert.equal(actual.imageDigest, digest)
  assert.equal(actual.registryDigestVerified, true)
})

test('production build preflight rejects mutable aliases and ambiguous modes before Docker runs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-build-preflight-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const binDir = path.join(directory, 'bin')
  const dockerMarker = path.join(directory, 'docker-called')
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(binDir, 'docker'), `#!/usr/bin/env bash\ntouch "${dockerMarker}"\nexit 97\n`, { mode: 0o755 })
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
        FSUSBLOG_FINAL_SKIP_WASM: '1'
    };
    const cases = [
        [{ FSUSBLOG_RELEASE_ID: 'latest' }, /does not match the canonical release identity snapshot/u],
        [{ FSUSBLOG_FINAL_IMAGE_REPOSITORY: 'ghcr.io/fsusblog/app:latest' }, /must be an untagged lowercase repository/u],
        [{ FSUSBLOG_FINAL_PUSH: '1', FSUSBLOG_FINAL_LOCAL_ONLY: '1' }, /set exactly one/u]
    ];

  for (const [overrides, expected] of cases) {
    fs.rmSync(dockerMarker, { force: true })
    const result = spawnSync('bash', [path.join(root, 'tools/build-final-image.sh')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...overrides }
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, expected)
    assert.equal(fs.existsSync(dockerMarker), false)
  }
})

test('production build generates one immutable release id when the caller omits it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-build-generated-id-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const binDir = path.join(directory, 'bin')
  const dockerArgs = path.join(directory, 'docker-args.txt')
  fs.mkdirSync(binDir)
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
    FSUSBLOG_FINAL_SKIP_WASM: '1'
  }
  delete environment.FSUSBLOG_RELEASE_ID
  delete environment.FSUSBLOG_FINAL_IMAGE_TAG

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

test('deploy input checker emits exact current-only bindings without a rollback or admission claim', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-input-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifestFile = path.join(directory, 'release-manifest.json')
  writeReleaseManifestAtomic(manifestFile, createReleaseManifest(createInput()))

  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/release/check-release-manifest.mjs'),
    '--manifest', manifestFile,
    '--release-id', releaseId,
    '--image-ref', `ghcr.io/fsusblog/app@${digest}`,
    '--slot', 'candidate'
  ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: deploymentEnvironment() })

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.releaseId, releaseId)
  assert.equal(output.slot, 'candidate')
  assert.equal(output.imageDigest, digest)
  assert.equal(Object.hasOwn(output, 'rollbackTarget'), false)
  assert.equal(output.admissionVerified, false)
  assert.deepEqual(output.currentSchema, createInput().currentSchema)
})

test('deploy input checker blocks missing identity digest mismatch mutable tag and damaged JSON', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-release-input-negative-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const checker = path.join(root, 'tools/release/check-release-manifest.mjs')
  const valid = createReleaseManifest(createInput())
  const cases = [
    ['missing-release.json', { ...valid, releaseId: '', imageTag: 'ghcr.io/fsusblog/app:' }, []],
    ['mutable-tag.json', { ...valid, imageTag: 'ghcr.io/fsusblog/app:final-current' }, []],
    ['digest-mismatch.json', valid, ['--image-digest', `sha256:${'e'.repeat(64)}`]],
    ['damaged.json', '{"schema":', []]
  ]

  for (const [name, contents, extraArgs] of cases) {
    const manifestFile = path.join(directory, name)
    fs.writeFileSync(manifestFile, typeof contents === 'string' ? contents : `${JSON.stringify(contents)}\n`)
    const result = spawnSync(process.execPath, [checker, '--manifest', manifestFile, ...extraArgs], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000
    })
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`)
    assert.match(result.stderr, /\[check-release-manifest\]/u)
  }
})

test('production dry-run reports immutable release slot digest without image-only rollback before no-build deploy', (t) => {
  const { envFile, manifestFile, descriptorPath, receiptPath } = createDeploymentFixture(t)

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
  ], { cwd: root, encoding: 'utf8', timeout: 10_000, env: deploymentEnvironment() })

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`release=${releaseId} slot=green digest=${digest}`))
  assert.doesNotMatch(result.stdout, /rollbackTarget=/u)
  assert.match(result.stdout, /dry-run command: docker pull ghcr\.io\/fsusblog\/app@sha256/u)
  assert.match(result.stdout, /verify pulled image digest and OCI release labels/u)
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
  fs.mkdirSync(binDir)
  const fakeDocker = path.join(binDir, 'docker')
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
`, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  const baseArgs = [
    path.join(root, 'tools/deploy-production.sh'),
    '--env-file', envFile,
    '--release-manifest', manifestFile,
    '--spa-manifest-descriptor', descriptorPath,
    '--production-build-receipt', receiptPath,
    '--slot', 'green',
    '--skip-up'
  ]
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
  })
  assert.notEqual(digestMismatch.status, 0)
  assert.match(digestMismatch.stderr, /pulled image digest does not match release manifest/u)

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

test('current-only manifest refuses legacy windows and distinguishes semantic target from physical observation', () =>
{
    const input = createInput();
    const manifest = createReleaseManifest(input);
    assert.deepEqual(manifest.currentSchema, input.currentSchema);
    assert.notEqual(manifest.currentSchema.target.contentDigest, manifest.currentSchema.actualSchemaDigest);
    assert.equal(Object.hasOwn(manifest, 'schemaCompatibility'), false);
    assert.throws(() => createReleaseManifest({ ...input, schemaMinimumCoordinate: releaseId }), /windows are retired/u);
    assert.throws(() => createReleaseManifest({ ...input, schemaMaximumCoordinate: releaseId }), /windows are retired/u);
    for (const schema of ['fsusblog.release-manifest.v1', 'fsusblog.release-manifest.v2'])
    {
        assert.ok(validateReleaseManifest({ ...manifest, schema }).length > 0);
    }
    assert.ok(validateReleaseManifest({ ...manifest, schemaCompatibility: { minimumCoordinate: releaseId, maximumCoordinate: releaseId } }).length > 0);
});

test('filesystem and explicit-value manifest consumers apply the same current-only contract', () =>
{
    const releaseIdContract = JSON.parse(fs.readFileSync(path.join(root, 'src/shared/Contracts/Validation/release-id-contract.json'), 'utf8'));
    const values = createReleaseManifestValueContract({ releaseIdContract });
    const input = createInput();
    const actual = createReleaseManifest(input);
    assert.deepEqual(values.createReleaseManifest(input), actual);
    for (const manifest of [actual,
        { ...actual, currentSchema: null },
        { ...actual, schema: 'fsusblog.release-manifest.v2' },
        { ...actual, currentSchema: { ...actual.currentSchema, status: 'verified-current' } },
        { ...actual, currentSchema: { ...actual.currentSchema, target: { ...actual.currentSchema.target, sourceDigest: null } } }
    ])
    {
        assert.deepEqual(values.validateReleaseManifest(manifest), validateReleaseManifest(manifest));
    }
    assert.ok(values.validateLegacyReleaseManifestV1({ ...actual, schema: 'fsusblog.release-manifest.v1' }).length > 0);
});

test('current receipt reference metadata is closed and cannot substitute status hashes or malformed identities', () =>
{
    const valid = createReleaseManifest(createInput());
    const binding = valid.currentSchema;
    const cases = [
        null, [], {},
        { ...binding, receipt: null },
        { ...binding, receipt: { ...binding.receipt, reference: 'receipts/latest/current.json' } },
        { ...binding, receipt: { ...binding.receipt, reference: ' receipts/current.json' } },
        { ...binding, receipt: { ...binding.receipt, sha256: 'sha256:' + binding.receipt.sha256 } },
        { ...binding, receipt: { ...binding.receipt, sha256: 'A'.repeat(64) } },
        { ...binding, target: { ...binding.target, modelVersion: '' } },
        { ...binding, target: { ...binding.target, sourceDigest: null } },
        { ...binding, target: { ...binding.target, contentDigest: 'bad' } },
        { ...binding, database: { ...binding.database, provider: 3 } },
        { ...binding, database: { ...binding.database, provider: '0' } },
        { ...binding, database: { ...binding.database, databaseId: '' } },
        { ...binding, database: { ...binding.database, instanceId: 'line\\nidentity' } },
        { ...binding, actualSchemaDigest: null },
        { ...binding, status: 'verified-current' },
        { ...binding, plan: { contentDigest: '1'.repeat(64) } },
        { ...binding, target: { ...binding.target, compatibilityCoordinate: releaseId } }
    ];
    for (const currentSchema of cases)
    {
        assert.ok(validateReleaseManifest({ ...valid, currentSchema }).length > 0);
    }
    // A known provider's shape is not a claim that a native observer or issuer exists for it.
    for (const provider of [0, 1, 2])
    {
        assert.deepEqual(validateReleaseManifest({
            ...valid, currentSchema: { ...binding, database: { ...binding.database, provider } }
        }), []);
    }
});

test('creator and input reader reject removed window or duplicate options before reading or writing products', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-release-refusal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = path.join(directory, 'must-not-exist.json');
    for (const removed of ['--schema-minimum-coordinate', '--schema-maximum-coordinate', '--legacy-rollback'])
    {
        const result = spawnSync(process.execPath, [
            path.join(root, 'tools/release/create-release-manifest.mjs'), '--output', output, removed, releaseId
        ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(output), false);
    }
    for (const args of [
        ['--manifest', 'missing.json', '--manifest', 'other.json'],
        ['--manifest', 'missing.json', '--legacy-rollback', 'false']
    ])
    {
        const result = spawnSync(process.execPath, [
            path.join(root, 'tools/release/check-release-manifest.mjs'), ...args
        ], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /unknown, duplicate or missing argument/u);
        assert.doesNotMatch(result.stderr, /unable to read/u);
    }
});

test('build reference projection binds whole receipt bytes without granting database admission', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-reference-projection-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'current.json');
    const binding = createInput().currentSchema;
    // Deliberately only a projection fixture, not a sealed Shared receipt or native observation.
    const projection = {
        format: 'fsusblog.current-schema-receipt.v1', status: 'verified-current',
        target: binding.target, database: binding.database, actualSchemaDigest: binding.actualSchemaDigest
    };
    const bytes = Buffer.from(JSON.stringify(projection));
    const wholeSha = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(file, bytes);
    const actual = readCurrentSchemaReleaseBinding(file, wholeSha);
    assert.deepEqual(actual, { ...binding, receipt: { reference: file, sha256: wholeSha } });
    assert.equal(Object.hasOwn(actual, 'status'), false);
    assert.notEqual(actual.target.contentDigest, actual.actualSchemaDigest);
    assert.deepEqual(createReleaseManifest({ ...createInput(), currentSchema: actual }).currentSchema, actual);
    fs.appendFileSync(file, '\n');
    assert.throws(() => readCurrentSchemaReleaseBinding(file, wholeSha), /whole-artifact SHA-256 mismatch/u);
});

test('reference projection rejects a real FIFO without waiting for a writer', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-reference-fifo-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fifo = path.join(fs.realpathSync(directory), 'current.fifo');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(created.status, 0, created.stderr);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        'import { readCurrentSchemaReleaseBinding } from "./tools/release/release-manifest.mjs"; readCurrentSchemaReleaseBinding(process.argv[1], process.argv[2]);',
        fifo, '1'.repeat(64)
    ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular artifact/u);
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
});

test('reference projection rejects missing, aliased, oversized, malformed or non-current artifacts', (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-reference-refusal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'current.json');
    const binding = createInput().currentSchema;
    const base = {
        format: 'fsusblog.current-schema-receipt.v1', status: 'verified-current',
        target: binding.target, database: binding.database, actualSchemaDigest: binding.actualSchemaDigest
    };
    const attempt = value =>
    {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        fs.writeFileSync(file, bytes);
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        assert.throws(() => readCurrentSchemaReleaseBinding(file, sha));
    };
    for (const value of [
        {}, { ...base, status: undefined }, { ...base, status: 'rejected' },
        { ...base, format: 'fsusblog.current-schema-receipt.v0' },
        { ...base, target: { ...base.target, sourceDigest: null } },
        { ...base, database: { ...base.database, provider: 3 } },
        Buffer.from('{not-json'), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 32)
    ]) attempt(value);
    const bytes = Buffer.from(JSON.stringify(base));
    fs.writeFileSync(file, bytes);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    for (const hash of [null, '', 'sha256:' + sha, sha.toUpperCase()])
    {
        assert.throws(() => readCurrentSchemaReleaseBinding(file, hash));
    }
    assert.throws(() => readCurrentSchemaReleaseBinding('relative.json', sha));
    assert.throws(() => readCurrentSchemaReleaseBinding(path.join(directory, 'missing.json'), sha));
    assert.throws(() => readCurrentSchemaReleaseBinding(directory, sha));
    const alias = path.join(directory, 'alias.json');
    fs.symlinkSync(file, alias);
    assert.throws(() => readCurrentSchemaReleaseBinding(alias, sha), /no symlinks/u);
});
