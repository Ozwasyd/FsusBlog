import { encodeFrame, ProtocolError } from './aeds.ts';
import { request, validSiteSessionId } from './client.ts';
import {
  decodeAuthoringWorkspaceSnapshot, encodeAuthoringWorkspaceCommand, FrameType, WireHeaders, WireLimits, WireRoutes,
  type AuthoringWorkspaceSnapshot,
} from './wire.generated.ts';

type Layout = Pick<AuthoringWorkspaceSnapshot, 'activeArticleId' | 'tabs'>;

function readSnapshot(payload: Uint8Array): AuthoringWorkspaceSnapshot {
  const value = decodeAuthoringWorkspaceSnapshot(payload);
  const ids = new Set(value.tabs.map(Math.abs));
  if (value.schemaVersion !== 1 || value.revision < 0n || value.activeArticleId < 0 ||
      value.skipped < 0 || value.skipped > WireLimits.AuthoringWorkspaceTabs || ids.size !== value.tabs.length ||
      value.tabs.some(id => id === 0 || id === -2_147_483_648) || value.tabs.filter(id => id < 0).length > 1 ||
      (value.activeArticleId !== 0 && !ids.has(value.activeArticleId)) ||
      (value.revision === 0n ? value.updatedAtUnixMs !== 0n || value.tabs.length !== 0 || value.skipped !== 0 : value.updatedAtUnixMs <= 0n))
    throw new ProtocolError('Invalid authoring workspace snapshot');
  return value;
}

export function authoringWorkspace(session: string, signal: AbortSignal, change?: Layout & { expectedRevision: bigint }) {
  if (!validSiteSessionId(session)) throw new ProtocolError('Invalid authoring workspace session');
  const headers = { [WireHeaders.CurrentSession]: session };
  const body = change && encodeFrame(FrameType.AuthoringWorkspaceCommand, encodeAuthoringWorkspaceCommand({ schemaVersion: 1, ...change }));
  return request(WireRoutes.AuthoringWorkspace, FrameType.AuthoringWorkspaceSnapshot, payload => {
    const value = readSnapshot(payload);
    if (change && value.revision !== change.expectedRevision + 1n) throw new ProtocolError('Unexpected authoring workspace revision');
    return value;
  }, signal, change ? 'POST' : 'GET', body, headers, 'same-origin', change !== undefined);
}
