import { ProtocolError } from './aeds.ts';
import type { AdminSession } from './admin-identity.ts';
import { request } from './client.ts';
import { decodeAdminClusterStatus, FrameType, WireHeaders, WireLimits, WireRoutes } from './wire.generated.ts';

export function readAdminCluster(session: AdminSession, signal: AbortSignal) {
  return request(WireRoutes.AdminClusterStatus, FrameType.AdminClusterStatus, (payload, headers) => {
    if (!session.permissionSession || headers.get(WireHeaders.AdminPermissionSession) !== session.permissionSession)
      throw new ProtocolError('Administrator permission session changed.');
    return decodeClusterObservation(payload);
  }, signal);
}

export function decodeClusterObservation(payload: Uint8Array) {
  const status = decodeAdminClusterStatus(payload);
  const startedAt = Number(status.startedAt);
  const observedAt = Number(status.observedAt);
  if (status.mode !== 1 || status.instanceId === '00000000-0000-0000-0000-000000000000' ||
      status.nodeId.length > WireLimits.AdminClusterNodeIdBytes || /[^A-Za-z0-9._-]/.test(status.nodeId) ||
      status.buildVersion.length > WireLimits.AdminClusterVersionBytes || status.buildVersion.length === 0 || /[^A-Za-z0-9.+-]/.test(status.buildVersion) ||
      !validTime(startedAt) || !validTime(observedAt) || status.leaseAgeMs < 0 || status.leaseAgeMs >= 1000)
    throw new ProtocolError('Invalid standalone deployment observation.');
  return { ...status, startedAt, observedAt };
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 253_402_300_799_999;
}
