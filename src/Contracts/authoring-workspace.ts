import { ApiError, encodeFrame, ProtocolError } from './aeds.ts';
import { request, validSiteSessionId } from './client.ts';
import {
  decodeAuthoringWorkspaceSnapshot, decodeAuthoringWorkspaceLayout, encodeAuthoringWorkspaceCommand, encodeAuthoringWorkspaceLayoutCommand,
  FrameType, WireHeaders, WireLimits, WireRoutes, type AuthoringWorkspaceSnapshot, type AuthoringWorkspaceLayout,
} from './wire.generated.ts';

type Layout = Pick<AuthoringWorkspaceLayout, 'activeArticleId' | 'tabs' | 'inspectorOpen'>;

function validateSnapshot(value: AuthoringWorkspaceSnapshot, expectedSchema: number) {
  const ids = new Set(value.tabs.map(Math.abs));
  if (value.schemaVersion !== expectedSchema || value.revision < 0n || value.activeArticleId < 0 ||
      value.skipped < 0 || value.skipped > WireLimits.AuthoringWorkspaceTabs || ids.size !== value.tabs.length ||
      value.tabs.some(id => id === 0 || id === -2_147_483_648) || value.tabs.filter(id => id < 0).length > 1 ||
      (value.activeArticleId !== 0 && !ids.has(value.activeArticleId)) ||
      (value.revision === 0n ? value.updatedAtUnixMs !== 0n || value.tabs.length !== 0 || value.skipped !== 0 : value.updatedAtUnixMs <= 0n))
    throw new ProtocolError('Invalid authoring workspace snapshot');
}

export async function authoringWorkspace(session: string, signal: AbortSignal, change?: Layout & { expectedRevision: bigint }, legacy = false) {
  if (!validSiteSessionId(session)) throw new ProtocolError('Invalid authoring workspace session');
  const headers = { [WireHeaders.CurrentSession]: session };
  const method = change ? 'POST' : 'GET';
  if (!legacy) {
    const body = change && encodeFrame(FrameType.AuthoringWorkspaceLayoutCommand, encodeAuthoringWorkspaceLayoutCommand({ schemaVersion: 2, ...change }));
    try {
      return await request(WireRoutes.AuthoringWorkspaceLayout, FrameType.AuthoringWorkspaceLayout, payload => {
        const value = decodeAuthoringWorkspaceLayout(payload);
        validateSnapshot(value, 2);
        if ((value.revision === 0n && value.inspectorOpen) || (change && value.revision !== change.expectedRevision + 1n))
          throw new ProtocolError('Unexpected authoring workspace revision');
        return value;
      }, signal, method, body, headers, 'same-origin', change !== undefined);
    } catch (error) {
      if (change || signal.aborted || !(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  const body = change && encodeFrame(FrameType.AuthoringWorkspaceCommand, encodeAuthoringWorkspaceCommand({ schemaVersion: 1, ...change }));
  return request(WireRoutes.AuthoringWorkspace, FrameType.AuthoringWorkspaceSnapshot, payload => {
    const value = decodeAuthoringWorkspaceSnapshot(payload);
    validateSnapshot(value, 1);
    if (change && value.revision !== change.expectedRevision + 1n) throw new ProtocolError('Unexpected authoring workspace revision');
    return { ...value, inspectorOpen: false };
  }, signal, method, body, headers, 'same-origin', change !== undefined);
}
