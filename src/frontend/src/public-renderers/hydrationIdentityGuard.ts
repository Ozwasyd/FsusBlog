import type { PublicHydrationPayload } from './types';

const SHELL_IDENTITY_DATASET_KEY = 'publicShellIdentity';

export type HydrationIdentityGuard = Readonly<{
  appRootRef: HTMLElement;
  shellRef: HTMLElement;
  firstChildRef: Element | null;
  childElementCount: number;
  identityMarker: string;
}>;

export function captureHydrationIdentity(
  appRoot: HTMLElement,
  shell: HTMLElement,
  payload: PublicHydrationPayload
): HydrationIdentityGuard {
  const identityMarker = `${payload.pageKind}:${payload.routeKey}`;
  shell.dataset[SHELL_IDENTITY_DATASET_KEY] = identityMarker;

  return {
    appRootRef: appRoot,
    shellRef: shell,
    firstChildRef: appRoot.firstElementChild,
    childElementCount: appRoot.childElementCount,
    identityMarker
  };
}

export function verifyHydrationIdentity(options: {
  appSelector: string;
  shellSelector: string;
  payload: PublicHydrationPayload;
  guard: HydrationIdentityGuard;
}): void {
  const { appSelector, shellSelector, payload, guard } = options;
  const root = document.querySelector<HTMLElement>(appSelector);
  if (!root) {
    throw new Error(`[public-hydrate] ${appSelector} missing after hydration`);
  }

  const shellAfterHydration = root.querySelector<HTMLElement>(shellSelector);
  if (shellAfterHydration !== guard.shellRef) {
    throw new Error(`[public-hydrate] shell remount detected for ${payload.pageKind} (${payload.routeKey})`);
  }

  if (shellAfterHydration.dataset[SHELL_IDENTITY_DATASET_KEY] !== guard.identityMarker) {
    throw new Error(`[public-hydrate] shell identity marker changed for ${payload.pageKind} (${payload.routeKey})`);
  }

  if (root.firstElementChild !== guard.firstChildRef || root.childElementCount !== guard.childElementCount) {
    throw new Error(`[public-hydrate] #app subtree rebuilt for ${payload.pageKind} (${payload.routeKey})`);
  }
}
