import { commitMarkdownEmbedResult } from '@ozwasyd/element-plus/markdown-runtime';

import type { MarkdownEmbedProvider, MarkdownEmbedRequest, MarkdownEmbedResult } from '@ozwasyd/element-plus';

export const authoringMarkdownProviderSchema = 'fsusblog.authoring-markdown-embed.v1' as const;

/** A host-authorized projection for the existing FsusUI embed slot, never a syntax registration. */
export interface AuthoringMarkdownProviderProjection {
    readonly schema: typeof authoringMarkdownProviderSchema;
    readonly featureKind: 'embed';
    readonly providerId: string;
    readonly extensionId: string;
    readonly extensionVersion: string;
    readonly packageSha256: string;
    readonly runtimeIdentity: string;
    readonly configurationSha256: string;
    readonly lifecycleGeneration: number;
    readonly executionClass: 'isolated-worker-wasm' | 'out-of-process-service';
    readonly permission: 'document-range-read';
    readonly grantIdentity: string;
    readonly documentId: string;
    readonly documentEpoch: number;
    readonly sourceRevision: number;
    readonly nodeId: string;
    readonly range: Readonly<{ start: number; end: number; }>;
    readonly source: string;
    readonly sourceSha256: string;
    readonly maximumResultBytes: number;
    readonly deadlineMilliseconds: number;
}

export interface AuthoringMarkdownProviderInvocation {
    readonly identity: string;
    readonly projection: AuthoringMarkdownProviderProjection;
    readonly request: MarkdownEmbedRequest;
}

/** Trusted host/broker boundary. dispatch transports data to an isolated executor, not plugin JS. */
export interface AuthoringMarkdownProviderHost {
    current(request: MarkdownEmbedRequest): unknown;
    isCurrent(projection: AuthoringMarkdownProviderProjection): boolean;
    signal(projection: AuthoringMarkdownProviderProjection): AbortSignal;
    dispatch(invocation: AuthoringMarkdownProviderInvocation, signal: AbortSignal): Promise<unknown>;
}

const projectionKeys = [
    'schema', 'featureKind', 'providerId', 'extensionId', 'extensionVersion', 'packageSha256',
    'runtimeIdentity', 'configurationSha256', 'lifecycleGeneration', 'executionClass', 'permission',
    'grantIdentity', 'documentId', 'documentEpoch', 'sourceRevision', 'nodeId', 'range', 'source',
    'sourceSha256', 'maximumResultBytes', 'deadlineMilliseconds'
] as const;
const requestKeys = ['requestId', 'documentIdentity', 'revision', 'nodeId', 'target', 'mode', 'version'];
const encoder = new TextEncoder();
const maximumCacheEntries = 128;
const maximumCacheBytes = 1024 * 1024;
const maximumPending = 8;
const snapshotDataObject = (value: unknown): Record<string, unknown> | undefined =>
{
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    {
        return undefined;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value))
    {
        if (typeof key !== 'string')
        {
            return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
        {
            return undefined;
        }
        // Read only descriptors: transport data cannot execute an accessor while being validated.
        Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return snapshot;
};
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedText = (value: unknown, maximum = 256): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    Array.from(value).every(character =>
    {
        const point = character.codePointAt(0)!;
        return point > 31 && point !== 127;
    });
const digest = (value: unknown): boolean =>
    typeof value === 'string' && value.length === 64 &&
    Array.from(value).every(character => '0123456789abcdef'.includes(character));
const integer = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number =>
    Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;

const snapshotRequest = (input: MarkdownEmbedRequest): MarkdownEmbedRequest =>
{
    const value = snapshotDataObject(input);
    const documentIdentity = value && snapshotDataObject(value.documentIdentity);
    if (!value || !exact(value, requestKeys) ||
        !documentIdentity || !exact(documentIdentity, ['id', 'epoch']) ||
        !boundedText(value.requestId) || !boundedText(documentIdentity.id) ||
        !integer(documentIdentity.epoch, 0) || !integer(value.revision, 0) ||
        !integer(value.version, 0) || !boundedText(value.nodeId) || !boundedText(value.target, 2048) ||
        (value.mode !== 'article' && value.mode !== 'heading' && value.mode !== 'block'))
    {
        throw new TypeError('Invalid public embed request.');
    }
    return Object.freeze({
        requestId: value.requestId,
        documentIdentity: Object.freeze({ id: documentIdentity.id, epoch: documentIdentity.epoch }),
        revision: value.revision,
        nodeId: value.nodeId,
        target: value.target,
        mode: value.mode,
        version: value.version
    });
};

const snapshotProjection = (
    input: unknown, request: MarkdownEmbedRequest
): AuthoringMarkdownProviderProjection | undefined =>
{
    const value = snapshotDataObject(input);
    const range = value && snapshotDataObject(value.range);
    if (!value || !exact(value, projectionKeys) ||
        value.schema !== authoringMarkdownProviderSchema || value.featureKind !== 'embed' ||
        !boundedText(value.extensionId, 128) || !boundedText(value.providerId) ||
        !value.providerId.startsWith(`${value.extensionId}.`) || value.providerId.startsWith('fsusblog.core.') ||
        !boundedText(value.extensionVersion, 64) || !boundedText(value.grantIdentity) ||
        typeof value.executionClass !== 'string' ||
        !['isolated-worker-wasm', 'out-of-process-service'].includes(value.executionClass) ||
        value.permission !== 'document-range-read' ||
        ![value.packageSha256, value.runtimeIdentity, value.configurationSha256, value.sourceSha256].every(digest) ||
        !integer(value.lifecycleGeneration, 1) || value.documentId !== request.documentIdentity.id ||
        value.documentEpoch !== request.documentIdentity.epoch || value.sourceRevision !== request.revision ||
        value.nodeId !== request.nodeId || !range || !exact(range, ['start', 'end']) ||
        !integer(range.start, 0) || !integer(range.end, Number(range.start)) ||
        typeof value.source !== 'string' || value.source.length !== Number(range.end) - Number(range.start) ||
        encoder.encode(value.source).length > 8192 || !integer(value.maximumResultBytes, 1, 16384) ||
        !integer(value.deadlineMilliseconds, 1, 10000))
    {
        return undefined;
    }
    return Object.freeze({
        ...(value as unknown as AuthoringMarkdownProviderProjection),
        range: Object.freeze({ start: Number(range.start), end: Number(range.end) })
    });
};

const resultFor = (request: MarkdownEmbedRequest, status: MarkdownEmbedResult['status']): MarkdownEmbedResult =>
    Object.freeze({ ...request, status });

/** Installs the single public embed provider slot; absent authority always yields a local forbidden state. */
export const createAuthoringMarkdownEmbedProvider = (host: AuthoringMarkdownProviderHost): {
    readonly provider: MarkdownEmbedProvider;
    readonly dispose: () => void;
} =>
{
    const cache = new Map<string, { result: MarkdownEmbedResult; bytes: number; }>();
    const pending = new Set<AbortController>();
    let cacheBytes = 0;
    let disposed = false;
    const provider: MarkdownEmbedProvider = async input =>
    {
        const request = snapshotRequest(input);
        if (disposed)
        {
            return resultFor(request, 'missing');
        }
        const projection = snapshotProjection(host.current(request), request);
        if (disposed)
        {
            return resultFor(request, 'stale');
        }
        if (!projection)
        {
            return resultFor(request, 'forbidden');
        }
        const initiallyCurrent = host.isCurrent(projection);
        if (disposed)
        {
            return resultFor(request, 'stale');
        }
        if (!initiallyCurrent)
        {
            return resultFor(request, 'forbidden');
        }
        const authoritySignal = host.signal(projection);
        if (disposed || authoritySignal.aborted)
        {
            return resultFor(request, 'stale');
        }
        const currentAfterSignal = host.isCurrent(projection);
        if (!currentAfterSignal || disposed || authoritySignal.aborted)
        {
            return resultFor(request, 'stale');
        }
        // Exact ordered projection includes source/grant/lifecycle/config; target-only reuse is impossible.
        const identity = JSON.stringify([
            projectionKeys.map(key => [key, projection[key]]), request.documentIdentity,
            request.revision, request.nodeId, request.target, request.mode, request.version
        ]);
        const cached = cache.get(identity);
        if (cached)
        {
            return commitMarkdownEmbedResult(request, Object.freeze({ ...cached.result, requestId: request.requestId }));
        }
        if (pending.size >= maximumPending)
        {
            return resultFor(request, 'size-exceeded');
        }
        const controller = new AbortController();
        pending.add(controller);
        const invalidate = () => controller.abort();
        authoritySignal.addEventListener('abort', invalidate, { once: true });
        let timedOut = false;
        const timer = setTimeout(() =>
        {
            timedOut = true;
            controller.abort();
        }, projection.deadlineMilliseconds);
        let resolveAbort!: (value: unknown) => void;
        const cancellation = new Promise<unknown>(resolve =>
        {
            resolveAbort = resolve;
        });
        const cancel = () => resolveAbort(undefined);
        controller.signal.addEventListener('abort', cancel, { once: true });
        try
        {
            const invocation = Object.freeze({ identity, projection, request });
            const rawOutput = await Promise.race([host.dispatch(invocation, controller.signal), cancellation]);
            if (timedOut)
            {
                return resultFor(request, 'time-exceeded');
            }
            if (disposed || controller.signal.aborted || authoritySignal.aborted)
            {
                return resultFor(request, 'stale');
            }
            const stillCurrent = host.isCurrent(projection);
            if (!stillCurrent || disposed || controller.signal.aborted || authoritySignal.aborted)
            {
                return resultFor(request, 'stale');
            }
            const output = snapshotDataObject(rawOutput);
            if (!output || !Reflect.ownKeys(output).every(key =>
                typeof key === 'string' && ['identity', 'status', 'title', 'excerpt'].includes(key)) ||
                output.identity !== identity || typeof output.status !== 'string' ||
                !['resolved', 'missing', 'forbidden', 'rejected'].includes(output.status) ||
                (output.title !== undefined && typeof output.title !== 'string') ||
                (output.excerpt !== undefined && typeof output.excerpt !== 'string') ||
                (output.status !== 'resolved' && (output.title !== undefined || output.excerpt !== undefined)))
            {
                return resultFor(request, 'rejected');
            }
            const bytes = encoder.encode(output.title ?? '').length + encoder.encode(output.excerpt ?? '').length;
            if (bytes > projection.maximumResultBytes)
            {
                return resultFor(request, 'size-exceeded');
            }
            const result = commitMarkdownEmbedResult(request, Object.freeze({
                ...request, status: output.status as MarkdownEmbedResult['status'],
                ...(output.title === undefined ? {} : { title: output.title }),
                ...(output.excerpt === undefined ? {} : { excerpt: output.excerpt })
            }));
            if (result.status === 'resolved')
            {
                const replaced = cache.get(identity);
                if (replaced)
                {
                    cacheBytes -= replaced.bytes;
                    cache.delete(identity);
                }
                while (cache.size >= maximumCacheEntries || cacheBytes + bytes > maximumCacheBytes)
                {
                    const oldest = cache.keys().next().value!;
                    cacheBytes -= cache.get(oldest)!.bytes;
                    cache.delete(oldest);
                }
                cache.set(identity, { result, bytes });
                cacheBytes += bytes;
            }
            return result;
        }
        catch
        {
            return resultFor(request, controller.signal.aborted ? 'stale' : 'rejected');
        }
        finally
        {
            clearTimeout(timer);
            authoritySignal.removeEventListener('abort', invalidate);
            controller.signal.removeEventListener('abort', cancel);
            pending.delete(controller);
        }
    };
    return Object.freeze({
        provider,
        dispose: () =>
        {
            disposed = true;
            for (const controller of pending)
            {
                controller.abort();
            }
            cache.clear();
            cacheBytes = 0;
        }
    });
};
