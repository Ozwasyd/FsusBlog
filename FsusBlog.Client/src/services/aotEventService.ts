export type AotEventDetail = {
  action?: string;
  actionId?: number;
  value?: number;
  key?: string;
  html?: string;
};

export function parseAotEvent(event: Event): AotEventDetail | null {
  const payload = (event as CustomEvent).detail as AotEventDetail | undefined;
  if (!payload || typeof payload.action !== 'string' || payload.action.length === 0) {
    return null;
  }

  return payload;
}

export function isTransportToggleAction(action: string): boolean {
  return action === 'force-json' || action === 'force-binary';
}

export function createRefreshGuard(cooldownMs = 300): () => boolean {
  let lastAt = 0;
  return () => {
    const now = Date.now();
    if (now - lastAt < cooldownMs) {
      return false;
    }

    lastAt = now;
    return true;
  };
}
