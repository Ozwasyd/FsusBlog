import { computed, ref } from 'vue';

import type { ImageCompressionOptions } from '@/api/upload';
import { useAbortableTask } from '@/composables/useAbortableTask';
import type { useImageUploadRuntime } from '@/composables/useImageUploadRuntime';
import type {
    ArticleDocumentTaskRegistry
} from '@/services/authoring/articleDocumentContext';
import { showErrorToast } from '@/utils/errorPresentation';
import { getErrorMessage, isAbortError } from '@/utils/errors';

type UploadRuntime = ReturnType<typeof useImageUploadRuntime>;

interface UploadContext {
    files: File[];
}

interface UploadCallbacks {
    onSuccess?: (urls: string[], context: UploadContext) => void | Promise<void>;
    onError?: (message: string, error: unknown, context: UploadContext) => void | Promise<void>;
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
}

export interface UseImageUploadFlowOptions {
    runtime: UploadRuntime;
    getOptions: () => ImageCompressionOptions;
    getWasmOnly: () => boolean;
    notify?: UploadNotify;
    taskRegistry?: ArticleDocumentTaskRegistry;
    taskProducerRef?: string;
}

interface PendingUploadContext {
    files: File[];
    callbacks?: UploadCallbacks;
    messages?: UploadMessages;
    notifyOnSuccess: boolean;
    notifyOnError: boolean;
}

export function useImageUploadFlow(options: UseImageUploadFlowOptions)
{
    const uploadTask = useAbortableTask({
        registry: options.taskRegistry,
        kind: options.taskRegistry ? 'attachment' : undefined,
        producerRef: options.taskProducerRef ?? 'image-upload'
    });
    const pendingContext = ref<PendingUploadContext | null>(null);

    const canResume = computed(() => pendingContext.value !== null);

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
        for (const file of context.files)
        {
            if (signal.aborted)
            {
                return;
            }
            const url = await options.runtime.uploadFile(file, options.getOptions(), {
                wasmOnly: options.getWasmOnly()
            });
            urls.push(url);
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

        pendingContext.value = {
            files: [...params.files],
            callbacks: {
                onSuccess: params.onSuccess,
                onError: params.onError
            },
            messages: params.messages,
            notifyOnSuccess: params.notifyOnSuccess ?? true,
            notifyOnError: params.notifyOnError ?? true
        };

        try
        {
            await uploadTask.run(async (signal) =>
            {
                if (pendingContext.value)
                {
                    await executeUpload(pendingContext.value, signal);
                }
            });
        }
        catch (error: unknown)
        {
            if (!isAbortError(error))
            {
                const message = getErrorMessage(error, params.messages?.uploadFailed ?? '文件上传失败');
                if (params.notifyOnError ?? true)
                {
                    showErrorToast(error, params.messages?.uploadFailed ?? '文件上传失败');
                }
                await params.onError?.(message, error, { files: params.files });
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
            onError: overrides?.onError ?? context.callbacks?.onError
        };

        try
        {
            await uploadTask.run(async (signal) =>
            {
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
            if (!isAbortError(error))
            {
                const message = getErrorMessage(error, overrides?.messages?.resumeFailed ?? context.messages?.resumeFailed ?? '继续上传失败');
                if (context.notifyOnError)
                {
                    showErrorToast(error, overrides?.messages?.resumeFailed ?? context.messages?.resumeFailed ?? '继续上传失败');
                }
                await callbacks.onError?.(message, error, { files: context.files });
            }
        }
    };

    const clearPending = (): void =>
    {
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
