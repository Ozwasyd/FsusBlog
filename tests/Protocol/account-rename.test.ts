import { equal, rejects } from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { frameResponse } from './fixture-source.ts';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import type { AdminSession } from '../../src/Contracts/admin-identity.ts';
import {
  executeAdminHandleRename,
  validAdminHandle,
  type AdminHandleCommand,
} from '../../src/Contracts/admin-handle.ts';
import {
  readSiteDisplayName,
  updateSiteDisplayName,
  validSiteDisplayName,
} from '../../src/Contracts/site-display-name.ts';
import {
  decodeAdminHandleCommand,
  decodeSiteDisplayNameCommand,
  encodeAdminHandleReceipt,
  encodeSiteDisplayNameState,
  FrameType,
  WireHeaders,
  WireLimits,
  WireRoutes,
} from '../../src/Contracts/wire.generated.ts';

const sessionId = 'c'.repeat(64);
const validProof = 'P'.repeat(43);
const validPermissionSession = 'a'.repeat(64);
const altPermissionSession = 'b'.repeat(64);
const commandId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function activeSession(permissionSession = validPermissionSession): AdminSession {
  return {
    handle: 'dev-admin',
    generation: 2n,
    expiresAt: Date.now() + 60_000,
    appearanceEnabled: true,
    siteConfigEnabled: true,
    permissionSession,
  };
}

function mockFetch(
  t: TestContext,
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

test('validSiteDisplayName enforces trimmed length, byte ceiling, and rejects control characters', () => {
  equal(validSiteDisplayName('林深'), true);
  equal(validSiteDisplayName('  Alice Reader  '), true);
  equal(validSiteDisplayName(''), false);
  equal(validSiteDisplayName('   '), false);
  equal(validSiteDisplayName('hello\nworld'), false);
  equal(validSiteDisplayName('a'.repeat(WireLimits.SiteDisplayNameChars)), true);
  equal(validSiteDisplayName('a'.repeat(WireLimits.SiteDisplayNameChars + 1)), false);
});

test('validAdminHandle matches PostgreSQL admin_principal.handle check constraint', () => {
  equal(validAdminHandle('dev-admin'), true);
  equal(validAdminHandle('a.b_c-1'), true);
  equal(validAdminHandle('a'.repeat(WireLimits.AdminHandleBytes)), true);
  equal(validAdminHandle('a'.repeat(WireLimits.AdminHandleBytes + 1)), false);
  equal(validAdminHandle('Admin'), false);
  equal(validAdminHandle('1admin'), false);
  equal(validAdminHandle('bad handle'), false);
  equal(validAdminHandle(''), false);
});

test('readSiteDisplayName and updateSiteDisplayName round-trip AEDS frames with current session header', async t => {
  let lastRequest: { url: string; method?: string; session?: string; decoded?: string } | undefined;
  mockFetch(t, (url, init) => {
    const headers = new Headers(init?.headers);
    if (init?.method === 'POST') {
      const frame = decodeFrame(new Uint8Array(init.body as ArrayBufferLike), FrameType.SiteDisplayNameCommand);
      const command = decodeSiteDisplayNameCommand(frame.payload);
      lastRequest = { url, method: init.method, session: headers.get(WireHeaders.CurrentSession) ?? undefined, decoded: command.displayName };
      return frameResponse(encodeFrame(FrameType.SiteDisplayNameState, encodeSiteDisplayNameState({ displayName: command.displayName })));
    }
    lastRequest = { url, method: init?.method, session: headers.get(WireHeaders.CurrentSession) ?? undefined };
    return frameResponse(encodeFrame(FrameType.SiteDisplayNameState, encodeSiteDisplayNameState({ displayName: '' })));
  });

  const initial = await readSiteDisplayName(sessionId, new AbortController().signal);
  equal(initial, '');
  equal(lastRequest?.url, WireRoutes.SiteDisplayName);
  equal(lastRequest?.session, sessionId);

  const saved = await updateSiteDisplayName(sessionId, '  林深  ', new AbortController().signal);
  equal(saved, '林深');
  equal(lastRequest?.method, 'POST');
  equal(lastRequest?.decoded, '林深');

  await rejects(() => updateSiteDisplayName(sessionId, '   ', new AbortController().signal), ProtocolError);
});

test('executeAdminHandleRename binds permission session, idempotency key, and rejects tampered receipts', async t => {
  const command: AdminHandleCommand = {
    expectedHandle: 'dev-admin',
    newHandle: 'chief-editor',
    idempotencyKey: commandId,
  };
  let seenHeaders: Headers | undefined;
  let seenDecoded: AdminHandleCommand | undefined;

  mockFetch(t, (_url, init) => {
    seenHeaders = new Headers(init?.headers);
    const frame = decodeFrame(new Uint8Array(init?.body as ArrayBufferLike), FrameType.AdminHandleCommand);
    seenDecoded = decodeAdminHandleCommand(frame.payload);
    return frameResponse(encodeFrame(FrameType.AdminHandleReceipt, encodeAdminHandleReceipt({
      handle: 'chief-editor',
      happenedAtUnixMs: 1_795_000_000_000n,
      replayed: false,
    })), { [WireHeaders.AdminPermissionSession]: validPermissionSession });
  });

  const receipt = await executeAdminHandleRename(activeSession(), command, validProof, new AbortController().signal);
  equal(receipt.handle, 'chief-editor');
  equal(receipt.replayed, false);
  equal(seenDecoded?.expectedHandle, 'dev-admin');
  equal(seenDecoded?.newHandle, 'chief-editor');
  equal(seenHeaders?.get(WireHeaders.ClientMutationId), commandId);
  equal(seenHeaders?.get(WireHeaders.MfaProof), validProof);

  // Reject mismatched permission session binding
  await rejects(
    () => executeAdminHandleRename(activeSession(altPermissionSession), command, validProof, new AbortController().signal),
    ProtocolError,
  );

  // Reject same handle rename
  await rejects(
    () => executeAdminHandleRename(activeSession(), { ...command, newHandle: 'dev-admin' }, validProof, new AbortController().signal),
    ProtocolError,
  );
});
