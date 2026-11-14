import { ApiError, decodeSuccess, ProtocolError } from './aeds.ts';
import { request } from './client.ts';
import { requestPasskeyAssertion, requestPasskeyAttestation } from './passkey.ts';
import { decodeAdminSessionSnapshot, FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export type AdminSession = Readonly<{ handle: string; generation: bigint; expiresAt: number }>;
export type AdminAuthority = { status: 'unavailable' } | { status: 'signed-out' } | { status: 'active'; session: AdminSession };

export function validAdminBootstrapToken(ticket: string): boolean {
  return /^[0-9a-f]{64}$/.test(ticket);
}

export async function readAdminAuthority(signal?: AbortSignal): Promise<AdminAuthority> {
  try {
    const session = await request(WireRoutes.AdminSession, FrameType.AdminSessionSnapshot, readAdminSession, signal);
    return { status: 'active', session };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return { status: 'signed-out' };
      if (error.status === 404) return { status: 'unavailable' };
    }
    throw error;
  }
}

export async function bootstrapAdminPasskey(ticket: string, signal?: AbortSignal): Promise<void> {
  if (!validAdminBootstrapToken(ticket)) throw new ProtocolError('Invalid administrator bootstrap key.');
  const headers = { [WireHeaders.AdminBootstrapToken]: ticket };
  const attestation = await requestPasskeyAttestation(WireRoutes.AdminBootstrapBegin, signal, undefined, headers);
  await request(WireRoutes.AdminBootstrapComplete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', attestation, headers);
}

export async function signInAdmin(signal?: AbortSignal): Promise<AdminSession> {
  const assertion = await requestPasskeyAssertion(WireRoutes.AdminPasskeyBegin, signal);
  await request(WireRoutes.AdminPasskeyComplete, FrameType.EmptySuccess, decodeSuccess, signal, 'POST', assertion);
  const authority = await readAdminAuthority(signal);
  if (authority.status !== 'active') throw new ProtocolError('The administrator session is unavailable.');
  return authority.session;
}

export async function signOutAdmin(signal?: AbortSignal): Promise<void> {
  await request(WireRoutes.AdminSignOut, FrameType.EmptySuccess, decodeSuccess, signal, 'POST');
}

function readAdminSession(payload: Uint8Array): AdminSession {
  const snapshot = decodeAdminSessionSnapshot(payload);
  const expiresAt = Number(snapshot.expiresAt);
  if (snapshot.handle.length === 0 || snapshot.generation <= 0n || !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 || expiresAt > 8.64e15) throw new ProtocolError('Invalid administrator session.');
  return { ...snapshot, expiresAt };
}
