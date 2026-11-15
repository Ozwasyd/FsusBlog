import { ProtocolError } from './aeds.ts';
import type { AdminSession } from './admin-identity.ts';
import { request } from './client.ts';
import { decodeAdminRiskReadiness, FrameType, WireHeaders, WireRoutes } from './wire.generated.ts';

export function readAdminRiskReadiness(session: AdminSession, signal: AbortSignal) {
  return request(WireRoutes.AdminRiskReadiness, FrameType.AdminRiskReadiness, (payload, headers) => {
    if (!session.permissionSession || headers.get(WireHeaders.AdminPermissionSession) !== session.permissionSession)
      throw new ProtocolError('Administrator permission session changed.');

    const status = decodeAdminRiskReadiness(payload);
    if (status.publicReadMode !== 1 || (status.rootWriteMode !== 0 && status.rootWriteMode !== 1) ||
        status.replyWriteMode < 0 || status.replyWriteMode > 2 || (status.rootWriteMode === 0 && status.replyWriteMode !== 0) ||
        (status.forwardingMode !== 0 && status.forwardingMode !== 1) ||
        status.dynamicRisk !== 0 || status.strongAnonymous !== 0)
      throw new ProtocolError('Invalid risk control status.');
    const rootPolicy = headers.get(WireHeaders.AdminRootCommentPowPolicy);
    if (rootPolicy !== null && (rootPolicy !== '1' || status.rootWriteMode !== 1))
      throw new ProtocolError('Invalid root comment proof policy status.');
    return { ...status, rootCommentPowPolicy: rootPolicy === '1' };
  }, signal);
}
