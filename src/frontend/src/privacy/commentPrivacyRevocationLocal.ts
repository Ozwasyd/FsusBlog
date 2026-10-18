import type { AnonymousCredentialRevocationArtifact } from '@/api/comment';

import {
    encodeCommentPrivacyRevocationWitnessMaterial,
    type CommentPrivacyRevocationWitnessMaterial
} from './commentPrivacyRevocationWitness';

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_DEPTH = 128;
const MIMC_ROUNDS = 91;
const FIELD_BYTES = 32;
const ALGORITHM = 'circuit-friendly-non-membership.v1';
const DISTRIBUTION_PROTOCOL = 'public-snapshot-delta.v1';
const ARTIFACT_SIGNATURE_DOMAIN = 'fsus.anonymous.revocation.public-artifact.v1';
const LEAF_DOMAIN = 'fsus.anonymous.revocation.circuit.leaf.v1';
const NODE_DOMAIN = 'fsus.anonymous.revocation.circuit.node.v1';
const WITNESS_DOMAIN = 'fsus.anonymous.revocation.circuit.nonmembership.v1';
const EMPTY_LEAF_DOMAIN = 'fsus.anonymous.revocation.circuit.empty.v1';
const SIBLING_DIGEST_DOMAIN = 'fsus.anonymous.revocation.circuit.sibling-digest.v1';
const ROUND_DOMAIN = 'fsus.anonymous.revocation.circuit.mimc7.bn254.round.v1';

export interface CommentPrivacyRevocationBuildRequest {
    artifact: AnonymousCredentialRevocationArtifact;
    baseEntryHashes?: Uint8Array;
    revocationHandleHash: Uint8Array;
    expectedEpoch: number;
    expectedVersion: number;
    expectedIssuerPublicKeyHash: string;
    expectedRevocationRoot: Uint8Array;
    nowUnixMs: number;
    maxCpuMs: number;
}

export interface CommentPrivacyRevocationBuildResult {
    witness: Uint8Array;
    entryHashes: Uint8Array;
}

let roundConstantsPromise: Promise<bigint[]> | null = null;
let defaultsPromise: Promise<string[]> | null = null;

export async function buildCommentPrivacyRevocationWitnessLocally(
    request: CommentPrivacyRevocationBuildRequest
): Promise<CommentPrivacyRevocationBuildResult>
{
    const startedAt = performance.now();
    const artifact = request.artifact;
    validateArtifactShape(request);
    const entries = artifact.kind === 1
        ? new Uint8Array(artifact.entryHashes)
        : concatBytes(request.baseEntryHashes ?? new Uint8Array(), artifact.entryHashes);
    if (entries.byteLength !== artifact.version * FIELD_BYTES)
    {
        throw new Error('comment_privacy_revocation_version_mismatch');
    }

    const contentHash = await computeArtifactContentHash(artifact);
    if (!bytesEqual(contentHash, artifact.contentHash))
    {
        throw new Error('comment_privacy_revocation_content_hash_invalid');
    }
    const signature = await sha256(utf8([
        ARTIFACT_SIGNATURE_DOMAIN,
        String(artifact.credentialEpoch),
        String(artifact.version),
        String(artifact.baseVersion),
        bytesToHex(artifact.revocationRoot),
        artifact.issuerPublicKeyHash.trim().toLowerCase(),
        bytesToHex(contentHash)
    ].join('\0')));
    if (!bytesEqual(signature, artifact.signature))
    {
        throw new Error('comment_privacy_revocation_signature_invalid');
    }

    const revokedHandles = splitHashes(entries);
    const handle = bytesToHex(request.revocationHandleHash);
    if (revokedHandles.includes(handle))
    {
        throw new Error('comment_privacy_credential_revoked');
    }

    const tree = await buildSparseTree(
        artifact.credentialEpoch,
        artifact.issuerPublicKeyHash.trim().toLowerCase(),
        revokedHandles,
        startedAt,
        request.maxCpuMs);
    const expectedRoot = bytesToHex(request.expectedRevocationRoot);
    if (tree.root !== expectedRoot)
    {
        throw new Error('comment_privacy_revocation_root_invalid');
    }

    const key = fieldFromHex(handle.slice(0, 32));
    const siblings: string[] = [];
    let cursor = key;
    for (let level = 0; level < TREE_DEPTH; level += 1)
    {
        const siblingIndex = cursor ^ 1n;
        siblings.push(tree.levels[level].get(siblingIndex) ?? tree.defaults[level]);
        cursor >>= 1n;
    }
    const leafKey = formatFieldBytes(key, 16);
    const witnessHash = hexToBytes(await circuitHash(
        WITNESS_DOMAIN,
        String(artifact.credentialEpoch),
        expectedRoot,
        artifact.issuerPublicKeyHash.trim().toLowerCase(),
        handle,
        bytesToHex(leafKey),
        await computeSiblingDigest(siblings)
    ));
    const material: CommentPrivacyRevocationWitnessMaterial = {
        credentialEpoch: artifact.credentialEpoch,
        algorithmId: ALGORITHM,
        pathDepth: TREE_DEPTH,
        issuerPublicKeyHash: artifact.issuerPublicKeyHash.trim().toLowerCase(),
        revocationRoot: new Uint8Array(artifact.revocationRoot),
        revocationHandleHash: new Uint8Array(request.revocationHandleHash),
        leafKey,
        witnessHash,
        siblingHashes: concatBytes(...siblings.map(hexToBytes))
    };
    return {
        witness: encodeCommentPrivacyRevocationWitnessMaterial(material),
        entryHashes: entries
    };
}

function validateArtifactShape(request: CommentPrivacyRevocationBuildRequest): void
{
    const artifact = request.artifact;
    const issuer = artifact.issuerPublicKeyHash.trim().toLowerCase();
    const expectedIssuer = request.expectedIssuerPublicKeyHash.trim().toLowerCase();
    if (artifact.credentialEpoch !== request.expectedEpoch ||
    artifact.version !== request.expectedVersion ||
    artifact.expiresAtUnixMs <= request.nowUnixMs ||
    artifact.algorithmId !== ALGORITHM ||
    artifact.pathDepth !== TREE_DEPTH ||
    issuer !== expectedIssuer ||
    !bytesEqual(artifact.revocationRoot, request.expectedRevocationRoot) ||
    artifact.contentHash.byteLength !== FIELD_BYTES || artifact.signature.byteLength !== FIELD_BYTES ||
    artifact.revocationRoot.byteLength !== FIELD_BYTES || artifact.entryHashes.byteLength % FIELD_BYTES !== 0 ||
    request.revocationHandleHash.byteLength !== FIELD_BYTES)
    {
        throw new Error('comment_privacy_revocation_artifact_invalid');
    }
    if ((artifact.kind === 1 && artifact.baseVersion !== 0) ||
    (artifact.kind === 2 && (artifact.baseVersion <= 0 ||
      request.baseEntryHashes?.byteLength !== artifact.baseVersion * FIELD_BYTES)))
    {
        throw new Error('comment_privacy_revocation_rollback_detected');
    }
}

async function computeArtifactContentHash(artifact: AnonymousCredentialRevocationArtifact): Promise<Uint8Array>
{
    return sha256(concatBytes(
        utf8(`${DISTRIBUTION_PROTOCOL}\0${artifact.credentialEpoch}\0${artifact.version}\0${artifact.baseVersion}\0${artifact.expiresAtUnixMs}\0${artifact.kind}\0${artifact.pathDepth}\0${artifact.algorithmId}\0${artifact.issuerPublicKeyHash.trim().toLowerCase()}\0`),
        artifact.revocationRoot,
        artifact.entryHashes
    ));
}

async function buildSparseTree(
    epoch: number,
    issuer: string,
    handles: string[],
    startedAt: number,
    maxCpuMs: number
): Promise<{ root: string; levels: Map<bigint, string>[]; defaults: string[]; }>
{
    const defaults = await getDefaultRoots();
    const leaves = new Map<bigint, string>();
    for (const handle of [...new Set(handles)].sort())
    {
        const key = fieldFromHex(handle.slice(0, 32));
        const leaf = await circuitHash(LEAF_DOMAIN, String(epoch), issuer, handle, bytesToHex(formatFieldBytes(key, 16)));
        const previous = leaves.get(key);
        if (previous && previous !== leaf)
        {
            throw new Error('comment_privacy_revocation_key_collision');
        }
        leaves.set(key, leaf);
        enforceCpuBudget(startedAt, maxCpuMs);
    }

    const levels: Map<bigint, string>[] = [leaves];
    let current = leaves;
    for (let level = 0; level < TREE_DEPTH; level += 1)
    {
        const parents = new Set<bigint>();
        for (const key of current.keys())
        {
            parents.add(key >> 1n);
        }
        const next = new Map<bigint, string>();
        for (const parent of parents)
        {
            const leftIndex = parent << 1n;
            const left = current.get(leftIndex) ?? defaults[level];
            const right = current.get(leftIndex + 1n) ?? defaults[level];
            next.set(parent, await circuitHash(NODE_DOMAIN, String(level), left, right));
        }
        current = next;
        levels.push(current);
        enforceCpuBudget(startedAt, maxCpuMs);
    }
    return { root: current.get(0n) ?? defaults[TREE_DEPTH], levels, defaults };
}

async function getDefaultRoots(): Promise<string[]>
{
    defaultsPromise ??= (async () =>
    {
        const defaults = new Array<string>(TREE_DEPTH + 1);
        defaults[0] = await circuitHash(EMPTY_LEAF_DOMAIN, '0');
        for (let level = 0; level < TREE_DEPTH; level += 1)
        {
            defaults[level + 1] = await circuitHash(NODE_DOMAIN, String(level), defaults[level], defaults[level]);
        }
        return defaults;
    })();
    return defaultsPromise;
}

async function getRoundConstants(): Promise<bigint[]>
{
    roundConstantsPromise ??= Promise.all(Array.from({ length: MIMC_ROUNDS }, async (_, index) =>
    index === 0 ? 0n : fieldFromBytes(await sha256(utf8(`${ROUND_DOMAIN}:${index}`)))));
    return roundConstantsPromise;
}

async function circuitHash(...parts: string[]): Promise<string>
{
    let state = 0n;
    for (const part of parts)
    {
        state = await mimc(mod(state + await fieldFromToken(part)));
    }
    return bytesToHex(formatFieldBytes(state, FIELD_BYTES));
}

async function computeSiblingDigest(siblings: string[]): Promise<string>
{
    let state = await fieldFromToken(SIBLING_DIGEST_DOMAIN);
    for (let index = 0; index < siblings.length; index += 1)
    {
        state = await mimc(mod(state + await fieldFromToken(String(index)) + fieldFromHex(siblings[index])));
    }
    return bytesToHex(formatFieldBytes(state, FIELD_BYTES));
}

async function mimc(value: bigint): Promise<bigint>
{
    let x = value;
    for (const constant of await getRoundConstants())
    {
        const base = mod(x + constant);
        const x2 = mod(base * base);
        const x4 = mod(x2 * x2);
        x = mod(mod(x4 * x2) * base);
    }
    return mod(x + value);
}

async function fieldFromToken(value: string): Promise<bigint>
{
    const trimmed = value.trim().slice(0, 4096);
    return trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-f]+$/i.test(trimmed)
        ? fieldFromHex(trimmed)
        : fieldFromBytes(await sha256(utf8(trimmed)));
}

function fieldFromHex(value: string): bigint
{
    return mod(BigInt(`0x${value || '0'}`));
}

function fieldFromBytes(bytes: Uint8Array): bigint
{
    return fieldFromHex(bytesToHex(bytes));
}

function mod(value: bigint): bigint
{
    const result = value % FIELD_PRIME;
    return result < 0n ? result + FIELD_PRIME : result;
}

function formatFieldBytes(value: bigint, length: number): Uint8Array
{
    const hex = mod(value).toString(16).padStart(length * 2, '0').slice(-length * 2);
    return hexToBytes(hex);
}

function splitHashes(bytes: Uint8Array): string[]
{
    const values: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += FIELD_BYTES)
    {
        values.push(bytesToHex(bytes.subarray(offset, offset + FIELD_BYTES)));
    }
    return values;
}

function enforceCpuBudget(startedAt: number, maxCpuMs: number): void
{
    if (performance.now() - startedAt > maxCpuMs)
    {
        throw new Error('comment_privacy_revocation_cpu_budget_exceeded');
    }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array>
{
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

function utf8(value: string): Uint8Array
{
    return new TextEncoder().encode(value);
}

function hexToBytes(hex: string): Uint8Array
{
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1)
    {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string
{
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean
{
    if (left.byteLength !== right.byteLength)
    {
        return false;
    }
    let diff = 0;
    for (let index = 0; index < left.byteLength; index += 1)
    {
        diff |= left[index] ^ right[index];
    }
    return diff === 0;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array
{
    const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts)
    {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}
