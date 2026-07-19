import type {
  AnonymousCommentTicketResponse,
  AnonymousCredentialIssueResponse,
  AnonymousCredentialRevocationArtifact,
  AnonymousCredentialRootSnapshot,
  BlindCredentialIssuerMetadata,
  BlindCredentialIssueResponse,
  AnonymousPrivacyStateSnapshot,
  CommentAuthorMode,
  CommentReplyItem,
  CommentThreadItem,
  CursorResponse,
  UserCommentResponse
} from '@/contracts/binaryApi';
import {
  CommentPolicyContractVersion,
  type CommentPolicySnapshot,
  type DecodedCommentPolicySnapshot
} from '@/contracts/commentPolicy';
import { finalizeCommentPolicySnapshot } from '@/policies/commentPolicy';
import { resolveCommentAuthorView } from '@/utils/commentAuthorView';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readByte, readCountChecked, readFixedUtf8, readInt32, readInt64Number, readNullableId64, readIsoDate64, readBlobText, readSliceRef, readSliceText } from '@/codecs/binary/reader';
import { readCursorEnvelope } from './envelopeReaders';
import { readReplyItem, readThreadItemFromReader } from './podReaders';
import {
  ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
  ANONYMOUS_CREDENTIAL_REVOCATION_ARTIFACT_POD_SIZE,
  ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE,
  BLIND_CREDENTIAL_ISSUER_METADATA_POD_SIZE,
  BLIND_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
  ANONYMOUS_PRIVACY_STATE_SNAPSHOT_POD_SIZE,
  COMMENT_POLICY_SNAPSHOT_POD_SIZE,
  COMMENT_REPLY_ITEM_POD_SIZE,
  USER_COMMENT_POD_SIZE
} from './types';

const ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES = 16 * 1024;
const REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();

type CommentPolicySnapshotLayout = {
  contractVersion: CommentPolicyContractVersion;
  podSize: number;
  commentMaxCharsOffset?: number;
  commentMaxUtf8BytesOffset?: number;
  supportedDisplayLanguagesOffset: number;
  snapshotHashOffset: number;
  unavailableReasonOffset: number;
};

const COMMENT_POLICY_SNAPSHOT_PACKED_LAYOUT: CommentPolicySnapshotLayout = {
  contractVersion: CommentPolicyContractVersion.Current,
  podSize: COMMENT_POLICY_SNAPSHOT_POD_SIZE,
  commentMaxCharsOffset: 9,
  commentMaxUtf8BytesOffset: 13,
  supportedDisplayLanguagesOffset: 17,
  snapshotHashOffset: 25,
  unavailableReasonOffset: 33
};

const COMMENT_POLICY_SNAPSHOT_LEGACY_PADDED_LAYOUT: CommentPolicySnapshotLayout = {
  contractVersion: CommentPolicyContractVersion.LegacyPadded,
  podSize: 48,
  commentMaxCharsOffset: 12,
  commentMaxUtf8BytesOffset: 16,
  supportedDisplayLanguagesOffset: 20,
  snapshotHashOffset: 28,
  unavailableReasonOffset: 36
};

const COMMENT_POLICY_SNAPSHOT_LEGACY_NO_LIMITS_LAYOUT: CommentPolicySnapshotLayout = {
  contractVersion: CommentPolicyContractVersion.LegacyWithoutLimits,
  podSize: 33,
  supportedDisplayLanguagesOffset: 9,
  snapshotHashOffset: 17,
  unavailableReasonOffset: 25
};

export function mapCommentCursorFromPodPayload(payload: Uint8Array): CursorResponse<CommentThreadItem> {
  const reader = new BinaryReader(payload);
  return readCursorEnvelope(reader, () => readThreadItemFromReader(reader), 'comment_thread_cursor_count_invalid', 'comment_thread_cursor_trailing_payload_invalid');
}

export function mapCommentPolicySnapshotFromPayload(payload: Uint8Array): CommentPolicySnapshot {
  let firstError: unknown;
  for (const layout of [
    COMMENT_POLICY_SNAPSHOT_PACKED_LAYOUT,
    COMMENT_POLICY_SNAPSHOT_LEGACY_NO_LIMITS_LAYOUT,
    COMMENT_POLICY_SNAPSHOT_LEGACY_PADDED_LAYOUT
  ]) {
    try {
      const result = tryMapCommentPolicySnapshotFromLayout(payload, layout);
      if (result) return result;
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) throw firstError;
  throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_trailing_payload_invalid');
}

function tryMapCommentPolicySnapshotFromLayout(payload: Uint8Array, layout: CommentPolicySnapshotLayout): CommentPolicySnapshot | null {
  if (payload.byteLength < layout.podSize + 4) {
    return null;
  }

  const blobLength = readInt32(payload, layout.podSize);
  if (blobLength < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_blob_length_invalid');
  }

  const expectedLength = layout.podSize + 4 + blobLength;
  if (expectedLength !== payload.byteLength) {
    return null;
  }

  const pod = payload.subarray(0, layout.podSize);
  const blob = payload.subarray(layout.podSize + 4, expectedLength);
  const decoded: DecodedCommentPolicySnapshot = {
    contractVersion: layout.contractVersion,
    anonymousCommentsEnabled: readBooleanByte(pod, 0, 'comment_policy_snapshot_anonymous_flag_invalid'),
    publicCommentsEnabled: readBooleanByte(pod, 1, 'comment_policy_snapshot_public_flag_invalid'),
    zkAnonymousEnabled: readBooleanByte(pod, 2, 'comment_policy_snapshot_zk_flag_invalid'),
    defaultAuthorMode: decodeCommentAuthorMode(readByte(pod, 3)),
    zkProdEnabled: readBooleanByte(pod, 4, 'comment_policy_snapshot_zk_prod_flag_invalid'),
    zkProdNativeVerifierConfigured: readBooleanByte(pod, 5, 'comment_policy_snapshot_zk_prod_verifier_flag_invalid'),
    zkProdTrustedSetupVerified: readBooleanByte(pod, 6, 'comment_policy_snapshot_zk_prod_setup_flag_invalid'),
    zkProdCredentialRequired: readBooleanByte(pod, 7, 'comment_policy_snapshot_zk_prod_credential_flag_invalid'),
    zkProdCredentialRootReady: readBooleanByte(pod, 8, 'comment_policy_snapshot_zk_prod_root_flag_invalid'),
    commentMaxChars: layout.commentMaxCharsOffset === undefined ? 1000 : readInt32(pod, layout.commentMaxCharsOffset),
    commentMaxUtf8Bytes: layout.commentMaxUtf8BytesOffset === undefined ? 4096 : readInt32(pod, layout.commentMaxUtf8BytesOffset),
    supportedDisplayLanguages: readSliceText(blob, readSliceRef(pod, layout.supportedDisplayLanguagesOffset))
      .split('\n')
      .map(language => language.trim())
      .filter(Boolean),
    snapshotHash: readSliceText(blob, readSliceRef(pod, layout.snapshotHashOffset)),
    zkProdUnavailableReason: readSliceText(blob, readSliceRef(pod, layout.unavailableReasonOffset))
  };
  return finalizeCommentPolicySnapshot(decoded);
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
    issuerPublicKeyId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'anonymous_credential_issue_response_issuer_invalid'),
    issuerSignature: readAnonymousSliceBytes(blob, readSliceRef(pod, 48), 'anonymous_credential_issue_response_signature_invalid')
  };
}

export function mapBlindCredentialIssuerMetadataFromPayload(payload: Uint8Array): BlindCredentialIssuerMetadata {
  const { pod, blob } = readAnonymousPrivacyPayload(
    payload,
    BLIND_CREDENTIAL_ISSUER_METADATA_POD_SIZE,
    'blind_credential_issuer_metadata');
  return {
    credentialEpoch: readInt64Number(pod, 0),
    expiresAtUnixMs: readInt64Number(pod, 8),
    circuitNumericId: readUint32(pod, 16),
    publicInputLayoutVersion: readUint16(pod, 20),
    modulusBytes: readUint16(pod, 22),
    circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 24), 'blind_credential_metadata_circuit_invalid'),
    credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'blind_credential_metadata_level_invalid'),
    schemeId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'blind_credential_metadata_scheme_invalid'),
    issuerPublicKeyId: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'blind_credential_metadata_key_id_invalid'),
    issuerPublicKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 56), 'blind_credential_metadata_key_hash_invalid'),
    subjectPublicKeyInfo: readAnonymousSliceBytes(blob, readSliceRef(pod, 64), 'blind_credential_metadata_spki_invalid')
  };
}

export function mapBlindCredentialIssueResponseFromPayload(payload: Uint8Array): BlindCredentialIssueResponse {
  const { pod, blob } = readAnonymousPrivacyPayload(
    payload,
    BLIND_CREDENTIAL_ISSUE_RESPONSE_POD_SIZE,
    'blind_credential_issue_response');
  return {
    credentialEpoch: readInt64Number(pod, 0),
    expiresAtUnixMs: readInt64Number(pod, 8),
    circuitNumericId: readUint32(pod, 16),
    publicInputLayoutVersion: readUint16(pod, 20),
    circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 24), 'blind_credential_response_circuit_invalid'),
    credentialLevel: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'blind_credential_response_level_invalid'),
    schemeId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'blind_credential_response_scheme_invalid'),
    issuerPublicKeyId: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'blind_credential_response_key_id_invalid'),
    blindSignature: readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'blind_credential_response_signature_invalid')
  };
}

export function mapAnonymousCredentialRootSnapshotFromPayload(payload: Uint8Array): AnonymousCredentialRootSnapshot {
  const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_CREDENTIAL_ROOT_SNAPSHOT_POD_SIZE, 'anonymous_credential_root_snapshot');

  return {
    credentialEpoch: readInt64Number(pod, 0),
    rootExpiresAtUnixMs: readInt64Number(pod, 8),
    rootGraceExpiresAtUnixMs: readInt64Number(pod, 16),
    circuitNumericId: readUint32(pod, 24),
    publicInputLayoutVersion: readUint16(pod, 28),
    zkAnonymousEnabled: readBooleanByte(pod, 30, 'anonymous_credential_root_snapshot_zk_flag_invalid'),
    verifierConfigured: readBooleanByte(pod, 31, 'anonymous_credential_root_snapshot_verifier_flag_invalid'),
    circuitId: readAnonymousSliceText(blob, readSliceRef(pod, 32), 'anonymous_credential_root_snapshot_circuit_invalid'),
    verifyingKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'anonymous_credential_root_snapshot_verifying_key_invalid'),
    issuerPublicKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'anonymous_credential_root_snapshot_issuer_invalid'),
    credentialRoot: readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'anonymous_credential_root_snapshot_root_invalid'),
    revocationRoot: readAnonymousSliceBytes(blob, readSliceRef(pod, 64), 'anonymous_credential_root_snapshot_revocation_invalid'),
    circuitMetadata: readAnonymousSliceBytes(blob, readSliceRef(pod, 72), 'anonymous_credential_root_snapshot_metadata_invalid')
  };
}

export function mapAnonymousCredentialRevocationArtifactFromPayload(payload: Uint8Array): AnonymousCredentialRevocationArtifact {
  const { pod, blob } = readAnonymousPrivacyPayload(
    payload,
    ANONYMOUS_CREDENTIAL_REVOCATION_ARTIFACT_POD_SIZE,
    'anonymous_credential_revocation_artifact',
    REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
  const entryCount = readUint32(pod, 32);
  const pathDepth = readUint16(pod, 36);
  const kind = readByte(pod, 38);
  const revocationRoot = readAnonymousSliceBytes(blob, readSliceRef(pod, 56), 'anonymous_credential_revocation_artifact_root_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
  const contentHash = readAnonymousSliceBytes(blob, readSliceRef(pod, 64), 'anonymous_credential_revocation_artifact_hash_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
  const signature = readAnonymousSliceBytes(blob, readSliceRef(pod, 72), 'anonymous_credential_revocation_artifact_signature_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
  const entryHashes = readAnonymousSliceBytes(blob, readSliceRef(pod, 80), 'anonymous_credential_revocation_artifact_entries_invalid', REVOCATION_ARTIFACT_MAX_PAYLOAD_BYTES);
  if ((kind !== 1 && kind !== 2) || pathDepth !== 128 ||
    revocationRoot.byteLength !== 32 || contentHash.byteLength !== 32 || signature.byteLength !== 32 ||
    entryHashes.byteLength !== entryCount * 32) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'anonymous_credential_revocation_artifact_shape_invalid');
  }

  return {
    credentialEpoch: readInt64Number(pod, 0),
    version: readInt64Number(pod, 8),
    baseVersion: readInt64Number(pod, 16),
    expiresAtUnixMs: readInt64Number(pod, 24),
    kind,
    algorithmId: readAnonymousSliceText(blob, readSliceRef(pod, 40), 'anonymous_credential_revocation_artifact_algorithm_invalid'),
    pathDepth,
    issuerPublicKeyHash: readAnonymousSliceText(blob, readSliceRef(pod, 48), 'anonymous_credential_revocation_artifact_issuer_invalid'),
    revocationRoot,
    contentHash,
    signature,
    entryHashes
  };
}

export function mapAnonymousCommentTicketResponseFromPayload(payload: Uint8Array): AnonymousCommentTicketResponse {
  const { pod, blob } = readAnonymousPrivacyPayload(payload, ANONYMOUS_COMMENT_TICKET_RESPONSE_POD_SIZE, 'anonymous_comment_ticket_response');

  return {
    ticketExpiresAtUnixMs: readInt64Number(pod, 0),
    rateClass: readAnonymousSliceText(blob, readSliceRef(pod, 12), 'anonymous_comment_ticket_response_rate_class_invalid') as 'common' | 'unknown',
    requiresModeration: readByte(pod, 8) === 1,
    ticket: readAnonymousSliceBytes(blob, readSliceRef(pod, 20), 'anonymous_comment_ticket_response_ticket_invalid'),
    moderationSubjectHash: readAnonymousSliceBytes(blob, readSliceRef(pod, 28), 'anonymous_comment_ticket_response_moderation_hash_invalid')
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
        ...readUserCommentAuthors(pod, blob),
        moderationStatus: readInt32(pod, 292),
        isPubliclyVisible: readByte(pod, 296) === 1,
        visibilityState: readFixedUtf8(pod, 300, 32),
        visibilityReasonCode: readFixedUtf8(pod, 332, 64),
        moderationStatusLabel: readFixedUtf8(pod, 396, 64)
      };
    },
    'user_comment_cursor_count_invalid',
    'user_comment_cursor_trailing_payload_invalid'
  );
}

function readUserCommentAuthors(pod: Uint8Array, blob: Uint8Array): Pick<UserCommentResponse, 'author' | 'replyToAuthor'> {
  const content = readSliceRef(pod, 20);
  let offset = content.offset + content.length;
  const authorPayload = readEmbeddedPayload(blob, offset, 'user_comment_author_contract_missing');
  offset = authorPayload.nextOffset;
  if (authorPayload.payload.byteLength === 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'user_comment_author_contract_missing');
  }

  const replyPayload = readEmbeddedPayload(blob, offset, 'user_comment_reply_author_contract_missing');
  if (replyPayload.nextOffset !== blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'user_comment_author_trailing_payload_invalid');
  }

  return {
    author: readCommentAuthorViewPayload(authorPayload.payload, 'user_comment_author_contract_missing'),
    replyToAuthor: replyPayload.payload.byteLength === 0
      ? null
      : readCommentAuthorViewPayload(replyPayload.payload, 'user_comment_reply_author_contract_missing')
  };
}

function readEmbeddedPayload(blob: Uint8Array, offset: number, errorCode: string): { payload: Uint8Array; nextOffset: number } {
  if (offset < 0 || offset + 4 > blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  const length = readInt32(blob, offset);
  const payloadOffset = offset + 4;
  const nextOffset = payloadOffset + length;
  if (length < 0 || nextOffset > blob.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return { payload: blob.subarray(payloadOffset, nextOffset), nextOffset };
}

function readCommentAuthorViewPayload(payload: Uint8Array, errorCode: string): UserCommentResponse['author'] {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(36);
  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return resolveCommentAuthorView({
    author: {
      mode: decodeEmbeddedCommentAuthorMode(readByte(pod, 0), errorCode),
      displayName: readSliceText(blob, readSliceRef(pod, 4)),
      displayLanguage: readSliceText(blob, readSliceRef(pod, 12)) === 'en' ? 'en' : 'zh-CN',
      badge: nullableAuthorField(readSliceText(blob, readSliceRef(pod, 20))),
      scopeLabel: nullableAuthorField(readSliceText(blob, readSliceRef(pod, 28)))
    }
  });
}

function decodeEmbeddedCommentAuthorMode(raw: number, errorCode: string): UserCommentResponse['author']['mode'] {
  if (raw === 0 || raw === 1) return 'legacy_server_visible_pseudonymous';
  if (raw === 3) return 'public';
  if (raw === 4) return 'zk_anonymous';
  throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
}

function nullableAuthorField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBooleanByte(pod: Uint8Array, offset: number, errorCode: string): boolean {
  const value = readByte(pod, offset);
  if (value > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return value === 1;
}

function readAnonymousPrivacyPayload(payload: Uint8Array, podSize: number, errorPrefix: string, maxPayloadBytes = ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES): { pod: Uint8Array; blob: Uint8Array } {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(podSize);
  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, `${errorPrefix}_trailing_payload_invalid`);
  }

  if (blob.byteLength > maxPayloadBytes) {
    throw createAppError(AppErrorCode.ProtocolFailure, `${errorPrefix}_payload_oversized`);
  }

  return { pod, blob };
}

function readAnonymousSliceBytes(blob: Uint8Array, slice: { offset: number; length: number }, errorCode: string, maxPayloadBytes = ANONYMOUS_PRIVACY_MAX_PAYLOAD_BYTES): Uint8Array {
  if (slice.offset < 0 || slice.length < 0 || slice.length > maxPayloadBytes || slice.offset + slice.length > blob.byteLength) {
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
    case 3:
      return 'public';
    case 4:
      return 'zk_anonymous';
    default:
      throw createAppError(AppErrorCode.ProtocolFailure, 'comment_policy_snapshot_author_mode_invalid');
  }
}
