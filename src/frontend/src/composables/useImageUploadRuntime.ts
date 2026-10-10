import { computed, getCurrentScope, onScopeDispose, reactive, ref, shallowRef } from 'vue';

import {
    abortUpload,
    completeUpload,
    getUploadPartMap,
    getUploadStatus,
    initUploadSession,
    type ImageCompressionOptions,
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
    startCompletionWindow: (() => void) | null;
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
    if (!raw)
    {
        return null;
    }
    try
    {
        return decodePublicAotPayload<ResumeSessionSnapshot>(raw);
    }
    catch
    {
        return null;
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

function expandUploadedRanges(ranges: readonly { start: number; end: number; }[] | null | undefined): Set<number>
{
    const uploadedParts = new Set<number>();
    if (!Array.isArray(ranges))
    {
        return uploadedParts;
    }

    for (const range of ranges as readonly { start: number; end: number; }[])
    {
        const start = Number(range.start);
        const end = Number(range.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        {
            continue;
        }

        for (let value = start; value <= end; value += 1)
        {
            uploadedParts.add(value);
        }
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
    let pendingOwnedInitialization: { work: ReturnType<typeof initUploadSession>; resumeKey: string; fileName: string; } | null = null;

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

    const borrowCurrentSession = (): ImageUploadSessionBorrow | null =>
    {
        const attempt = ownedAttempt;
        if (!attempt?.access || !bindingIsCurrent(attempt.binding, attempt.file, attempt.completed))
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
        // Chunk IO belongs to the original task, not to the completion-consumer window.
        let deadline = Infinity;
        let timer: ReturnType<typeof setTimeout> | undefined;
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
            attempt.startCompletionWindow = null;
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
        const startCompletionWindow = (): void =>
        {
            if (released || deadline !== Infinity)
            {
                return;
            }
            deadline = performance.now() + SESSION_BORROW_LIFETIME_MS;
            timer = setTimeout(release, SESSION_BORROW_LIFETIME_MS);
        };
        attempt.startCompletionWindow = startCompletionWindow;
        if (attempt.completed)
        {
            startCompletionWindow();
        }
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
        if (cleanupRequired.value || abandonPromise)
        {
            throw createAppError(AppErrorCode.Conflict, '上传会话尚未取消，请先重试取消');
        }
        if (ownedAttempt?.active || pendingOwnedInitialization)
        {
            throw createAppError(AppErrorCode.Conflict, '上传尝试仍在执行，请先取消并等待清理确认');
        }
        discardOwnedAttempt();
        const generation = ++attemptGeneration;
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

        const resumeKey = buildResumeKey(file, options, runtimeOptions);
        const fullHash = await sha256Hex(uploadPayload.file);
        ensureCurrentAttempt();
        let snapshot = readSnapshot(resumeKey);
        let uploadId = '';
        let uploadToken = '';
        let initializedByThisAttempt = false;
        let commitMayHaveStarted = false;
        let uploadedParts = new Set<number>();

        if (snapshot && (
            snapshot.sha256 !== fullHash
      || snapshot.resumeKey !== resumeKey
      || snapshot.fileName !== uploadPayload.file.name
      || !snapshot.uploadId
      || !snapshot.uploadToken
        ))
        {
            snapshot = null;
        }

        if (snapshot)
        {
            try
            {
                const status = await getUploadStatus(snapshot.uploadId);
                ensureCurrentAttempt();
                if (status.uploadId !== snapshot.uploadId)
                {
                    throw createAppError(AppErrorCode.Validation, '上传会话身份不匹配');
                }
                uploadId = status.uploadId;
                uploadToken = snapshot.uploadToken;
                if (status.uploadedPartCount > 0)
                {
                    const map = await getUploadPartMap(snapshot.uploadId);
                    ensureCurrentAttempt();
                    uploadedParts = expandUploadedRanges(map.uploadedRanges);
                }
            }
            catch (error)
            {
                ensureCurrentAttempt();
                if (error instanceof UploadAttemptSupersededError)
                {
                    throw error;
                }
                snapshot = null;
            }
        }

        if (!snapshot || !uploadId)
        {
            ensureCurrentAttempt();
            const initialization = initUploadSession({
                fileName: uploadPayload.file.name,
                mimeType: uploadPayload.file.type,
                targetFormat: uploadTargetFormat,
                totalBytes: uploadPayload.file.size,
                chunkSize: 512 * 1024,
                sha256: fullHash
            });
            if (runtimeOptions.attemptBinding)
            {
                // Cleanup must await this original request, even if its owner cancels before acknowledgement.
                pendingOwnedInitialization = { work: initialization, resumeKey, fileName: uploadPayload.file.name };
            }
            let init: Awaited<typeof initialization>;
            try
            {
                init = await initialization;
            }
            catch (error)
            {
                if (runtimeOptions.attemptBinding && generation === attemptGeneration)
                {
                    cleanupRequired.value = true;
                    phase.value = 'error';
                    errorMessage.value = '上传初始化状态未知，取消未确认';
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
            // Access closes over this original operation's locals, never a stored snapshot.
            ownedAttempt = {
                generation,
                file,
                binding: runtimeOptions.attemptBinding,
                access: () => ({ uploadId, uploadToken, sha256: fullHash,
                    totalBytes: uploadPayload.file.size, commitMayHaveStarted }),
                active: true,
                completed: false,
                borrow: null,
                borrowIssued: false,
                startCompletionWindow: null
            };
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

        const chunkSize = 512 * 1024;
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
        if (runtimeOptions.attemptBinding)
        {
            ownedCommitStateUnknown = true;
        }
        const complete = await completeUpload(uploadId, uploadToken, fullHash);
        ensureCurrentAttempt();
        ownedCommitStateUnknown = false;
        if (ownedAttempt?.generation === generation)
        {
            ownedAttempt.completed = true;
            ownedAttempt.startCompletionWindow?.();
        }
        phase.value = 'completed';
        progress.value = 100;
        errorMessage.value = '';
        clearSnapshot(resumeKey);
        pendingAttempt.value = null;
        activeSession.uploadId = '';
        activeSession.resumeKey = '';
        activeSession.fileName = '';
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
        let uploadId = activeSession.uploadId;
        let resumeKey = activeSession.resumeKey;
        const initialization = pendingOwnedInitialization;
        ownedCommitStateUnknown ||= ownedAttempt?.access?.().commitMayHaveStarted === true && !ownedAttempt.completed;
        discardOwnedAttempt();
        attemptGeneration += 1;
        progress.value = 0;
        errorMessage.value = '';
        preview.value = null;
        pendingAttempt.value = null;
        cleanupRequired.value = Boolean(uploadId) || initialization !== null || ownedCommitStateUnknown;
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
                if (initialization)
                {
                    const initialized = await initialization.work;
                    if (!initialized.uploadId)
                    {
                        throw createAppError(AppErrorCode.InfraFailure, '上传初始化状态未知，取消未确认');
                    }
                    uploadId = initialized.uploadId;
                    resumeKey = initialization.resumeKey;
                    activeSession.uploadId = uploadId;
                    activeSession.resumeKey = resumeKey;
                    activeSession.fileName = initialization.fileName;
                }
                if (uploadId)
                {
                    await abortUpload(uploadId);
                }
                if (resumeKey)
                {
                    clearSnapshot(resumeKey);
                }
                activeSession.uploadId = '';
                activeSession.resumeKey = '';
                activeSession.fileName = '';
                cleanupRequired.value = false;
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
            if (ownedAttempt || pendingOwnedInitialization || ownedCommitStateUnknown
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
