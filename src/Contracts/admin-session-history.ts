import { ProtocolError } from './aeds.ts';
import { assertAdminPermissionSession, type AdminSession } from './admin-identity.ts';
import { request } from './client.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

const headerBytes = 12;
const rowBytes = 25;
const maxRows = 50;
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
    return decodeHistory(payload, session.generation);
  }, signal);
}

function decodeHistory(payload: Uint8Array, generation: bigint): readonly AdminSessionHistoryRow[] {
  if (payload.length < headerBytes) throw invalid();
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getInt32(8, true);
  if (view.getBigInt64(0, true) !== generation || count < 0 || count > maxRows || payload.length !== headerBytes + count * rowBytes)
    throw invalid();

  const rows: AdminSessionHistoryRow[] = [];
  for (let i = 0; i < count; i++) {
    const offset = headerBytes + i * rowBytes;
    const startedAt = time(view.getBigInt64(offset, true));
    const expiresAt = time(view.getBigInt64(offset + 8, true));
    if (expiresAt <= startedAt) throw invalid();
    const ending = view.getBigInt64(offset + 16, true);
    const state = view.getUint8(offset + 24);
    if (state === 1) {
      if (i !== 0 || ending !== 0n) throw invalid();
      rows.push({ startedAt, expiresAt, endedAt: null, state: 'current' });
    } else {
      const endedAt = time(ending);
      if (endedAt < startedAt) throw invalid();
      if ((state === 2 && endedAt < expiresAt) || (state === 3 && endedAt === expiresAt))
        rows.push({ startedAt, expiresAt, endedAt, state: state === 2 ? 'ended' : 'expired' });
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
