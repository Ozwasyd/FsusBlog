/* eslint-disable import-x/no-relative-parent-imports -- Nonqualifying byte fixtures share the original manifest and transferred asset owners. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isValidReleaseId } from '../../../tools/release/release-id.mjs';
import { signReleaseManifest } from '../../../tools/release/release-manifest-signature-contract.mjs';
import { createReleaseManifest } from '../../../tools/release/release-manifest.mjs';
import { buildReleaseAssetManifest } from '../../../tools/storage/release-assets.mjs';
import { createReleaseBrowserProjection, createReleaseBrowserTrustScript, releaseBrowserTrust } from '../../../tools/storage/release-browser-projection.mjs';

import { createCurrentSchemaReleaseBindingFixture, createReleaseIdentityRosterFixture } from './release-readiness-test-helpers.mjs';

const api = globalThis.FsusCurrentReleaseAssets;
const releaseId = '20260711010101-0123456789ab';
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const encode = value => Buffer.from(api.canonicalize(value));

// Source fixture bytes only; no native operation, backup or database qualification.
export function currentReleaseAssetsFixture(context, mutateSource = () =>
{})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-current-assets-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'release');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const keyId = createReleaseIdentityRosterFixture({}).signing.keyId;
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(source, 'wasm'));
    fs.mkdirSync(path.join(source, 'generated'));
    fs.writeFileSync(path.join(source, 'generated/current-release-trust.js'),
        createReleaseBrowserTrustScript(Buffer.from(publicPem), keyId, hash(publicPem)));
    for (const publicPath of ['current-release-assets.js', 'generated/release-id-contract.js'])
    {
        fs.copyFileSync(new URL(`../../../src/frontend/public/${publicPath}`, import.meta.url), path.join(source, publicPath));
    }
    fs.writeFileSync(path.join(source, 'index.html'), `<script src="/release-assets/${releaseId}/assets/current.js"></script>`);
    fs.writeFileSync(path.join(source, 'assets/current.js'), 'export const current = true;');
    fs.writeFileSync(path.join(source, 'assets/current.css'), 'body { color: black; }');
    fs.writeFileSync(path.join(source, 'assets/current.woff2'), 'font-control');
    fs.writeFileSync(path.join(source, 'wasm/decoder.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    fs.writeFileSync(path.join(source, 'sw.js'), '/* current worker byte control */');
    mutateSource(source);
    const inventory = buildReleaseAssetManifest({ releaseId, slot: 'blue', sourceDirectory: source });
    fs.writeFileSync(path.join(source, 'asset-manifest.json'), encode(inventory));
    const commitSha = '0123456789abcdef0123456789abcdef01234567';
    const identity = createReleaseIdentityRosterFixture({ commitSha, imageDigest: hash('image'),
        frontendManifestHash: hash('build'), wasmArtifactHash: hash('wasm') });
    function writeArtifact(artifact, bytes, reference = path.join(root, path.basename(artifact.reference)))
    {
        fs.writeFileSync(reference, bytes);
        artifact.reference = reference;
        artifact.sha256 = hash(bytes);
    }
    function populate(value)
    {
        if (Object.hasOwn(value, 'reference'))
        {
            writeArtifact(value, `fixture:${value.reference}`);
        }
        else
        {
            for (const child of Object.values(value))
            {
                if (child && typeof child === 'object')
                {
                    populate(child);
                }
            }
        }
    }
    populate(identity);
    writeArtifact(identity.frontend.assetManifest, encode(inventory), path.join(source, 'asset-manifest.json'));
    writeArtifact(identity.serviceWorker.artifact, fs.readFileSync(path.join(source, 'sw.js')));
    writeArtifact(identity.frontend.wasmArtifact, fs.readFileSync(path.join(source, 'wasm/decoder.wasm')));
    writeArtifact(identity.signing.publicKey, publicKey.export({ type: 'spki', format: 'pem' }));
    writeArtifact(identity.signing.trustPolicy.artifact, encode({ schema: 'fsusblog.release-signing-trust.v1',
        version: identity.signing.trustPolicy.version, allowedKeys: [{ keyId: identity.signing.keyId,
            algorithm: 'ed25519', publicKeySha256: identity.signing.publicKey.sha256 }] }));
    const manifest = signReleaseManifest(createReleaseManifest({ releaseId, commitSha,
        imageRepository: 'ghcr.io/fsusblog/app', imageTag: `ghcr.io/fsusblog/app:${releaseId}`,
        imageDigest: identity.backend.imageDigest, registryDigestVerified: true, createdAtUtc: '2026-07-11T01:01:01.000Z',
        frontendManifestHash: identity.frontend.buildManifest.sha256, wasmArtifactHash: identity.frontend.wasmArtifact.sha256,
        currentSchema: createCurrentSchemaReleaseBindingFixture(), identity,
        dotnetVersion: '10.0.401', nodeVersion: '24.19.0', dockerVersion: '28.0.0', dockerfileDigest: hash('dockerfile'),
        runtimeProfile: { id: 'throughput-musl', manifestDigest: hash('profiles'), profileDigest: hash('profile'),
            baseImageFamily: 'musl', targetRuntime: 'linux-musl-x64', singleFile: true, readyToRun: false,
            tieredPgo: true, quickJitForLoops: true, serverGc: true, nativeAot: false,
            threadPoolMode: 'runtime-default', topologyMode: 'smt-visible' } }), privateKey);
    const options = { manifest, trustPolicyReference: identity.signing.trustPolicy.artifact.reference,
        trustPolicySha256: identity.signing.trustPolicy.artifact.sha256, readBytes: reference => fs.readFileSync(reference) };
    const projection = createReleaseBrowserProjection(options, privateKey);
    const trust = { ...releaseBrowserTrust(privateKey, identity.signing.keyId), isReleaseId: isValidReleaseId };
    return { root, source, inventory, options, projection, trust, privateKey };
}
