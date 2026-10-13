import { computed, getCurrentScope, onScopeDispose, reactive, ref, shallowReactive, shallowRef } from 'vue';

import {
    type completeUpload,
    type initUploadSession,
    type ImageCompressionOptions,
    type UploadSessionInitRequest,
    type UploadInitViewModel,
    requestAbortUpload,
    requestCompleteUpload,
    requestInitUploadSession,
    requestUploadPart,
    requestUploadPartMap,
    requestUploadStatus
} from '@/api/upload';
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload';
import type { BinaryTransportOperation, BinaryTransportResources, BinaryTransportTerminal } from '@/contracts/binaryTransport';
import type { ArticlePositionMapBinding } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentPendingHandle } from '@/services/authoring/articleAttachmentContext';
import { ArticleDocumentContextAdapter, type ArticleDocumentTaskLease } from '@/services/authoring/articleDocumentContext';
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError';
import { requestCompressImageFileWithRuntime, requestSha256Hex, type ImageCompressionPreview,
    type ImageProducerOperation, type ImageProducerResourceCensus } from '@/utils/imageCompression';
import { getWasmSupportedFormats } from '@/utils/wasmImageCodec';

type UploadPhase = 'idle' | 'compressing' | 'uploading' | 'retrying' | 'paused' | 'error' | 'completed';

interface ResumeSessionSnapshot {
    uploadId: string;
    resumeKey: string;
    fileName: string;
    sha256: string;
    uploadToken: string;
}

interface PendingAttempt {
    file: File;
    options: ImageCompressionOptions;
    runtimeOptions: ImageUploadRuntimeOptions;
}

const STORAGE_PREFIX = 'fsus:image-upload-session:';
const MAX_RETRIES = 3;
const UPLOAD_CHUNK_SIZE = 512 * 1024;
const SESSION_BORROW_LIFETIME_MS = 30_000;

/** Original caller-held objects; a serialized intent is not an attempt binding. */
export interface ImageUploadAttemptBinding {
    readonly owner: ArticleAttachmentContextAdapter;
    readonly intent: ArticleAttachmentPendingHandle;
    readonly documentOwner: ArticleDocumentContextAdapter;
    readonly lease: ArticleDocumentTaskLease;
    readonly getBinding: () => ArticlePositionMapBinding;
}

/** Memory-only access during withSession; never a public session or persisted DTO. */
export interface ImageUploadSessionAccess {
    readonly uploadId: string;
    readonly uploadToken: string;
    readonly sha256: string;
    readonly totalBytes: number;
    readonly commitMayHaveStarted: boolean;
}

export interface ImageUploadSessionBorrow {
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    withSession<T>(read: (session: ImageUploadSessionAccess, signal: AbortSignal) => Promise<T>): Promise<T>;
    release(): void;
}

interface OwnedUploadAttempt {
    readonly generation: number;
    readonly file: File;
    readonly binding: ImageUploadAttemptBinding;
    access: (() => ImageUploadSessionAccess) | null;
    active: boolean;
    completed: boolean;
    borrow: ImageUploadSessionBorrow | null;
    borrowIssued: boolean;
    readonly local: OwnedLocalUploadAttempt;
}

/** Authority from one actual init request; public snapshots cannot reconstruct it. */
interface UploadCancellationContext {
    readonly generation: number;
    readonly local: OwnedLocalUploadAttempt;
    readonly work: ReturnType<typeof initUploadSession>;
    readonly resumeKey: string;
    readonly fileName: string;
    readonly sha256: string;
    readonly request: UploadSessionInitRequest;
    readonly bound: boolean;
    acknowledgement: Awaited<ReturnType<typeof initUploadSession>> | null;
}

interface AcknowledgedUploadCompletion {
    readonly generation: number;
    readonly uploadId: string;
    readonly binding: ImageUploadAttemptBinding | undefined;
    snapshot: ResumeSessionSnapshot | null;
    readonly response: Awaited<ReturnType<typeof completeUpload>>;
    readonly local: OwnedLocalUploadAttempt;
    transportCompleted: boolean;
    recoveryRequired: boolean;
    callbackError: unknown;
    callbackErrorRecorded: boolean;
}

class UploadAttemptSupersededError extends Error
{
    constructor()
    {
        super('upload_attempt_superseded');
        this.name = 'UploadAttemptSupersededError';
    }
}

export interface ImageUploadRuntimeOptions {
    /** Actual caller cancellation request; never a terminal or business acknowledgement. */
    signal?: AbortSignal;
    wasmOnly?: boolean;
    bypassCompression?: boolean;
    targetFormat?: string;
    attemptBinding?: ImageUploadAttemptBinding;
    /** Return this consumer's work only; upload/Flow result and settled depend on this callback. */
    onSessionReady?: (borrow: ImageUploadSessionBorrow, completionUrl: string) => void | Promise<void>;
}

export interface ImageUploadLocalResource {
    readonly id: string;
    readonly kind: string;
    readonly result: 'pending' | 'finished';
    readonly terminal: 'active' | 'settled' | 'unknown';
    readonly cancellationSupported: boolean;
    readonly cancellationRequested: boolean;
    readonly transport?: Readonly<{
        local: 'pending' | BinaryTransportTerminal['local'];
        resources: Readonly<BinaryTransportResources>;
    }>;
    readonly image?: ImageProducerResourceCensus;
}

export interface ImageUploadLocalResourceCensus {
    readonly executionFinished: boolean;
    readonly cancellationRequested: boolean;
    readonly resources: readonly ImageUploadLocalResource[];
    readonly pending: number;
    readonly unknown: number;
    readonly fullLocalSettled: boolean;
}

/** Owned local work only. No checkpoint, remote atomic cancellation or business release. */
export interface ImageUploadLocalRequest<T> {
    readonly result: Promise<T>;
    readonly settled: Promise<void>;
    cancelLocal(reason?: unknown): void;
    inspectLocalResources(): ImageUploadLocalResourceCensus;
}

interface LocalUploadResourceRecord {
    id: string;
    kind: string;
    result: 'pending' | 'finished';
    terminal: 'active' | 'settled' | 'unknown';
    cancellationSupported: boolean;
    cancellationRequested: boolean;
    cancel?: () => void;
    work?: Promise<unknown>;
    callbackWork?: unknown;
    scopeCleanup?: { action: () => void; completed: boolean; }[];
    retryCleanup?: () => void;
    cleanupFailures?: unknown[];
    transportOperation?: BinaryTransportOperation<unknown>;
    transportTerminal?: Readonly<BinaryTransportTerminal>;
    imageOperation?: ImageProducerOperation<unknown>;
}

/** Resource accounting on the original operation, separate from its existing business authority. */
class OwnedLocalUploadAttempt
{
    readonly file: File;
    readonly options: ImageCompressionOptions;
    readonly runtimeOptions: ImageUploadRuntimeOptions;
    readonly controller = new AbortController();
    readonly settled: Promise<void>;
    private readonly resources: LocalUploadResourceRecord[] = [];
    private executionFinished = false;
    private resolveSettled!: () => void;

    constructor(file: File, options: ImageCompressionOptions, runtimeOptions: ImageUploadRuntimeOptions)
    {
        this.file = file;
        this.options = options;
        this.runtimeOptions = runtimeOptions;
        this.settled = new Promise<void>((resolve) =>
        {
            this.resolveSettled = resolve;
        });
    }

    inspect(): ImageUploadLocalResourceCensus
    {
        const resources = Object.freeze(this.resources.map(value => Object.freeze({
            id: value.id, kind: value.kind, result: value.result, terminal: value.terminal,
            cancellationSupported: value.cancellationSupported,
            cancellationRequested: value.cancellationRequested,
            ...(value.transportOperation ? { transport: Object.freeze({
                local: value.transportTerminal?.local ?? 'pending',
                resources: value.transportOperation.inspectResources()
            }) } : {}),
            ...(value.imageOperation ? { image: value.imageOperation.inspectLocalResources() } : {})
        })));
        const pending = resources.filter(value => value.result === 'pending').length;
        const unknown = resources.filter(value => value.terminal === 'unknown').length;
        const fullLocalSettled = this.executionFinished && pending === 0
            && resources.every(value => value.terminal === 'settled');
        return Object.freeze({ executionFinished: this.executionFinished,
            cancellationRequested: this.controller.signal.aborted, resources, pending, unknown, fullLocalSettled });
    }

    private reconsider(): void
    {
        if (this.inspect().fullLocalSettled)
        {
            this.resolveSettled();
        }
    }

    private ownCleanup(resource: LocalUploadResourceRecord, actions: readonly (() => void)[],
        completed?: () => void): () => void
    {
        resource.scopeCleanup = actions.map(action => ({ action, completed: false }));
        let running = false;
        const run = (): void =>
        {
            if (running || resource.terminal === 'settled')
            {
                return;
            }
            running = true;
            resource.retryCleanup = run;
            let failed = false;
            let failure: unknown;
            for (const entry of resource.scopeCleanup ?? [])
            {
                if (entry.completed)
                {
                    continue;
                }
                try
                {
                    entry.action();
                    entry.completed = true;
                }
                catch (error)
                {
                    if (!failed)
                    {
                        failure = error;
                    }
                    failed = true;
                    (resource.cleanupFailures ??= []).push(error);
                }
            }
            resource.result = 'finished';
            resource.terminal = failed ? 'unknown' : 'settled';
            if (!failed)
            {
                resource.retryCleanup = undefined;
                resource.scopeCleanup = undefined;
                completed?.();
            }
            running = false;
            this.reconsider();
            if (failed)
            {
                throw failure;
            }
        };
        return run;
    }

    cleanup(kind: string, actions: readonly (() => void)[]): () => void
    {
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1), kind,
            result: 'pending', terminal: 'active', cancellationSupported: false, cancellationRequested: false };
        this.resources.push(resource);
        return this.ownCleanup(resource, actions);
    }

    retryPendingCleanup(): void
    {
        let failed = false;
        let failure: unknown;
        // These are the original retained actions, not a reconstructed cleanup receipt.
        for (const retry of this.resources.map(resource => resource.retryCleanup))
        {
            try
            {
                retry?.();
            }
            catch (error)
            {
                if (!failed)
                {
                    failure = error;
                }
                failed = true;
            }
        }
        if (failed)
        {
            throw failure;
        }
    }

    cancelLocal(reason?: unknown): void
    {
        if (this.inspect().fullLocalSettled)
        {
            return;
        }
        const actions: (() => void)[] = [() =>
        {
            if (!this.controller.signal.aborted)
            {
                this.controller.abort(reason === undefined ? new DOMException('upload_local_cancel_requested', 'AbortError') : reason);
            }
        }];
        for (const resource of this.resources)
        {
            if (resource.cancellationSupported && resource.terminal !== 'settled')
            {
                resource.cancellationRequested = true;
                const cancel = resource.cancel;
                if (cancel)
                {
                    actions.push(cancel);
                }
            }
        }
        actions.push(() => this.retryPendingCleanup());
        this.cleanup('attempt-cancel-cleanup', actions)();
    }

    listen(signal: AbortSignal, listener: () => void): () => void
    {
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1),
            kind: 'abort-listener', result: 'pending', terminal: 'active',
            cancellationSupported: false, cancellationRequested: false };
        this.resources.push(resource);
        const detach = (): void =>
        {
            if (resource.terminal === 'settled')
            {
                return;
            }
            try
            {
                signal.removeEventListener('abort', invoke);
            }
            catch (error)
            {
                (resource.cleanupFailures ??= []).push(error);
                resource.terminal = 'unknown';
                resource.retryCleanup = detach;
                throw error;
            }
            resource.result = 'finished';
            resource.terminal = 'settled';
            resource.retryCleanup = undefined;
            this.reconsider();
        };
        const invoke = (): void =>
        {
            let failed = false;
            let failure: unknown;
            try
            {
                listener();
            }
            catch (error)
            {
                failed = true;
                failure = error;
                (resource.cleanupFailures ??= []).push(error);
            }
            try
            {
                detach();
            }
            catch (error)
            {
                if (!failed)
                {
                    failed = true;
                    failure = error;
                }
            }
            if (failed)
            {
                throw failure;
            }
        };
        try
        {
            signal.addEventListener('abort', invoke, { once: true });
        }
        catch (error)
        {
            (resource.cleanupFailures ??= []).push(error);
            resource.terminal = 'unknown';
            resource.retryCleanup = detach;
            throw error;
        }
        return detach;
    }

    timer(callback: () => void, milliseconds: number, canceled?: () => void): () => void
    {
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1),
            kind: 'timer', result: 'pending', terminal: 'active',
            cancellationSupported: true, cancellationRequested: false };
        this.resources.push(resource);
        let finished = false;
        let finishing = false;
        const finish = (action?: () => void): void =>
        {
            if (finished || finishing)
            {
                return;
            }
            finishing = true;
            try
            {
                clearTimeout(handle);
                finished = true;
                action?.();
            }
            catch (error)
            {
                (resource.cleanupFailures ??= []).push(error);
                if (!finished)
                {
                    resource.terminal = 'unknown';
                    resource.retryCleanup = () => finish(action);
                }
                throw error;
            }
            finally
            {
                finishing = false;
                if (finished)
                {
                    resource.result = 'finished';
                    resource.terminal = 'settled';
                    resource.cancel = undefined;
                    resource.retryCleanup = undefined;
                }
                this.reconsider();
            }
        };
        const handle = setTimeout(() => finish(callback), milliseconds);
        resource.cancel = () => finish(canceled);
        return () => finish();
    }

    delay(milliseconds: number): Promise<void>
    {
        this.controller.signal.throwIfAborted();
        return new Promise<void>((resolve, reject) =>
        {
            this.timer(resolve, milliseconds, () =>
            {
                const reason: unknown = this.controller.signal.reason;
                reject(reason instanceof Error ? reason : new DOMException('upload_local_cancel_requested', 'AbortError'));
            });
        });
    }

    observe<T>(kind: string, task: () => Promise<T>, cancellationSupported = false, cleanup = false): Promise<T>
    {
        if (!cleanup)
        {
            this.controller.signal.throwIfAborted();
        }
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1), kind,
            result: 'pending', terminal: 'unknown', cancellationSupported, cancellationRequested: false };
        this.resources.push(resource);
        const finished = (): void =>
        {
            resource.result = 'finished';
            // A result/failure is not the missing opaque producer terminal contract.
            this.reconsider();
        };
        try
        {
            const work = task();
            resource.work = work;
            void work.then(finished, finished);
            return work;
        }
        catch (error)
        {
            finished();
            throw error;
        }
    }

    observeTransport<T>(kind: string, start: () => BinaryTransportOperation<T>,
        cancellationSupported = true, cleanup = false): Promise<T>
    {
        if (!cleanup)
        {
            this.controller.signal.throwIfAborted();
        }
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1), kind,
            result: 'pending', terminal: 'active', cancellationSupported, cancellationRequested: false };
        this.resources.push(resource);
        try
        {
            const operation = start();
            resource.transportOperation = operation;
            resource.work = operation.result;
            if (cancellationSupported)
            {
                resource.cancel = () => operation.cancel(this.controller.signal.reason);
            }
            const resultFinished = (): void =>
            {
                resource.result = 'finished';
                this.reconsider();
            };
            void operation.result.then(resultFinished, resultFinished).catch((error: unknown) =>
            {
                (resource.cleanupFailures ??= []).push(error);
                resource.terminal = 'unknown';
            });
            void operation.terminal.then((terminal) =>
            {
                resource.transportTerminal = terminal;
                // This actual local observation includes unavailable network/shared-Wasm boundaries.
                // It is not a full upload terminal, even when terminal.local is observed.
                resource.terminal = 'unknown';
                this.reconsider();
            }).catch((error: unknown) =>
            {
                (resource.cleanupFailures ??= []).push(error);
                resource.terminal = 'unknown';
                this.reconsider();
            });
            return operation.result;
        }
        catch (error)
        {
            resource.result = 'finished';
            resource.terminal = 'unknown';
            (resource.cleanupFailures ??= []).push(error);
            this.reconsider();
            throw error;
        }
    }

    observeImage<T>(kind: string, start: () => ImageProducerOperation<T>): Promise<T>
    {
        this.controller.signal.throwIfAborted();
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1), kind,
            result: 'pending', terminal: 'active', cancellationSupported: true, cancellationRequested: false };
        this.resources.push(resource);
        try
        {
            const operation = start();
            resource.imageOperation = operation;
            resource.work = operation.result;
            resource.cancel = () => operation.cancelLocal(this.controller.signal.reason);
            const reinspect = (): void =>
            {
                const census = operation.inspectLocalResources();
                resource.terminal = census.local === 'settled' ? 'settled'
                    : census.local === 'unknown' ? 'unknown' : 'active';
                if (census.local === 'settled')
                {
                    resource.retryCleanup = undefined;
                    resource.cancel = undefined;
                    resource.work = undefined;
                }
                this.reconsider();
            };
            resource.retryCleanup = () =>
            {
                operation.retryCleanup();
                reinspect();
            };
            const resultFinished = (): void =>
            {
                resource.result = 'finished';
                reinspect();
            };
            void operation.result.then(resultFinished, resultFinished).catch((error: unknown) =>
            {
                (resource.cleanupFailures ??= []).push(error);
                resource.terminal = 'unknown';
            });
            void operation.settled.then(reinspect).catch((error: unknown) =>
            {
                (resource.cleanupFailures ??= []).push(error);
                resource.terminal = 'unknown';
                this.reconsider();
            });
            // Numeric IDs and local/third-party resources stay in the actual producer census.
            // This finite local completion never claims shared-codec or full-upload completion.
            return operation.result;
        }
        catch (error)
        {
            resource.result = 'finished';
            resource.terminal = 'unknown';
            (resource.cleanupFailures ??= []).push(error);
            this.reconsider();
            throw error;
        }
    }

    async observeCallbackScope<T>(kind: string, task: () => T | Promise<T>,
        cleanup: readonly (() => void)[] = [], cancellationSupported = false): Promise<T>
    {
        const resource: LocalUploadResourceRecord = { id: String(this.resources.length + 1), kind,
            result: 'pending', terminal: 'active', cancellationSupported, cancellationRequested: false };
        this.resources.push(resource);
        const cleanScope = this.ownCleanup(resource, cleanup, () =>
        {
            resource.callbackWork = undefined;
        });
        let callbackFailed = false;
        let callbackFailure: unknown;
        let value!: T;
        try
        {
            this.controller.signal.throwIfAborted();
            const work = task();
            resource.callbackWork = work;
            value = await work;
        }
        catch (error)
        {
            callbackFailed = true;
            callbackFailure = error;
        }
        resource.result = 'finished';
        let cleanupFailed = false;
        let cleanupFailure: unknown;
        try
        {
            cleanScope();
        }
        catch (error)
        {
            cleanupFailed = true;
            cleanupFailure = error;
        }
        if (callbackFailed)
        {
            throw callbackFailure;
        }
        if (cleanupFailed)
        {
            throw cleanupFailure;
        }
        return value;
    }

    async runWithCleanup<T>(kind: string, task: () => Promise<T>, actions: readonly (() => void)[]): Promise<T>
    {
        let failed = false;
        let failure: unknown;
        let value!: T;
        try
        {
            value = await task();
        }
        catch (error)
        {
            failed = true;
            failure = error;
        }
        try
        {
            this.cleanup(kind, actions)();
        }
        catch (error)
        {
            if (!failed)
            {
                failed = true;
                failure = error;
            }
        }
        if (failed)
        {
            throw failure;
        }
        return value;
    }

    finishExecution(): void
    {
        this.executionFinished = true;
        this.reconsider();
    }
}

function buildResumeKey(file: File, options: ImageCompressionOptions, runtimeOptions?: ImageUploadRuntimeOptions): string
{
    return [
        file.name,
        file.size,
        file.lastModified,
        runtimeOptions?.targetFormat ?? options.format,
        options.quality,
        options.scaleRatio,
        options.maxEdge,
    options.preserveAlpha ? 1 : 0,
    runtimeOptions?.bypassCompression ? 'raw' : 'compressed'
    ].join(':');
}

function persistSnapshot(snapshot: ResumeSessionSnapshot): void
{
    if (typeof window === 'undefined')
    {
        return;
    }
    window.localStorage.setItem(STORAGE_PREFIX + snapshot.resumeKey, encodePublicAotPayload(snapshot));
}

function readSnapshot(resumeKey: string): ResumeSessionSnapshot | null
{
    if (typeof window === 'undefined')
    {
        return null;
    }
    const raw = window.localStorage.getItem(STORAGE_PREFIX + resumeKey);
    if (raw === null)
    {
        return null;
    }
    try
    {
        const snapshot = decodePublicAotPayload<ResumeSessionSnapshot>(raw);
        if (!snapshot || typeof snapshot !== 'object')
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'upload_resume_snapshot_invalid');
        }
        return snapshot;
    }
    catch (error)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_resume_snapshot_invalid', { cause: error });
    }
}

function clearSnapshot(resumeKey: string): void
{
    if (typeof window === 'undefined')
    {
        return;
    }
    window.localStorage.removeItem(STORAGE_PREFIX + resumeKey);
}

function validUploadId(uploadId: unknown): uploadId is string
{
    return typeof uploadId === 'string' && /^[0-9a-f]{32}$/.test(uploadId) && uploadId !== '0'.repeat(32);
}

function assertUploadGeometry(totalBytes: number, chunkSize: number, totalParts: number, expectedBytes: number): void
{
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes !== expectedBytes
        || chunkSize !== UPLOAD_CHUNK_SIZE || totalParts !== Math.ceil(expectedBytes / UPLOAD_CHUNK_SIZE))
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_geometry_mismatch');
    }
}

function assertInitialization(init: UploadInitViewModel, request: UploadSessionInitRequest): void
{
    if (!init.uploadToken?.trim())
    {
        throw createAppError(AppErrorCode.InfraFailure, '上传初始化缺少恢复凭证');
    }
    if (!validUploadId(init.uploadId) || init.fileName !== request.fileName
        || init.mimeType !== request.mimeType.trim() || init.targetFormat !== request.targetFormat)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_init_response_mismatch');
    }
    assertUploadGeometry(init.totalBytes, init.chunkSize, init.totalParts, request.totalBytes);
}

function expandUploadedRanges(ranges: readonly { start: number; end: number; }[], totalParts: number): Set<number>
{
    const uploadedParts = new Set<number>();
    if (!Array.isArray(ranges) || ranges.length > totalParts)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_map_invalid');
    }
    let previousEnd = -1;
    for (const range of ranges as readonly { start: number; end: number; }[])
    {
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
            || range.start <= previousEnd || range.end < range.start || range.end >= totalParts)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_map_invalid');
        }
        for (let value = range.start; value <= range.end; value += 1)
        {
            uploadedParts.add(value);
        }
        previousEnd = range.end;
    }
    return uploadedParts;
}

async function retry<T>(task: () => Promise<T>, onRetry: (attempt: number) => void, local: OwnedLocalUploadAttempt): Promise<T>
{
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1)
    {
        try
        {
            if (attempt > 0)
            {
                onRetry(attempt);
            }
            return await task();
        }
        catch (error)
        {
            if (error instanceof UploadAttemptSupersededError || local.controller.signal.aborted)
            {
                throw error;
            }
            lastError = error;
            await local.delay(500 * (attempt + 1));
        }
    }

    if (lastError)
    {
        throw toAppError(lastError, 'upload_retry_exhausted');
    }

    throw createAppError(AppErrorCode.InfraFailure, 'upload_retry_exhausted');
}

// Sole registration is the original factory; this holds a reader, never another obligation record.
const originalRuntimeAdmission = new WeakMap<object, () => ReturnType<typeof createAppError> | null>();

/** Read-only original-instance admission observation; this grants no recovery release authority. */
export function getImageUploadRuntimeAdmissionError(runtime: ReturnType<typeof useImageUploadRuntime>): ReturnType<typeof createAppError> | null
{
    const read = originalRuntimeAdmission.get(runtime);
    if (!read)
    {
        return createAppError(AppErrorCode.Conflict, 'upload_runtime_authority_unavailable');
    }
    const blocked = read();
    // Diagnostic copy only. Never expose original callback payload, ACK, snapshot or closure state.
    return blocked ? createAppError(blocked.code, blocked.message) : null;
}

export function useImageUploadRuntime()
{
    const phase = ref<UploadPhase>('idle');
    const progress = ref(0);
    const errorMessage = ref('');
    const preview = ref<ImageCompressionPreview | null>(null);
    const pendingAttempt = shallowRef<PendingAttempt | null>(null);
    const wasmSupportedFormats = ref<ImageCompressionOptions['format'][]>(['png']);
    const activeSession = reactive<{ uploadId: string; resumeKey: string; fileName: string; }>({
        uploadId: '',
        resumeKey: '',
        fileName: ''
    });
    let attemptGeneration = 0;
    const cleanupRequired = ref(false);
    // These replace the original private locals; nested SDK/File/payload identities stay raw.
    const ownedState = shallowReactive<{
        abandonPromise: Promise<void> | null;
        ownedAttempt: OwnedUploadAttempt | null;
        disposed: boolean;
        ownedCommitStateUnknown: boolean;
        resumeLookupUnresolved: boolean;
        acknowledgedCompletion: AcknowledgedUploadCompletion | null;
        pendingOwnedInitialization: UploadCancellationContext | null;
        cancellationObligation: UploadCancellationContext | null;
    }>({
        abandonPromise: null, ownedAttempt: null, disposed: false,
        ownedCommitStateUnknown: false, resumeLookupUnresolved: false, acknowledgedCompletion: null,
        pendingOwnedInitialization: null, cancellationObligation: null
    });
    let cancellationOperation: { generation: number; context: UploadCancellationContext; } | null = null;
    // Unknown producer terminals retain the original File/options/work after public state resets.
    const localAttempts = new Set<OwnedLocalUploadAttempt>();
    let currentLocalAttempt: OwnedLocalUploadAttempt | null = null;

    const bindingIsCurrent = (binding: ImageUploadAttemptBinding, file: File, completed = false): boolean =>
    {
        try
        {
            if (ownedState.disposed || !(binding.owner instanceof ArticleAttachmentContextAdapter)
                || !(binding.documentOwner instanceof ArticleDocumentContextAdapter)
                || binding.lease.signal.aborted || binding.intent.signal.aborted
                || !binding.documentOwner.isCurrentContext(binding.lease.envelope.context)
                || (!binding.documentOwner.isTaskCurrent(binding.lease as Parameters<ArticleDocumentContextAdapter['isTaskCurrent']>[0])
                    && !(completed && binding.lease.envelope.status === 'completed')))
            {
                return false;
            }
            const observation = binding.owner.readOwnedIntent(binding.intent, binding.getBinding());
            const candidate = binding.intent.snapshot.intent.candidate;
            return observation?.current === true
                && observation.snapshot.intent === binding.intent.snapshot.intent
                && observation.contextDigest === binding.lease.envelope.context.contextDigest
                && candidate.name === file.name && candidate.mimeType === file.type
                && candidate.byteLength === file.size;
        }
        catch
        {
            return false;
        }
    };

    const discardOwnedAttempt = (): void =>
    {
        const attempt = ownedState.ownedAttempt;
        ownedState.ownedAttempt = null;
        if (attempt)
        {
            attempt.access = null;
            attempt.borrow?.release();
        }
    };

    const completionRecoveryError = (): ReturnType<typeof createAppError> => createAppError(
        AppErrorCode.Conflict, 'upload_completion_recovery_required', {
            cause: ownedState.acknowledgedCompletion?.callbackError,
            // Diagnostic history only; this is neither an asset receipt nor cleanup authority.
            details: ownedState.acknowledgedCompletion ? `completion_acknowledged; generation=${ownedState.acknowledgedCompletion.generation}; `
                + `upload_id=${ownedState.acknowledgedCompletion.uploadId}; result_url=${ownedState.acknowledgedCompletion.response.url}` : undefined
        });

    const retainCompletionRecovery = (error?: unknown, failed = false): void =>
    {
        const acknowledged = ownedState.acknowledgedCompletion;
        if (!acknowledged)
        {
            return;
        }
        acknowledged.recoveryRequired = true;
        if (failed && !acknowledged.callbackErrorRecorded)
        {
            acknowledged.callbackError = error;
            acknowledged.callbackErrorRecorded = true;
        }
        const attempt = ownedState.ownedAttempt;
        const borrow = attempt?.borrow;
        acknowledged.local.cleanup('completion-recovery-cleanup', [
            () =>
            {
                if (ownedState.ownedAttempt === attempt)
                {
                    ownedState.ownedAttempt = null;
                }
                if (attempt)
                {
                    attempt.access = null;
                    borrow?.release();
                }
            },
            () => pendingAttempt.value = null,
            () => activeSession.uploadId = '',
            () => activeSession.resumeKey = '',
            () => activeSession.fileName = '',
            () => cleanupRequired.value = true,
            () => phase.value = 'error',
            () => errorMessage.value = !acknowledged.callbackErrorRecorded ? 'upload_completion_recovery_required'
                : `${toAppError(acknowledged.callbackError, '上传完成回调失败').message}; upload_completion_recovery_required`
        ])();
        // No receiver exists here. Keep the original snapshot/ACK in this instance;
        // revoking a loan or clearing public transport is not recovery acknowledgement.
    };

    const borrowCurrentSession = (): ImageUploadSessionBorrow | null =>
    {
        const attempt = ownedState.ownedAttempt;
        if (!attempt || !bindingIsCurrent(attempt.binding, attempt.file, attempt.completed))
        {
            discardOwnedAttempt();
            return null;
        }
        // Before the actual completion acknowledgement these are operation locals only.
        if (!attempt.completed)
        {
            return null;
        }
        if (!attempt.access)
        {
            discardOwnedAttempt();
            return null;
        }
        if (attempt.borrow?.isCurrent())
        {
            return attempt.borrow;
        }
        if (attempt.borrowIssued)
        {
            return null;
        }
        if (!attempt.active)
        {
            discardOwnedAttempt();
            return null;
        }
        const controller = new AbortController();
        const deadline = performance.now() + SESSION_BORROW_LIFETIME_MS;
        let revoked = false;
        const current = (): boolean => !revoked && !ownedState.disposed && performance.now() < deadline
            && ownedState.ownedAttempt === attempt && attempt.generation === attemptGeneration && attempt.access !== null
            && bindingIsCurrent(attempt.binding, attempt.file, attempt.completed);
        const assertCurrent = (): void =>
        {
            if (!current())
            {
                release();
                throw new UploadAttemptSupersededError();
            }
        };
        const release = (): void =>
        {
            // Permission is permanently revoked before fallible physical cleanup starts.
            revoked = true;
            let failed = false;
            let failure: unknown;
            for (const clean of [cleanLoan, () => attempt.local.retryPendingCleanup()])
            {
                try
                {
                    clean();
                }
                catch (error)
                {
                    if (!failed)
                    {
                        failure = error;
                    }
                    failed = true;
                }
            }
            if (failed)
            {
                throw failure;
            }
        };
        const clearTimer = attempt.local.timer(release, SESSION_BORROW_LIFETIME_MS, release);
        const detachLease = attempt.local.listen(attempt.binding.lease.signal, release);
        const detachIntent = attempt.local.listen(attempt.binding.intent.signal, release);
        const detachLocal = attempt.local.listen(attempt.local.controller.signal, release);
        const cleanLoan = attempt.local.cleanup('session-loan-cleanup', [
            clearTimer, detachLease, detachIntent, detachLocal,
            () => controller.abort(new DOMException('upload_session_borrow_released', 'AbortError')),
            () => attempt.borrow = null,
            () =>
            {
                if (!attempt.active)
                {
                    attempt.access = null;
                    if (ownedState.ownedAttempt === attempt)
                    {
                        ownedState.ownedAttempt = null;
                    }
                }
            }
        ]);
        const borrow: ImageUploadSessionBorrow = Object.freeze({
            signal: controller.signal,
            isCurrent: current,
            async withSession<T>(read: (session: ImageUploadSessionAccess, signal: AbortSignal) => Promise<T>): Promise<T>
            {
                assertCurrent();
                let scopeActive = true;
                const scopeDeadline = performance.now() + SESSION_BORROW_LIFETIME_MS;
                const scopeController = new AbortController();
                const revokeScope = (): void =>
                {
                    scopeActive = false;
                    scopeController.abort(new DOMException('upload_session_access_released', 'AbortError'));
                };
                const detachController = attempt.local.listen(controller.signal, revokeScope);
                const clearScopeTimer = attempt.local.timer(revokeScope, SESSION_BORROW_LIFETIME_MS, revokeScope);
                const access = Object.create(null) as ImageUploadSessionAccess;
                for (const key of ['uploadId', 'uploadToken', 'sha256', 'totalBytes', 'commitMayHaveStarted'] as const)
                {
                    Object.defineProperty(access, key, { get: () =>
                    {
                        if (!scopeActive || performance.now() >= scopeDeadline)
                        {
                            throw new UploadAttemptSupersededError();
                        }
                        assertCurrent();
                        return attempt.access!()[key];
                    } });
                }
                Object.defineProperty(access, 'toJSON', { value: (): never =>
                {
                    throw new Error('upload_session_borrow_not_serializable');
                } });
                Object.freeze(access);
                return await attempt.local.observeCallbackScope('session-callback-scope', async () =>
                {
                    const result = await read(access, scopeController.signal);
                    assertCurrent();
                    if (!scopeActive || performance.now() >= scopeDeadline)
                    {
                        throw new UploadAttemptSupersededError();
                    }
                    return result;
                }, [clearScopeTimer, detachController, revokeScope], true);
            },
            release
        });
        attempt.borrowIssued = true;
        attempt.borrow = borrow;
        return borrow;
    };

    const statusText = computed(() =>
    {
        if (cleanupRequired.value)
        {
            return errorMessage.value || '等待上传取消确认';
        }
        switch (phase.value)
        {
            case 'compressing':
                return '图片压缩中';
            case 'uploading':
                return `上传中 ${progress.value}%`;
            case 'retrying':
                return `上传重试中 ${progress.value}%`;
            case 'paused':
                return '上传已暂停，可继续';
            case 'error':
                return errorMessage.value || '上传失败';
            case 'completed':
                return '上传完成';
            default:
                return '';
        }
    });

    const readOriginalAdmission = (): ReturnType<typeof createAppError> | null =>
    {
        if (ownedState.acknowledgedCompletion?.recoveryRequired)
        {
            return completionRecoveryError();
        }
        if (ownedState.ownedCommitStateUnknown)
        {
            return createAppError(AppErrorCode.Conflict, 'upload_commit_state_unknown');
        }
        if (ownedState.disposed)
        {
            return createAppError(AppErrorCode.Conflict, 'upload_attempt_superseded');
        }
        if (ownedState.abandonPromise || ownedState.cancellationObligation || ownedState.resumeLookupUnresolved)
        {
            return createAppError(AppErrorCode.Conflict, '上传会话尚未取消，请先重试取消');
        }
        if (ownedState.ownedAttempt?.active || ownedState.pendingOwnedInitialization)
        {
            return createAppError(AppErrorCode.Conflict, '上传尝试仍在执行，请先取消并等待清理确认');
        }
        return null;
    };

    const canResume = computed(() => readOriginalAdmission() === null && (phase.value === 'paused' || phase.value === 'error'));

    const performUpload = async (file: File, options: ImageCompressionOptions, runtimeOptions: ImageUploadRuntimeOptions,
        local: OwnedLocalUploadAttempt, started: (generation: number) => void): Promise<string> =>
    {
        const blocked = readOriginalAdmission();
        if (blocked)
        {
            throw blocked;
        }
        discardOwnedAttempt();
        ownedState.acknowledgedCompletion = null;
        const previousCancellation = cancellationOperation;
        const generation = ++attemptGeneration;
        started(generation);
        currentLocalAttempt?.cancelLocal(new DOMException('upload_attempt_superseded', 'AbortError'));
        currentLocalAttempt = local;
        cancellationOperation = previousCancellation ? { generation, context: previousCancellation.context } : null;
        const ensureCurrentAttempt = (): void =>
        {
            if (ownedState.disposed || local.controller.signal.aborted || generation !== attemptGeneration
                || (runtimeOptions.attemptBinding && !bindingIsCurrent(runtimeOptions.attemptBinding, file)))
            {
                if (generation === attemptGeneration)
                {
                    void abandon().catch(() =>
                    {
                        // Failed canonical cleanup remains an obligation; retain it for explicit retry.
                    });
                }
                throw new UploadAttemptSupersededError();
            }
        };
        ensureCurrentAttempt();

        phase.value = 'compressing';
        errorMessage.value = '';
        progress.value = 0;
        const wasmOnly = runtimeOptions?.wasmOnly ?? false;
        const uploadTargetFormat = (runtimeOptions.targetFormat ?? options.format).trim().toLowerCase();
        pendingAttempt.value = {
            file,
            options: { ...options },
            runtimeOptions: { ...runtimeOptions, wasmOnly }
        };

        const uploadPayload = runtimeOptions.bypassCompression === true
            ? { file, preview: null }
            : await local.observeImage('compression', () => requestCompressImageFileWithRuntime(file, options,
                { wasmOnly, signal: local.controller.signal }));
        ensureCurrentAttempt();
        preview.value = uploadPayload.preview;

        // The original UploadInitRequest filename is a zero-padded 256-byte UTF-8 field.
        // Refuse truncation or replacement before creating a server session or cleanup obligation.
        const encodedFileName = new TextEncoder().encode(uploadPayload.file.name);
        if (encodedFileName.byteLength > 256 || uploadPayload.file.name.includes('\0')
            || new TextDecoder().decode(encodedFileName) !== uploadPayload.file.name)
        {
            phase.value = 'error';
            errorMessage.value = 'upload_file_name_not_representable';
            throw createAppError(AppErrorCode.Validation, errorMessage.value);
        }

        const resumeKey = buildResumeKey(file, options, runtimeOptions);
        const fullHash = await local.observeImage('file-hash', () => requestSha256Hex(uploadPayload.file,
            { signal: local.controller.signal }));
        ensureCurrentAttempt();
        let snapshot: ResumeSessionSnapshot | null;
        let uploadId = '';
        let uploadToken = '';
        let initializedByThisAttempt = false;
        let commitMayHaveStarted = false;
        let uploadedParts = new Set<number>();
        try
        {
            snapshot = readSnapshot(resumeKey);
            const original = previousCancellation?.context;
            if ((snapshot && (snapshot.sha256 !== fullHash || snapshot.resumeKey !== resumeKey
                || snapshot.fileName !== uploadPayload.file.name || !validUploadId(snapshot.uploadId)
                || !snapshot.uploadToken?.trim()))
                || (original && (!snapshot || original.resumeKey !== resumeKey || original.sha256 !== fullHash
                    || original.fileName !== uploadPayload.file.name
                    || original.acknowledgement?.uploadId !== snapshot.uploadId
                    || original.acknowledgement.uploadToken !== snapshot.uploadToken)))
            {
                throw createAppError(AppErrorCode.ProtocolFailure, 'upload_resume_snapshot_mismatch');
            }
            if (snapshot)
            {
                activeSession.uploadId = snapshot.uploadId;
                activeSession.resumeKey = resumeKey;
                activeSession.fileName = uploadPayload.file.name;
                const resumeSnapshot = snapshot;
                const status = await local.observeTransport('upload-status', () =>
                    requestUploadStatus(resumeSnapshot.uploadId, local.controller.signal, resumeSnapshot.uploadToken));
                ensureCurrentAttempt();
                if (status.uploadId !== snapshot.uploadId)
                {
                    throw createAppError(AppErrorCode.ProtocolFailure, 'upload_status_identity_mismatch');
                }
                if (status.status === 'completed')
                {
                    ownedState.ownedCommitStateUnknown = true;
                    throw createAppError(AppErrorCode.Conflict, 'upload_commit_state_unknown');
                }
                assertUploadGeometry(status.totalBytes, status.chunkSize, status.totalParts, uploadPayload.file.size);
                if (!['pending', 'uploading', 'uploaded'].includes(status.status)
                    || !Number.isSafeInteger(status.uploadedPartCount) || status.uploadedPartCount < 0
                    || status.uploadedPartCount > status.totalParts
                    || !Number.isSafeInteger(status.uploadedBytes) || status.uploadedBytes < 0
                    || status.uploadedBytes > status.totalBytes
                    || (status.status === 'pending' && status.uploadedPartCount !== 0)
                    || (status.status === 'uploading' && (status.uploadedPartCount === 0 || status.uploadedPartCount === status.totalParts))
                    || (status.status === 'uploaded' && status.uploadedPartCount !== status.totalParts))
                {
                    throw createAppError(AppErrorCode.ProtocolFailure, 'upload_status_progress_mismatch');
                }
                if (status.uploadedPartCount > 0)
                {
                    const map = await local.observeTransport('upload-part-map', () =>
                        requestUploadPartMap(resumeSnapshot.uploadId, local.controller.signal, resumeSnapshot.uploadToken));
                    ensureCurrentAttempt();
                    if (map.uploadId !== snapshot.uploadId)
                    {
                        throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_map_identity_mismatch');
                    }
                    uploadedParts = expandUploadedRanges(map.uploadedRanges, status.totalParts);
                }
                let mappedBytes = 0;
                let nextPartHint = 0;
                uploadedParts.forEach(part => mappedBytes += Math.min(UPLOAD_CHUNK_SIZE, status.totalBytes - part * UPLOAD_CHUNK_SIZE));
                while (uploadedParts.has(nextPartHint))
                {
                    nextPartHint += 1;
                }
                if (uploadedParts.size !== status.uploadedPartCount || mappedBytes !== status.uploadedBytes
                    || nextPartHint !== status.nextPartHint)
                {
                    throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_map_progress_mismatch');
                }
                uploadId = status.uploadId;
                uploadToken = snapshot.uploadToken;
            }
        }
        catch (error)
        {
            ensureCurrentAttempt();
            cleanupRequired.value = true;
            ownedState.resumeLookupUnresolved = true;
            phase.value = 'error';
            errorMessage.value = toAppError(error, 'upload_resume_lookup_failed').message;
            // Lookup failures, including obscured 404, acknowledge neither absence nor cleanup.
            const original = previousCancellation?.context;
            if (original)
            {
                activeSession.uploadId = original.acknowledgement?.uploadId ?? '';
                activeSession.resumeKey = original.resumeKey;
                activeSession.fileName = original.fileName;
            }
            throw error;
        }

        if (!snapshot || !uploadId)
        {
            ensureCurrentAttempt();
            const initializationRequest: UploadSessionInitRequest = {
                fileName: uploadPayload.file.name,
                mimeType: uploadPayload.file.type,
                targetFormat: uploadTargetFormat,
                totalBytes: uploadPayload.file.size,
                chunkSize: UPLOAD_CHUNK_SIZE,
                sha256: fullHash
            };
            const initialization = local.observeTransport('upload-init', () => requestInitUploadSession(initializationRequest, local.controller.signal));
            const cancellationContext: UploadCancellationContext = {
                generation, local, work: initialization, resumeKey, fileName: uploadPayload.file.name,
                sha256: fullHash, request: initializationRequest, bound: Boolean(runtimeOptions.attemptBinding), acknowledgement: null
            };
            // Capture the actual promise before cancellation can intentionally invalidate its generation.
            ownedState.pendingOwnedInitialization = cancellationContext;
            cancellationOperation = { generation, context: cancellationContext };
            let init: Awaited<typeof initialization>;
            try
            {
                init = await initialization;
                cancellationContext.acknowledgement = { ...init };
                ensureCurrentAttempt();
                assertInitialization(init, initializationRequest);
            }
            catch (error)
            {
                if (generation === attemptGeneration)
                {
                    cleanupRequired.value = true;
                    phase.value = 'error';
                    errorMessage.value = toAppError(error, '上传初始化状态未知，取消未确认').message;
                }
                throw error;
            }
            ensureCurrentAttempt();
            if (ownedState.pendingOwnedInitialization?.work === initialization)
            {
                ownedState.pendingOwnedInitialization = null;
            }
            uploadId = init.uploadId;
            uploadToken = init.uploadToken;
            if (!uploadToken)
            {
                throw createAppError(AppErrorCode.InfraFailure, '上传初始化缺少恢复凭证');
            }
            initializedByThisAttempt = true;
            snapshot = {
                uploadId,
                resumeKey,
                fileName: uploadPayload.file.name,
                sha256: fullHash,
                uploadToken
            };
            persistSnapshot(snapshot);
        }

        activeSession.uploadId = uploadId;
        activeSession.resumeKey = resumeKey;
        activeSession.fileName = uploadPayload.file.name;

        if (runtimeOptions.attemptBinding && initializedByThisAttempt)
        {
            // Keep original operation ownership without granting precompletion access.
            ownedState.ownedAttempt = shallowReactive({
                generation,
                file,
                binding: runtimeOptions.attemptBinding,
                access: null,
                active: true,
                completed: false,
                borrow: null,
                borrowIssued: false,
                local
            });
        }
        if (runtimeOptions.onSessionReady && !ownedState.ownedAttempt)
        {
            throw createAppError(AppErrorCode.Conflict, 'upload_session_borrow_unavailable');
        }

        const chunkSize = UPLOAD_CHUNK_SIZE;
        const totalParts = Math.ceil(uploadPayload.file.size / chunkSize);
        let uploadedBytes = 0;
        uploadedParts.forEach((partNumber) =>
        {
            const start = partNumber * chunkSize;
            const end = Math.min(start + chunkSize, uploadPayload.file.size);
            uploadedBytes += Math.max(0, end - start);
        });
        progress.value = Math.min(99, Math.round((uploadedBytes / uploadPayload.file.size) * 100));
        phase.value = 'uploading';

        for (let partNumber = 0; partNumber < totalParts; partNumber += 1)
        {
            ensureCurrentAttempt();
            if (uploadedParts.has(partNumber))
            {
                continue;
            }

            const start = partNumber * chunkSize;
            const end = Math.min(start + chunkSize, uploadPayload.file.size);
            const chunk = uploadPayload.file.slice(start, end);
            const payloadHash = await local.observeImage('part-hash', () => requestSha256Hex(chunk,
                { signal: local.controller.signal }));
            ensureCurrentAttempt();

            try
            {
                const ack = await retry(
                    () =>
                    {
                        ensureCurrentAttempt();
                        return local.observeTransport('upload-part', () =>
                            requestUploadPart(uploadId, uploadToken, partNumber, start, chunk, payloadHash, local.controller.signal));
                    },
                    () =>
                    {
                        ensureCurrentAttempt();
                        phase.value = 'retrying';
                    },
                    local
                );
                ensureCurrentAttempt();

                if (ack.uploadId !== uploadId || ack.partNumber !== partNumber || ack.offset !== start
                    || ack.size !== chunk.size || ack.uploadedBytes !== uploadedBytes + chunk.size
                    || ack.uploadedPartCount !== uploadedParts.size + 1)
                {
                    throw createAppError(AppErrorCode.ProtocolFailure, 'upload_part_ack_mismatch');
                }
                uploadedBytes = ack.uploadedBytes;
                progress.value = Math.min(99, Math.round((uploadedBytes / uploadPayload.file.size) * 100));
                phase.value = 'uploading';
                uploadedParts.add(partNumber);
            }
            catch (error)
            {
                ensureCurrentAttempt();
                if (error instanceof UploadAttemptSupersededError)
                {
                    throw error;
                }
                const normalized = toAppError(error, '上传失败，可继续恢复');
                phase.value = 'paused';
                errorMessage.value = normalized.message || '上传失败，可继续恢复';
                persistSnapshot(snapshot);
                throw normalized;
            }
        }

        ensureCurrentAttempt();
        commitMayHaveStarted = true;
        ownedState.ownedCommitStateUnknown = true;
        let complete: Awaited<ReturnType<typeof completeUpload>>;
        try
        {
            complete = await local.observeTransport('upload-complete', () =>
                requestCompleteUpload(uploadId, uploadToken, fullHash, local.controller.signal));
            ensureCurrentAttempt();
            if (complete.uploadId !== uploadId || complete.totalBytes !== uploadPayload.file.size
                || complete.mimeType !== uploadPayload.file.type.trim()
                || typeof complete.url !== 'string' || !complete.url.trim()
                || typeof complete.relativeUrl !== 'string' || !complete.relativeUrl.trim())
            {
                throw createAppError(AppErrorCode.ProtocolFailure, 'upload_complete_ack_mismatch');
            }
        }
        catch (error)
        {
            if (generation === attemptGeneration)
            {
                cleanupRequired.value = true;
                phase.value = 'error';
                errorMessage.value = toAppError(error, 'upload_commit_state_unknown').message;
            }
            throw error;
        }
        ensureCurrentAttempt();
        ownedState.ownedCommitStateUnknown = false;
        const acknowledgedResponse = Object.freeze({ ...complete });
        ownedState.acknowledgedCompletion = shallowReactive({
            generation, uploadId, binding: runtimeOptions.attemptBinding, snapshot,
            response: acknowledgedResponse, local, transportCompleted: false,
            recoveryRequired: false, callbackError: undefined, callbackErrorRecorded: false
        });
        cancellationOperation = null;
        if (ownedState.ownedAttempt?.generation === generation)
        {
            ownedState.ownedAttempt.completed = true;
            // Only actual successful completion exposes the fresh initialization facts.
            ownedState.ownedAttempt.access = () => ({ uploadId, uploadToken, sha256: fullHash,
                totalBytes: uploadPayload.file.size, commitMayHaveStarted });
        }
        if (runtimeOptions.onSessionReady)
        {
            const borrow = borrowCurrentSession();
            if (!borrow)
            {
                throw createAppError(AppErrorCode.Conflict, 'upload_session_borrow_unavailable');
            }
            // The result comes only from this operation's already-correlated actual ACK.
            const onSessionReady = runtimeOptions.onSessionReady;
            await local.observeCallbackScope('session-ready-callback-scope', () => onSessionReady(borrow, acknowledgedResponse.url));
            ensureCurrentAttempt();
        }
        phase.value = 'completed';
        progress.value = 100;
        errorMessage.value = '';
        clearSnapshot(resumeKey);
        pendingAttempt.value = null;
        activeSession.uploadId = '';
        activeSession.resumeKey = '';
        activeSession.fileName = '';
        if (ownedState.acknowledgedCompletion?.generation === generation)
        {
            ownedState.acknowledgedCompletion.transportCompleted = true;
            // Normal transport completion retains only bounded current-operation ACK history.
            // A void callback is not an asset-cleanup receipt; failed callbacks keep their snapshot.
            ownedState.acknowledgedCompletion.snapshot = null;
        }
        return acknowledgedResponse.url;
    };

    const executeUploadFile = async (file: File, options: ImageCompressionOptions, runtimeOptions: ImageUploadRuntimeOptions,
        local: OwnedLocalUploadAttempt): Promise<string> =>
    {
        if (ownedState.disposed)
        {
            throw new UploadAttemptSupersededError();
        }
        const attemptOptions = { ...runtimeOptions, attemptBinding: runtimeOptions.attemptBinding
            ? Object.freeze({ ...runtimeOptions.attemptBinding }) : undefined };
        let generation: number | null = null;
        const binding = attemptOptions.attemptBinding;
        const onAbort = (): void =>
        {
            local.cancelLocal();
            if (generation !== null && generation === attemptGeneration)
            {
                void abandon().catch(() =>
                {
                    // Failed canonical cleanup remains an obligation; retain it for explicit retry.
                });
            }
        };
        let detachLease: (() => void) | undefined;
        let detachIntent: (() => void) | undefined;
        let succeeded = false;
        let failed = false;
        let failure: unknown;
        let originalAttempt: OwnedUploadAttempt | null = null;
        let originalBorrow: ImageUploadSessionBorrow | null = null;
        return await local.runWithCleanup('upload-attempt-finalization', async () =>
        {
            try
            {
                // Registration is inside the original guarded execution, before work starts.
                detachLease = binding ? local.listen(binding.lease.signal, onAbort) : undefined;
                detachIntent = binding ? local.listen(binding.intent.signal, onAbort) : undefined;
                const work = performUpload(file, options, attemptOptions, local, value => generation = value);
                const url = await work;
                succeeded = true;
                return url;
            }
            catch (error)
            {
                failed = true;
                failure = error;
                throw error;
            }
        }, [
            () =>
            {
                originalAttempt = ownedState.ownedAttempt?.generation === generation ? ownedState.ownedAttempt : null;
                originalBorrow = originalAttempt?.borrow ?? null;
            },
            () =>
            {
                if (failed && ownedState.acknowledgedCompletion?.generation === generation
                    && !ownedState.acknowledgedCompletion.transportCompleted)
                {
                    retainCompletionRecovery(failure, true);
                }
            },
            () => detachLease?.(),
            () => detachIntent?.(),
            () =>
            {
                if (originalAttempt)
                {
                    originalAttempt.active = false;
                    if (!succeeded || !originalBorrow?.isCurrent())
                    {
                        if (ownedState.ownedAttempt === originalAttempt)
                        {
                            ownedState.ownedAttempt = null;
                        }
                        originalAttempt.access = null;
                        originalBorrow?.release();
                    }
                }
            }
        ]);
    };

    const requestUploadFile = (file: File, options: ImageCompressionOptions,
        runtimeOptions: ImageUploadRuntimeOptions = {}): ImageUploadLocalRequest<string> =>
    {
        const local = new OwnedLocalUploadAttempt(file, options, runtimeOptions);
        localAttempts.add(local);
        void local.settled.then(() =>
        {
            localAttempts.delete(local);
            if (currentLocalAttempt === local)
            {
                currentLocalAttempt = null;
            }
        });
        const result = (async (): Promise<string> =>
        {
            const signal = runtimeOptions.signal;
            let detach: (() => void) | undefined;
            return await local.runWithCleanup('upload-caller-finalization', async () =>
            {
                detach = signal ? local.listen(signal, () => local.cancelLocal(signal.reason)) : undefined;
                if (signal?.aborted)
                {
                    local.cancelLocal(signal.reason);
                }
                return await executeUploadFile(file, options, runtimeOptions, local);
            }, [() => detach?.(), () => local.finishExecution()]);
        })();
        return Object.freeze({ result, settled: local.settled,
            cancelLocal: (reason?: unknown) => local.cancelLocal(reason),
            inspectLocalResources: () => local.inspect() });
    };

    // Existing Promise callers use the same producer and original business execution.
    const uploadFile = (file: File, options: ImageCompressionOptions,
        runtimeOptions: ImageUploadRuntimeOptions = {}): Promise<string> => requestUploadFile(file, options, runtimeOptions).result;

    const resumeLatest = async (): Promise<string> =>
    {
        if (ownedState.acknowledgedCompletion?.recoveryRequired)
        {
            throw completionRecoveryError();
        }
        const attempt = pendingAttempt.value;
        if (!attempt)
        {
            throw createAppError(AppErrorCode.Validation, '没有可恢复的上传任务');
        }

        return uploadFile(attempt.file, attempt.options, attempt.runtimeOptions);
    };

    const abandon = (): Promise<void> =>
    {
        currentLocalAttempt?.cancelLocal();
        if (ownedState.abandonPromise)
        {
            return ownedState.abandonPromise;
        }
        if (ownedState.acknowledgedCompletion)
        {
            retainCompletionRecovery();
            attemptGeneration += 1;
            return Promise.reject(completionRecoveryError());
        }
        const initialization = ownedState.pendingOwnedInitialization;
        const currentCancellation = cancellationOperation?.generation === attemptGeneration
            ? cancellationOperation.context : null;
        // An existing obligation survives this intentional invalidation and every genuine retry.
        ownedState.cancellationObligation ??= currentCancellation;
        const cancellation = ownedState.cancellationObligation;
        let uploadId = cancellation?.acknowledgement?.uploadId ?? '';
        let resumeKey = cancellation?.resumeKey ?? activeSession.resumeKey;
        ownedState.ownedCommitStateUnknown ||= ownedState.ownedAttempt?.access?.().commitMayHaveStarted === true && !ownedState.ownedAttempt.completed;
        discardOwnedAttempt();
        attemptGeneration += 1;
        progress.value = 0;
        errorMessage.value = '';
        preview.value = null;
        pendingAttempt.value = null;
        cleanupRequired.value = cancellation !== null || Boolean(activeSession.uploadId) || initialization !== null || ownedState.ownedCommitStateUnknown || ownedState.resumeLookupUnresolved;
        // Invalidate live work immediately, but retain its original session and
        // recovery evidence until the canonical abort API acknowledges cleanup.
        // Schedule the request after assigning the promise, including sync throws.
        ownedState.abandonPromise = Promise.resolve().then(async () =>
        {
            try
            {
                if (ownedState.ownedCommitStateUnknown)
                {
                    throw createAppError(AppErrorCode.Conflict, 'upload_commit_state_unknown');
                }
                if (cancellation)
                {
                    const initialized = cancellation.acknowledgement ?? await cancellation.work;
                    if (!initialized.uploadId || !initialized.uploadToken)
                    {
                        throw createAppError(AppErrorCode.InfraFailure, '上传初始化状态未知，取消未确认');
                    }
                    cancellation.acknowledgement ??= { ...initialized };
                    assertInitialization(initialized, cancellation.request);
                    uploadId = initialized.uploadId;
                    resumeKey = cancellation.resumeKey;
                    activeSession.uploadId = uploadId;
                    activeSession.resumeKey = resumeKey;
                    activeSession.fileName = cancellation.fileName;
                    // Canonical remote cleanup keeps its own acknowledgement authority and is not
                    // canceled by the already-aborted local upload signal.
                    const response = await cancellation.local.observeTransport('upload-abort', () =>
                        requestAbortUpload(uploadId, undefined, initialized.uploadToken), false, true);
                    if (response.uploadId !== uploadId || response.status !== 'aborted')
                    {
                        throw createAppError(AppErrorCode.Conflict, 'upload_abort_not_acknowledged');
                    }
                }
                else if (cleanupRequired.value)
                {
                    throw createAppError(AppErrorCode.Conflict, 'upload_cleanup_authority_unavailable');
                }
                if (resumeKey)
                {
                    clearSnapshot(resumeKey);
                }
                activeSession.uploadId = '';
                activeSession.resumeKey = '';
                activeSession.fileName = '';
                cleanupRequired.value = false;
                ownedState.resumeLookupUnresolved = false;
                ownedState.cancellationObligation = null;
                cancellationOperation = null;
                if (ownedState.pendingOwnedInitialization === initialization)
                {
                    ownedState.pendingOwnedInitialization = null;
                }
                phase.value = 'idle';
            }
            catch (error)
            {
                phase.value = 'error';
                errorMessage.value = toAppError(error, '上传取消未完成，请重试取消').message;
                throw error;
            }
            finally
            {
                ownedState.abandonPromise = null;
            }
        });
        return ownedState.abandonPromise;
    };

    if (getCurrentScope())
    {
        onScopeDispose(() =>
        {
            ownedState.disposed = true;
            for (const local of localAttempts)
            {
                local.cancelLocal();
            }
            if (ownedState.ownedAttempt || ownedState.acknowledgedCompletion || ownedState.pendingOwnedInitialization?.bound || ownedState.ownedCommitStateUnknown
                || pendingAttempt.value?.runtimeOptions.attemptBinding)
            {
                void abandon().catch(() =>
                {
                    // Scope disposal cannot acknowledge failed canonical cleanup.
                });
            }
            else
            {
                // Legacy attempts retain their original cleanup owner; disposal grants no new deletion.
                attemptGeneration += 1;
            }
        });
    }

    void getWasmSupportedFormats().then((formats) =>
    {
        if (formats.length > 0)
        {
            wasmSupportedFormats.value = formats;
        }
    }).catch(() =>
    {
        wasmSupportedFormats.value = ['png'];
    });

    const runtime = reactive({
        phase,
        progress,
        errorMessage,
        preview,
        wasmSupportedFormats,
        statusText,
        canResume,
        cleanupRequired,
        activeSession,
        uploadFile,
        requestUploadFile,
        resumeLatest,
        borrowCurrentSession,
        abandon
    });
    originalRuntimeAdmission.set(runtime, readOriginalAdmission);
    return runtime;
}
