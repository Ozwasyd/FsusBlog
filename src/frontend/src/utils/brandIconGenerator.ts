export type BrandIconField =
  | 'faviconIcoUrl'
  | 'faviconPngUrl'
  | 'appleTouchIconUrl'
  | 'pwaIcon192Url'
  | 'pwaIcon512Url'
  | 'pwaMaskableIconUrl';

export type BrandIconUploadFormat = 'ico' | 'png';

export interface BrandIconSetUpload {
    field: BrandIconField;
    format: BrandIconUploadFormat;
    fileName: string;
    size: number;
    maskable?: boolean;
}

export interface GeneratedBrandIconUpload {
    field: BrandIconField;
    format: BrandIconUploadFormat;
    file: File;
}

export interface IcoPngEntry {
    size: number;
    png: Uint8Array;
}

export const BRAND_ICON_SET_UPLOADS: readonly BrandIconSetUpload[] = [
    { field: 'faviconIcoUrl', format: 'ico', fileName: 'favicon.ico', size: 48 },
    { field: 'faviconPngUrl', format: 'png', fileName: 'favicon-96.png', size: 96 },
    { field: 'appleTouchIconUrl', format: 'png', fileName: 'apple-touch-icon.png', size: 180 },
    { field: 'pwaIcon192Url', format: 'png', fileName: 'pwa-192.png', size: 192 },
    { field: 'pwaIcon512Url', format: 'png', fileName: 'pwa-512.png', size: 512 },
    { field: 'pwaMaskableIconUrl', format: 'png', fileName: 'pwa-maskable-512.png', size: 512, maskable: true }
];

const RASTER_ICON_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;

export function isRasterBrandIconSource(file: File): boolean
{
    const mimeType = file.type.trim().toLowerCase();
    if (RASTER_ICON_MIME_TYPES.has(mimeType))
    {
        return true;
    }

    return /\.(?:png|jpe?g|webp)$/iu.test(file.name);
}

export function getSafeBrandIconBaseName(fileName: string): string
{
    const leafName = (fileName.trim().replace(/\\/gu, '/').split('/').pop() ?? '').replace(/\.[^.]*$/u, '');
    const safe = leafName
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 48);

    return safe || 'brand-icon';
}

export function encodeIcoFromPngEntries(entries: readonly IcoPngEntry[]): Uint8Array<ArrayBuffer>
{
    if (entries.length === 0 || entries.length > 16)
    {
        throw new Error('ico_entry_count_invalid');
    }

    let offset = 6 + entries.length * 16;
    const totalBytes = offset + entries.reduce((sum, entry) => sum + entry.png.byteLength, 0);
    const bytes = new Uint8Array(totalBytes);
    const view = new DataView(bytes.buffer);

    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, entries.length, true);

    entries.forEach((entry, index) =>
    {
        if (entry.size < 1 || entry.size > 256 || !Number.isInteger(entry.size))
        {
            throw new Error('ico_entry_size_invalid');
        }
        if (!isPngPayload(entry.png))
        {
            throw new Error('ico_entry_png_invalid');
        }

        const directoryOffset = 6 + index * 16;
        bytes[directoryOffset] = entry.size === 256 ? 0 : entry.size;
        bytes[directoryOffset + 1] = entry.size === 256 ? 0 : entry.size;
        bytes[directoryOffset + 2] = 0;
        bytes[directoryOffset + 3] = 0;
        view.setUint16(directoryOffset + 4, 1, true);
        view.setUint16(directoryOffset + 6, 32, true);
        view.setUint32(directoryOffset + 8, entry.png.byteLength, true);
        view.setUint32(directoryOffset + 12, offset, true);
        bytes.set(entry.png, offset);
        offset += entry.png.byteLength;
    });

    return bytes;
}

export async function generateBrandIconSet(file: File): Promise<GeneratedBrandIconUpload[]>
{
    if (!isRasterBrandIconSource(file))
    {
        throw new Error('brand_icon_source_format_invalid');
    }

    const source = await loadRasterSource(file);
    try
    {
        const baseName = getSafeBrandIconBaseName(file.name);
        const icoSizes = [16, 32, 48];
        const icoEntries = await Promise.all(icoSizes.map(async (size) => ({
            size,
            png: await renderSourceToPngBytes(source, size, false)
        })));
        const icoFile = new File([encodeIcoFromPngEntries(icoEntries)], `${baseName}-favicon.ico`, {
            type: 'image/x-icon',
            lastModified: Date.now()
        });
        const generated: GeneratedBrandIconUpload[] = [{
            field: 'faviconIcoUrl',
            format: 'ico',
            file: icoFile
        }];

        for (const target of BRAND_ICON_SET_UPLOADS)
        {
            if (target.format !== 'png')
            {
                continue;
            }

            const blob = await renderSourceToPngBlob(source, target.size, target.maskable === true);
            generated.push({
                field: target.field,
                format: 'png',
                file: new File([blob], `${baseName}-${target.fileName}`, {
                    type: 'image/png',
                    lastModified: Date.now()
                })
            });
        }

        return generated;
    }
    finally
    {
        closeRasterSource(source);
    }
}

function isPngPayload(bytes: Uint8Array): boolean
{
    return bytes.byteLength >= 8
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function blobToDataUrl(blob: Blob): Promise<string>
{
    return new Promise((resolve, reject) =>
    {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('blob_read_failed'));
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.readAsDataURL(blob);
    });
}

async function loadRasterSource(file: File): Promise<{ bitmap?: ImageBitmap; image?: HTMLImageElement; width: number; height: number; }>
{
    if ('createImageBitmap' in window)
    {
        const bitmap = await createImageBitmap(file);
        return { bitmap, width: bitmap.width, height: bitmap.height };
    }

    const dataUrl = await blobToDataUrl(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) =>
    {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('image_decode_failed'));
        element.src = dataUrl;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight };
}

function closeRasterSource(source: { bitmap?: ImageBitmap; }): void
{
    source.bitmap?.close();
}

async function renderSourceToPngBytes(
    source: { bitmap?: ImageBitmap; image?: HTMLImageElement; width: number; height: number; },
    size: number,
    maskable: boolean
): Promise<Uint8Array<ArrayBuffer>>
{
    const blob = await renderSourceToPngBlob(source, size, maskable);
    return new Uint8Array(await blob.arrayBuffer());
}

async function renderSourceToPngBlob(
    source: { bitmap?: ImageBitmap; image?: HTMLImageElement; width: number; height: number; },
    size: number,
    maskable: boolean
): Promise<Blob>
{
    if (source.width <= 0 || source.height <= 0)
    {
        throw new Error('image_dimension_invalid');
    }

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context)
    {
        throw new Error('canvas_context_unavailable');
    }

    context.clearRect(0, 0, size, size);
    const safeScale = maskable ? 0.8 : 1;
    const scale = Math.min(size / source.width, size / source.height) * safeScale;
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const x = Math.round((size - width) / 2);
    const y = Math.round((size - height) / 2);
    const drawable = source.bitmap ?? source.image;
    if (!drawable)
    {
        throw new Error('image_decode_failed');
    }
    context.drawImage(drawable, x, y, width, height);

    return await new Promise<Blob>((resolve, reject) =>
    {
        canvas.toBlob((blob) =>
        {
            if (!blob)
            {
                reject(new Error('image_encode_failed'));
                return;
            }
            resolve(blob);
        }, 'image/png');
    });
}
