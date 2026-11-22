import { encodeFrame, ProtocolError } from './aeds.ts';
import { assertAdminPermissionSession, type AdminSession } from './admin-identity.ts';
import { optionalAdminProofHeaders, proveAdminStepUp } from './admin-step-up.ts';
import { post } from './internal/http-methods.ts';
import {
  decodeAdminHandleReceipt,
  encodeAdminHandleCommand,
  FrameType,
  WireHeaders,
  WireLimits,
  WireRoutes,
  type AdminHandleCommand,
  type AdminHandleReceipt,
} from './wire.generated.ts';

const handlePattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const maxDate = 8_640_000_000_000_000n;
const zeroUuid = '00000000-0000-0000-0000-000000000000';

export type { AdminHandleCommand, AdminHandleReceipt };

export function validAdminHandle(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= WireLimits.AdminHandleBytes && handlePattern.test(trimmed);
}

export async function requestAdminHandleProof(command: AdminHandleCommand, signal: AbortSignal): Promise<string> {
  const normalized = normalizeCommand(command);
  return proveAdminStepUp({
    begin: WireRoutes.AdminHandleStepUpBegin,
    complete: WireRoutes.AdminHandleStepUpComplete,
  }, commandFrame(normalized), signal, { [WireHeaders.ClientMutationId]: normalized.idempotencyKey });
}

export async function executeAdminHandleRename(
  session: AdminSession,
  command: AdminHandleCommand,
  proof: string | undefined,
  signal: AbortSignal,
): Promise<AdminHandleReceipt> {
  const normalized = normalizeCommand(command);
  return post(WireRoutes.AdminHandleExecute, FrameType.AdminHandleReceipt, (payload, headers) => {
    assertAdminPermissionSession(session, headers);
    const receipt = decodeAdminHandleReceipt(payload);
    if (receipt.handle !== normalized.newHandle ||
        receipt.happenedAtUnixMs <= 0n || receipt.happenedAtUnixMs > maxDate)
      throw new ProtocolError('Invalid administrator handle receipt.');
    return receipt;
  }, signal, commandFrame(normalized), {
    ...optionalAdminProofHeaders(proof),
    [WireHeaders.ClientMutationId]: normalized.idempotencyKey,
  });
}

function normalizeCommand(command: AdminHandleCommand): AdminHandleCommand {
  const expectedHandle = command.expectedHandle.trim();
  const newHandle = command.newHandle.trim();
  if (!command.idempotencyKey || command.idempotencyKey === zeroUuid ||
      !validAdminHandle(expectedHandle) || !validAdminHandle(newHandle) ||
      expectedHandle === newHandle)
    throw new ProtocolError('Invalid administrator handle rename command.');
  return { expectedHandle, newHandle, idempotencyKey: command.idempotencyKey };
}

function commandFrame(command: AdminHandleCommand): Uint8Array<ArrayBuffer> {
  return encodeFrame(FrameType.AdminHandleCommand, encodeAdminHandleCommand(command));
}
