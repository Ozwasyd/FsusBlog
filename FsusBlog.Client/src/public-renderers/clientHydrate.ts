import { createSSRApp, shallowReadonly, shallowRef } from 'vue';
import type { PublicHydrationPayload } from './types';
import { loadPublicAotPageComponent } from './registry';
import {
  beginHydrationMetrics,
  finishHydrationMetrics,
  markHydrationStep
} from './hydrationPerf';
import { captureHydrationIdentity, verifyHydrationIdentity } from './hydrationIdentityGuard';
import { normalizePublicHydrationPayload } from './publicPayloadNormalizer';

const SHELL_SELECTOR = '#fsus-aot-shell';
const APP_SELECTOR = '#app';

export async function hydratePublicPage(payload: PublicHydrationPayload): Promise<void> {
  const container = document.getElementById('app');
  if (!container) {
    return;
  }

  const shell = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell || shell.dataset.publicHydrationKind !== payload.pageKind) {
    return;
  }

  const metrics = beginHydrationMetrics(payload);
  markHydrationStep('hydrate:start');
  const guard = captureHydrationIdentity(container, shell, payload);

  const component = await loadPublicAotPageComponent(payload.pageKind);
  const normalizedPayload = shallowRef(
    shallowReadonly(normalizePublicHydrationPayload(payload))
  );
  markHydrationStep('hydrate:component-ready');
  const app = createSSRApp(component, normalizedPayload.value);
  app.mount(container, true);
  markHydrationStep('hydrate:mounted');

  verifyHydrationIdentity({
    appSelector: APP_SELECTOR,
    shellSelector: SHELL_SELECTOR,
    payload,
    guard
  });
  const shellAfterHydration = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (shellAfterHydration) {
    shellAfterHydration.dataset.publicHydrated = 'true';
  }
  finishHydrationMetrics(metrics);
}
