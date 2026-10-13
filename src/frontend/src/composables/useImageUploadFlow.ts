import { computed, shallowRef, type ShallowRef } from 'vue';

import type { ImageCompressionOptions } from '@/api/upload';
import { useAbortableTask } from '@/composables/useAbortableTask';
import { getImageUploadRuntimeAdmissionError, type ImageUploadAttemptBinding, type ImageUploadLocalRequest, type ImageUploadLocalResource, type ImageUploadLocalResourceCensus, type ImageUploadRuntimeOptions, type ImageUploadSessionBorrow, type useImageUploadRuntime } from '@/composables/useImageUploadRuntime';
import type { ArticleAnchorContext } from '@/services/authoring/articleAnchorContext';
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext';
import { ArticleDocumentContextAdapter, type ArticleDocumentTaskLease, type ArticleDocumentTaskRegistry } from '@/services/authoring/articleDocumentContext';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { showErrorToast } from '@/utils/errorPresentation';
import { getErrorMessage, isAbortError } from '@/utils/errors';

type UploadRuntime = ReturnType<typeof useImageUploadRuntime>;

interface UploadContext {
    files: File[];
}

interface UploadCallbacks {
    /** Await this callback's work, never the result/settled of its containing Flow run. */
    onSuccess?: (urls: string[], context: UploadContext) => void | Promise<void>;
    onError?: (message: string, error: unknown, context: UploadContext) => void | Promise<void>;
    /** Await this consumer's work, never the upstream upload/Flow result or settled. */
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
    /** Await consumer work before the next file; use withSession, never upstream result/settled. */
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

/** Retains the actual run and child producers independently of public pending/reset state. */
class OwnedLocalUploadFlow
{
    readonly input: StartUploadParams | UploadCallbacks | undefined;
    readonly settled: Promise<void>;
    context: PendingUploadContext | null = null;
    private readonly children: ImageUploadLocalRequest<string>[] = [];
    private readonly resources: ImageUploadLocalResource[] = [];
    private readonly callbackWork = new Map<string, void | Promise<void>>();
    private readonly controller = new AbortController();
    private executionFinished = false;
    private cancelTask: (() => void) | null = null;
    private detachTask: (() => void) | null = null;
    private resolveSettled!: () => void;

    constructor(input: StartUploadParams | UploadCallbacks | undefined)
    {
        this.input = input;
        this.settled = new Promise<void>((resolve) =>
        {
            this.resolveSettled = resolve;
        });
    }

    inspect(): ImageUploadLocalResourceCensus
    {
        const children = this.children.map(child => child.inspectLocalResources());
        const resources = Object.freeze([
            ...this.resources.map(resource => Object.freeze({ ...resource })),
            ...children.flatMap((child, index) => child.resources.map(resource => Object.freeze({
                ...resource, id: `file-${index + 1}/${resource.id}`
            })))
        ]);
        const pending = resources.filter(resource => resource.result === 'pending').length;
        const unknown = resources.filter(resource => resource.terminal === 'unknown').length;
        const fullLocalSettled = this.executionFinished && pending === 0
            && resources.every(resource => resource.terminal === 'settled')
            && children.every(child => child.fullLocalSettled);
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

    cancelLocal(reason?: unknown): void
    {
        if (!this.controller.signal.aborted)
        {
            this.controller.abort(reason === undefined ? new DOMException('upload_flow_cancel_requested', 'AbortError') : reason);
            this.cancelTask?.();
        }
        for (const child of this.children)
        {
            child.cancelLocal(this.controller.signal.reason);
        }
    }

    bindTask(signal: AbortSignal, cancelTask: () => void): void
    {
        this.cancelTask = () =>
        {
            if (!signal.aborted)
            {
                cancelTask();
            }
        };
        const index = this.resources.length;
        this.resources.push({ id: `flow-${index + 1}`, kind: 'flow-task-abort-listener',
            result: 'pending', terminal: 'active', cancellationSupported: false, cancellationRequested: false });
        const detach = (): void =>
        {
            signal.removeEventListener('abort', onAbort);
            this.resources[index] = { ...this.resources[index], result: 'finished', terminal: 'settled' };
            this.reconsider();
        };
        const onAbort = (): void =>
        {
            detach();
            this.cancelLocal(signal.reason);
        };
        this.detachTask = detach;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
        {
            onAbort();
        }
        if (this.controller.signal.aborted && !signal.aborted)
        {
            this.cancelTask();
        }
    }

    addChild(child: ImageUploadLocalRequest<string>): void
    {
        this.children.push(child);
        void child.settled.then(() => this.reconsider());
        if (this.controller.signal.aborted)
        {
            child.cancelLocal(this.controller.signal.reason);
        }
    }

    async observeCallback(task: () => void | Promise<void>): Promise<void>
    {
        const index = this.resources.length;
        const id = `flow-${index + 1}`;
        this.resources.push({ id, kind: 'flow-callback-scope',
            result: 'pending', terminal: 'active', cancellationSupported: false, cancellationRequested: false });
        try
        {
            const work = task();
            this.callbackWork.set(id, work);
            await work;
        }
        finally
        {
            // This invocation owns its await only. Child requests and the task listener stay separate.
            this.resources[index] = { ...this.resources[index], result: 'finished', terminal: 'settled' };
            this.callbackWork.delete(id);
            this.reconsider();
        }
    }

    finishExecution(): void
    {
        this.detachTask?.();
        this.cancelTask = null;
        this.executionFinished = true;
        this.reconsider();
    }
}

export function useImageUploadFlow(options: UseImageUploadFlowOptions)
{
    const originalRuntime = options.runtime;
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
    const activeRun: ShallowRef<object | null> = shallowRef<object | null>(null);
    const localRuns = new Set<OwnedLocalUploadFlow>();
    let activeLocalRun: OwnedLocalUploadFlow | null = null;

    const admissionError = (): ReturnType<typeof createAppError> | null => activeRun.value !== null
        ? createAppError(AppErrorCode.Conflict, 'upload_flow_operation_pending')
        : getImageUploadRuntimeAdmissionError(originalRuntime);
    const canResume = computed(() => pendingContext.value !== null && admissionError() === null);

    const notifyWarning = (message: string): void =>
    {
        options.notify?.warning?.(message);
    };

    const notifySuccess = (message: string): void =>
    {
        options.notify?.success?.(message);
    };

    const executeUpload = async (context: PendingUploadContext, signal: AbortSignal, local: OwnedLocalUploadFlow): Promise<void> =>
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
                signal,
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
                    runtimeOptions.onSessionReady = async (value, completionUrl) =>
                    {
                        borrow = value;
                        await options.onSessionReady?.(file, value);
                        if (onFileUploaded)
                        {
                            const completedIntent = intent;
                            if (!value.isCurrent() || !completedIntent || signal.aborted)
                            {
                                throw new Error('upload_session_borrow_unavailable');
                            }
                            // Stay inside the original ACK owner's catch and original finite access scope.
                            await value.withSession(async () =>
                            {
                                await onFileUploaded(Object.freeze({ file, intent: completedIntent,
                                    borrow: value, url: completionUrl }));
                            });
                        }
                    };
                }
            }
            try
            {
                const child = originalRuntime.requestUploadFile(file, options.getOptions(), runtimeOptions);
                local.addChild(child);
                const url = await child.result;
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
        const onSuccess = context.callbacks?.onSuccess;
        if (onSuccess)
        {
            await local.observeCallback(() => onSuccess(urls, { files: context.files }));
        }
        if (context.notifyOnSuccess)
        {
            const message = context.messages?.uploadSucceeded ?? `成功上传 ${urls.length} 个文件`;
            notifySuccess(message);
        }
        pendingContext.value = null;
    };

    const executeStartUpload = async (params: StartUploadParams, local: OwnedLocalUploadFlow): Promise<void> =>
    {
        const blocked = admissionError();
        if (params.files.length === 0)
        {
            const message = params.messages?.emptyFiles ?? '没有可上传的文件';
            notifyWarning(message);
            if (params.onError)
            {
                await local.observeCallback(() => params.onError!(message, new Error(message), { files: params.files }));
            }
            return;
        }

        if (typeof params.maxFiles === 'number' && params.files.length > params.maxFiles)
        {
            const message = params.messages?.tooManyFiles ?? `单次上传文件不得超过 ${params.maxFiles} 个`;
            notifyWarning(message);
            if (params.onError)
            {
                await local.observeCallback(() => params.onError!(message, new Error(message), { files: params.files }));
            }
            return;
        }

        if (blocked)
        {
            if (params.onError)
            {
                await local.observeCallback(() => params.onError!(blocked.message, blocked, { files: params.files }));
            }
            return;
        }
        const run = Object.freeze({});
        activeRun.value = run;
        activeLocalRun = local;
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
        local.context = pendingContext.value;

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
                local.bindTask(signal, () =>
                {
                    if (activeRun.value === run)
                    {
                        uploadTask.cancel();
                    }
                });
                if (pendingContext.value)
                {
                    await executeUpload(pendingContext.value, signal, local);
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
                if (params.onError)
                {
                    await local.observeCallback(() => params.onError!(message, error, { files: params.files }));
                }
            }
        }
        finally
        {
            if (activeRun.value === run)
            {
                activeRun.value = null;
                activeLocalRun = null;
            }
        }
    };

    const executeResumeUpload = async (overrides: (UploadCallbacks & { messages?: UploadMessages; }) | undefined,
        local: OwnedLocalUploadFlow): Promise<void> =>
    {
        const blocked = admissionError();
        const context = pendingContext.value;
        if (!context)
        {
            if (blocked)
            {
                if (overrides?.onError)
                {
                    await local.observeCallback(() => overrides.onError!(blocked.message, blocked, { files: [] }));
                }
                return;
            }
            notifyWarning(overrides?.messages?.resumeMissing ?? '没有可恢复的上传任务');
            return;
        }

        const callbacks: UploadCallbacks = {
            onSuccess: overrides?.onSuccess ?? context.callbacks?.onSuccess,
            onError: overrides?.onError ?? context.callbacks?.onError,
            onFileUploaded: overrides?.onFileUploaded ?? context.callbacks?.onFileUploaded
        };

        if (blocked)
        {
            if (callbacks.onError)
            {
                await local.observeCallback(() => callbacks.onError!(blocked.message, blocked, { files: context.files }));
            }
            return;
        }
        const run = Object.freeze({});
        activeRun.value = run;
        activeLocalRun = local;
        const resumedContext = { ...context, callbacks, messages: { ...context.messages, ...overrides?.messages } };
        local.context = resumedContext;
        let runSignal: AbortSignal | null = null;
        try
        {
            await uploadTask.run(async (signal) =>
            {
                runSignal = signal;
                local.bindTask(signal, () =>
                {
                    if (activeRun.value === run)
                    {
                        uploadTask.cancel();
                    }
                });
                await executeUpload(resumedContext, signal, local);
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
                if (callbacks.onError)
                {
                    await local.observeCallback(() => callbacks.onError!(message, error, { files: context.files }));
                }
            }
        }
        finally
        {
            if (activeRun.value === run)
            {
                activeRun.value = null;
                activeLocalRun = null;
            }
        }
    };

    const requestRun = (local: OwnedLocalUploadFlow, execute: () => Promise<void>): ImageUploadLocalRequest<void> =>
    {
        localRuns.add(local);
        void local.settled.then(() => localRuns.delete(local));
        const result = (async (): Promise<void> =>
        {
            try
            {
                await execute();
            }
            finally
            {
                local.finishExecution();
            }
        })();
        return Object.freeze({ result, settled: local.settled,
            cancelLocal: (reason?: unknown) => local.cancelLocal(reason),
            inspectLocalResources: () => local.inspect() });
    };

    const requestStartUpload = (params: StartUploadParams): ImageUploadLocalRequest<void> =>
    {
        const local = new OwnedLocalUploadFlow(params);
        return requestRun(local, () => executeStartUpload(params, local));
    };
    const requestResumeUpload = (overrides?: UploadCallbacks & { messages?: UploadMessages; }): ImageUploadLocalRequest<void> =>
    {
        const local = new OwnedLocalUploadFlow(overrides);
        return requestRun(local, () => executeResumeUpload(overrides, local));
    };
    const startUpload = (params: StartUploadParams): Promise<void> => requestStartUpload(params).result;
    const resumeUpload = (overrides?: UploadCallbacks & { messages?: UploadMessages; }): Promise<void> => requestResumeUpload(overrides).result;

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
        activeLocalRun?.cancelLocal();
        uploadTask.cancel();
    };

    return {
        canResume,
        pendingContext,
        startUpload,
        resumeUpload,
        requestStartUpload,
        requestResumeUpload,
        clearPending,
        cancel
    };
}
