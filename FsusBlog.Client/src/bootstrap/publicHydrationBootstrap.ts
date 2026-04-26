import type { PublicHydrationPayload } from '@/public-renderers';

const HYDRATION_SCRIPT_ID = 'fsus-aot-hydration-props';
let cachedPayload: PublicHydrationPayload | null | undefined;

function decodeHtmlEntities(raw: string): string {
  return raw
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&#39;', '\'')
    .replaceAll('&#x2F;', '/');
}

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
    const parsed = JSON.parse(decodeHtmlEntities(text)) as PublicHydrationPayload;
    cachedPayload = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedPayload = null;
  }

  return cachedPayload;
}

export function replacePublicHydrationPayloadJson(rawJson: string | null): PublicHydrationPayload | null {
  const script = document.getElementById(HYDRATION_SCRIPT_ID);
  if (!rawJson) {
    script?.remove();
    cachedPayload = null;
    return cachedPayload;
  }

  const target = script ?? (() => {
    const created = document.createElement('script');
    created.id = HYDRATION_SCRIPT_ID;
    created.type = 'application/json';
    document.body.appendChild(created);
    return created;
  })();

  target.textContent = rawJson;

  try {
    const parsed = JSON.parse(decodeHtmlEntities(rawJson)) as PublicHydrationPayload;
    cachedPayload = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    cachedPayload = null;
  }

  return cachedPayload;
}
