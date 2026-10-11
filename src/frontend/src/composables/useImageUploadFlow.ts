import { computed, shallowRef } from 'vue';

import type { ImageCompressionOptions } from '@/api/upload';
import { useAbortableTask } from '@/composables/useAbortableTask';
import type { ImageUploadAttemptBinding, ImageUploadRuntimeOptions, ImageUploadSessionBorrow, useImageUploadRuntime } from '@/composables/useImageUploadRuntime';
import type { ArticleAnchorContext } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { ArticleDocumentContextAdapter, type ArticleDocumentTaskLease, type ArticleDocumentTaskRegistry } from '@/services/authoring/articleDocumentContext';
import { showErrorToast } from '@/utils/errorPresentation';
import { getErrorMessage, isAbortError } from '@/utils/errors';
import { AppErrorCode, createAppError } from '@/utils/appError';

type UploadRuntime = ReturnType<typeof useImageUploadRuntime>;

interface UploadContext {
    files: File[];
}

interface UploadCallbacks {
    onSuccess?: (urls: string[], context: UploadContext) => void | Promise<void>;
    onError?: (message: string, error: unknown, context: UploadContext) => void | Promise<void>;
    onFileUploaded?: (completion: ImageUploadFileCompletion) => Promise<void>;
}

interface UploadMessages {
    tooManyFiles?: string;
    emptyFiles?: string;
    uploadFailed?: string;
    resumeFailed?: string;
    resumeMissing?: string;
    uploadSucceeded?: string;
}

interface UploadNotify {
    success?: (message: string) => void;
    warning?: (message: string) => void;
    error?: (message: string) => void;
}

export interface StartUploadParams extends UploadCallbacks {
    files: File[];
    maxFiles?: number;
    messages?: UploadMessages;
    notifyOnSuccess?: boolean;
    notifyOnError?: boolean;
    attachmentInput?: ImageUploadAttachmentInput;
}

/** Capture uses the caller's real selection and original authoring transaction port. */
export interface ImageUploadAttachmentInput {
    readonly owner: ImageUploadAttemptBinding['owner'];
    readonly documentOwner: ImageUploadAttemptBinding['documentOwner'];
    readonly port: ArticleAttachmentTransactionPort;
    readonly anchor: ArticleAnchorContext;
    readonly origin: 'pick' | 'paste' | 'drop';
}

export interface ImageUploadFileCompletion {
    readonly file: File;
    readonly intent: ImageUploadAttemptBinding['intent'];
    readonly borrow: ImageUploadSessionBorrow;
    readonly url: string;
}

export interface UseImageUploadFlowOptions {
    runtime: UploadRuntime;
    getOptions: () => ImageCompressionOptions;
    getWasmOnly: () => boolean;
    notify?: UploadNotify;
    taskRegistry?: ArticleDocumentTaskRegistry;
    taskProducerRef?: string;
    getAttemptBinding?: (file: File) => Omit<ImageUploadAttemptBinding, 'lease'> | null;
    onSessionReady?: (file: File, borrow: ImageUploadSessionBorrow) => void | Promise<void>;
    /** Awaited before the next file; observe inside withSession, then release. */
    onFileUploaded?: (completion: ImageUploadFileCompletion) => Promise<void>;
}

interface PendingUploadContext {
    files: File[];
    callbacks?: UploadCallbacks;
    messages?: UploadMessages;
    notifyOnSuccess: boolean;
    notifyOnError: boolean;
    attempts?: readonly Readonly<{ file: File; binding: Omit<ImageUploadAttemptBinding, 'lease'>; }>[];
}

export function useImageUploadFlow(options: UseImageUploadFlowOptions)
{
    let currentLease: ArticleDocumentTaskLease | null = null;
    const uploadTask = useAbortableTask({
        registry: options.taskRegistry ? {
            beginTask: (...args) =>
            {
                // Capture the exact lease issued by the existing owner, without creating another task.
                const lease = options.taskRegistry!.beginTask(...args);
                currentLease = lease;
                return lease;
            }
        } : undefined,
        kind: options.taskRegistry ? 'attachment' : undefined,
        producerRef: options.taskProducerRef ?? 'image-upload'
    });
    const pendingContext = shallowRef<PendingUploadContext | null>(null);
    // This identifies a still-awaited local execution, never a business receipt or release ACK.
    const activeRun = shallowRef<object | null>(null);

    const canResume = computed(() => pendingContext.value !== null && activeRun.value === null && !options.runtime.cleanupRequired);
    const admissionError = (): ReturnType<typeof createAppError> | null => activeRun.value !== null
        ? createAppError(AppErrorCode.Conflict, 'upload_flow_operation_pending')
        : options.runtime.cleanupRequired ? createAppError(AppErrorCode.Conflict, 'upload_flow_recovery_blocked') : null;

    const notifyWarning = (message: string): void =>
    {
        options.notify?.warning?.(message);
    };

    const notifySuccess = (message: string): void =>
    {
        options.notify?.success?.(message);
    };

    const executeUpload = async (context: PendingUploadContext, signal: AbortSignal): Promise<void> =>
    {
        const urls: string[] = [];
        const onFileUploaded = context.callbacks?.onFileUploaded ?? options.onFileUploaded;
        for (const [index, file] of context.files.entries())
        {
            if (signal.aborted)
            {
                return;
            }
            const runtimeOptions: ImageUploadRuntimeOptions = {
                wasmOnly: options.getWasmOnly()
            };
            let borrow: ImageUploadSessionBorrow | null = null;
            let intent: ImageUploadAttemptBinding['intent'] | null = null;
            if (context.attempts || options.getAttemptBinding || options.onSessionReady || onFileUploaded)
            {
                const attempt = context.attempts?.[index];
                if (context.attempts && attempt?.file !== file)
                {
                    throw new Error('upload_file_association_invalid');
                }
                const binding = attempt?.binding ?? options.getAttemptBinding?.(file);
                const lease = currentLease;
                if (!binding || lease?.signal !== signal || !lease.isCurrent())
                {
                    throw new Error('upload_attempt_binding_unavailable');
                }
                runtimeOptions.attemptBinding = Object.freeze({ ...binding, lease });
                intent = binding.intent;
                if (options.onSessionReady || onFileUploaded)
                {
                    runtimeOptions.onSessionReady = async value =>
                    {
                        borrow = value;
                        await options.onSessionReady?.(file, value);
                    };
                }
            }
            try
            {
                const url = await options.runtime.uploadFile(file, options.getOptions(), runtimeOptions);
                if (onFileUploaded)
                {
                    const completedBorrow = borrow as ImageUploadSessionBorrow | null;
                    if (!completedBorrow?.isCurrent() || !intent || signal.aborted)
                    {
                        throw new Error('upload_session_borrow_unavailable');
                    }
                    await onFileUploaded(Object.freeze({ file, intent, borrow: completedBorrow, url }));
                }
                urls.push(url);
            }
            finally
            {
                if (onFileUploaded)
                {
                    (borrow as ImageUploadSessionBorrow | null)?.release();
                }
            }
        }

        if (signal.aborted)
        {
            return;
        }
        await context.callbacks?.onSuccess?.(urls, { files: context.files });
        if (context.notifyOnSuccess)
        {
            const message = context.messages?.uploadSucceeded ?? `成功上传 ${urls.length} 个文件`;
            notifySuccess(message);
        }
        pendingContext.value = null;
    };

    const startUpload = async (params: StartUploadParams): Promise<void> =>
    {
        if (params.files.length === 0)
        {
            const message = params.messages?.emptyFiles ?? '没有可上传的文件';
            notifyWarning(message);
            await params.onError?.(message, new Error(message), { files: params.files });
            return;
        }

        if (typeof params.maxFiles === 'number' && params.files.length > params.maxFiles)
        {
            const message = params.messages?.tooManyFiles ?? `单次上传文件不得超过 ${params.maxFiles} 个`;
            notifyWarning(message);
            await params.onError?.(message, new Error(message), { files: params.files });
            return;
        }

        const blocked = admissionError();
        if (blocked)
        {
            await params.onError?.(blocked.message, blocked, { files: params.files });
            return;
        }
        const run = Object.freeze({});
        activeRun.value = run;
        pendingContext.value = {
            files: [...params.files],
            callbacks: {
                onSuccess: params.onSuccess,
                onError: params.onError,
                onFileUploaded: params.onFileUploaded
            },
            messages: params.messages,
            notifyOnSuccess: params.notifyOnSuccess ?? true,
            notifyOnError: params.notifyOnError ?? true
        };

        let runSignal: AbortSignal | null = null;
        try
        {
            const input = params.attachmentInput;
            if (input)
            {
                if (!options.taskRegistry || !(params.onFileUploaded ?? options.onFileUploaded)
                    || !(input.owner instanceof ArticleAttachmentContextAdapter)
                    || !(input.documentOwner instanceof ArticleDocumentContextAdapter)
                    || !input.documentOwner.isCurrentContext(input.anchor.document))
                {
                    throw new Error('upload_attachment_input_invalid');
                }
                const files = pendingContext.value.files;
                const capture = input.owner.capture({ origin: input.origin, anchor: input.anchor,
                    source: input.port.binding().map.source,
                    files: files.map(file => ({ name: file.name, mimeType: file.type, byteLength: file.size })) });
                if (capture.status !== 'created')
                {
                    throw new Error(`upload_attachment_capture_${capture.reason}`);
                }
                if (capture.handles.length !== files.length)
                {
                    capture.handles.forEach(handle => handle.cancel());
                    throw new Error('upload_file_association_invalid');
                }
                // Insertion changes the source revision. Begin the existing flow task only afterwards.
                const handles = input.owner.commitCreated(capture, input.port);
                if (handles.length !== files.length || handles.some((handle, index) =>
                    handle.snapshot.intent !== capture.handles[index].intent
                    || input.owner.readOwnedIntent(handle, input.port.binding())?.contextDigest
                        !== input.documentOwner.context.contextDigest))
                {
                    handles.forEach(handle => handle.cancel());
                    throw new Error('upload_file_association_invalid');
                }
                pendingContext.value.attempts = Object.freeze(files.map((file, index) => Object.freeze({
                    file,
                    binding: Object.freeze({ owner: input.owner, documentOwner: input.documentOwner,
                        intent: handles[index], getBinding: () => input.port.binding() })
                })));
            }
            await uploadTask.run(async (signal) =>
            {
                runSignal = signal;
                if (pendingContext.value)
                {
                    await executeUpload(pendingContext.value, signal);
                }
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error) && !(runSignal as AbortSignal | null)?.aborted)
            {
                const message = getErrorMessage(error, params.messages?.uploadFailed ?? '文件上传失败');
                if (params.notifyOnError ?? true)
                {
                    showErrorToast(error, params.messages?.uploadFailed ?? '文件上传失败');
                }
                await params.onError?.(message, error, { files: params.files });
            }
        }
        finally
        {
            if (activeRun.value === run)
            {
                activeRun.value = null;
            }
        }
    };

    const resumeUpload = async (overrides?: UploadCallbacks & { messages?: UploadMessages; }): Promise<void> =>
    {
        const context = pendingContext.value;
        if (!context)
        {
            notifyWarning(overrides?.messages?.resumeMissing ?? '没有可恢复的上传任务');
            return;
        }

        const callbacks: UploadCallbacks = {
            onSuccess: overrides?.onSuccess ?? context.callbacks?.onSuccess,
            onError: overrides?.onError ?? context.callbacks?.onError,
            onFileUploaded: overrides?.onFileUploaded ?? context.callbacks?.onFileUploaded
        };

        const blocked = admissionError();
        if (blocked)
        {
            await callbacks.onError?.(blocked.message, blocked, { files: context.files });
            return;
        }
        const run = Object.freeze({});
        activeRun.value = run;
        let runSignal: AbortSignal | null = null;
        try
        {
            await uploadTask.run(async (signal) =>
            {
                runSignal = signal;
                await executeUpload({
                    ...context,
                    callbacks,
                    messages: {
                        ...context.messages,
                        ...overrides?.messages
                    }
                }, signal);
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error) && !(runSignal as AbortSignal | null)?.aborted)
            {
                const message = getErrorMessage(error, overrides?.messages?.resumeFailed ?? context.messages?.resumeFailed ?? '继续上传失败');
                if (context.notifyOnError)
                {
                    showErrorToast(error, overrides?.messages?.resumeFailed ?? context.messages?.resumeFailed ?? '继续上传失败');
                }
                await callbacks.onError?.(message, error, { files: context.files });
            }
        }
        finally
        {
            if (activeRun.value === run)
            {
                activeRun.value = null;
            }
        }
    };

    const clearPending = (): void =>
    {
        if (admissionError())
        {
            return;
        }
        pendingContext.value = null;
    };

    const cancel = (): void =>
    {
        uploadTask.cancel();
    };

    return {
        canResume,
        pendingContext,
        startUpload,
        resumeUpload,
        clearPending,
        cancel
    };
}
