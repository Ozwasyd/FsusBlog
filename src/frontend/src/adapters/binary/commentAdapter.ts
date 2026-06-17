import type {
  CommentReplyItem,
  CommentThreadItem,
  CursorResponse,
  UserCommentResponse
} from '@/api/comment';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readByte, readCountChecked, readFixedTextNullable, readFixedUtf8, readInt32, readNullableId64, readIsoDate64, readBlobText, readSliceRef, readSliceText } from './reader';
import { readCursorEnvelope } from './envelopeReaders';
import { readReplyItem, readThreadItemFromReader } from './podReaders';
import {
  COMMENT_POLICY_SNAPSHOT_POD_SIZE,
  COMMENT_REPLY_ITEM_POD_SIZE,
  USER_COMMENT_POD_SIZE
} from './types';

export type CommentAuthorMode = 'anonymous' | 'pseudonymous' | 'public' | 'zk_anonymous';

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
