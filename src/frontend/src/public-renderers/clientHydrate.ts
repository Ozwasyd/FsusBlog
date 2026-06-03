import { createSSRApp, nextTick, type App as VueApp } from 'vue'
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
import { createPublicHydrationRootComponent } from './publicHydrationRoot';

const APP_SELECTOR = '#app';
const SHELL_SELECTOR = '#fsus-aot-shell';
let mountedPublicShellApp: VueApp<Element> | null = null;

function removeWhitespaceTextNodes(container: HTMLElement): void {
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
      node.remove();
    }
  }
}

/**
 * Hydration of public shell via the shared public shell factory.
 * SSR and BlogLayout both consume the same shell-state builder, so the hydrated
 * public route tree stays structurally identical across first paint and takeover.
 */
export async function hydratePublicPage(payload: PublicHydrationPayload): Promise<void> {
  const container = document.querySelector<HTMLElement>(APP_SELECTOR);
  if (!container) {
    return;
  }

  const shell = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell || shell.dataset.publicHydrationKind !== payload.pageKind) {
    return;
  }

  removeWhitespaceTextNodes(container);
  const guard = captureHydrationIdentity(container, shell, payload);

  const metrics = beginHydrationMetrics(payload);
  markHydrationStep('hydrate:start');

  const normalizedPayload = normalizePublicHydrationPayload(payload);
  markHydrationStep('hydrate:component-ready');

  if (!mountedPublicShellApp) {
    const app = createSSRApp(createPublicHydrationRootComponent(normalizedPayload));
    provideFsusUiAppContext(app);
    app.mount(container, true);
    mountedPublicShellApp = app;
    await nextTick();
  }

  verifyHydrationIdentity({
    appSelector: APP_SELECTOR,
    shellSelector: SHELL_SELECTOR,
    payload: normalizedPayload,
    guard
  });
  markHydrationStep('hydrate:mounted');

  finishHydrationMetrics(metrics);
}
