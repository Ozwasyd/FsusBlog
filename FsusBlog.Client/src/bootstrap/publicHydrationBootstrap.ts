import type { PublicHydrationPayload } from '@/public-renderers';

const HYDRATION_SCRIPT_ID = 'fsus-aot-hydration-props';
let cachedPayload: PublicHydrationPayload | null | undefined;

function readText(): string | null {
  const element = document.getElementById(HYDRATION_SCRIPT_ID);
  const text = element?.textContent?.trim();
  return text ? text : null;
}

export function readPublicHydrationPayload(): PublicHydrationPayload | null {
  if (cachedPayload !== undefined) {
    return cachedPayload;
  }

  const text = readText();
  if (!text) {
    cachedPayload = null;
    return cachedPayload;
  }

  try {
    const parsed = JSON.parse(text) as PublicHydrationPayload;
    cachedPayload = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedPayload = null;
  }

  return cachedPayload;
}
