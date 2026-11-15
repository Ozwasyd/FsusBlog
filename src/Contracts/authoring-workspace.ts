import { ApiError, encodeFrame, ProtocolError } from './aeds.ts';
import { request, siteSessionHeader } from './client.ts';
import {
  decodeAuthoringWorkspaceGroups, decodeAuthoringWorkspaceLayout, decodeAuthoringWorkspaceSnapshot,
  encodeAuthoringWorkspaceCommand, encodeAuthoringWorkspaceGroupsCommand, encodeAuthoringWorkspaceLayoutCommand,
  FrameType, WireLimits, WireRoutes, type AuthoringWorkspaceGroups, type AuthoringWorkspaceGroupsCommand,
} from './wire.generated.ts';

export type AuthoringWorkspaceVersion = 1 | 2 | 3;
type Layout = Omit<AuthoringWorkspaceGroupsCommand, 'schemaVersion' | 'expectedRevision' | 'focusedGroup'> & { focusedGroup: 0 | 1 };
export type WorkspaceChange = Layout & { expectedRevision: bigint };
export type WorkspaceSnapshot = Layout & {
  schemaVersion: AuthoringWorkspaceVersion;
  revision: bigint;
  updatedAtUnixMs: bigint;
  skipped: number;
};

const singleGroup = { secondaryActiveArticleId: 0, secondaryTabs: Object.freeze([]), focusedGroup: 0 } as const;

function validatePane(active: number, tabs: readonly number[], allIds: Set<number>) {
  let preview = false;
  let hasActive = active === 0;
  for (const tab of tabs) {
    const id = Math.abs(tab);
    if (!Number.isInteger(tab) || id === 0 || id > 0x7fffffff || allIds.has(id) || (preview && tab < 0))
      throw new ProtocolError('Invalid authoring workspace tabs');
    allIds.add(id);
    preview ||= tab < 0;
    hasActive ||= active === id;
  }
  if (!hasActive) throw new ProtocolError('Invalid active authoring workspace article');
}

function validateLayout(layout: Omit<Layout, 'focusedGroup'> & { focusedGroup: number }): asserts layout is Layout {
  if (layout.tabs.length + layout.secondaryTabs.length > WireLimits.AuthoringWorkspaceTabs ||
      (layout.focusedGroup !== 0 && layout.focusedGroup !== 1) || (layout.focusedGroup === 1 && layout.secondaryActiveArticleId === 0))
    throw new ProtocolError('Invalid authoring workspace groups');
  const ids = new Set<number>();
  validatePane(layout.activeArticleId, layout.tabs, ids);
  validatePane(layout.secondaryActiveArticleId, layout.secondaryTabs, ids);
}

function validateSnapshot(value: AuthoringWorkspaceGroups, version: AuthoringWorkspaceVersion, change?: WorkspaceChange): WorkspaceSnapshot {
  validateLayout(value);
  const count = value.tabs.length + value.secondaryTabs.length;
  const skippedLimit = WireLimits.AuthoringWorkspaceTabs - (version === 3 ? count : 0);
  if (value.schemaVersion !== version || value.revision < 0n || value.skipped < 0 || value.skipped > skippedLimit ||
      (value.revision === 0n ? value.updatedAtUnixMs !== 0n || count !== 0 || value.skipped !== 0 || value.inspectorOpen : value.updatedAtUnixMs <= 0n) ||
      (change && value.revision !== change.expectedRevision + 1n))
    throw new ProtocolError('Invalid authoring workspace snapshot');
  return { ...value, schemaVersion: version, focusedGroup: value.focusedGroup };
}

function workspaceRequest(session: string, signal: AbortSignal, version: AuthoringWorkspaceVersion, change?: WorkspaceChange) {
  const headers = siteSessionHeader(session);
  const method = change ? 'POST' : 'GET';
  const keepalive = change !== undefined;
  if (version === 3) {
    const body = change && encodeFrame(FrameType.AuthoringWorkspaceGroupsCommand, encodeAuthoringWorkspaceGroupsCommand({ ...change, schemaVersion: 3 }));
    return request(WireRoutes.AuthoringWorkspaceGroups, FrameType.AuthoringWorkspaceGroups,
      payload => validateSnapshot(decodeAuthoringWorkspaceGroups(payload), 3, change), signal, method, body, headers, 'same-origin', keepalive);
  }
  if (version === 2) {
    const body = change && encodeFrame(FrameType.AuthoringWorkspaceLayoutCommand, encodeAuthoringWorkspaceLayoutCommand({ ...change, schemaVersion: 2 }));
    return request(WireRoutes.AuthoringWorkspaceLayout, FrameType.AuthoringWorkspaceLayout,
      payload => validateSnapshot({ ...decodeAuthoringWorkspaceLayout(payload), ...singleGroup }, 2, change), signal, method, body, headers, 'same-origin', keepalive);
  }
  const body = change && encodeFrame(FrameType.AuthoringWorkspaceCommand, encodeAuthoringWorkspaceCommand({ ...change, schemaVersion: 1 }));
  return request(WireRoutes.AuthoringWorkspace, FrameType.AuthoringWorkspaceSnapshot,
    payload => validateSnapshot({ ...decodeAuthoringWorkspaceSnapshot(payload), inspectorOpen: false, ...singleGroup }, 1, change), signal,
    method, body, headers, 'same-origin', keepalive);
}

export function authoringWorkspace(session: string, signal: AbortSignal, change: WorkspaceChange, version: AuthoringWorkspaceVersion): Promise<WorkspaceSnapshot>;
export function authoringWorkspace(session: string, signal: AbortSignal, change?: undefined, version?: AuthoringWorkspaceVersion): Promise<WorkspaceSnapshot>;
export async function authoringWorkspace(session: string, signal: AbortSignal, change?: WorkspaceChange, version?: AuthoringWorkspaceVersion): Promise<WorkspaceSnapshot> {
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3) throw new ProtocolError('Invalid authoring workspace version');
  if (change) {
    validateLayout(change);
    if (version === undefined || change.expectedRevision < 0n || (version < 3 && change.secondaryTabs.length !== 0))
      throw new ProtocolError('Unsupported authoring workspace change');
    return workspaceRequest(session, signal, version, change);
  }
  if (version !== undefined) return workspaceRequest(session, signal, version);

  for (const candidate of [3, 2] as const) {
    try {
      return await workspaceRequest(session, signal, candidate);
    } catch (error) {
      if (signal.aborted || !(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  return workspaceRequest(session, signal, 1);
}
