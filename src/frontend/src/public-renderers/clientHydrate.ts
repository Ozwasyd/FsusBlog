import { createSSRApp, nextTick, ref, shallowRef, type App as VueApp, type VNode } from 'vue'
import { createPinia, type Pinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import type { PublicHydrationPayload } from './types';
import {
  beginHydrationMetrics,
  finishHydrationMetrics,
  markHydrationStep
} from './hydrationPerf';
import {
  captureHydrationIdentity,
  verifyHydrationIdentity
} from './hydrationIdentityGuard';
import { normalizePublicHydrationPayload } from './publicPayloadNormalizer';
import {
  createPublicHydrationRootComponent,
  type PublicHydrationTakeoverController
} from './publicHydrationRoot';
import { registerPublicStaticRouterLink } from './publicStaticRouterLink';
import { initializeLocaleRuntime, isSupportedLocale } from '@/locales'
import { requiredLocaleDomainsForPublicPage } from '@/locales/routeLocaleDomains'
import { hasCanonicalPublicSeedRenderTimestamp } from './publicRenderClock';

const APP_SELECTOR = '#app';
const SHELL_SELECTOR = '#fsus-aot-shell';
const ALLOW_MISMATCH_ATTR = 'data-allow-mismatch';
const PUBLIC_AOT_MISMATCH_SELECTORS = [
  '#fsus-aot-shell',
  '#fsus-aot-shell .el-input',
  '#fsus-aot-shell .el-input__wrapper',
  '#fsus-aot-shell .el-input__inner',
  '#fsus-aot-shell .el-radio-group',
  '#fsus-aot-shell .el-theme-mode-toggle',
  '#fsus-aot-shell [data-fsus-motion-surface]'
] as const;
let mountedPublicShellApp: VueApp<Element> | null = null;
let mountedPublicShellPinia: Pinia | null = null;
let mountedPublicShellPayload: PublicHydrationPayload | null = null;
let publicTakeoverController: PublicHydrationTakeoverController | null = null;

export type PublicHydrationTakeoverHandle = Readonly<{
  app: VueApp<Element>
  pinia: Pinia
  payload: PublicHydrationPayload
  activate: (renderer: () => VNode) => Promise<void>
}>

export function getPublicHydrationTakeoverHandle(): PublicHydrationTakeoverHandle | null {
  if (!mountedPublicShellApp || !mountedPublicShellPinia || !mountedPublicShellPayload || !publicTakeoverController) {
    return null;
  }

  const controller = publicTakeoverController;
  return {
    app: mountedPublicShellApp,
    pinia: mountedPublicShellPinia,
    payload: mountedPublicShellPayload,
    activate: async (renderer: () => VNode): Promise<void> => {
      controller.renderer.value = renderer;
      controller.active.value = true;
      await nextTick();
    }
  };
}

export function disposePublicHydrationApp(): void {
  if (!mountedPublicShellApp) {
    return;
  }

  mountedPublicShellApp.unmount();
  mountedPublicShellApp = null;
  mountedPublicShellPinia = null;
  mountedPublicShellPayload = null;
  publicTakeoverController = null;
}

function removeWhitespaceTextNodes(container: HTMLElement): void {
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
      node.remove();
    }
  }
}

function markPublicAotMismatchBoundaries(container: HTMLElement): void {
  for (const selector of PUBLIC_AOT_MISMATCH_SELECTORS) {
    for (const element of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
      element.setAttribute(ALLOW_MISMATCH_ATTR, '');
    }
  }
}

/**
 * Hydration of public shell via the shared public shell factory.
 * SSR and BlogLayout both consume the same shell-state builder, so the hydrated
 * public route tree stays structurally identical across first paint and takeover.
 */
export async function hydratePublicPage(payload: PublicHydrationPayload): Promise<void> {
  if (!hasCanonicalPublicSeedRenderTimestamp(payload)) {
    throw new Error('public_aot_hydration_render_timestamp_invalid');
  }
  const container = document.querySelector<HTMLElement>(APP_SELECTOR);
  if (!container) {
    return;
  }

  const shell = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell || shell.dataset.publicHydrationKind !== payload.pageKind) {
    return;
  }

  if (!isSupportedLocale(payload.renderLocale)
    || shell.dataset.publicRenderLocale !== payload.renderLocale
    || document.documentElement.lang !== payload.renderLocale) {
    throw new Error('public_aot_hydration_locale_mismatch');
  }

  // Hydration invariant: strip whitespace-only SSR text nodes before Vue compares the public shell tree.
  removeWhitespaceTextNodes(container);
  markPublicAotMismatchBoundaries(container);
  const guard = captureHydrationIdentity(container, shell, payload);

  const metrics = beginHydrationMetrics(payload);
  markHydrationStep('hydrate:start');

  const normalizedPayload = normalizePublicHydrationPayload(payload);
  await initializeLocaleRuntime(
    normalizedPayload.renderLocale,
    requiredLocaleDomainsForPublicPage(normalizedPayload.pageKind)
  )
  markHydrationStep('hydrate:component-ready');

  if (!mountedPublicShellApp) {
    const takeoverController: PublicHydrationTakeoverController = {
      active: ref(false),
      renderer: shallowRef<(() => VNode) | null>(null)
    };
    const app = createSSRApp(createPublicHydrationRootComponent(normalizedPayload, takeoverController));
    const pinia = createPinia();
    pinia.use(piniaPluginPersistedstate);
    app.use(pinia);
    provideFsusUiAppContext(app);
    registerPublicStaticRouterLink(app);
    app.mount(container, true);
    mountedPublicShellApp = app;
    mountedPublicShellPinia = pinia;
    mountedPublicShellPayload = normalizedPayload;
    publicTakeoverController = takeoverController;
    await nextTick();
  }

  verifyHydrationIdentity({
    appSelector: APP_SELECTOR,
    shellSelector: SHELL_SELECTOR,
    payload: normalizedPayload,
    guard
  });
  shell.dataset.publicHydrated = 'true';
  markHydrationStep('hydrate:mounted');

  finishHydrationMetrics(metrics);
}
