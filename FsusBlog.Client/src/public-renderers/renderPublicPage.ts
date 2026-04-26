import { createApp, createSSRApp, nextTick, type Component } from 'vue';
import type {
  PublicHydrationPayload,
  PublicArchiveHydrationPayload,
  PublicArticleDetailHydrationPayload,
  PublicFilterHydrationPayload,
  PublicHomeHydrationPayload,
  PublicPassiveHydrationPayload
} from './types';
import { loadPublicAotPageComponent } from './registry';

export const PUBLIC_RENDERER_VERSION = 'public-vue-renderer@2026-04-19-1';

export type RenderedPublicHydrationBundle = Readonly<{
  html: string;
  hydrationPropsJson: string;
  rendererVersion: string;
  islandsJson?: string | null;
}>;

async function renderComponentToHtml(component: Component, payload: object): Promise<string> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    const { renderToString } = await import('@vue/server-renderer');
    const app = createSSRApp(component, payload);
    return await renderToString(app);
  }

  const container = document.createElement('div');
  container.setAttribute('data-public-render-buffer', 'true');
  container.hidden = true;
  document.body.appendChild(container);

  try {
    const app = createApp(component, payload);
    app.mount(container);
    await nextTick();
    const html = container.innerHTML;
    app.unmount();
    return html;
  } finally {
    container.remove();
  }
}

async function renderPublicBundle(
  payload: PublicHydrationPayload,
  islandsJson: string | null = null
): Promise<RenderedPublicHydrationBundle> {
  const component = await loadPublicAotPageComponent(payload.pageKind);
  const html = await renderComponentToHtml(component, payload);
  return {
    html,
    hydrationPropsJson: JSON.stringify(payload),
    rendererVersion: PUBLIC_RENDERER_VERSION,
    islandsJson
  };
}

export async function renderPublicHomeBundle(payload: PublicHomeHydrationPayload): Promise<RenderedPublicHydrationBundle> {
  return await renderPublicBundle(payload);
}

export async function renderPublicArticleDetailBundle(payload: PublicArticleDetailHydrationPayload): Promise<RenderedPublicHydrationBundle> {
  return await renderPublicBundle(payload);
}

export async function renderPublicAboutBundle(payload: PublicPassiveHydrationPayload): Promise<RenderedPublicHydrationBundle> {
  return await renderPublicBundle(payload);
}

export async function renderPublicArchiveBundle(payload: PublicArchiveHydrationPayload): Promise<RenderedPublicHydrationBundle> {
  return await renderPublicBundle(payload);
}

export async function renderPublicFilterBundle(payload: PublicFilterHydrationPayload): Promise<RenderedPublicHydrationBundle> {
  return await renderPublicBundle(payload);
}
