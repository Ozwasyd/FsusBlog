import { encodeAedsFrame } from '@/api/binaryFrame';
import {
    encodeBlindCredentialIssueRequest,
    getBlindCredentialIssuerMetadata,
    getAnonymousCredentialRevocationArtifact,
    getAnonymousCredentialCircuitSnapshot,
    getAnonymousCredentialRootSnapshot,
    type AnonymousCredentialRevocationArtifact,
    type AnonymousCredentialRootSnapshot
} from '@/api/comment';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

import { createBlindRsaCredentialSuite } from './commentPrivacyBlindRsaSuite';
import {
    purgeCommentPrivacyCredentialState,
    type CommentPrivacyCredentialPurgeReason,
    zeroizeCommentPrivacyBytes
} from './commentPrivacyCredentialLifecycle';
import {
    createCommentPrivacyCredentialVault,
    currentCommentPrivacyVaultPartition,
    type CommentPrivacyCredentialVault,
    type CommentPrivacyCredentialVaultPartition
} from './commentPrivacyCredentialVault';
import { getCommentPrivacyWorkerClient } from './commentPrivacyWorkerClient';

import type {
    CommentPrivacyCredentialIssuePayload,
    CommentPrivacyCredentialIssueRequest,
    CommentPrivacyCredentialIssueResponse,
    CommentPrivacyCredentialIssuerMetadata,
    CommentPrivacyCredentialMaterial,
    CommentPrivacyCredentialProvider,
    CommentPrivacyCredentialSuite,
    CommentPrivacyRevocationDistribution
} from './commentPrivacyContracts';


export type { CommentPrivacyCredentialVault } from './commentPrivacyCredentialVault';

const DEFAULT_CREDENTIAL_SECRET_BYTES = 32;
const DEFAULT_CLIENT_NONCE_BYTES = 32;
const DEFAULT_FAILURE_CACHE_TTL_MS = 30_000;
const DEFAULT_CREDENTIAL_LEVEL = 'strong_anonymous';
const DEFAULT_REPUTATION_BUCKET = 'unrated';
const MAX_REVOCATION_ARTIFACT_BYTES = 4 * 1024 * 1024;

const revocationArtifactCache = new Map<number, {
    version: number;
    revocationRoot: string;
    entryHashes: Uint8Array;
}>();

export type CommentPrivacyCredentialMetadataLoader = (
    request: { signal: AbortSignal; }
) => Promise<CommentPrivacyCredentialIssuerMetadata | null>;

export type CommentPrivacyCredentialIssuer = (
    request: CommentPrivacyCredentialIssueRequest,
    config: { signal: AbortSignal; }
) => Promise<CommentPrivacyCredentialIssueResponse>;

export type CommentPrivacyRevocationArtifactLoader = (
    path: string,
    kind: 1 | 2,
    config: { signal: AbortSignal; }
) => Promise<AnonymousCredentialRevocationArtifact>;

export interface CommentPrivacyCredentialProviderOptions {
    vault?: CommentPrivacyCredentialVault | null;
    loadMetadata?: CommentPrivacyCredentialMetadataLoader;
    issueCredential?: CommentPrivacyCredentialIssuer;
    loadRevocationArtifact?: CommentPrivacyRevocationArtifactLoader;
    credentialSuite?: CommentPrivacyCredentialSuite | null;
    crypto?: Pick<Crypto, 'getRandomValues' | 'subtle'> | null;
    now?: () => number;
    unavailableCacheTtlMs?: number;
    credentialSecretBytes?: number;
    clientNonceBytes?: number;
}

export function createCommentPrivacyCredentialProvider(
    options: CommentPrivacyCredentialProviderOptions = {}
): CommentPrivacyCredentialProvider
{
    const vault = options.vault === undefined
        ? createCommentPrivacyCredentialVault()
        : options.vault;
    const cryptoSource = options.crypto === undefined
        ? getGlobalCrypto()
        : options.crypto;
    const loadMetadata = options.loadMetadata ?? loadDefaultCredentialMetadata;
    const issueCredential = options.issueCredential ?? issueAnonymousCredential;
    const loadRevocationArtifact = options.loadRevocationArtifact ?? loadAnonymousCredentialRevocationArtifact;
    const credentialSuite = options.credentialSuite === undefined && cryptoSource
        ? createBlindRsaCredentialSuite({ crypto: cryptoSource })
        : options.credentialSuite ?? null;
    const now = options.now ?? (() => Date.now());
    const unavailableCacheTtlMs = options.unavailableCacheTtlMs ?? DEFAULT_FAILURE_CACHE_TTL_MS;
    const credentialSecretBytes = options.credentialSecretBytes ?? DEFAULT_CREDENTIAL_SECRET_BYTES;
    const clientNonceBytes = options.clientNonceBytes ?? DEFAULT_CLIENT_NONCE_BYTES;
    let unavailableUntilUnixMs = 0;
    let lastMetadata: CommentPrivacyCredentialIssuerMetadata | null = null;

    const failClosed = (signal: AbortSignal): null =>
    {
        if (!signal.aborted)
        {
            unavailableUntilUnixMs = now() + unavailableCacheTtlMs;
        }
        return null;
    };

    return {
        async prepareCredential({ signal })
        {
            if (signal.aborted || now() < unavailableUntilUnixMs)
            {
                return null;
            }
            if (!vault || !cryptoSource || typeof cryptoSource.getRandomValues !== 'function')
            {
                return failClosed(signal);
            }

            const temporaryBytes: Uint8Array[] = [];
            const track = (bytes: Uint8Array): Uint8Array =>
            {
                temporaryBytes.push(bytes);
                return bytes;
            };
            try
            {
                if (vault.initialize && !await vault.initialize())
                {
                    await vault.clear();
                    lastMetadata = null;
                    return failClosed(signal);
                }
                await vault.pruneExpired(now());
                const metadata = await loadMetadata({ signal });
                if (signal.aborted)
                {
                    return null;
                }
                if (!isUsableMetadata(metadata, now()))
                {
                    if (lastMetadata)
                    {
                        await purgeCommentPrivacyCredentialState('feature-disabled');
                        await vault.clear();
                        lastMetadata = null;
                    }
                    return failClosed(signal);
                }

                if (lastMetadata && metadataBinding(lastMetadata) !== metadataBinding(metadata))
                {
                    const rotationReason = classifyMetadataRotation(lastMetadata, metadata);
                    lastMetadata = cloneMetadata(metadata);
                    await purgeCommentPrivacyCredentialState(rotationReason);
                    await vault.clear();
                    return null;
                }
                lastMetadata = cloneMetadata(metadata);
                const partition = metadataPartition(metadata);
                const cached = await vault.get(partition);
                if (cached)
                {
                    const result = cloneCredentialMaterial(cached);
                    zeroizeCredentialMaterial(cached);
                    return result;
                }

                if (!credentialSuite)
                {
                    return failClosed(signal);
                }

                const credentialSecret = track(randomBytes(cryptoSource, credentialSecretBytes));
                const clientNonce = track(randomBytes(cryptoSource, clientNonceBytes));
                const credentialIssuePayload = await credentialSuite.createCredentialRequest({
                    credentialSecret: track(cloneBytes(credentialSecret)),
                    clientNonce: track(cloneBytes(clientNonce)),
                    metadata,
                    signal
                });
                if (signal.aborted)
                {
                    return null;
                }
                if (!isUsableCredentialIssuePayload(credentialIssuePayload))
                {
                    return failClosed(signal);
                }
                track(credentialIssuePayload.credentialRequest);
                track(credentialIssuePayload.credentialOpening);

                const issuerResponse = await issueCredential({
                    credentialEpoch: metadata.credentialEpoch,
                    circuitNumericId: metadata.circuitNumericId,
                    publicInputLayoutVersion: metadata.publicInputLayoutVersion,
                    circuitId: metadata.circuitId,
                    credentialLevel: metadata.credentialLevel,
                    schemeId: metadata.schemeId,
                    issuerPublicKeyId: metadata.issuerPublicKeyId,
                    blindedMessage: track(cloneBytes(credentialIssuePayload.credentialRequest))
                }, { signal });
                if (signal.aborted)
                {
                    return null;
                }
                if (!matchesMetadata(issuerResponse, metadata) || issuerResponse.rootExpiresAtUnixMs <= now())
                {
                    return failClosed(signal);
                }
                track(issuerResponse.blindSignature);

                const material = await credentialSuite.acceptIssuerResponse({
                    credentialSecret: track(cloneBytes(credentialSecret)),
                    clientNonce: track(cloneBytes(clientNonce)),
                    credentialOpening: track(cloneBytes(credentialIssuePayload.credentialOpening)),
                    issuerPublicKeyId: issuerResponse.issuerPublicKeyId,
                    issuerSignature: track(cloneBytes(issuerResponse.blindSignature)),
                    metadata,
                    response: issuerResponse,
                    signal
                });
                if (signal.aborted)
                {
                    return null;
                }
                if (!isUsableCredentialMaterial(material))
                {
                    return failClosed(signal);
                }
                trackCredentialMaterial(material, track);

                if (!(material.revocationHandleHash instanceof Uint8Array) ||
          material.revocationHandleHash.byteLength === 0 ||
          metadata.revocationRoot.byteLength === 0)
                {
                    return failClosed(signal);
                }

                const cachedArtifact = revocationArtifactCache.get(metadata.credentialEpoch);
                if (cachedArtifact && (cachedArtifact.version > metadata.revocationDistribution.version ||
          (cachedArtifact.version === metadata.revocationDistribution.version &&
            cachedArtifact.revocationRoot !== bytesToHex(metadata.revocationRoot))))
                {
                    return failClosed(signal);
                }
                const canApplyDelta = Boolean(cachedArtifact &&
          cachedArtifact.version === metadata.revocationDistribution.version - 1 &&
          metadata.revocationDistribution.deltaPath);
                const artifactKind: 1 | 2 = canApplyDelta ? 2 : 1;
                const artifactPath = canApplyDelta
                    ? metadata.revocationDistribution.deltaPath!
                    : metadata.revocationDistribution.snapshotPath;
                const artifact = await loadRevocationArtifact(artifactPath, artifactKind, { signal });
                if (signal.aborted)
                {
                    return null;
                }
                const artifactBytes = artifact.entryHashes.byteLength + 88;
                if (artifactBytes > resolveRevocationDownloadBudget(metadata.revocationDistribution.maxArtifactBytes))
                {
                    return failClosed(signal);
                }
                track(artifact.revocationRoot);
                track(artifact.contentHash);
                track(artifact.signature);
                track(artifact.entryHashes);
                const workerResult = await getCommentPrivacyWorkerClient().buildRevocationWitness({
                    artifact,
                    baseEntryHashes: canApplyDelta ? cachedArtifact?.entryHashes : undefined,
                    revocationHandleHash: track(cloneBytes(material.revocationHandleHash)),
                    expectedEpoch: metadata.credentialEpoch,
                    expectedVersion: metadata.revocationDistribution.version,
                    expectedIssuerPublicKeyHash: metadata.issuerPublicKeyHash,
                    expectedRevocationRoot: track(cloneBytes(metadata.revocationRoot)),
                    nowUnixMs: now(),
                    maxCpuMs: resolveRevocationCpuBudget(),
                    signal
                });
                const revocationWitness = workerResult.witness;
                if (signal.aborted || revocationWitness.byteLength === 0 ||
          workerResult.entryHashes.byteLength !== metadata.revocationDistribution.version * 32)
                {
                    return null;
                }
                track(revocationWitness);
                track(workerResult.entryHashes);
                revocationArtifactCache.set(metadata.credentialEpoch, {
                    version: metadata.revocationDistribution.version,
                    revocationRoot: bytesToHex(metadata.revocationRoot),
                    entryHashes: cloneBytes(workerResult.entryHashes)
                });

                const expiresAtUnixMs = Math.min(metadata.rootExpiresAtUnixMs, issuerResponse.rootExpiresAtUnixMs);
                if (expiresAtUnixMs <= now())
                {
                    return failClosed(signal);
                }

                const credential = cloneCredentialMaterial({
                    ...material,
                    revocationWitness: cloneBytes(revocationWitness),
                    credentialLevel: issuerResponse.credentialLevel || material.credentialLevel || metadata.credentialLevel,
                    reputationBucket: material.reputationBucket || metadata.reputationBucket || DEFAULT_REPUTATION_BUCKET
                });
                trackCredentialMaterial(credential, track);
                const storedCredential = {
                    ...partition,
                    ...cloneCredentialMaterial(credential),
                    expiresAtUnixMs,
                    issuerPublicKeyId: issuerResponse.issuerPublicKeyId
                };
                await vault.put(storedCredential);
                zeroizeCredentialMaterial(storedCredential);

                return cloneCredentialMaterial(credential);
            }
            catch
            {
                return failClosed(signal);
            }
            finally
            {
                for (const bytes of temporaryBytes)
                {
                    zeroizeCommentPrivacyBytes(bytes);
                }
            }
        }
    };
}

export async function issueAnonymousCredential(
    request: CommentPrivacyCredentialIssueRequest,
    config: { signal: AbortSignal; }
): Promise<CommentPrivacyCredentialIssueResponse>
{
    const payload = encodeBlindCredentialIssueRequest(request);
    return await requestBinaryOnly<CommentPrivacyCredentialIssueResponse>({
        binaryUrl: '/api/binary/anonymous-credential/blind-issue',
        privateScope: 'account',
        frameType: FrameType.BlindCredentialIssueResponse,
        signal: config.signal,
        requestOptions: {
            method: 'POST',
            credentials: 'include',
            body: encodeAedsFrame(FrameType.BlindCredentialIssueRequest, payload)
        }
    });
}

export async function loadAnonymousCredentialRevocationArtifact(
    path: string,
    kind: 1 | 2,
    config: { signal: AbortSignal; }
): Promise<AnonymousCredentialRevocationArtifact>
{
    return getAnonymousCredentialRevocationArtifact(path, kind, { signal: config.signal });
}

async function loadDefaultCredentialMetadata(
    request: { signal: AbortSignal; }
): Promise<CommentPrivacyCredentialIssuerMetadata | null>
{
    const [root, circuit, blindIssuer] = await Promise.all([
        getAnonymousCredentialRootSnapshot({ signal: request.signal, credentials: 'omit' }),
        getAnonymousCredentialCircuitSnapshot({ signal: request.signal, credentials: 'omit' }),
        getBlindCredentialIssuerMetadata({ signal: request.signal, credentials: 'omit' })
    ]);
    const issuerPublicKeyHash = readIssuerPublicKeyHash(root);
    const circuitId = root.circuitId || circuit.circuitId;
    const revocationDistribution = readRevocationDistribution(root);
    if (!root.zkAnonymousEnabled ||
    !root.verifierConfigured ||
    !issuerPublicKeyHash ||
    !circuitId ||
    blindIssuer.issuerPublicKeyHash.trim().toLowerCase() !== issuerPublicKeyHash.trim().toLowerCase() ||
    blindIssuer.credentialEpoch !== root.credentialEpoch ||
    blindIssuer.circuitId !== circuitId ||
    blindIssuer.publicInputLayoutVersion !== root.publicInputLayoutVersion ||
    !revocationDistribution)
    {
        return null;
    }

    return {
        credentialEpoch: root.credentialEpoch,
        rootExpiresAtUnixMs: root.rootExpiresAtUnixMs,
        circuitNumericId: root.circuitNumericId,
        publicInputLayoutVersion: root.publicInputLayoutVersion,
        circuitId,
        credentialLevel: blindIssuer.credentialLevel || DEFAULT_CREDENTIAL_LEVEL,
        reputationBucket: DEFAULT_REPUTATION_BUCKET,
        issuerPublicKeyHash,
        schemeId: blindIssuer.schemeId,
        issuerPublicKeyId: blindIssuer.issuerPublicKeyId,
        modulusBytes: blindIssuer.modulusBytes,
        subjectPublicKeyInfo: cloneBytes(blindIssuer.subjectPublicKeyInfo),
        credentialRoot: cloneBytes(root.credentialRoot),
        revocationRoot: cloneBytes(root.revocationRoot),
        revocationDistribution
    };
}

function readIssuerPublicKeyHash(root: AnonymousCredentialRootSnapshot): string
{
    const issuerPublicKeyHash = (root as AnonymousCredentialRootSnapshot & {
        issuerPublicKeyHash?: unknown;
    }).issuerPublicKeyHash;
    return typeof issuerPublicKeyHash === 'string' && issuerPublicKeyHash.trim()
        ? issuerPublicKeyHash.trim()
        : '';
}

function readRevocationDistribution(root: AnonymousCredentialRootSnapshot): CommentPrivacyRevocationDistribution | null
{
    try
    {
        const metadata = JSON.parse(new TextDecoder().decode(root.circuitMetadata)) as {
            revocationDistribution?: Record<string, unknown>;
        };
        const value = metadata.revocationDistribution;
        if (!value)
        {
            return null;
        }
        const rootHex = bytesToHex(root.revocationRoot);
        const epoch = Number(value.epoch);
        const version = Number(value.version);
        const expectedPrefix = `/api/binary/anonymous-credential/revocation/${epoch}/${version}/${rootHex}`;
        const distribution: CommentPrivacyRevocationDistribution = {
            protocol: value.protocol as CommentPrivacyRevocationDistribution['protocol'],
            epoch,
            version,
            contentAddress: String(value.contentAddress ?? '').toLowerCase(),
            snapshotPath: String(value.snapshotPath ?? ''),
            deltaPath: typeof value.deltaPath === 'string' ? value.deltaPath : null,
            entryBytes: Number(value.entryBytes) as 32,
            maxArtifactBytes: Number(value.maxArtifactBytes)
        };
        if (distribution.protocol !== 'public-snapshot-delta.v1' ||
      distribution.epoch !== root.credentialEpoch ||
      !Number.isSafeInteger(distribution.version) || distribution.version < 0 ||
      distribution.contentAddress !== rootHex ||
      distribution.snapshotPath !== `${expectedPrefix}/full.aeds` ||
      distribution.deltaPath !== (version > 0 ? `${expectedPrefix}/delta/${version - 1}.aeds` : null) ||
      distribution.entryBytes !== 32 ||
      !Number.isSafeInteger(distribution.maxArtifactBytes) ||
      distribution.maxArtifactBytes <= 0 || distribution.maxArtifactBytes > MAX_REVOCATION_ARTIFACT_BYTES)
        {
            return null;
        }
        return distribution;
    }
    catch
    {
        return null;
    }
}

function isUsableRevocationDistribution(
    distribution: CommentPrivacyRevocationDistribution,
    metadata: CommentPrivacyCredentialIssuerMetadata
): boolean
{
    return distribution.protocol === 'public-snapshot-delta.v1' &&
    distribution.epoch === metadata.credentialEpoch &&
    Number.isSafeInteger(distribution.version) && distribution.version >= 0 &&
    distribution.contentAddress === bytesToHex(metadata.revocationRoot) &&
    distribution.entryBytes === 32 &&
    distribution.maxArtifactBytes > 0 &&
    distribution.maxArtifactBytes <= MAX_REVOCATION_ARTIFACT_BYTES;
}

function resolveRevocationDownloadBudget(serverMaximum: number): number
{
    const deviceMemory = Number((globalThis.navigator as Navigator & { deviceMemory?: number; } | undefined)?.deviceMemory ?? 4);
    const deviceBudget = deviceMemory <= 2 ? 1024 * 1024 : deviceMemory <= 4 ? 2 * 1024 * 1024 : MAX_REVOCATION_ARTIFACT_BYTES;
    return Math.min(serverMaximum, deviceBudget);
}

function resolveRevocationCpuBudget(): number
{
    const hardwareConcurrency = Number(globalThis.navigator?.hardwareConcurrency ?? 2);
    const deviceMemory = Number((globalThis.navigator as Navigator & { deviceMemory?: number; } | undefined)?.deviceMemory ?? 4);
    return hardwareConcurrency <= 2 || deviceMemory <= 2 ? 4_000 : 2_000;
}

function isUsableMetadata(
    metadata: CommentPrivacyCredentialIssuerMetadata | null,
    nowUnixMs: number
): metadata is CommentPrivacyCredentialIssuerMetadata
{
    if (!metadata)
    {
        return false;
    }

    return Number.isSafeInteger(metadata.credentialEpoch) &&
    metadata.credentialEpoch > 0 &&
    Number.isFinite(metadata.rootExpiresAtUnixMs) &&
    metadata.rootExpiresAtUnixMs > nowUnixMs &&
    Number.isSafeInteger(metadata.circuitNumericId) &&
    metadata.circuitNumericId > 0 &&
    Number.isSafeInteger(metadata.publicInputLayoutVersion) &&
    metadata.publicInputLayoutVersion > 0 &&
    Boolean(metadata.circuitId) &&
    Boolean(metadata.credentialLevel) &&
    Boolean(metadata.reputationBucket) &&
    Boolean(metadata.issuerPublicKeyHash) &&
    Boolean(metadata.schemeId) &&
    Boolean(metadata.issuerPublicKeyId) &&
    metadata.modulusBytes === 384 &&
    metadata.subjectPublicKeyInfo instanceof Uint8Array &&
    metadata.subjectPublicKeyInfo.byteLength > 0 &&
    metadata.credentialRoot instanceof Uint8Array &&
    metadata.credentialRoot.byteLength > 0 &&
    metadata.revocationRoot instanceof Uint8Array &&
    metadata.revocationRoot.byteLength === 32 &&
    isUsableRevocationDistribution(metadata.revocationDistribution, metadata);
}

function metadataPartition(
    metadata: CommentPrivacyCredentialIssuerMetadata
): CommentPrivacyCredentialVaultPartition
{
    return currentCommentPrivacyVaultPartition({
        credentialEpoch: metadata.credentialEpoch,
        circuitId: metadata.circuitId,
        issuerPublicKeyHash: metadata.issuerPublicKeyHash
    });
}

function metadataBinding(metadata: CommentPrivacyCredentialIssuerMetadata): string
{
    return [
        metadata.credentialEpoch,
        metadata.circuitNumericId,
        metadata.publicInputLayoutVersion,
        metadata.circuitId,
        metadata.issuerPublicKeyHash.trim().toLowerCase(),
        metadata.schemeId,
        metadata.issuerPublicKeyId,
        bytesToHex(metadata.credentialRoot),
        bytesToHex(metadata.revocationRoot),
        metadata.revocationDistribution.version,
        metadata.revocationDistribution.contentAddress
    ].join(':');
}

function classifyMetadataRotation(
    previous: CommentPrivacyCredentialIssuerMetadata,
    current: CommentPrivacyCredentialIssuerMetadata
): CommentPrivacyCredentialPurgeReason
{
    if (previous.credentialEpoch !== current.credentialEpoch)
    {
        return 'epoch-changed';
    }
    if (previous.issuerPublicKeyHash.trim().toLowerCase() !== current.issuerPublicKeyHash.trim().toLowerCase())
    {
        return 'issuer-key-rotation';
    }
    return 'root-retired';
}

function cloneMetadata(metadata: CommentPrivacyCredentialIssuerMetadata): CommentPrivacyCredentialIssuerMetadata
{
    return {
        ...metadata,
        subjectPublicKeyInfo: cloneBytes(metadata.subjectPublicKeyInfo),
        credentialRoot: cloneBytes(metadata.credentialRoot),
        revocationRoot: cloneBytes(metadata.revocationRoot),
        revocationDistribution: { ...metadata.revocationDistribution }
    };
}

function isUsableCredentialIssuePayload(
    request: CommentPrivacyCredentialIssuePayload | null
): request is CommentPrivacyCredentialIssuePayload
{
    return Boolean(request) &&
    request?.credentialRequest instanceof Uint8Array &&
    request.credentialRequest.byteLength > 0 &&
    request.credentialOpening instanceof Uint8Array &&
    request.credentialOpening.byteLength > 0;
}

function matchesMetadata(
    response: CommentPrivacyCredentialIssueResponse,
    metadata: CommentPrivacyCredentialIssuerMetadata
): boolean
{
    return response.credentialEpoch === metadata.credentialEpoch &&
    response.circuitNumericId === metadata.circuitNumericId &&
    response.publicInputLayoutVersion === metadata.publicInputLayoutVersion &&
    response.circuitId === metadata.circuitId &&
    response.schemeId === metadata.schemeId &&
    response.issuerPublicKeyId === metadata.issuerPublicKeyId &&
    typeof response.issuerPublicKeyId === 'string' &&
    response.issuerPublicKeyId.trim().length > 0 &&
    response.blindSignature instanceof Uint8Array &&
    response.blindSignature.byteLength === metadata.modulusBytes;
}

function isUsableCredentialMaterial(
    material: CommentPrivacyCredentialMaterial | null
): material is CommentPrivacyCredentialMaterial
{
    return Boolean(material) &&
    material?.credentialSecret instanceof Uint8Array &&
    material.credentialSecret.byteLength > 0 &&
    material.credentialCommitment instanceof Uint8Array &&
    material.credentialCommitment.byteLength > 0 &&
    material.issuerSignature instanceof Uint8Array &&
    material.issuerSignature.byteLength > 0 &&
    material.revocationWitness instanceof Uint8Array &&
    material.revocationWitness.byteLength > 0 &&
    typeof material.credentialLevel === 'string' &&
    material.credentialLevel.length > 0 &&
    typeof material.reputationBucket === 'string' &&
    material.reputationBucket.length > 0;
}

function randomBytes(
    cryptoSource: Pick<Crypto, 'getRandomValues'>,
    byteLength: number
): Uint8Array
{
    const bytes = new Uint8Array(byteLength);
    cryptoSource.getRandomValues(bytes);
    return bytes;
}

function cloneCredentialMaterial(material: CommentPrivacyCredentialMaterial): CommentPrivacyCredentialMaterial
{
    const cloned: CommentPrivacyCredentialMaterial = {
        credentialSecret: cloneBytes(material.credentialSecret),
        credentialCommitment: cloneBytes(material.credentialCommitment),
        issuerSignature: cloneBytes(material.issuerSignature),
        revocationWitness: cloneBytes(material.revocationWitness),
        credentialLevel: material.credentialLevel,
        reputationBucket: material.reputationBucket
    };
    if (material.revocationHandleHash instanceof Uint8Array && material.revocationHandleHash.byteLength > 0)
    {
        cloned.revocationHandleHash = cloneBytes(material.revocationHandleHash);
    }
    return cloned;
}

function trackCredentialMaterial(
    material: CommentPrivacyCredentialMaterial,
    track: (bytes: Uint8Array) => Uint8Array
): void
{
    track(material.credentialSecret);
    track(material.credentialCommitment);
    track(material.issuerSignature);
    track(material.revocationWitness);
    if (material.revocationHandleHash)
    {
        track(material.revocationHandleHash);
    }
}

function zeroizeCredentialMaterial(material: CommentPrivacyCredentialMaterial): void
{
    zeroizeCommentPrivacyBytes(material.credentialSecret);
    zeroizeCommentPrivacyBytes(material.credentialCommitment);
    zeroizeCommentPrivacyBytes(material.issuerSignature);
    zeroizeCommentPrivacyBytes(material.revocationWitness);
    zeroizeCommentPrivacyBytes(material.revocationHandleHash);
}

function cloneBytes(bytes: Uint8Array): Uint8Array
{
    return new Uint8Array(bytes);
}

function bytesToHex(bytes: Uint8Array): string
{
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function getGlobalCrypto(): Pick<Crypto, 'getRandomValues' | 'subtle'> | null
{
    return typeof globalThis.crypto === 'undefined'
        ? null
        : globalThis.crypto;
}
