import { createSSRApp } from 'vue';
import type { PublicHydrationPayload } from './types';
import { loadPublicAotPageComponent } from './registry';

const SHELL_SELECTOR = '#fsus-aot-shell';
const SHELL_IDENTITY_DATASET_KEY = 'publicShellIdentity';

export async function hydratePublicPage(payload: PublicHydrationPayload): Promise<void> {
  const container = document.getElementById('app');
  if (!container) {
    return;
  }

  const shell = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell || shell.dataset.publicHydrationKind !== payload.pageKind) {
    return;
  }

  const identityMarker = `${payload.pageKind}:${payload.routeKey}`;
  shell.dataset[SHELL_IDENTITY_DATASET_KEY] = identityMarker;
  const shellRefBeforeHydration = shell;

  const component = await loadPublicAotPageComponent(payload.pageKind);
  const app = createSSRApp(component, payload);
  app.mount(container, true);

  const shellAfterHydration = container.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (shellAfterHydration !== shellRefBeforeHydration) {
    throw new Error(`[public-hydrate] shell remount detected for ${payload.pageKind} (${payload.routeKey})`);
  }
  if (shellAfterHydration?.dataset[SHELL_IDENTITY_DATASET_KEY] !== identityMarker) {
    throw new Error(`[public-hydrate] shell identity marker mismatch for ${payload.pageKind} (${payload.routeKey})`);
  }

  shellAfterHydration.dataset.publicHydrated = 'true';
}
