/* eslint-disable import-x/no-relative-parent-imports -- This source contract fixture imports the canonical release and digest owners under test. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';

import { digestValue, stable } from '../../../tools/fact-extractors/lib/canonicalize.mjs';
import { createReleaseManifest } from '../../../tools/release/release-manifest.mjs';

export const digest = (character) => `sha256:${character.repeat(64)}`;
export const semanticDigest = (value) => `sha256:${digestValue(stable(value))}`;
export const fileDigest = (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;

export function write(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const schemaFixtureRoot = path.resolve(import.meta.dirname, '../../../.tmp/release-schema-unit-fixtures', String(process.pid));
after(() => fs.rmSync(schemaFixtureRoot, { recursive: true, force: true }));

// Synthetic release projection for source contract tests only. This is not a
// receipt issued by the migration verifier and cannot qualify database startup.
export function createCurrentSchemaReleaseBindingFixture()
{
    const binding = {
        receiptFormat: 'fsusblog.current-schema-receipt.v1',
        receipt: { reference: '/unit-fixture/current-schema-receipt.json', sha256: 'a'.repeat(64) },
        receiptContentDigest: 'b'.repeat(64),
        target: {
            modelVersion: 'unit-model-v1',
            extractorVersion: 'unit-extractor-v1',
            generatorVersion: 'unit-generator-v1',
            sourceDigest: 'c'.repeat(64),
            contentDigest: 'd'.repeat(64)
        },
        database: { provider: 0, instanceId: 'unit-instance', databaseId: 'unit-database' },
        actualSchemaDigest: 'e'.repeat(64)
    };
    const receipt = {
        unitFixture: true,
        format: binding.receiptFormat,
        status: 'verified-current',
        contentDigest: binding.receiptContentDigest,
        target: binding.target,
        database: binding.database,
        actualSchemaDigest: binding.actualSchemaDigest
    };
    fs.mkdirSync(schemaFixtureRoot, { recursive: true, mode: 0o700 });
    const reference = path.join(schemaFixtureRoot, 'nonqualifying-byte-projection.json');
    const bytes = Buffer.from(JSON.stringify(receipt));
    fs.writeFileSync(reference, bytes, { mode: 0o600 });
    binding.receipt = { reference, sha256: createHash('sha256').update(bytes).digest('hex') };
    return binding;
}

// A structural source fixture, never an artifact verifier, signing authority or native receipt.
export function createReleaseIdentityRosterFixture({ commitSha, imageDigest, frontendManifestHash, wasmArtifactHash })
{
    const artifact = (name, sha256 = digest('7')) => ({ reference: `/unit-fixture/${name}`, sha256 });
    const contract = name => ({ version: 'unit-current-v1', artifact: artifact(name) });
    return {
        source: { commitSha, worktreeFingerprint: digest('8'), buildId: 'unit-build-v1', buildReceipt: artifact('build.json') },
        backend: { imageDigest, artifact: artifact('backend.bin') },
        frontend: { buildId: 'unit-build-v1', buildReceipt: artifact('frontend-build.json'),
            buildManifest: artifact('vite-manifest.json', frontendManifestHash), assetManifest: artifact('asset-manifest.json'), wasmArtifact: artifact('decoder.wasm', wasmArtifactHash) },
        serviceWorker: { namespace: 'unit-current-sw', version: 'unit-sw-v1', artifact: artifact('sw.js') },
        contracts: { aeds: contract('aeds.json'), protocol: contract('protocol.json'), wasmAbi: contract('wasm-abi.json'), notification: contract('notification.json') },
        runtime: { roles: contract('roles.json'), config: contract('config.json'), dependencies: contract('dependencies.json') },
        provenance: contract('provenance.json'),
        signing: { algorithm: 'ed25519', keyId: 'unit-signing-key', publicKey: artifact('public.pem'), trustPolicy: contract('trust.json') }
    };
}

export function createReadinessManifest(releaseId, commit)
{
    return createReleaseManifest({
        releaseId,
        commitSha: commit,
        imageRepository: 'ghcr.io/fsusblog/app',
        imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
        imageDigest: digest('1'),
        registryDigestVerified: true,
        createdAtUtc: '2026-07-11T01:01:01.000Z',
        frontendManifestHash: digest('2'),
        wasmArtifactHash: digest('3'),
        currentSchema: createCurrentSchemaReleaseBindingFixture(),
        identity: createReleaseIdentityRosterFixture({ commitSha: commit, imageDigest: digest('1'), frontendManifestHash: digest('2'), wasmArtifactHash: digest('3') }),
        dotnetVersion: '10.0.100',
        nodeVersion: '24.0.0',
        dockerVersion: '28.0.0',
        dockerfileDigest: digest('4'),
        runtimeProfile: {
            id: 'throughput-musl',
            manifestDigest: digest('5'),
            profileDigest: digest('6'),
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
        target: 'final'
    });
}
