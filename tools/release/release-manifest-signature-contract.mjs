/* eslint-disable import-x/no-relative-parent-imports -- Signature verification shares the canonical pure content serializer. */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

import { canonicalize } from '../fact-extractors/lib/canonicalize.mjs';
import { validateCurrentReleaseAssetInventory } from '../storage/release-asset-value-contract.mjs';

import { releaseIdentityRosterArtifacts } from './release-manifest-identity-contract.mjs';
import { createReleaseManifestValueContract, deriveReleaseCandidateId, deriveReleaseManifestContentDigest } from './release-manifest-value-contract.mjs';

const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const fail = message =>
{
    throw new Error(`release signature: ${message}`);
};

// The signing key remains process-owned input. It is never written into the manifest.
export function signReleaseManifest(manifest, signingKey)
{
    if (manifest.candidateId !== deriveReleaseCandidateId(manifest)
        || manifest.contentDigest !== deriveReleaseManifestContentDigest(manifest))
    {
        fail('unsigned candidate/content identity mismatch');
    }
    const publicKey = createPublicKey(signingKey);
    if (publicKey.asymmetricKeyType !== 'ed25519')
    {
        fail('only Ed25519 is supported');
    }
    const keyDigest = `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'pem' })).digest('hex')}`;
    if (keyDigest !== manifest.identity.signing.publicKey.sha256)
    {
        fail('signing key does not match the bound public key');
    }
    return { ...manifest, signature: sign(null, Buffer.from(manifest.contentDigest), signingKey).toString('base64') };
}

// The trust anchor is independent caller configuration. Never infer it from the
// candidate, and never turn artifact/signature verification into DB admission.
export function verifyReleaseManifestArtifacts({ manifest, releaseIdContract, trustPolicyReference, trustPolicySha256, readBytes })
{
    const { validateReleaseManifest } = createReleaseManifestValueContract({ releaseIdContract });
    const errors = validateReleaseManifest(manifest, { requireConcreteRuntimeProfile: true, requireSignature: true });
    if (errors.length > 0)
    {
        fail(errors.join('; '));
    }
    if (typeof readBytes !== 'function')
    {
        fail('an explicit artifact byte reader is required');
    }
    const trust = manifest.identity.signing.trustPolicy;
    if (!trustPolicyReference || !trustPolicySha256 || trust.artifact.reference !== trustPolicyReference
        || trust.artifact.sha256 !== trustPolicySha256)
    {
        fail('independent trust policy anchor mismatch');
    }
    const opened = new Map();
    const artifacts = [...releaseIdentityRosterArtifacts(manifest.identity), { name: 'currentSchema.receipt',
        reference: manifest.currentSchema.receipt.reference, sha256: `sha256:${manifest.currentSchema.receipt.sha256}` }].map(artifact =>
    {
        const bytes = readBytes(artifact.reference, artifact.sha256);
        if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024 * 1024)
        {
            fail(`${artifact.name} is not bounded artifact bytes`);
        }
        if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.sha256)
        {
            fail(`${artifact.name} byte digest mismatch`);
        }
        opened.set(artifact.reference, bytes);
        return { ...artifact, bytes: bytes.length };
    });
    const inventoryBytes = opened.get(manifest.identity.frontend.assetManifest.reference);
    const inventory = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventoryBytes));
    const inventoryAssets = validateCurrentReleaseAssetInventory(inventory, manifest.releaseId, releaseIdContract);
    const inventoryRoot = manifest.identity.frontend.assetManifest.reference.slice(0,
        manifest.identity.frontend.assetManifest.reference.lastIndexOf('/'));
    const currentAssets = inventoryAssets.map(asset =>
    {
        const bytes = readBytes(`${inventoryRoot}/${asset.path}`, asset.sha256);
        if (!Buffer.isBuffer(bytes) || bytes.length !== asset.bytes
            || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.sha256)
        {
            fail(`current inventory asset byte digest or size mismatch: ${asset.path}`);
        }
        return asset;
    });
    const receiptBytes = opened.get(manifest.currentSchema.receipt.reference);
    if (receiptBytes.length > 1024 * 1024)
    {
        fail('current receipt exceeds its canonical byte bound');
    }
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
    if (receipt.format !== manifest.currentSchema.receiptFormat || receipt.status !== 'verified-current'
        || receipt.contentDigest !== manifest.currentSchema.receiptContentDigest
        || receipt.actualSchemaDigest !== manifest.currentSchema.actualSchemaDigest
        || canonicalize(receipt.target) !== canonicalize(manifest.currentSchema.target)
        || canonicalize(receipt.database) !== canonicalize(manifest.currentSchema.database))
    {
        fail('current receipt byte projection mismatch');
    }
    const policyBytes = opened.get(trustPolicyReference);
    if (policyBytes.length > 64 * 1024)
    {
        fail('trust policy exceeds the closed policy bound');
    }
    const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(policyBytes));
    if (canonicalize(policy) !== policyBytes.toString('utf8'))
    {
        fail('trust policy must be canonical JSON without duplicate fields');
    }
    if (!closed(policy, ['schema', 'version', 'allowedKeys']) || policy.schema !== 'fsusblog.release-signing-trust.v1'
        || policy.version !== trust.version || !Array.isArray(policy.allowedKeys)
        || policy.allowedKeys.length < 1 || policy.allowedKeys.length > 32)
    {
        fail('trust policy must be a closed exact current policy');
    }
    const keyIds = new Set();
    for (const key of policy.allowedKeys)
    {
        if (!closed(key, ['keyId', 'algorithm', 'publicKeySha256']) || key.algorithm !== 'ed25519'
            || typeof key.keyId !== 'string' || keyIds.has(key.keyId) || !/^sha256:[a-f0-9]{64}$/u.test(key.publicKeySha256))
        {
            fail('trust key roster is invalid');
        }
        keyIds.add(key.keyId);
    }
    const signing = manifest.identity.signing;
    if (!policy.allowedKeys.some(key => key.keyId === signing.keyId && key.publicKeySha256 === signing.publicKey.sha256))
    {
        fail('signing key is not admitted by the independent trust policy');
    }
    const publicKey = createPublicKey(opened.get(signing.publicKey.reference));
    if (publicKey.asymmetricKeyType !== 'ed25519'
        || !verify(null, Buffer.from(manifest.contentDigest), publicKey, Buffer.from(manifest.signature, 'base64')))
    {
        fail('Ed25519 signature verification failed');
    }
    return { candidateId: manifest.candidateId, manifestContentDigest: manifest.contentDigest, artifacts, currentAssets,
        signatureVerified: true, nativeClaimEligible: false, actualDatabaseObserved: false };
}
