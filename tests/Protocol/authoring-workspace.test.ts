import { deepEqual, equal, rejects } from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { authoringWorkspace, type WorkspaceChange } from '../../src/Contracts/authoring-workspace.ts';
import {
  decodeAuthoringWorkspaceCommand, decodeAuthoringWorkspaceGroupsCommand, decodeAuthoringWorkspaceLayoutCommand,
  encodeAuthoringWorkspaceGroups, encodeAuthoringWorkspaceGroupsCommand,
  encodeAuthoringWorkspaceLayout, encodeAuthoringWorkspaceSnapshot, FrameType, WireHeaders, WireLimits, WireRoutes,
  type AuthoringWorkspaceGroups,
} from '../../src/Contracts/wire.generated.ts';

const session = 'ab'.repeat(32);
const signal = new AbortController().signal;
const groups: AuthoringWorkspaceGroups = {
  schemaVersion: 3, revision: 5n, updatedAtUnixMs: 1700000000000n,
  activeArticleId: 2, tabs: [1, -2], skipped: 0, inspectorOpen: true,
  secondaryActiveArticleId: 4, secondaryTabs: [-3, 4], focusedGroup: 1,
};

const change: WorkspaceChange = {
  expectedRevision: 4n, activeArticleId: 2, tabs: [1, -2], inspectorOpen: true,
  secondaryActiveArticleId: 4, secondaryTabs: [-3, 4], focusedGroup: 1,
};

const frame = (type: FrameType, payload: Uint8Array) =>
  new Response(encodeFrame(type, payload), { headers: { 'Content-Type': 'application/octet-stream' } });

test('reads and writes the same workspace groups format and preserves the exact session header', async t => {
  const methods: (string | undefined)[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    equal(path, WireRoutes.AuthoringWorkspaceGroups);
    const headers = new Headers(init.headers);
    equal(headers.get(WireHeaders.CurrentSession), session);
    equal(init.credentials, 'same-origin');
    equal(init.signal, signal);
    methods.push(init.method);
    if (init.method === 'POST') {
      equal(headers.get('Content-Type'), 'application/octet-stream');
      equal(init.keepalive, true);
      const payload = decodeFrame(init.body as Uint8Array, FrameType.AuthoringWorkspaceGroupsCommand).payload;
      deepEqual(decodeAuthoringWorkspaceGroupsCommand(payload), { schemaVersion: 3, ...change });
    }
    return frame(FrameType.AuthoringWorkspaceGroups, encodeAuthoringWorkspaceGroups(groups));
  });
  deepEqual(await authoringWorkspace(session, signal), groups);
  deepEqual(await authoringWorkspace(session, signal, change, 3), groups);
  deepEqual(methods, ['GET', 'POST']);
});

test('negotiates only unavailable read routes and normalizes both older layouts', async t => {
  const calls: string[] = [];
  let layoutAvailable = true;
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push(path);
    equal(init.method, 'GET');
    if (path === WireRoutes.AuthoringWorkspaceGroups || (path === WireRoutes.AuthoringWorkspaceLayout && !layoutAvailable))
      return new Response(null, { status: 404 });
    if (path === WireRoutes.AuthoringWorkspaceLayout)
      return frame(FrameType.AuthoringWorkspaceLayout, encodeAuthoringWorkspaceLayout({ ...groups, schemaVersion: 2 }));
    return frame(FrameType.AuthoringWorkspaceSnapshot, encodeAuthoringWorkspaceSnapshot({ ...groups, schemaVersion: 1 }));
  });
  const primary = { ...groups, secondaryActiveArticleId: 0, secondaryTabs: [], focusedGroup: 0 };
  deepEqual(await authoringWorkspace(session, signal), { ...primary, schemaVersion: 2 });
  deepEqual(calls.splice(0), [WireRoutes.AuthoringWorkspaceGroups, WireRoutes.AuthoringWorkspaceLayout]);
  layoutAvailable = false;
  deepEqual(await authoringWorkspace(session, signal), { ...primary, schemaVersion: 1, inspectorOpen: false });
  deepEqual(calls, [WireRoutes.AuthoringWorkspaceGroups, WireRoutes.AuthoringWorkspaceLayout, WireRoutes.AuthoringWorkspace]);
});

test('does not downgrade split writes, failed writes, or failed authorized reads', async t => {
  const calls: string[] = [];
  let status = 404;
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls.push(path);
    return new Response(null, { status });
  });
  for (const version of [1, 2] as const)
    await rejects(authoringWorkspace(session, signal, change, version), ProtocolError);
  deepEqual(calls, []);
  await rejects(authoringWorkspace(session, signal, change, 3), { name: ApiError.name, status: 404 });
  deepEqual(calls.splice(0), [WireRoutes.AuthoringWorkspaceGroups]);
  for (const unauthorized of [401, 403, 409]) {
    status = unauthorized;
    await rejects(authoringWorkspace(session, signal), { name: ApiError.name, status });
    deepEqual(calls.splice(0), [WireRoutes.AuthoringWorkspaceGroups]);
  }
});

test('uses the negotiated legacy format for a single-group write', async t => {
  const single: WorkspaceChange = { ...change, secondaryActiveArticleId: 0, secondaryTabs: [], focusedGroup: 0 };
  const primary = { expectedRevision: single.expectedRevision, activeArticleId: single.activeArticleId, tabs: single.tabs };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push(path);
    equal(init.method, 'POST');
    if (path === WireRoutes.AuthoringWorkspaceLayout) {
      const payload = decodeFrame(init.body as Uint8Array, FrameType.AuthoringWorkspaceLayoutCommand).payload;
      deepEqual(decodeAuthoringWorkspaceLayoutCommand(payload), { schemaVersion: 2, ...primary, inspectorOpen: true });
      return frame(FrameType.AuthoringWorkspaceLayout, encodeAuthoringWorkspaceLayout({ ...groups, schemaVersion: 2 }));
    }
    const payload = decodeFrame(init.body as Uint8Array, FrameType.AuthoringWorkspaceCommand).payload;
    deepEqual(decodeAuthoringWorkspaceCommand(payload), { schemaVersion: 1, ...primary });
    return frame(FrameType.AuthoringWorkspaceSnapshot, encodeAuthoringWorkspaceSnapshot({ ...groups, schemaVersion: 1 }));
  });
  equal((await authoringWorkspace(session, signal, single, 2)).inspectorOpen, true);
  equal((await authoringWorkspace(session, signal, single, 1)).inspectorOpen, false);
  deepEqual(calls, [WireRoutes.AuthoringWorkspaceLayout, WireRoutes.AuthoringWorkspace]);
});

test('rejects mismatched receipts and malformed group coordinates even in valid frames', async t => {
  let value = { ...groups, revision: 6n };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls.push(path);
    return frame(FrameType.AuthoringWorkspaceGroups, encodeAuthoringWorkspaceGroups(value));
  });
  await rejects(authoringWorkspace(session, signal, change, 3), ProtocolError);

  for (const invalid of [
    { secondaryTabs: [-1, 4] },
    { secondaryTabs: [-3, -4] },
    { secondaryActiveArticleId: 2 },
    { secondaryActiveArticleId: 0 },
    { focusedGroup: 2 },
    { tabs: [...groups.tabs, -0x80000000] },
    { tabs: Array.from({ length: 100 }, (_, index) => index + 1), secondaryTabs: [101], secondaryActiveArticleId: 101 },
    { skipped: 97 },
    { revision: 0n, updatedAtUnixMs: 0n },
    { schemaVersion: 2 },
  ]) {
    value = { ...groups, ...invalid };
    await rejects(authoringWorkspace(session, signal), ProtocolError);
  }
  equal(calls.every(path => path === WireRoutes.AuthoringWorkspaceGroups), true);
});

test('bounds the complete write frame at one hundred tabs across both groups', () => {
  const tabs = Array.from({ length: 50 }, (_, index) => index + 1);
  const secondaryTabs = Array.from({ length: 50 }, (_, index) => index + 51);
  const value = { ...change, schemaVersion: 3, tabs, secondaryActiveArticleId: 51, secondaryTabs };
  const encoded = encodeFrame(FrameType.AuthoringWorkspaceGroupsCommand, encodeAuthoringWorkspaceGroupsCommand(value));
  equal(encoded.byteLength, WireLimits.MaxAuthoringWorkspaceGroupsCommandFrameBytes);
  deepEqual(decodeAuthoringWorkspaceGroupsCommand(decodeFrame(encoded).payload), value);
});
