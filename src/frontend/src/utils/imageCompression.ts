import type { ImageCompressionOptions } from '@/api/upload';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { createImageProducerOperation, type ImageProducerOperation, type ImageProducerOwner } from '@/utils/imageProducerOperation';
import { WasmEncodeError, getWasmCapabilityLevel, getWasmImageCodec } from '@/utils/wasmImageCodec';

export type { ImageProducerCleanupError, ImageProducerOperation, ImageProducerResource, ImageProducerResourceCensus } from '@/utils/imageProducerOperation';

export interface ImageCompressionPreview {
    originalBytes: number;
    compressedBytes: number;
    width: number;
    height: number;
    format: string;
    pipeline: 'wasm-simd' | 'wasm-basic' | 'canvas-fallback';
    wasmCapability: 'simd' | 'basic' | 'none';
    wasmOnly?: boolean;
    wasmError?: {
        format: ImageCompressionOptions['format'];
        pipeline: 'wasm-simd' | 'wasm-basic' | 'wasm-none';
        reason: string;
    };
}

export interface ImageCompressionRuntimeOptions {
    wasmOnly?: boolean;
    signal?: AbortSignal;
}

export interface ImageHashRuntimeOptions {
    signal?: AbortSignal;
}

export interface ImageCompressionResult {
    file: File;
    preview: ImageCompressionPreview;
}

let wasmOnlyCompressionMode = false;

export function setWasmOnlyCompressionMode(enabled: boolean): void
{
    wasmOnlyCompressionMode = enabled;
}

export function isWasmOnlyCompressionMode(): boolean
{
    return wasmOnlyCompressionMode;
}

async function blobToDataUrl(blob: Blob, owner: ImageProducerOwner): Promise<string>
{
    owner.ensureActive();
    const reader = new FileReader();
    const resource = owner.hold('file-reader', reader, () =>
    {
        reader.onerror = null;
        reader.onload = null;
        reader.onabort = null;
    }, () =>
    {
        if (reader.readyState === FileReader.LOADING)
        {
            reader.abort();
        }
    });
    try
    {
        return await new Promise<string>((resolve, reject) =>
        {
            reader.onerror = () => reject(reader.error ?? createAppError(AppErrorCode.InfraFailure, 'blob_read_failed'));
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onabort = () =>
            {
                try
                {
                    owner.ensureActive();
                    reject(new DOMException('Blob reader aborted', 'AbortError'));
                }
                catch (error)
                {
                    reject(error);
                }
            };
            const readAsDataUrl = reader.readAsDataURL.bind(reader);
            owner.ensureActive();
            readAsDataUrl(blob);
        });
    }
    finally
    {
        owner.release(resource);
    }
}

async function loadImageBitmap(file: File, owner: ImageProducerOwner): Promise<{
    bitmap?: ImageBitmap;
    image?: HTMLImageElement;
    releaseBitmap?: () => void;
}>
{
    owner.ensureActive();
    if ('createImageBitmap' in window)
    {
        const bitmap = await owner.observe('bitmap-decode', () =>
        {
            const decode = createImageBitmap;
            owner.ensureActive();
            return decode(file);
        });
        // Adopt before cancellation or dimensions so early failures retain the original cleanup handle.
        const resource = owner.hold('image-bitmap', bitmap, () => bitmap.close());
        owner.ensureActive();
        return { bitmap, releaseBitmap: () => owner.release(resource, true) };
    }

    const dataUrl = await blobToDataUrl(file, owner);
    owner.hold('image-data-url', dataUrl);
    owner.ensureActive();
    const element = new Image();
    owner.hold('image-element', element, () =>
    {
        element.onload = null;
        element.onerror = null;
        element.removeAttribute('src');
    });
    const image = await new Promise<HTMLImageElement>((resolve, reject) =>
    {
        element.onload = () => resolve(element);
        element.onerror = () => reject(createAppError(AppErrorCode.InfraFailure, 'image_decode_failed'));
        owner.ensureActive();
        element.src = dataUrl;
    });
    owner.ensureActive();
    return { image };
}

function computeTargetSize(width: number, height: number, options: ImageCompressionOptions): { width: number; height: number; }
{
    const ratioWidth = Math.max(1, Math.round(width * options.scaleRatio));
    const ratioHeight = Math.max(1, Math.round(height * options.scaleRatio));
    const edgeScale = Math.min(1, options.maxEdge / Math.max(ratioWidth, ratioHeight));
    return {
        width: Math.max(1, Math.round(ratioWidth * edgeScale)),
        height: Math.max(1, Math.round(ratioHeight * edgeScale))
    };
}

function resolveOutputMime(format: ImageCompressionOptions['format']): string
{
    switch (format)
    {
        case 'avif':
            return 'image/avif';
        case 'jpeg':
            return 'image/jpeg';
        case 'png':
            return 'image/png';
        case 'gif':
            return 'image/gif';
        default:
            return 'image/webp';
    }
}

function isEncodedImageLikelyValid(bytes: Uint8Array, format: ImageCompressionOptions['format']): boolean
{
    if (bytes.byteLength < 8)
    {
        return false;
    }

    if (format === 'png')
    {
        return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    }

    if (format === 'jpeg')
    {
        return bytes[0] === 0xff && bytes[1] === 0xd8;
    }

    if (format === 'gif')
    {
        return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
    }

    if (format === 'webp')
    {
        return bytes.byteLength >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    }

    if (format === 'avif')
    {
        return bytes.byteLength >= 12
      && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66;
    }

    return false;
}

/** The Promise API delegates to the same original producer invocation. */
export function compressImageFile(file: File, options: ImageCompressionOptions): Promise<ImageCompressionResult>
{
    return compressImageFileWithRuntime(file, options);
}

/** Compatible Promise API; runtime signal requests cancellation without racing native completion. */
export function compressImageFileWithRuntime(
    file: File,
    options: ImageCompressionOptions,
    runtimeOptions: ImageCompressionRuntimeOptions = {}
): Promise<ImageCompressionResult>
{
    return requestCompressImageFileWithRuntime(file, options, runtimeOptions).result;
}

/** Starts the original compression once and exposes its finite local work/cleanup custody. */
export function requestCompressImageFileWithRuntime(
    file: File,
    options: ImageCompressionOptions,
    runtimeOptions: ImageCompressionRuntimeOptions = {}
): ImageProducerOperation<ImageCompressionResult>
{
    return createImageProducerOperation(async (owner) =>
    {
        owner.hold('input-file', file);
        owner.hold('compression-options', options);
        owner.hold('runtime-options', runtimeOptions);
        return await compressImageFileOwned(file, options, runtimeOptions, owner);
    }, runtimeOptions?.signal);
}

async function compressImageFileOwned(
    file: File,
    options: ImageCompressionOptions,
    runtimeOptions: ImageCompressionRuntimeOptions,
    owner: ImageProducerOwner
): Promise<ImageCompressionResult>
{
    const wasmOnly = runtimeOptions.wasmOnly ?? wasmOnlyCompressionMode;
    owner.ensureActive();
    const wasmCapability = getWasmCapabilityLevel();

    if (file.type === 'image/gif')
    {
        if (wasmOnly)
        {
            throw new WasmEncodeError({
                format: 'gif',
                pipeline: 'wasm-none',
                reason: 'codec_need_fallback',
                codecLevel: wasmCapability
            });
        }

        return {
            file,
            preview: {
                originalBytes: file.size,
                compressedBytes: file.size,
                width: 0,
                height: 0,
                format: 'gif',
                pipeline: 'canvas-fallback',
                wasmCapability,
                wasmOnly
            }
        };
    }

    const decoded = await loadImageBitmap(file, owner);
    const sourceWidth = decoded.bitmap?.width ?? decoded.image?.naturalWidth ?? 0;
    const sourceHeight = decoded.bitmap?.height ?? decoded.image?.naturalHeight ?? 0;
    if (sourceWidth <= 0 || sourceHeight <= 0)
    {
        throw createAppError(AppErrorCode.Validation, 'image_dimension_invalid');
    }

    const { width, height } = computeTargetSize(sourceWidth, sourceHeight, options);
    const createElement = document.createElement.bind(document);
    owner.ensureActive();
    const canvas = createElement('canvas');
    owner.hold('canvas', canvas, () =>
    {
        canvas.width = 0;
        canvas.height = 0;
    });
    canvas.width = width;
    canvas.height = height;

    const contextOptions = { alpha: options.preserveAlpha };
    const getContext: (contextId: '2d', options: CanvasRenderingContext2DSettings) => CanvasRenderingContext2D | null = canvas.getContext;
    const readContext = getContext.bind(canvas);
    owner.ensureActive();
    const context = readContext('2d', contextOptions);
    if (!context)
    {
        throw createAppError(AppErrorCode.InfraFailure, 'canvas_context_unavailable');
    }
    owner.hold('canvas-context', context);

    context.clearRect(0, 0, width, height);
    if (!options.preserveAlpha && (options.format === 'jpeg' || options.format === 'webp' || options.format === 'avif'))
    {
        owner.ensureActive();
        context.fillStyle = 'white';
        context.fillRect(0, 0, width, height);
    }

    owner.ensureActive();
    if (decoded.bitmap)
    {
        context.drawImage(decoded.bitmap, 0, 0, width, height);
        decoded.releaseBitmap?.();
    }
    else if (decoded.image)
    {
        context.drawImage(decoded.image, 0, 0, width, height);
    }

    const mimeType = resolveOutputMime(options.format);
    let encodedBlob: Blob | null = null;
    let pipeline: ImageCompressionPreview['pipeline'] = 'canvas-fallback';
    let wasmError: ImageCompressionPreview['wasmError'];

    owner.ensureActive();
    owner.noteThirdParty('shared-codec-loader-internals');
    const wasmCodec = await owner.observe('codec-acquisition', () => getWasmImageCodec());
    owner.ensureActive();
    if (!wasmCodec && wasmOnly)
    {
        throw new WasmEncodeError({
            format: options.format,
            pipeline: 'wasm-none',
            reason: 'codec_unavailable',
            codecLevel: 'none'
        });
    }

    if (wasmCodec)
    {
        owner.hold('codec-reference', wasmCodec);
        try
        {
            const getImageData = context.getImageData.bind(context);
            owner.ensureActive();
            const imageData = getImageData(0, 0, width, height);
            const rgbaResource = owner.hold('image-data', imageData);
            owner.noteThirdParty('codec-internal-custody');
            const encoded = await owner.observe('codec-encode', () =>
            {
                const request = {
                    rgba: imageData.data,
                    width,
                    height,
                    format: options.format,
                    quality: options.quality,
                    preserveAlpha: options.preserveAlpha
                };
                const encode = wasmCodec.encode.bind(wasmCodec);
                owner.ensureActive();
                return encode(request);
            });
            owner.release(rgbaResource);
            owner.hold('encoded-bytes', encoded);
            const validationFormat = options.format;
            owner.ensureActive();
            if (isEncodedImageLikelyValid(encoded, validationFormat))
            {
                const createBlob = Blob;
                owner.ensureActive();
                encodedBlob = new createBlob([encoded as unknown as BlobPart], { type: mimeType });
                pipeline = wasmCodec.level === 'simd' ? 'wasm-simd' : 'wasm-basic';
            }
            else
            {
                throw new WasmEncodeError({
                    format: options.format,
                    pipeline: wasmCodec.level === 'simd' ? 'wasm-simd' : 'wasm-basic',
                    reason: 'invalid_encoded_payload',
                    codecLevel: wasmCodec.level,
                    codecVersion: wasmCodec.version
                });
            }
        }
        catch (error)
        {
            if (owner.isCancellationError(error))
            {
                throw error;
            }
            const normalized = error instanceof WasmEncodeError
                ? error
                : new WasmEncodeError({
          format: options.format,
          pipeline: wasmCodec.level === 'simd' ? 'wasm-simd' : 'wasm-basic',
          reason: error instanceof Error ? error.message : 'encode_failed',
          codecLevel: wasmCodec.level,
          codecVersion: wasmCodec.version,
          cause: error
        });
            if (wasmOnly || owner.isCancellationRequested())
            {
                throw normalized;
            }
            wasmError = {
                format: normalized.format,
                pipeline: normalized.pipeline,
                reason: normalized.reason
            };
            encodedBlob = null;
            pipeline = 'canvas-fallback';
        }
    }

    owner.ensureActive();
    const blob = encodedBlob ?? await owner.observe('canvas-to-blob', () => new Promise<Blob>((resolve, reject) =>
    {
        const onBlob = (value: Blob | null) =>
        {
            if (!value)
            {
                reject(createAppError(AppErrorCode.InfraFailure, 'image_encode_failed'));
                return;
            }
            resolve(value);
        };
        const quality = Math.min(1, Math.max(0.05, options.quality / 100));
        const toBlob = canvas.toBlob.bind(canvas);
        owner.ensureActive();
        toBlob(onBlob, mimeType, quality);
    }));
    owner.hold('encoded-blob', blob);
    owner.ensureActive();

    const extension = options.format === 'jpeg' ? 'jpg' : options.format;
    const nextName = file.name.replace(/\.[^.]+$/, `.${extension}`);
    const fileOptions = {
        type: mimeType,
        lastModified: Date.now()
    };
    const createFile = File;
    owner.ensureActive();
    const nextFile = new createFile([blob], nextName, fileOptions);

    return {
        file: nextFile,
        preview: {
            originalBytes: file.size,
            compressedBytes: nextFile.size,
            width,
            height,
            format: extension,
            pipeline,
            wasmCapability,
            wasmOnly,
            wasmError
        }
    };
}

/** The original awaited hash pipeline; its Promise is the request's exact result Promise. */
export function sha256Hex(blob: Blob): Promise<string>
{
    return requestSha256Hex(blob).result;
}

/** Cancellation stops subsequent stages; already executing arrayBuffer/digest work is awaited. */
export function requestSha256Hex(blob: Blob, runtimeOptions: ImageHashRuntimeOptions = {}): ImageProducerOperation<string>
{
    return createImageProducerOperation(async (owner) =>
    {
        owner.hold('input-blob', blob);
        const buffer = await owner.observe('blob-array-buffer', () =>
        {
            const arrayBuffer = blob.arrayBuffer.bind(blob);
            owner.ensureActive();
            return arrayBuffer();
        });
        owner.hold('array-buffer', buffer);
        owner.ensureActive();
        const digest = await owner.observe('sha256-digest', () =>
        {
            const subtle = crypto.subtle;
            const computeDigest = subtle.digest.bind(subtle);
            owner.ensureActive();
            return computeDigest('SHA-256', buffer);
        });
        owner.hold('digest-buffer', digest);
        owner.ensureActive();
        return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
    }, runtimeOptions.signal);
}
