import { computed, getCurrentScope, onScopeDispose, reactive, ref, shallowRef } from 'vue';

import {
    abortUpload,
    completeUpload,
    getUploadPartMap,
    getUploadStatus,
    initUploadSession,
    type ImageCompressionOptions,
    type UploadSessionInitRequest,
    type UploadInitViewModel,
    uploadPart
} from '@/api/upload';
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload';
import type { ArticlePositionMapBinding } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentPendingHandle } from '@/services/authoring/articleAttachmentContext';
import { ArticleDocumentContextAdapter, type ArticleDocumentTaskLease } from '@/services/authoring/articleDocumentContext';
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError';
import { compressImageFileWithRuntime, sha256Hex, type ImageCompressionPreview } from '@/utils/imageCompression';
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
}

/** Authority from one actual init request; public snapshots cannot reconstruct it. */
interface UploadCancellationContext {
    readonly generation: number;
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
    snapshot: ResumeSessionSnapshot | null;
    readonly response: Awaited<ReturnType<typeof completeUpload>>;
    transportCompleted: boolean;
    recoveryRequired: boolean;
    callbackError: unknown;
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
    wasmOnly?: boolean;
    bypassCompression?: boolean;
    targetFormat?: string;
    attemptBinding?: ImageUploadAttemptBinding;
    onSessionReady?: (borrow: ImageUploadSessionBorrow) => void | Promise<void>;
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

async function retry<T>(task: () => Promise<T>, onRetry: (attempt: number) => void): Promise<T>
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
            if (error instanceof UploadAttemptSupersededError)
            {
                throw error;
            }
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }

    if (lastError)
    {
        throw toAppError(lastError, 'upload_retry_exhausted');
    }

    throw createAppError(AppErrorCode.InfraFailure, 'upload_retry_exhausted');
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
    let abandonPromise: Promise<void> | null = null;
    let ownedAttempt: OwnedUploadAttempt | null = null;
    let disposed = false;
    let ownedCommitStateUnknown = false;
    let resumeLookupUnresolved = false;
    let acknowledgedCompletion: AcknowledgedUploadCompletion | null = null;
    let pendingOwnedInitialization: UploadCancellationContext | null = null;
    let cancellationOperation: { generation: number; context: UploadCancellationContext; } | null = null;
    let cancellationObligation: UploadCancellationContext | null = null;

    const bindingIsCurrent = (binding: ImageUploadAttemptBinding, file: File, completed = false): boolean =>
    {
        try
        {
            if (disposed || !(binding.owner instanceof ArticleAttachmentContextAdapter)
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
        const attempt = ownedAttempt;
        ownedAttempt = null;
        if (attempt)
        {
            attempt.borrow?.release();
            attempt.access = null;
        }
    };

    const completionRecoveryError = (): ReturnType<typeof createAppError> => createAppError(
        AppErrorCode.Conflict, 'upload_completion_recovery_required', {
            cause: acknowledgedCompletion?.callbackError,
            // Diagnostic history only; this is neither an asset receipt nor cleanup authority.
            details: acknowledgedCompletion ? `completion_acknowledged; generation=${acknowledgedCompletion.generation}; `
                + `upload_id=${acknowledgedCompletion.uploadId}; result_url=${acknowledgedCompletion.response.url}` : undefined
        });

    const retainCompletionRecovery = (error?: unknown): void =>
    {
        const acknowledged = acknowledgedCompletion;
        if (!acknowledged)
        {
            return;
        }
        acknowledged.recoveryRequired = true;
        if (error !== undefined && acknowledged.callbackError === undefined)
        {
            acknowledged.callbackError = error;
        }
        discardOwnedAttempt();
        pendingAttempt.value = null;
        activeSession.uploadId = '';
        activeSession.resumeKey = '';
        activeSession.fileName = '';
        cleanupRequired.value = true;
        phase.value = 'error';
        errorMessage.value = acknowledged.callbackError === undefined ? 'upload_completion_recovery_required'
            : `${toAppError(acknowledged.callbackError, '上传完成回调失败').message}; upload_completion_recovery_required`;
        // No receiver exists here. Keep the original snapshot/ACK in this instance;
        // revoking a loan or clearing public transport is not recovery acknowledgement.
    };

    const borrowCurrentSession = (): ImageUploadSessionBorrow | null =>
    {
        const attempt = ownedAttempt;
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
        let released = false;
        const current = (): boolean => !released && !disposed && performance.now() < deadline
            && ownedAttempt === attempt && attempt.generation === attemptGeneration && attempt.access !== null
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
            if (released)
            {
                return;
            }
            released = true;
            clearTimeout(timer);
            attempt.binding.lease.signal.removeEventListener('abort', release);
            attempt.binding.intent.signal.removeEventListener('abort', release);
            controller.abort(new DOMException('upload_session_borrow_released', 'AbortError'));
            attempt.borrow = null;
            if (!attempt.active)
            {
                attempt.access = null;
                if (ownedAttempt === attempt)
                {
                    ownedAttempt = null;
                }
            }
        };
        const timer = setTimeout(release, SESSION_BORROW_LIFETIME_MS);
        attempt.binding.lease.signal.addEventListener('abort', release, { once: true });
        attempt.binding.intent.signal.addEventListener('abort', release, { once: true });
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
                controller.signal.addEventListener('abort', revokeScope, { once: true });
                const scopeTimer = setTimeout(revokeScope, SESSION_BORROW_LIFETIME_MS);
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
                try
                {
                    const result = await read(access, scopeController.signal);
                    assertCurrent();
                    if (!scopeActive || performance.now() >= scopeDeadline)
                    {
                        throw new UploadAttemptSupersededError();
                    }
                    return result;
                }
                finally
                {
                    // Each invocation owns its own scope, including concurrent invocations.
                    clearTimeout(scopeTimer);
                    controller.signal.removeEventListener('abort', revokeScope);
                    revokeScope();
                }
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

    const canResume = computed(() => !cleanupRequired.value && (phase.value === 'paused' || phase.value === 'error'));

    const performUpload = async (file: File, options: ImageCompressionOptions, runtimeOptions: ImageUploadRuntimeOptions): Promise<string> =>
    {
        if (acknowledgedCompletion?.recoveryRequired)
        {
            throw completionRecoveryError();
        }
        if (ownedCommitStateUnknown)
        {
            throw createAppError(AppErrorCode.Conflict, 'upload_commit_state_unknown');
        }
        if (cleanupRequired.value || abandonPromise)
        {
            throw createAppError(AppErrorCode.Conflict, '上传会话尚未取消，请先重试取消');
        }
        if (ownedAttempt?.active || pendingOwnedInitialization)
        {
            throw createAppError(AppErrorCode.Conflict, '上传尝试仍在执行，请先取消并等待清理确认');
        }
        discardOwnedAttempt();
        acknowledgedCompletion = null;
        const previousCancellation = cancellationOperation;
        const generation = ++attemptGeneration;
        cancellationOperation = previousCancellation ? { generation, context: previousCancellation.context } : null;
        const ensureCurrentAttempt = (): void =>
        {
            if (disposed || generation !== attemptGeneration
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
            : await compressImageFileWithRuntime(file, options, { wasmOnly });
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
        const fullHash = await sha256Hex(uploadPayload.file);
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
                const status = await getUploadStatus(snapshot.uploadId, undefined, snapshot.uploadToken);
                ensureCurrentAttempt();
                if (status.uploadId !== snapshot.uploadId)
                {
                    throw createAppError(AppErrorCode.ProtocolFailure, 'upload_status_identity_mismatch');
                }
                if (status.status === 'completed')
                {
                    ownedCommitStateUnknown = true;
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
                    const map = await getUploadPartMap(snapshot.uploadId, undefined, snapshot.uploadToken);
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
            resumeLookupUnresolved = true;
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
            const initialization = initUploadSession(initializationRequest);
            const cancellationContext: UploadCancellationContext = {
                generation, work: initialization, resumeKey, fileName: uploadPayload.file.name,
                sha256: fullHash, request: initializationRequest, bound: Boolean(runtimeOptions.attemptBinding), acknowledgement: null
            };
            // Capture the actual promise before cancellation can intentionally invalidate its generation.
            pendingOwnedInitialization = cancellationContext;
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
            if (pendingOwnedInitialization?.work === initialization)
            {
                pendingOwnedInitialization = null;
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
            ownedAttempt = {
                generation,
                file,
                binding: runtimeOptions.attemptBinding,
                access: null,
                active: true,
                completed: false,
                borrow: null,
                borrowIssued: false
            };
        }
        if (runtimeOptions.onSessionReady && !ownedAttempt)
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
            const payloadHash = await sha256Hex(chunk);
            ensureCurrentAttempt();

            try
            {
                const ack = await retry(
                    () =>
                    {
                        ensureCurrentAttempt();
                        return uploadPart(uploadId, uploadToken, partNumber, start, chunk, payloadHash);
                    },
                    () =>
                    {
                        ensureCurrentAttempt();
                        phase.value = 'retrying';
                    }
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
        ownedCommitStateUnknown = true;
        let complete: Awaited<ReturnType<typeof completeUpload>>;
        try
        {
            complete = await completeUpload(uploadId, uploadToken, fullHash);
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
        ownedCommitStateUnknown = false;
        acknowledgedCompletion = {
            generation, uploadId, snapshot, response: complete, transportCompleted: false,
            recoveryRequired: false, callbackError: undefined
        };
        cancellationOperation = null;
        if (ownedAttempt?.generation === generation)
        {
            ownedAttempt.completed = true;
            // Only actual successful completion exposes the fresh initialization facts.
            ownedAttempt.access = () => ({ uploadId, uploadToken, sha256: fullHash,
                totalBytes: uploadPayload.file.size, commitMayHaveStarted });
        }
        if (runtimeOptions.onSessionReady)
        {
            const borrow = borrowCurrentSession();
            if (!borrow)
            {
                throw createAppError(AppErrorCode.Conflict, 'upload_session_borrow_unavailable');
            }
            await runtimeOptions.onSessionReady(borrow);
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
        if (acknowledgedCompletion?.generation === generation)
        {
            acknowledgedCompletion.transportCompleted = true;
            // Normal transport completion retains only bounded current-operation ACK history.
            // A void callback is not an asset-cleanup receipt; failed callbacks keep their snapshot.
            acknowledgedCompletion.snapshot = null;
        }
        return complete.url;
    };

    const uploadFile = async (file: File, options: ImageCompressionOptions, runtimeOptions: ImageUploadRuntimeOptions = {}): Promise<string> =>
    {
        if (disposed)
        {
            throw new UploadAttemptSupersededError();
        }
        const attemptOptions = { ...runtimeOptions, attemptBinding: runtimeOptions.attemptBinding
            ? Object.freeze({ ...runtimeOptions.attemptBinding }) : undefined };
        const previousGeneration = attemptGeneration;
        const work = performUpload(file, options, attemptOptions);
        const generation = attemptGeneration;
        if (generation === previousGeneration)
        {
            return await work;
        }
        const binding = attemptOptions.attemptBinding;
        const onAbort = (): void =>
        {
            if (generation === attemptGeneration)
            {
                void abandon().catch(() =>
                {
                    // Failed canonical cleanup remains an obligation; retain it for explicit retry.
                });
            }
        };
        binding?.lease.signal.addEventListener('abort', onAbort, { once: true });
        binding?.intent.signal.addEventListener('abort', onAbort, { once: true });
        let succeeded = false;
        try
        {
            const url = await work;
            succeeded = true;
            return url;
        }
        catch (error)
        {
            if (acknowledgedCompletion?.generation === generation && !acknowledgedCompletion.transportCompleted)
            {
                retainCompletionRecovery(error);
            }
            throw error;
        }
        finally
        {
            binding?.lease.signal.removeEventListener('abort', onAbort);
            binding?.intent.signal.removeEventListener('abort', onAbort);
            if (ownedAttempt?.generation === generation)
            {
                ownedAttempt.active = false;
                if (!succeeded || !ownedAttempt.borrow?.isCurrent())
                {
                    discardOwnedAttempt();
                }
            }
        }
    };

    const resumeLatest = async (): Promise<string> =>
    {
        if (acknowledgedCompletion?.recoveryRequired)
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
        if (abandonPromise)
        {
            return abandonPromise;
        }
        if (acknowledgedCompletion)
        {
            retainCompletionRecovery();
            attemptGeneration += 1;
            return Promise.reject(completionRecoveryError());
        }
        const initialization = pendingOwnedInitialization;
        const currentCancellation = cancellationOperation?.generation === attemptGeneration
            ? cancellationOperation.context : null;
        // An existing obligation survives this intentional invalidation and every genuine retry.
        cancellationObligation ??= currentCancellation;
        const cancellation = cancellationObligation;
        let uploadId = cancellation?.acknowledgement?.uploadId ?? '';
        let resumeKey = cancellation?.resumeKey ?? activeSession.resumeKey;
        ownedCommitStateUnknown ||= ownedAttempt?.access?.().commitMayHaveStarted === true && !ownedAttempt.completed;
        discardOwnedAttempt();
        attemptGeneration += 1;
        progress.value = 0;
        errorMessage.value = '';
        preview.value = null;
        pendingAttempt.value = null;
        cleanupRequired.value = cancellation !== null || Boolean(activeSession.uploadId) || initialization !== null || ownedCommitStateUnknown || resumeLookupUnresolved;
        // Invalidate live work immediately, but retain its original session and
        // recovery evidence until the canonical abort API acknowledges cleanup.
        // Schedule the request after assigning the promise, including sync throws.
        abandonPromise = Promise.resolve().then(async () =>
        {
            try
            {
                if (ownedCommitStateUnknown)
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
                    const response = await abortUpload(uploadId, undefined, initialized.uploadToken);
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
                resumeLookupUnresolved = false;
                cancellationObligation = null;
                cancellationOperation = null;
                if (pendingOwnedInitialization === initialization)
                {
                    pendingOwnedInitialization = null;
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
                abandonPromise = null;
            }
        });
        return abandonPromise;
    };

    if (getCurrentScope())
    {
        onScopeDispose(() =>
        {
            disposed = true;
            if (ownedAttempt || acknowledgedCompletion || pendingOwnedInitialization?.bound || ownedCommitStateUnknown
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

    return reactive({
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
        resumeLatest,
        borrowCurrentSession,
        abandon
    });
}
