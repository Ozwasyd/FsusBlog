import type {
  AnonymousCommentTicketResponse,
  AnonymousCredentialIssueResponse,
  AnonymousCredentialRootSnapshot,
  AnonymousPrivacyStateSnapshot,
  CommentReplyItem,
  CommentThreadItem,
  CursorResponse,
  UserCommentResponse
} from '@/api/comment';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readByte, readCountChecked, readFixedTextNullable, readFixedUtf8, readInt32, readInt64Number, readNullableId64, readIsoDate64, readBlobText, readSliceRef, readSliceText } from './reader';
import { readCursorEnvelope } from './envelopeReaders';
import { readReplyItem, readThreadItemFromReader } from './podReaders';
import {
  ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE,
  ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE,
  COMMENT_POLICY_SNAPSHOT_POD_SIZE,
  COMMENT_REPLY_ITEM_POD_SIZE,
  USER_COMMENT_POD_SIZE
} from './types';

export type CommentAuthorMode = 'anonymous' | 'pseudonymous' | 'public' | 'zk_anonymous';
const ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES = 16 * 1024;
const decoder = new TextDecoder();

export type CommentPolicySnapshot = {
  anonymousCommentsEnabled: boolean;
  publicCommentsEnabled: boolean;
  zkAnonymousEnabled: boolean;
  defaultAuthorMode: CommentAuthorMode;
  supportedDisplayLanguages: string[];
};

export function mapCommentCursorFromPodPayload(payload: Uint8Array): CursorResponse<CommentThreadItem> {
  const reader = new BinaryReader(payload);
  return readCursorEnvelope(reader, () => readThreadItemFromReader(reader), 'comment_thread_cursor_count_invalid', 'comment_thread_cursor_trailing_payload_invalid');
}

export function mapCommentPolicySnapshotFromPayload(payload: Uint8Array): CommentPolicySnapshot {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(COMMENT_POLICY_SNAPSHOT_POD_SIZE);
  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_trailing_payload_invalid');
  }

  return {
    anonymousCommentsEnabled: readBooleanByte(pod, 0, 'comment_policy_snapshot_anonymous_flag_invalid'),
    publicCommentsEnabled: readBooleanByte(pod, 1, 'comment_policy_snapshot_public_flag_invalid'),
    zkAnonymousEnabled: readBooleanByte(pod, 2, 'comment_policy_snapshot_zk_flag_invalid'),
    defaultAuthorMode: decodeCommentAuthorMode(readByte(pod, 3)),
    supportedDisplayLanguages: readSliceText(blob, readSliceRef(pod, 4))
      .split('\n')
      .map(language => language.trim())
      .filter(Boolean)
  };
}

export function mapAnonymousCredentialIssueResponseFromPayload(payload: Uint8Array): AnonymousCredentialIssueResponse {
  const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE, 'anonymous_credential_issue_response');

  return {
    credentialEpoch: readInt64Number(pod, 0),
    rootExpiresAtUnixMs: readInt64Number(pod, 8),
    circuitNumericId: readUint32(pod, 16),
    publicInputLayoutVersion: readUint16(pod, 20),
    circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 24), 'anonymous_credential_issue_response_circuit_invalid'),
    credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'anonymous_credential_issue_response_level_invalid'),
    issuerResponse: readAnonymousSliceBytes(blob, readSliceRef(pod, 40), 'anonymous_credential_issue_response_issuer_invalid'),
    credentialCommitment: readAnonymousSliceBytes(blob, readSliceRef(pod, 48), 'anonymous_credential_issue_response_commitment_invalid')
  };
}

export function mapAnonymousCredentialRootSnapshotFromPayload(payload: Uint8Array): AnonymousCredentialRootSnapshot {
  const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE, 'anonymous_credential_root_snapshot');

  return {
    credentialEpoch: readInt64Number(pod, 0),
    rootExpiresAtUnixMs: readInt64Number(pod, 8),
    circuitNumericId: readUint32(pod, 16),
    publicInputLayoutVersion: readUint16(pod, 20),
    circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 24), 'anonymous_credential_root_snapshot_circuit_invalid'),
    verifyingKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'anonymous_credential_root_snapshot_verifying_key_invalid'),
    credentialRoot: readAnonymousSliceBytes(blob, readSliceRef(pod, 40), 'anonymous_credential_root_snapshot_root_invalid'),
    revocationRoot: readAnonymousSliceBytes(blob, readSliceRef(pod, 48), 'anonymous_credential_root_snapshot_revocation_invalid'),
    circuitMetadata: readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'anonymous_credential_root_snapshot_metadata_invalid')
  };
}

export function mapAnonymousCommentTicketResponseFromPayload(payload: Uint8Array): AnonymousCommentTicketResponse {
  const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE, 'anonymous_comment_ticket_response');

  return {
    credentialEpoch: readInt64Number(pod, 0),
    ticketExpiresAtUnixMs: readInt64Number(pod, 8),
    credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 16), 'anonymous_comment_ticket_response_level_invalid'),
    ticket: readAnonymousSliceBytes(blob, readSliceRef(pod, 24), 'anonymous_comment_ticket_response_ticket_invalid'),
    moderationSubjectHash: readAnonymousSliceBytes(blob, readSliceRef(pod, 32), 'anonymous_comment_ticket_response_moderation_hash_invalid'),
    anonymousNullifierHash: readAnonymousSliceBytes(blob, readSliceRef(pod, 40), 'anonymous_comment_ticket_response_nullifier_invalid')
  };
}

export function mapAnonymousPrivacyStateSnapshotFromPayload(payload: Uint8Array): AnonymousPrivacyStateSnapshot {
  const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE, 'anonymous_privacy_state_snapshot');

  return {
    credentialEpoch: readInt64Number(pod, 0),
    rootExpiresAtUnixMs: readInt64Number(pod, 8),
    ticketExpiresAtUnixMs: readInt64Number(pod, 16),
    circuitNumericId: readUint32(pod, 24),
    publicInputLayoutVersion: readUint16(pod, 28),
    hasActiveCredential: readBooleanByte(pod, 30, 'anonymous_privacy_state_active_flag_invalid'),
    canIssueCredential: readBooleanByte(pod, 31, 'anonymous_privacy_state_issue_flag_invalid'),
    canSubmitAnonymousComment: readBooleanByte(pod, 32, 'anonymous_privacy_state_submit_flag_invalid'),
    circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 34), 'anonymous_privacy_state_circuit_invalid'),
    verifyingKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 42), 'anonymous_privacy_state_verifying_key_invalid'),
    credentialStatus: readAnonymousSliceText(blob, readSliceRef(pod, 50), 'anonymous_privacy_state_status_invalid'),
    credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 58), 'anonymous_privacy_state_level_invalid')
  };
}

export function mapThreadReplyCursorFromPodPayload(payload: Uint8Array): CursorResponse<CommentReplyItem> {
  const reader = new BinaryReader(payload);
  const rootIdRaw = reader.readInt64();
  const nextCursorRaw = reader.readInt64();
  const hasMore = reader.readByte() === 1;
  const count = readCountChecked(reader, 'comment_reply_cursor_count_invalid');
  const data: CommentReplyItem[] = [];

  for (let i = 0; i < count; i++) {
    const pod = reader.readSpan(COMMENT_REPLY_ITEM_POD_SIZE);
    const blob = reader.readBlob();
    const reply = readReplyItem(pod, blob);
    if (!reply.rootId || reply.rootId === '0') {
      reply.rootId = String(rootIdRaw);
    }
    data.push(reply);
  }

  return {
    data,
    nextCursor: nextCursorRaw === 0 ? null : String(nextCursorRaw),
    hasMore
  };
}

export function mapUserCommentCursorFromPodPayload(payload: Uint8Array): CursorResponse<UserCommentResponse> {
  const reader = new BinaryReader(payload);
  return readCursorEnvelope(
    reader,
    () => {
      const pod = reader.readSpan(USER_COMMENT_POD_SIZE);
      const blob = reader.readBlob();
      return {
        id: readNullableId64(pod, 0) ?? '0',
        articleId: readInt32(pod, 8),
        createTime: readIsoDate64(pod, 12),
        content: readBlobText(pod, blob, 20),
        articleTitle: readFixedUtf8(pod, 28, 256),
        rootId: readNullableId64(pod, 284),
        replyToUserName: readFixedTextNullable(pod, 292, 64),
        moderationStatus: readInt32(pod, 356),
        isPubliclyVisible: readByte(pod, 360) === 1,
        visibilityState: readFixedUtf8(pod, 364, 32),
        visibilityReasonCode: readFixedUtf8(pod, 396, 64),
        moderationStatusLabel: readFixedUtf8(pod, 460, 64)
      };
    },
    'user_comment_cursor_count_invalid',
    'user_comment_cursor_trailing_payload_invalid'
  );
}

function readBooleanByte(pod: Uint8Array, offset: number, errorCode: string): boolean {
  const value = readByte(pod, offset);
  if (value > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return value === 1;
}

function readAnonymousPrivacyPayload(payload: Uint8Array, podSize: number, errorPrefix: string): { pod: Uint8Array; blob: Uint8Array } {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(podSize);
  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, `${errorPrefix}_trailing_payload_invalid`);
  }

  if (blob.byteLength > ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES) {
    throw createAppError(AppErrorCode.ProtocolFailure, `${errorPrefix}_payload_oversized`);
  }

  return { pod, blob };
}

function readAnonymousSliceBytes(blob: Uint8Array, slice: { offset: number; length: number }, errorCode: string): Uint8Array {
  if (slice.offset < 0 || slice.length < 0 || slice.length > ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES || slice.offset + slice.length > blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return blob.slice(slice.offset, slice.offset + slice.length);
}

function readAnonymousSliceText(blob: Uint8Array, slice: { offset: number; length: number }, errorCode: string): string {
  return decoder.decode(readAnonymousSliceBytes(blob, slice, errorCode));
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>> 0
  );
}

function decodeCommentAuthorMode(value: number): CommentAuthorMode {
  switch (value) {
    case 0:
    case 1:
      return 'anonymous';
    case 2:
      return 'pseudonymous';
    case 3:
      return 'public';
    case 4:
      return 'zk_anonymous';
    default:
      throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_author_mode_invalid');
  }
}
