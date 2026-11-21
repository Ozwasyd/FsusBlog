import { encodeFrame, ProtocolError } from './aeds.ts';
import { assertAdminPermissionSession, type AdminSession } from './admin-identity.ts';
import { optionalAdminProofHeaders, proveAdminStepUp } from './admin-step-up.ts';
import { request } from './client.ts';
import {
  decodeAdminReaderAccountPage,
  decodeAdminReaderStatusReceipt,
  encodeAdminReaderStatusCommand,
  FrameType,
  WireHeaders,
  WireLimits,
  WireRoutes,
  type AdminReaderAccount,
  type AdminReaderAccountPage,
  type AdminReaderStatusCommand,
  type AdminReaderStatusReceipt,
} from './wire.generated.ts';

const encoder = new TextEncoder();
const maxDate = 8_640_000_000_000_000n;
const zeroUuid = '00000000-0000-0000-0000-000000000000';

export type { AdminReaderAccount, AdminReaderAccountPage, AdminReaderStatusCommand, AdminReaderStatusReceipt };
export type AdminReaderStatusFilter = 'all' | 'enabled' | 'disabled';
export type AdminReaderCursor = Readonly<{ accountId: number; userId: string }>;
export type AdminReaderQuery = Readonly<{
  status?: AdminReaderStatusFilter;
  keyword?: string;
  after?: AdminReaderCursor;
}>;

export function validReaderGovernanceReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length > 0 && trimmed.length <= WireLimits.AdminReaderReasonChars &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed) &&
    encoder.encode(trimmed).length <= WireLimits.AdminReaderReasonBytes;
}

export function readAdminReaderAccounts(
  session: AdminSession,
  query: AdminReaderQuery,
  signal: AbortSignal,
): Promise<AdminReaderAccountPage> {
  const params = new URLSearchParams();
  if (query.status && query.status !== 'all') params.set('status', query.status);
  const keyword = query.keyword?.trim() ?? '';
  if (keyword) params.set('keyword', keyword);
  if (query.after) {
    params.set('afterAccountId', String(query.after.accountId));
    params.set('afterUserId', query.after.userId);
  }
  const suffix = params.size > 0 ? `?${params}` : '';
  return request(`${WireRoutes.AdminReaderAccounts}${suffix}`, FrameType.AdminReaderAccountPage, (payload, headers) => {
    assertAdminPermissionSession(session, headers);
    return validatePage(decodeAdminReaderAccountPage(payload));
  }, signal);
}

export async function requestReaderStatusProof(command: AdminReaderStatusCommand, signal: AbortSignal): Promise<string> {
  const normalized = normalizeCommand(command);
  return proveAdminStepUp({
    begin: WireRoutes.AdminReaderStatusStepUpBegin,
    complete: WireRoutes.AdminReaderStatusStepUpComplete,
  }, commandFrame(normalized), signal, { [WireHeaders.ClientMutationId]: normalized.idempotencyKey });
}

export async function executeReaderStatusChange(
  session: AdminSession,
  command: AdminReaderStatusCommand,
  proof: string | undefined,
  signal: AbortSignal,
): Promise<AdminReaderStatusReceipt> {
  const normalized = normalizeCommand(command);
  return request(WireRoutes.AdminReaderStatusExecute, FrameType.AdminReaderStatusReceipt, (payload, headers) => {
    assertAdminPermissionSession(session, headers);
    const receipt = decodeAdminReaderStatusReceipt(payload);
    if (receipt.userId !== normalized.userId || receipt.enabled !== normalized.targetEnabled ||
        receipt.generation !== normalized.expectedGeneration + 1n ||
        receipt.revokedSessionCount < 0 || receipt.happenedAtUnixMs <= 0n || receipt.happenedAtUnixMs > maxDate)
      throw new ProtocolError('Invalid administrator reader status receipt.');
    return receipt;
  }, signal, 'POST', commandFrame(normalized), {
    ...optionalAdminProofHeaders(proof),
    [WireHeaders.ClientMutationId]: normalized.idempotencyKey,
  });
}

function normalizeCommand(command: AdminReaderStatusCommand): AdminReaderStatusCommand {
  const reason = command.reason.trim();
  if (!command.userId || command.userId === zeroUuid || command.expectedGeneration <= 0n ||
      !command.idempotencyKey || command.idempotencyKey === zeroUuid || !validReaderGovernanceReason(reason))
    throw new ProtocolError('Invalid administrator reader status command.');
  return { ...command, reason };
}

function commandFrame(command: AdminReaderStatusCommand): Uint8Array<ArrayBuffer> {
  return encodeFrame(FrameType.AdminReaderStatusCommand, encodeAdminReaderStatusCommand(command));
}

function validatePage(page: AdminReaderAccountPage): AdminReaderAccountPage {
  if (page.total < 0 || page.enabledTotal < 0 || page.disabledTotal < 0 ||
      page.total > page.enabledTotal + page.disabledTotal ||
      page.items.length > WireLimits.AdminReaderPageSize || page.nextCursorAccountId < 0 ||
      (page.hasMore ? page.nextCursorUserId === zeroUuid || page.items.length === 0
        : page.nextCursorAccountId !== 0 || page.nextCursorUserId !== zeroUuid))
    throw new ProtocolError('Invalid administrator reader account page.');

  for (const item of page.items) {
    if (!item.userId || item.userId === zeroUuid || item.accountId < 0 || !item.name || item.generation <= 0n ||
        item.passkeyCount < 0 || item.activeSessionCount < 0 || item.commentCount < 0 ||
        item.registeredAtUnixMs < 0n || item.registeredAtUnixMs > maxDate ||
        item.lastUsedAtUnixMs < 0n || item.lastUsedAtUnixMs > maxDate ||
        item.lastGovernanceAtUnixMs < 0n || item.lastGovernanceAtUnixMs > maxDate ||
        (item.lastGovernanceAtUnixMs === 0n
          ? item.lastGovernanceActor.length > 0 || item.lastGovernanceReason.length > 0
          : item.lastGovernanceActor.length === 0 || item.lastGovernanceReason.length === 0))
      throw new ProtocolError('Invalid administrator reader account entry.');
  }
  return page;
}
