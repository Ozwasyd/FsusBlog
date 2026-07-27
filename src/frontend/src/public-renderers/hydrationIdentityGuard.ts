import type { PublicHydrationPayload } from './types';

export type HydrationIdentityGuard = Readonly<{
  appRootRef: HTMLElement;
  shellRef: HTMLElement;
  firstChildRef: Element | null;
  childElementCount: number;
  identityMarker: string;
  pageKind: string;
  routeKey: string;
}>;

function summarizeDomPath(root: HTMLElement, target: Element | null): string {
  if (!target || !root.contains(target)) {
    return '#app'
  }

  const parts: string[] = []
  let current: Element | null = target
  while (current && current !== root) {
    const parent: Element | null = current.parentElement
    if (!parent) {
      break
    }
    const siblings = Array.from(parent.children)
    const index = siblings.indexOf(current)
    const id = current.id ? `#${current.id}` : ''
    parts.push(`${current.tagName.toLowerCase()}${id}[${index}]`)
    current = parent
  }
  parts.push('#app')
  return parts.reverse().join(' > ')
}

export function captureHydrationIdentity(
  appRoot: HTMLElement,
  shell: HTMLElement,
  payload: PublicHydrationPayload
): HydrationIdentityGuard {
  const identityMarker = `${payload.pageKind}:${payload.routeKey}`;

  return {
    appRootRef: appRoot,
    shellRef: shell,
    firstChildRef: appRoot.firstElementChild,
    childElementCount: appRoot.childElementCount,
    identityMarker,
    pageKind: payload.pageKind,
    routeKey: payload.routeKey
  };
}

export function verifyHydrationIdentity(options: {
  appSelector: string;
  shellSelector: string;
  payload: PublicHydrationPayload;
  guard: HydrationIdentityGuard;
}): void {
  const { appSelector, shellSelector, payload, guard } = options;
  const expectedMarker = `${payload.pageKind}:${payload.routeKey}`
  if (guard.identityMarker !== expectedMarker
    || guard.pageKind !== payload.pageKind
    || guard.routeKey !== payload.routeKey) {
    throw new Error(
      `[public-hydrate] route identity mismatch expected=${expectedMarker} actual=${guard.identityMarker} path=#app > #fsus-aot-shell`
    )
  }

  const root = document.querySelector<HTMLElement>(appSelector);
  if (!root) {
    throw new Error(`[public-hydrate] ${appSelector} missing after hydration path=#app`);
  }

  const shellAfterHydration = root.querySelector<HTMLElement>(shellSelector);
  if (shellAfterHydration !== guard.shellRef) {
    const path = summarizeDomPath(root, shellAfterHydration)
    throw new Error(
      `[public-hydrate] shell remount detected for ${payload.pageKind} (${payload.routeKey}) path=${path}`
    );
  }

  if (shellAfterHydration?.dataset.publicHydrationKind
    && shellAfterHydration.dataset.publicHydrationKind !== payload.pageKind) {
    throw new Error(
      `[public-hydrate] pageKind mismatch expected=${payload.pageKind} actual=${shellAfterHydration.dataset.publicHydrationKind} path=#app > #fsus-aot-shell`
    )
  }

  if (root.firstElementChild !== guard.firstChildRef || root.childElementCount !== guard.childElementCount) {
    const path = summarizeDomPath(root, root.firstElementChild)
    throw new Error(
      `[public-hydrate] #app subtree rebuilt for ${payload.pageKind} (${payload.routeKey}) path=${path}`
    );
  }
}
