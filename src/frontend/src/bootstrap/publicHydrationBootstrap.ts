import type { PublicHydrationPayload } from '@/public-renderers';
import { AEDS_BINARY_MEDIA_TYPE } from '@/api/contracts';
import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload';

const HYDRATION_SCRIPT_ID = 'fsus-aot-hydration-props';
let cachedPayload: PublicHydrationPayload | null | undefined;
let serverHydrationPayloadOverride: PublicHydrationPayload | null = null;

type PublicHydrationSnapshotWindow = Window & typeof globalThis & {
  __FSUS_PUBLIC_HYDRATION_RAW__?: string | null;
};

function readWindowHydrationRaw(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = (window as PublicHydrationSnapshotWindow).__FSUS_PUBLIC_HYDRATION_RAW__;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function writeWindowHydrationRaw(rawPayload: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  (window as PublicHydrationSnapshotWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = rawPayload;
}

function readText(): string | null {
  const element = document.getElementById(HYDRATION_SCRIPT_ID);
  const text = element?.textContent?.trim();
  if (text) {
    return text;
  }

  return readWindowHydrationRaw();
}

export function readPublicHydrationPayload(): PublicHydrationPayload | null {
  if (serverHydrationPayloadOverride) {
    return serverHydrationPayloadOverride;
  }

  const text = readText();

  if (cachedPayload !== undefined && (cachedPayload !== null || !text)) {
    return cachedPayload;
  }

  if (!text) {
    return null;
  }

  try {
    const parsed = decodePublicAotPayload<PublicHydrationPayload>(text);
    cachedPayload = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedPayload = null;
  }

  return cachedPayload;
}

export function setServerPublicHydrationPayloadOverride(payload: PublicHydrationPayload | null): void {
  serverHydrationPayloadOverride = payload;
  cachedPayload = payload;
}

export function replacePublicHydrationPayloadBinary(rawPayload: string | null): PublicHydrationPayload | null {
  const script = document.getElementById(HYDRATION_SCRIPT_ID);
  if (!rawPayload) {
    script?.remove();
    writeWindowHydrationRaw(null);
    cachedPayload = null;
    return cachedPayload;
  }

  const target = script ?? (() => {
    const created = document.createElement('script');
    created.id = HYDRATION_SCRIPT_ID;
    created.type = AEDS_BINARY_MEDIA_TYPE;
    document.body.appendChild(created);
    return created;
  })();

  target.textContent = rawPayload;
  writeWindowHydrationRaw(rawPayload);

  try {
    const parsed = decodePublicAotPayload<PublicHydrationPayload>(rawPayload);
    cachedPayload = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedPayload = null;
  }

  return cachedPayload;
}
