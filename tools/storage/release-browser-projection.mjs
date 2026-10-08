/* eslint-disable import-x/no-relative-parent-imports -- The asset owner derives a public credential from the sole verified release owner. */
import { createHash, createPublicKey, sign } from 'node:crypto';

import '../../src/frontend/public/current-release-assets.js';
import { RELEASE_ID_CONTRACT, isValidReleaseId } from '../release/release-id.mjs';
import { verifyReleaseManifestArtifacts } from '../release/release-manifest-signature-contract.mjs';

const { canonicalize, validateProjection } = globalThis.FsusCurrentReleaseAssets;
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// This is a derivative public credential, not a second release or asset manifest.
// The full operational manifest, DB identities and artifact paths remain private.
export function createReleaseBrowserProjection(options, signingKey)
{
    const { manifest } = options;
    const verified = verifyReleaseManifestArtifacts({ ...options, releaseIdContract: RELEASE_ID_CONTRACT });
    if (verified.currentAssets.find(asset => asset.path === 'sw.js')?.sha256 !== manifest.identity.serviceWorker.artifact.sha256
        || !verified.currentAssets.some(asset => asset.path.endsWith('.wasm') && asset.sha256 === manifest.wasmArtifactHash))
    {
        throw new Error('browser projection requires the same inventoried worker and Wasm bytes as the release');
    }
    const publicKey = createPublicKey(signingKey);
    if (publicKey.asymmetricKeyType !== 'ed25519'
        || digest(publicKey.export({ type: 'spki', format: 'pem' })) !== manifest.identity.signing.publicKey.sha256)
    {
        throw new Error('browser projection signing key must match the verified release authority');
    }
    const contract = value => ({ version: value.version, sha256: value.artifact.sha256 });
    const projection = {
        schema: 'fsusblog.release-browser-projection.v1', candidateId: manifest.candidateId,
        manifestContentDigest: manifest.contentDigest, releaseId: manifest.releaseId, buildId: manifest.releaseId,
        source: { commitSha: manifest.commitSha, worktreeFingerprint: manifest.identity.source.worktreeFingerprint,
            buildId: manifest.identity.source.buildId },
        backendImageDigest: manifest.imageDigest, schemaDigest: `sha256:${manifest.currentSchema.actualSchemaDigest}`,
        contracts: Object.fromEntries(Object.entries(manifest.identity.contracts).map(([name, value]) => [name, contract(value)])),
        serviceWorker: { namespace: manifest.identity.serviceWorker.namespace, version: manifest.identity.serviceWorker.version,
            sha256: manifest.identity.serviceWorker.artifact.sha256 },
        inventory: { url: `/release-assets/${manifest.releaseId}/asset-manifest.json`, sha256: manifest.identity.frontend.assetManifest.sha256 },
        signing: { algorithm: 'ed25519', keyId: manifest.identity.signing.keyId,
            publicKeySha256: manifest.identity.signing.publicKey.sha256 }
    };
    const contentDigest = digest(canonicalize(projection));
    const signed = { ...projection, contentDigest, signature: sign(null, Buffer.from(contentDigest), signingKey).toString('base64') };
    validateProjection(signed, isValidReleaseId);
    return signed;
}

export function releaseBrowserTrust(publicKey, keyId)
{
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519')
    {
        throw new Error('browser trust requires Ed25519');
    }
    return { keyId, publicKeySha256: digest(key.export({ type: 'spki', format: 'pem' })),
        publicKeySpkiBase64: key.export({ type: 'spki', format: 'der' }).toString('base64') };
}

// Emit before the frontend inventory/build is sealed. Public key bytes are
// independently pinned input; candidate/projection digests are deliberately absent.
export function createReleaseBrowserTrustScript(publicKeyBytes, keyId, publicKeySha256)
{
    if (!Buffer.isBuffer(publicKeyBytes) || publicKeyBytes.length === 0 || publicKeyBytes.length > 64 * 1024
        || digest(publicKeyBytes) !== publicKeySha256
        || typeof keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyId))
    {
        throw new Error('browser build trust requires pinned public key bytes and exact key identity');
    }
    const trust = releaseBrowserTrust(publicKeyBytes, keyId);
    if (trust.publicKeySha256 !== publicKeySha256)
    {
        throw new Error('browser build trust requires canonical admitted public PEM bytes');
    }
    return `Object.defineProperty(globalThis, 'FsusCurrentReleaseBrowserTrust', { value: Object.freeze(${canonicalize(trust)}), writable: false, configurable: false });\n`;
}

// Emit after sealing. The projection is detached from the inventoried frontend
// bytes, avoiding a candidate -> worker -> candidate digest cycle.
export function createCurrentReleaseBrowserArtifacts(options, signingKey)
{
    const projection = createReleaseBrowserProjection(options, signingKey);
    const verified = verifyReleaseManifestArtifacts({ ...options, releaseIdContract: RELEASE_ID_CONTRACT });
    const signing = options.manifest.identity.signing;
    const trustScript = createReleaseBrowserTrustScript(options.readBytes(signing.publicKey.reference, signing.publicKey.sha256),
        signing.keyId, signing.publicKey.sha256);
    if (verified.currentAssets.find(asset => asset.path === 'generated/current-release-trust.js')?.sha256 !== digest(trustScript)
        || !['current-release-assets.js', 'generated/release-id-contract.js'].every(assetPath =>
            verified.currentAssets.some(asset => asset.path === assetPath)))
    {
        throw new Error('current browser artifacts require the matching inventoried prebuild trust and bootstrap consumers');
    }
    const projectionBytes = Buffer.from(canonicalize(projection));
    return { projection, projectionBytes, projectionSha256: digest(projectionBytes),
        projectionUrl: `/release-assets/${projection.releaseId}/release-browser-projection.json`,
        candidateId: projection.candidateId, manifestContentDigest: projection.manifestContentDigest,
        runtimeQualificationEligible: false };
}
