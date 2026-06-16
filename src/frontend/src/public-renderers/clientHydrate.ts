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
import { registerPublicStaticRouterLink } from './publicStaticRouterLink';

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

export function disposePublicHydrationApp(): void {
  if (!mountedPublicShellApp) {
    return;
  }

  mountedPublicShellApp.unmount();
  mountedPublicShellApp = null;
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
  const container = document.querySelector<HTMLElement>(APP_SELECTOR);
  if (!container) {
    return;
  }

  const shell = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell || shell.dataset.publicHydrationKind !== payload.pageKind) {
    return;
  }

  // Hydration invariant: strip whitespace-only SSR text nodes before Vue compares the public shell tree.
  removeWhitespaceTextNodes(container);
  markPublicAotMismatchBoundaries(container);
  const guard = captureHydrationIdentity(container, shell, payload);

  const metrics = beginHydrationMetrics(payload);
  markHydrationStep('hydrate:start');

  const normalizedPayload = normalizePublicHydrationPayload(payload);
  markHydrationStep('hydrate:component-ready');

  if (!mountedPublicShellApp) {
    const app = createSSRApp(createPublicHydrationRootComponent(normalizedPayload));
    provideFsusUiAppContext(app);
    registerPublicStaticRouterLink(app);
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
  shell.dataset.publicHydrated = 'true';
  markHydrationStep('hydrate:mounted');

  finishHydrationMetrics(metrics);
}
