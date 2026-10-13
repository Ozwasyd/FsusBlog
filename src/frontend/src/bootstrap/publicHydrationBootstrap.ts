import { AEDS_BINARY_MEDIA_TYPE, PUBLIC_AOT_HYDRATION_MEDIA_TYPE } from '@/api/contracts';
import { decodePublicAotPayload, decodePublicAotPayloadBytes } from '@/bootstrap/publicAotBinaryPayload';
import type { PublicHydrationPayload } from '@/public-renderers';
import { setNonExecutableScriptText } from '@/security/trustedTypesRuntime';

const HYDRATION_SCRIPT_ID = 'fsus-aot-hydration-props';
let cachedPayload: PublicHydrationPayload | null | undefined;
let pendingPayload: Promise<PublicHydrationPayload | null> | null = null;
let serverHydrationPayloadOverride: PublicHydrationPayload | null = null;

type PublicHydrationSnapshotWindow = Window & typeof globalThis & {
    __FSUS_PUBLIC_HYDRATION_RAW__?: string | null;
};

function readWindowHydrationRaw(): string | null
{
    if (typeof window === 'undefined')
    {
        return null;
    }

    const raw = (window as PublicHydrationSnapshotWindow).__FSUS_PUBLIC_HYDRATION_RAW__;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function writeWindowHydrationRaw(rawPayload: string | null): void
{
    if (typeof window === 'undefined')
    {
        return;
    }

    (window as PublicHydrationSnapshotWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = rawPayload;
}

function readText(): string | null
{
    if (typeof document === 'undefined')
    {
        return readWindowHydrationRaw();
    }

    const element = document.getElementById(HYDRATION_SCRIPT_ID);
    const text = element?.textContent?.trim();
    if (text)
    {
        return text;
    }

    return readWindowHydrationRaw();
}

function readSidecarUrl(): string | null
{
    if (typeof document === 'undefined')
    {
        return null;
    }

    const element = document.getElementById(HYDRATION_SCRIPT_ID);
    const raw = element?.dataset.aedsSrc || element?.getAttribute('src') || '';
    if (!raw.trim())
    {
        return null;
    }

    return new URL(raw.trim(), window.location.href).toString();
}

function cacheHydrationPayload(payload: PublicHydrationPayload | null): PublicHydrationPayload | null
{
    cachedPayload = payload;
    return payload;
}

export function readPublicHydrationPayload(): PublicHydrationPayload | null
{
    if (serverHydrationPayloadOverride)
    {
        return serverHydrationPayloadOverride;
    }

    const text = readText();

    if (cachedPayload !== undefined && (cachedPayload !== null || !text))
    {
        return cachedPayload;
    }

    if (!text)
    {
        return null;
    }

    try
    {
        const parsed = decodePublicAotPayload<PublicHydrationPayload>(text);
        cacheHydrationPayload(parsed && typeof parsed === 'object' ? parsed : null);
    }
    catch
    {
        cacheHydrationPayload(null);
    }

    return cachedPayload ?? null;
}

export async function readPublicHydrationPayloadFromUrl(
    url: string,
    signal?: AbortSignal
): Promise<PublicHydrationPayload | null>
{
    const response = await fetch(url, {
        credentials: 'same-origin',
        headers: {
            Accept: PUBLIC_AOT_HYDRATION_MEDIA_TYPE
        },
        signal
    });
    if (!response.ok)
    {
        return null;
    }

    const parsed = decodePublicAotPayloadBytes<PublicHydrationPayload>(await response.arrayBuffer());
    return parsed && typeof parsed === 'object' ? parsed : null;
}

export async function readPublicHydrationPayloadAsync(signal?: AbortSignal): Promise<PublicHydrationPayload | null>
{
    const payload = readPublicHydrationPayload();
    if (payload || cachedPayload !== undefined)
    {
        return payload;
    }

    const sidecarUrl = readSidecarUrl();
    if (!sidecarUrl)
    {
        return null;
    }

    pendingPayload ??= readPublicHydrationPayloadFromUrl(sidecarUrl, signal)
        .then((value) => cacheHydrationPayload(value))
        .finally(() =>
        {
            pendingPayload = null;
        });

    return await pendingPayload;
}

export function setServerPublicHydrationPayloadOverride(payload: PublicHydrationPayload | null): void
{
    serverHydrationPayloadOverride = payload;
    cacheHydrationPayload(payload);
}

export function replacePublicHydrationPayloadSnapshot(payload: PublicHydrationPayload | null): PublicHydrationPayload | null
{
    document.getElementById(HYDRATION_SCRIPT_ID)?.remove();
    writeWindowHydrationRaw(null);
    return cacheHydrationPayload(payload);
}

export function replacePublicHydrationPayloadBinary(rawPayload: string | null): PublicHydrationPayload | null
{
    const script = document.getElementById(HYDRATION_SCRIPT_ID);
    if (!rawPayload)
    {
        script?.remove();
        writeWindowHydrationRaw(null);
        return cacheHydrationPayload(null);
    }

    if (script !== null && !(script instanceof HTMLScriptElement))
    {
        throw new Error('public_hydration_script_invalid');
    }

    const target = script ?? (() =>
    {
        const created = document.createElement('script');
        created.id = HYDRATION_SCRIPT_ID;
        created.type = AEDS_BINARY_MEDIA_TYPE;
        document.body.appendChild(created);
        return created;
    })();

    setNonExecutableScriptText(target, rawPayload);
    writeWindowHydrationRaw(rawPayload);

    try
    {
        const parsed = decodePublicAotPayload<PublicHydrationPayload>(rawPayload);
        cacheHydrationPayload(parsed && typeof parsed === 'object' ? parsed : null);
    }
    catch
    {
        cacheHydrationPayload(null);
    }

    return cachedPayload ?? null;
}
