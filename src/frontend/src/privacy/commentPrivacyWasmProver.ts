import {
    resolveCommentPrivacyProverModuleUrl,
    setCommentPrivacyProverScriptUrl
} from '@/security/trustedTypesRuntime';

import { parseCommentPrivacyRevocationWitnessMaterial } from './commentPrivacyRevocationWitness';

import type { CommentPrivacyProofBundle, CommentPrivacyProofRequest } from './commentPrivacyTypes';

export interface CommentPrivacyProverManifest {
    moduleUrl: string;
    wasmUrl: string;
    provingKeyUrl: string;
    integrity: string;
    circuitId: string;
    publicInputLayoutVersion: number;
    provingKeySha256: string;
    wasmSha256: string;
}

export interface CommentPrivacyWasmProver {
    prewarm(signal?: AbortSignal): Promise<void>;
    prepareProof(request: CommentPrivacyProofRequest): Promise<CommentPrivacyProofBundle>;
}

export interface CommentPrivacyWasmProverOptions {
    manifestUrl?: string;
    loadManifest?: (request: { manifestUrl: string; signal?: AbortSignal; }) => Promise<CommentPrivacyProverManifest | null>;
    loadArtifact?: (request: { artifactUrl: string; signal?: AbortSignal; }) => Promise<Uint8Array | null>;
    loadModule?: (moduleUrl: string, signal?: AbortSignal) => Promise<unknown>;
    importModule?: (moduleUrl: string, signal?: AbortSignal) => Promise<unknown>;
}

interface WasmProverDelegate {
    prewarm?: (request: { manifest: CommentPrivacyProverManifest; signal?: AbortSignal; }) => Promise<void> | void;
    prepareProof: (request: CommentPrivacyProofRequest & { manifest: CommentPrivacyProverManifest; }) => unknown;
}

interface LoadedProver {
    manifest: CommentPrivacyProverManifest;
    delegate: WasmProverDelegate;
}

const DEFAULT_MANIFEST_URL = '/wasm/comment-privacy-prover.manifest.json';
const ARTIFACT_UNAVAILABLE = 'comment_privacy_prover_artifact_unavailable';
const ARTIFACT_INVALID = 'comment_privacy_prover_artifact_invalid';
const PROOF_FAILED = 'comment_privacy_prover_failed';
const PUBLIC_INPUT_TRANSCRIPT_DOMAIN = 'fsus.anonymous.comment.v5.public-inputs';
const COMMENT_ACTION_CONTEXT = 'comment.create';
const BROWSER_PROVER_MODULE_GLOBAL = '__fsusCommentPrivacyProverModule';
const browserProverScriptLoads = new Map<string, Promise<unknown>>();
const workerProverModuleImports = new Map<string, Promise<unknown>>();

export function createCommentPrivacyWasmProver(options: CommentPrivacyWasmProverOptions = {}): CommentPrivacyWasmProver
{
    const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
    const loadManifest = options.loadManifest ?? defaultLoadManifest;
    const loadArtifact = options.loadArtifact ?? defaultLoadArtifact;
    const importModule = options.importModule ?? defaultImportModule;
    const loadModule = options.loadModule ?? ((moduleUrl, signal) => defaultLoadModule(moduleUrl, signal, importModule));
    let loadedPromise: Promise<LoadedProver> | null = null;

    const load = async (signal?: AbortSignal): Promise<LoadedProver> =>
    {
        throwIfAborted(signal);
        loadedPromise ??= (async () =>
        {
            const manifest = normalizeManifest(await loadManifest({ manifestUrl, signal }));
            await verifyManifestArtifacts(manifest, loadArtifact, signal);
            const module = await loadModule(manifest.moduleUrl, signal);
            return {
                manifest,
                delegate: resolveDelegate(module)
            };
        })();

        try
        {
            return await loadedPromise;
        }
        catch (error)
        {
            loadedPromise = null;
            throw sanitizeProverError(error);
        }
    };

    return {
        async prewarm(signal?: AbortSignal): Promise<void>
        {
            const loaded = await load(signal);
            await loaded.delegate.prewarm?.({ manifest: loaded.manifest, signal });
        },
        async prepareProof(request: CommentPrivacyProofRequest): Promise<CommentPrivacyProofBundle>
        {
            throwIfAborted(request.signal);
            assertProofRequest(request);
            const loaded = await load(request.signal);
            assertManifestMatchesRequest(loaded.manifest, request);
            try
            {
                const result = await loaded.delegate.prepareProof({ ...request, manifest: loaded.manifest });
                return normalizeProofBundle(result, request);
            }
            catch (error)
            {
                throw sanitizeProverError(error, PROOF_FAILED);
            }
        }
    };
}

async function defaultLoadManifest(request: { manifestUrl: string; signal?: AbortSignal; }): Promise<CommentPrivacyProverManifest | null>
{
    if (typeof fetch !== 'function')
    {
        return null;
    }

    const response = await fetch(request.manifestUrl, {
        cache: 'force-cache',
        credentials: 'omit',
        signal: request.signal
    });
    if (!response.ok)
    {
        return null;
    }

    return await response.json() as CommentPrivacyProverManifest;
}

async function defaultLoadArtifact(request: { artifactUrl: string; signal?: AbortSignal; }): Promise<Uint8Array | null>
{
    if (typeof fetch !== 'function')
    {
        return null;
    }

    const response = await fetch(request.artifactUrl, {
        cache: 'force-cache',
        credentials: 'omit',
        signal: request.signal
    });
    if (!response.ok)
    {
        return null;
    }

    return new Uint8Array(await response.arrayBuffer());
}

async function defaultLoadModule(
    moduleUrl: string,
    signal: AbortSignal | undefined,
    importModule: NonNullable<CommentPrivacyWasmProverOptions['importModule']>
): Promise<unknown>
{
    throwIfAborted(signal);
    if (typeof document === 'undefined' || typeof document.createElement !== 'function' || !document.head)
    {
        return await loadWorkerProverModule(moduleUrl, signal, importModule);
    }

    const loadedModule = getBrowserProverModule();
    if (loadedModule)
    {
        return loadedModule;
    }

    let loadPromise = browserProverScriptLoads.get(moduleUrl);
    if (!loadPromise)
    {
        loadPromise = loadBrowserProverModuleScript(moduleUrl, signal);
        browserProverScriptLoads.set(moduleUrl, loadPromise);
    }

    try
    {
        return await loadPromise;
    }
    catch (error)
    {
        if (browserProverScriptLoads.get(moduleUrl) === loadPromise)
        {
            browserProverScriptLoads.delete(moduleUrl);
        }
        throw error;
    }
}

async function defaultImportModule(moduleUrl: string, signal?: AbortSignal): Promise<unknown>
{
    throwIfAborted(signal);
    const loaded: unknown = await import(/* @vite-ignore */ resolveCommentPrivacyProverModuleUrl(moduleUrl));
    throwIfAborted(signal);
    return loaded;
}

async function loadWorkerProverModule(
    moduleUrl: string,
    signal: AbortSignal | undefined,
    importModule: NonNullable<CommentPrivacyWasmProverOptions['importModule']>
): Promise<unknown>
{
    let loadPromise = workerProverModuleImports.get(moduleUrl);
    if (!loadPromise)
    {
        loadPromise = importModule(moduleUrl, signal);
        workerProverModuleImports.set(moduleUrl, loadPromise);
    }

    try
    {
        const importedModule = await loadPromise;
        throwIfAborted(signal);
        return getBrowserProverModule() ?? importedModule;
    }
    catch (error)
    {
        if (workerProverModuleImports.get(moduleUrl) === loadPromise)
        {
            workerProverModuleImports.delete(moduleUrl);
        }
        throw error;
    }
}

async function loadBrowserProverModuleScript(moduleUrl: string, signal?: AbortSignal): Promise<unknown>
{
    return await new Promise<unknown>((resolve, reject) =>
    {
        throwIfAborted(signal);
        const script = document.createElement('script');
        let settled = false;

        const cleanup = (): void =>
        {
            script.onload = null;
            script.onerror = null;
            signal?.removeEventListener('abort', abort);
        };
        const finish = (callback: () => void): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            cleanup();
            callback();
        };
        const abort = (): void =>
        {
            script.remove();
            finish(() => reject(new DOMException('Aborted', 'AbortError')));
        };

        script.type = 'module';
        script.async = true;
        setCommentPrivacyProverScriptUrl(script, moduleUrl);
        script.onload = (): void =>
        {
            finish(() =>
            {
                const browserModule = getBrowserProverModule();
                if (browserModule)
                {
                    resolve(browserModule);
                    return;
                }
                reject(new Error(ARTIFACT_INVALID));
            });
        };
        script.onerror = (): void =>
        {
            finish(() => reject(new Error(ARTIFACT_UNAVAILABLE)));
        };
        signal?.addEventListener('abort', abort, { once: true });
        document.head.appendChild(script);
    });
}

function getBrowserProverModule(): unknown
{
    return asRecord(globalThis)[BROWSER_PROVER_MODULE_GLOBAL] ?? null;
}

function normalizeManifest(manifest: CommentPrivacyProverManifest | null): CommentPrivacyProverManifest
{
    if (!manifest)
    {
        throw new Error(ARTIFACT_UNAVAILABLE);
    }

    if (
        !isNonEmptyString(manifest.moduleUrl) ||
    !isNonEmptyString(manifest.wasmUrl) ||
    !isNonEmptyString(manifest.provingKeyUrl) ||
    !isNonEmptyString(manifest.integrity) ||
    !isNonEmptyString(manifest.circuitId) ||
    !isValidLayoutVersion(manifest.publicInputLayoutVersion) ||
    !isSha256Hex(manifest.wasmSha256) ||
    !isSha256Hex(manifest.provingKeySha256)
    )
    {
        throw new Error(ARTIFACT_INVALID);
    }

    return {
        moduleUrl: normalizeSameOriginArtifactUrl(manifest.moduleUrl, '/wasm/comment-privacy-prover.js'),
        wasmUrl: normalizeSameOriginArtifactUrl(manifest.wasmUrl, '/wasm/comment-privacy-prover.wasm'),
        provingKeyUrl: normalizeSameOriginArtifactUrl(manifest.provingKeyUrl, '/wasm/comment-privacy-prover.zkey'),
        integrity: manifest.integrity.trim(),
        circuitId: manifest.circuitId.trim(),
        publicInputLayoutVersion: manifest.publicInputLayoutVersion,
        wasmSha256: manifest.wasmSha256.toLowerCase(),
        provingKeySha256: manifest.provingKeySha256.toLowerCase()
    };
}

function normalizeSameOriginArtifactUrl(value: string, expectedPath: string): string
{
    const raw = value.trim();
    const runtimeLocation = typeof globalThis.location === 'undefined' ? null : globalThis.location;
    const baseHref = runtimeLocation?.href ?? 'http://localhost/';
    let resolved: URL;
    try
    {
        resolved = new URL(raw, baseHref);
    }
    catch
    {
        throw new Error(ARTIFACT_INVALID);
    }
    const runtimeOrigin = runtimeLocation?.origin;
    const expectedOrigin = (runtimeOrigin === '' ? undefined : runtimeOrigin) ?? new URL(baseHref).origin;
    if (!raw || resolved.origin !== expectedOrigin || resolved.pathname !== expectedPath
    || resolved.search || resolved.hash || resolved.username || resolved.password)
    {
        throw new Error(ARTIFACT_INVALID);
    }
    return raw;
}

async function verifyManifestArtifacts(
    manifest: CommentPrivacyProverManifest,
    loadArtifact: NonNullable<CommentPrivacyWasmProverOptions['loadArtifact']>,
    signal?: AbortSignal
): Promise<void>
{
    const [moduleBytes, wasmBytes, provingKeyBytes] = await Promise.all([
        loadRequiredArtifact(loadArtifact, manifest.moduleUrl, signal),
        loadRequiredArtifact(loadArtifact, manifest.wasmUrl, signal),
        loadRequiredArtifact(loadArtifact, manifest.provingKeyUrl, signal)
    ]);

    await Promise.all([
        assertSubresourceIntegrity(moduleBytes, manifest.integrity),
        assertSha256(wasmBytes, manifest.wasmSha256),
        assertSha256(provingKeyBytes, manifest.provingKeySha256)
    ]);
}

async function loadRequiredArtifact(
    loadArtifact: NonNullable<CommentPrivacyWasmProverOptions['loadArtifact']>,
    artifactUrl: string,
    signal?: AbortSignal
): Promise<Uint8Array>
{
    throwIfAborted(signal);
    const artifact = await loadArtifact({ artifactUrl, signal });
    throwIfAborted(signal);
    if (!(artifact instanceof Uint8Array))
    {
        throw new Error(ARTIFACT_UNAVAILABLE);
    }
    if (artifact.byteLength === 0)
    {
        throw new Error(ARTIFACT_INVALID);
    }

    return new Uint8Array(artifact);
}

async function assertSubresourceIntegrity(bytes: Uint8Array, integrity: string): Promise<void>
{
    const tokens = parseIntegrityTokens(integrity);
    if (tokens.length === 0)
    {
        throw new Error(ARTIFACT_INVALID);
    }

    const digests = new Map<string, string>();
    for (const token of tokens)
    {
        if (!digests.has(token.algorithm))
        {
            digests.set(token.algorithm, bytesToBase64(await digestBytes(token.algorithm, bytes)));
        }
        if (digests.get(token.algorithm) === token.value)
        {
            return;
        }
    }

    throw new Error(ARTIFACT_INVALID);
}

async function assertSha256(bytes: Uint8Array, expectedHex: string): Promise<void>
{
    const actualHex = bytesToHex(await digestBytes('SHA-256', bytes));
    if (actualHex !== expectedHex)
    {
        throw new Error(ARTIFACT_INVALID);
    }
}

function parseIntegrityTokens(integrity: string): { algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512'; value: string; }[]
{
    const tokens: { algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512'; value: string; }[] = [];
    for (const token of integrity.trim().split(/\s+/u))
    {
        const separator = token.indexOf('-');
        if (separator <= 0)
        {
            continue;
        }

        const algorithm = normalizeIntegrityAlgorithm(token.slice(0, separator));
        const value = token.slice(separator + 1).split('?')[0];
        if (algorithm && value.length > 0)
        {
            tokens.push({ algorithm, value });
        }
    }

    return tokens;
}

function normalizeIntegrityAlgorithm(value: string): 'SHA-256' | 'SHA-384' | 'SHA-512' | null
{
    switch (value.toLowerCase())
    {
        case 'sha256':
            return 'SHA-256';
        case 'sha384':
            return 'SHA-384';
        case 'sha512':
            return 'SHA-512';
        default:
            return null;
    }
}

async function digestBytes(algorithm: 'SHA-256' | 'SHA-384' | 'SHA-512', bytes: Uint8Array): Promise<Uint8Array>
{
    if (!globalThis.crypto?.subtle)
    {
        throw new Error(ARTIFACT_INVALID);
    }

    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, buffer));
}

function resolveDelegate(module: unknown): WasmProverDelegate
{
    const record = asRecord(module);
    const defaultExport = asRecord(record.default);
    const factory = getFunction(record, 'createCommentPrivacyProver') ?? getFunction(defaultExport, 'createCommentPrivacyProver');
    const candidate = factory ? factory() : (hasPrepareProof(record) ? record : defaultExport);

    if (!hasPrepareProof(candidate))
    {
        throw new Error(ARTIFACT_INVALID);
    }

    return {
        prewarm: getFunction(candidate, 'prewarm') as WasmProverDelegate['prewarm'],
        prepareProof: candidate.prepareProof
    };
}

function hasPrepareProof(value: unknown): value is { prepareProof: WasmProverDelegate['prepareProof']; prewarm?: WasmProverDelegate['prewarm']; }
{
    return typeof asRecord(value).prepareProof === 'function';
}

function getFunction(record: Record<string, unknown>, key: string): ((...args: never[]) => unknown) | undefined
{
    return typeof record[key] === 'function' ? record[key] as (...args: never[]) => unknown : undefined;
}

function normalizeProofBundle(result: unknown, request: CommentPrivacyProofRequest): CommentPrivacyProofBundle
{
    const record = asRecord(result);
    const proofBytes = toRequiredBytes(record.proofBytes, 'proofBytes');
    const publicInputs = toRequiredBytes(record.publicInputs, 'publicInputs');
    const nullifierHash = toRequiredBytes(record.nullifierHash, 'nullifierHash');
    const expectedPublicInputs = encodeNativeGroth16PublicInputs(request, nullifierHash);
    if (!bytesEqual(publicInputs, expectedPublicInputs))
    {
        throw new Error(ARTIFACT_INVALID);
    }

    return { proofBytes, publicInputs, nullifierHash };
}

function assertProofRequest(request: CommentPrivacyProofRequest): void
{
    if (!isNonEmptyString(request.scope) ||
    !isNonEmptyString(request.rootVersion) ||
    !isNonEmptyString(request.circuitId) ||
    !isNonEmptyString(request.verifyingKeyHash) ||
    !isNonEmptyString(request.issuerPublicKeyHash) ||
    !isNonEmptyString(request.policyHash) ||
    request.isEligible !== true ||
    request.mayComment !== true ||
    (request.rateClass !== 'common' && request.rateClass !== 'unknown') ||
    typeof request.requiresModeration !== 'boolean' ||
    !isNonEmptyString(request.credentialLevel) ||
    !isNonEmptyString(request.reputationBucket))
    {
        throw new Error(ARTIFACT_INVALID);
    }
    if (!Number.isFinite(request.credentialEpoch) || !Number.isFinite(request.circuitNumericId) || !Number.isFinite(request.publicInputLayoutVersion))
    {
        throw new Error(ARTIFACT_INVALID);
    }

    toRequiredBytes(request.metadataBytes, 'metadataBytes');
    toRequiredBytes(request.credentialCommitment, 'credentialCommitment');
    toRequiredBytes(request.credentialRoot, 'credentialRoot');
    toRequiredBytes(request.revocationRoot, 'revocationRoot');
    toRequiredBytes(request.circuitMetadata, 'circuitMetadata');
    toRequiredBytes(request.credentialSecret, 'credentialSecret');
    toRequiredBytes(request.issuerSignature, 'issuerSignature');
    const revocationWitness = toRequiredBytes(request.revocationWitness, 'revocationWitness');
    if (!parseCommentPrivacyRevocationWitnessMaterial(revocationWitness))
    {
        throw new Error(ARTIFACT_INVALID);
    }
}

function encodeNativeGroth16PublicInputs(
    request: CommentPrivacyProofRequest,
    nullifierHash: Uint8Array
): Uint8Array
{
    const chunks: Uint8Array[] = [];
    writeString(chunks, PUBLIC_INPUT_TRANSCRIPT_DOMAIN);
    writeString(chunks, COMMENT_ACTION_CONTEXT);
    writeString(chunks, request.scope);
    writeString(chunks, request.circuitId ?? '');
    writeString(chunks, request.verifyingKeyHash ?? '');
    writeUInt16(chunks, request.publicInputLayoutVersion ?? 0);
    writeString(chunks, bytesToHex(nullifierHash));
    writeString(chunks, bytesToHex(toRequiredBytes(request.credentialRoot, 'credentialRoot')));
    writeString(chunks, bytesToHex(toRequiredBytes(request.revocationRoot, 'revocationRoot')));
    writeString(chunks, request.issuerPublicKeyHash ?? '');
    writeString(chunks, request.policyHash ?? '');
    chunks.push(Uint8Array.of(request.isEligible ? 1 : 0));
    chunks.push(Uint8Array.of(request.mayComment ? 1 : 0));
    writeString(chunks, request.rateClass ?? 'unknown');
    chunks.push(Uint8Array.of(request.requiresModeration ? 1 : 0));
    return concatChunks(chunks);
}

function writeString(chunks: Uint8Array[], value: string): void
{
    const bytes = new TextEncoder().encode(value);
    writeInt32(chunks, bytes.byteLength);
    chunks.push(bytes);
}

function writeInt32(chunks: Uint8Array[], value: number): void
{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    chunks.push(bytes);
}

function writeUInt16(chunks: Uint8Array[], value: number): void
{
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    chunks.push(bytes);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array
{
    const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks)
    {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
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

function assertManifestMatchesRequest(manifest: CommentPrivacyProverManifest, request: CommentPrivacyProofRequest): void
{
    if (request.circuitId !== manifest.circuitId || request.publicInputLayoutVersion !== manifest.publicInputLayoutVersion)
    {
        throw new Error(ARTIFACT_INVALID);
    }
}

function toRequiredBytes(value: unknown, field: string): Uint8Array
{
    if (!(value instanceof Uint8Array) || value.byteLength === 0)
    {
        throw new Error(`${ARTIFACT_INVALID}:${field}`);
    }

    return new Uint8Array(value);
}

function asRecord(value: unknown): Record<string, unknown>
{
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function sanitizeProverError(error: unknown, fallback = ARTIFACT_UNAVAILABLE): Error
{
    if (error instanceof DOMException && error.name === 'AbortError')
    {
        return error;
    }
    if (error instanceof Error && error.message.startsWith('comment_privacy_prover_'))
    {
        return new Error(error.message);
    }

    return new Error(fallback);
}

function throwIfAborted(signal?: AbortSignal): void
{
    if (signal?.aborted)
    {
        throw new DOMException('Aborted', 'AbortError');
    }
}

function isNonEmptyString(value: unknown): value is string
{
    return typeof value === 'string' && value.trim().length > 0;
}

function isValidLayoutVersion(value: unknown): value is number
{
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 0xffff;
}

function isSha256Hex(value: unknown): value is string
{
    return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value);
}

function bytesToHex(bytes: Uint8Array): string
{
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string
{
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    let index = 0;
    while (index < bytes.length)
    {
        const first = bytes[index++];
        const second = index < bytes.length ? bytes[index++] : undefined;
        const third = index < bytes.length ? bytes[index++] : undefined;
        const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
        output += alphabet[(triple >> 18) & 0x3f];
        output += alphabet[(triple >> 12) & 0x3f];
        output += second === undefined ? '=' : alphabet[(triple >> 6) & 0x3f];
        output += third === undefined ? '=' : alphabet[triple & 0x3f];
    }

    return output;
}
