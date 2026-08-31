import { computed, reactive, ref } from 'vue';

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

    for (const range of ranges)
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
    const pendingAttempt = ref<PendingAttempt | null>(null);
    const wasmSupportedFormats = ref<ImageCompressionOptions['format'][]>(['png']);
    const activeSession = reactive<{ uploadId: string; resumeKey: string; fileName: string; }>({
        uploadId: '',
        resumeKey: '',
        fileName: ''
    });
    let attemptGeneration = 0;

    const statusText = computed(() =>
    {
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

    const canResume = computed(() => phase.value === 'paused' || phase.value === 'error');

    const uploadFile = async (file: File, options: ImageCompressionOptions, runtimeOptions: ImageUploadRuntimeOptions = {}): Promise<string> =>
    {
        const generation = ++attemptGeneration;
        const ensureCurrentAttempt = (): void =>
        {
            if (generation !== attemptGeneration)
            {
                throw new UploadAttemptSupersededError();
            }
        };

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
            const init = await initUploadSession({
                fileName: uploadPayload.file.name,
                mimeType: uploadPayload.file.type,
                targetFormat: uploadTargetFormat,
                totalBytes: uploadPayload.file.size,
                chunkSize: 512 * 1024,
                sha256: fullHash
            });
            ensureCurrentAttempt();
            uploadId = init.uploadId;
            uploadToken = init.uploadToken;
            if (!uploadToken)
            {
                throw createAppError(AppErrorCode.InfraFailure, '上传初始化缺少恢复凭证');
            }
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
        const complete = await completeUpload(uploadId, uploadToken, fullHash);
        ensureCurrentAttempt();
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

    const resumeLatest = async (): Promise<string> =>
    {
        const attempt = pendingAttempt.value;
        if (!attempt)
        {
            throw createAppError(AppErrorCode.Validation, '没有可恢复的上传任务');
        }

        return uploadFile(attempt.file, attempt.options, attempt.runtimeOptions);
    };

    const abandon = async (): Promise<void> =>
    {
        const uploadId = activeSession.uploadId;
        const resumeKey = activeSession.resumeKey;
        attemptGeneration += 1;
        if (resumeKey)
        {
            clearSnapshot(resumeKey);
        }
        phase.value = 'idle';
        progress.value = 0;
        errorMessage.value = '';
        preview.value = null;
        pendingAttempt.value = null;
        activeSession.uploadId = '';
        activeSession.resumeKey = '';
        activeSession.fileName = '';

        if (uploadId)
        {
            await abortUpload(uploadId);
        }
    };

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
        activeSession,
        uploadFile,
        resumeLatest,
        abandon
    });
}
