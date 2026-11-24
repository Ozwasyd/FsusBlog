import { decodePod } from './binary.ts';
import { ProtocolError, validSiteSessionId } from './client.ts';
import { postEmpty, request } from './internal/http.ts';
import { FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

type SessionRow = Readonly<{ id: string; expiresAt: number; current: boolean; method: 'ticket' | 'passkey'; mfa: boolean }>;
export type SessionList = Readonly<{ hasMore: boolean; sessions: readonly SessionRow[] }>;

export function listSiteSessions(current: string, signal?: AbortSignal): Promise<SessionList> {
  return request(WireRoutes.SiteSessions, FrameType.SiteSessionList, payload => decode(payload, current), signal,
    'GET', undefined, currentHeader(current));
}

export function revokeSiteSessions(current: string, target: string | undefined, signal?: AbortSignal): Promise<void> {
  if (target !== undefined && !validSiteSessionId(target)) throw invalid();
  const path = target === undefined ? WireRoutes.SiteSessionsRevokeOthers : WireRoutes.SiteSessionRevoke.replace('{id}', target);
  return postEmpty(path, signal, undefined, currentHeader(current));
}

function currentHeader(current: string): HeadersInit {
  if (!validSiteSessionId(current)) throw invalid();
  return { [WireHeaders.CurrentSession]: current };
}

function decode(payload: Uint8Array, expected: string): SessionList {
  return decodePod(payload, reader => {
    const hasMore = reader.bool(), count = reader.i32();
    if (count < 1 || count > WireLimits.SiteSessionListSize || (hasMore && count !== WireLimits.SiteSessionListSize)) throw invalid();
    const seen = new Set<string>();
    const sessions = Array.from({ length: count }, (_, i): SessionRow => {
      const id = reader.text(WireLimits.SiteSessionIdBytes), expiresAt = Number(reader.i64());
      const current = reader.bool(), method = reader.i32(), mfa = reader.bool();
      if (!validSiteSessionId(id) || seen.has(id) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt > 8.64e15 ||
          current !== (i === 0) || current !== (id === expected) || (method !== 1 && method !== 2) || (method === 1 && mfa)) throw invalid();
      seen.add(id);
      return { id, expiresAt, current, method: method === 1 ? 'ticket' : 'passkey', mfa };
    });
    return { hasMore, sessions };
  });
}

function invalid() { return new ProtocolError('Invalid site session data.'); }
