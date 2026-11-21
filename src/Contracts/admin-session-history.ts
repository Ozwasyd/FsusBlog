import { ProtocolError } from './aeds.ts';
import { assertAdminPermissionSession, type AdminSession } from './admin-identity.ts';
import { request } from './client.ts';
import {
  AdminSignInState, decodeAdminSignInHistorySnapshot, FrameType, WireRoutes,
} from './wire.generated.ts';

const maxDate = 8_640_000_000_000_000n;

export type AdminSessionHistoryRow = Readonly<{
  startedAt: number;
  expiresAt: number;
  endedAt: number | null;
  state: 'current' | 'ended' | 'expired';
}>;

export function readAdminSessionHistory(session: AdminSession, signal: AbortSignal): Promise<readonly AdminSessionHistoryRow[]> {
  return request(WireRoutes.AdminSignInHistory, FrameType.AdminSignInHistory, (payload, headers) => {
    assertAdminPermissionSession(session, headers, 'Administrator history session changed.');
    return decodeAdminSessionHistory(payload, session.generation);
  }, signal);
}

export function decodeAdminSessionHistory(payload: Uint8Array, generation: bigint): readonly AdminSessionHistoryRow[] {
  const snapshot = decodeAdminSignInHistorySnapshot(payload);
  if (snapshot.generation <= 0n || snapshot.generation !== generation) throw invalid();

  const rows: AdminSessionHistoryRow[] = [];
  for (let i = 0; i < snapshot.signIns.length; i++) {
    const signIn = snapshot.signIns[i];
    const startedAt = time(signIn.startedAt);
    const expiresAt = time(signIn.expiresAt);
    if (expiresAt <= startedAt) throw invalid();
    if (signIn.state === AdminSignInState.Current) {
      if (i !== 0 || signIn.endedAt !== 0n) throw invalid();
      rows.push({ startedAt, expiresAt, endedAt: null, state: 'current' });
    } else {
      const endedAt = time(signIn.endedAt);
      if (endedAt < startedAt) throw invalid();
      if ((signIn.state === AdminSignInState.Ended && endedAt < expiresAt) ||
          (signIn.state === AdminSignInState.Expired && endedAt === expiresAt))
        rows.push({ startedAt, expiresAt, endedAt, state: signIn.state === AdminSignInState.Ended ? 'ended' : 'expired' });
      else throw invalid();
    }
  }
  return rows;
}

function time(value: bigint): number {
  if (value <= 0n || value > maxDate) throw invalid();
  return Number(value);
}

function invalid() { return new ProtocolError('Invalid administrator session history.'); }
