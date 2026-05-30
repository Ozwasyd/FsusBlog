import { bootstrapFullApp } from '@/bootstrap/fullApp'
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

const APP_SELECTOR = '#app';
const SHELL_SELECTOR = '#fsus-aot-shell';

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

  const guard = captureHydrationIdentity(container, shell, payload);

  const metrics = beginHydrationMetrics(payload);
  markHydrationStep('hydrate:start');

  normalizePublicHydrationPayload(payload);
  markHydrationStep('hydrate:component-ready');

  // Bootstrap full app with hydration.
  // The public route will resolve through BlogLayout and consume the same
  // shell-state factory as SSR.
  await bootstrapFullApp({
    hydrate: true,
    deferRuntime: true,
    takeover: 'public-shell'
  });
  verifyHydrationIdentity({
    appSelector: APP_SELECTOR,
    shellSelector: SHELL_SELECTOR,
    payload,
    guard
  });
  markHydrationStep('hydrate:mounted');

  finishHydrationMetrics(metrics);
}
