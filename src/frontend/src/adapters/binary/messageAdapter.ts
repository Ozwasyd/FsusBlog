import type { AdminConversationDetailResponse, AdminConversationListItemResponse, BinaryPageResponse as PageResponse, ConversationDetailResponse, ConversationListItemResponse, ConversationMessagePreviewResponse, ConversationMessageResponse } from '@/contracts/binaryApi';
import { createAppError, AppErrorCode } from '@/utils/appError';
import { BinaryReader, readBlobText, readByte, readInt32, readInt64String, readIsoDate64 } from '@/codecs/binary/reader';
import { ADMIN_CONVERSATION_DETAIL_POD_SIZE, ADMIN_CONVERSATION_LIST_ITEM_POD_SIZE, CONVERSATION_DETAIL_POD_SIZE, CONVERSATION_DETAIL_V2_POD_SIZE, CONVERSATION_DETAIL_V3_POD_SIZE, CONVERSATION_LIST_ITEM_POD_SIZE, CONVERSATION_MESSAGE_POD_SIZE, CONVERSATION_MESSAGE_PREVIEW_POD_SIZE } from './types';

const CONVERSATION_LIST_CURSOR_ENVELOPE_MAGIC = 0x4D534743;
const CONVERSATION_LIST_CURSOR_ENVELOPE_VERSION = 1;
const CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE = 17;

export function mapConversationListFromPayload(payload: Uint8Array): PageResponse<ConversationListItemResponse> {
  let payloadBody = payload;
  let hasMore = false;
  let nextCursorPod: Uint8Array | null = null;
  if (payload.byteLength >= CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE &&
      readInt32(payload, 0) === CONVERSATION_LIST_CURSOR_ENVELOPE_MAGIC) {
    const version = readInt32(payload, 4);
    if (version !== CONVERSATION_LIST_CURSOR_ENVELOPE_VERSION || payload[8]! > 1) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_list_cursor_envelope_invalid');
    }

    hasMore = payload[8] === 1;
    nextCursorPod = payload.subarray(9, CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE);
    payloadBody = payload.subarray(CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE);
  }

  const reader = new BinaryReader(payloadBody);
  const total = reader.readInt32();
  const count = reader.readInt32();
  if (total < 0 || count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_list_count_invalid');
  }

  const pods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    pods.push(reader.readSpan(CONVERSATION_LIST_ITEM_POD_SIZE));
  }
  const blob = reader.readBlob();

  const nextCursor = hasMore && nextCursorPod ? readBlobText(nextCursorPod, blob, 0) : null;
  if (hasMore && !nextCursor) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_list_next_cursor_missing');
  }

  return {
    total,
    items: pods.map((pod) => readConversationListItem(pod, blob)),
    nextCursor,
    hasMore
  };
}

export function mapAdminConversationListFromPayload(payload: Uint8Array): PageResponse<AdminConversationListItemResponse> {
  let payloadBody = payload;
  let hasMore = false;
  let nextCursorPod: Uint8Array | null = null;
  if (payload.byteLength >= CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE &&
      readInt32(payload, 0) === CONVERSATION_LIST_CURSOR_ENVELOPE_MAGIC) {
    const version = readInt32(payload, 4);
    if (version !== CONVERSATION_LIST_CURSOR_ENVELOPE_VERSION || payload[8]! > 1) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'admin_conversation_list_cursor_envelope_invalid');
    }

    hasMore = payload[8] === 1;
    nextCursorPod = payload.subarray(9, CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE);
    payloadBody = payload.subarray(CONVERSATION_LIST_CURSOR_ENVELOPE_SIZE);
  }

  const reader = new BinaryReader(payloadBody);
  const total = reader.readInt32();
  const count = reader.readInt32();
  if (total < 0 || count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'admin_conversation_list_count_invalid');
  }

  const pods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    pods.push(reader.readSpan(ADMIN_CONVERSATION_LIST_ITEM_POD_SIZE));
  }
  const blob = reader.readBlob();
  const nextCursor = hasMore && nextCursorPod ? readBlobText(nextCursorPod, blob, 0) : null;
  if (hasMore && !nextCursor) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'admin_conversation_list_next_cursor_missing');
  }

  return {
    total,
    items: pods.map((pod) => {
      const conversation = readConversationListItem(pod.subarray(0, CONVERSATION_LIST_ITEM_POD_SIZE), blob);
      const counterpartyAccountId = readInt64String(pod, CONVERSATION_LIST_ITEM_POD_SIZE);
      const counterpartyAccountStatus = readInt32(pod, CONVERSATION_LIST_ITEM_POD_SIZE + 8) as 0 | 1 | 2 | 3;
      if (counterpartyAccountStatus < 0 ||
          counterpartyAccountStatus > 3 ||
          (counterpartyAccountId === '0' && counterpartyAccountStatus !== 3)) {
        throw createAppError(AppErrorCode.ProtocolFailure, 'admin_conversation_projection_invalid');
      }

      return {
        ...conversation,
        counterpartyAccountId,
        counterpartyAccountStatus
      };
    }),
    nextCursor,
    hasMore
  };
}

export function mapConversationDetailFromPayload(payload: Uint8Array): ConversationDetailResponse {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(CONVERSATION_DETAIL_POD_SIZE);
  const count = reader.readInt32();
  if (count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_message_count_invalid');
  }

  const messagePods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
  }
  const blob = reader.readBlob();

  return {
    conversationId: readInt64String(pod, 0),
    readSnapshotMessageId: '',
    subject: readBlobText(pod, blob, 28),
    status: readInt32(pod, 8) as 0 | 1 | 2,
    isSystemSource: readByte(pod, 24) === 1,
    canReply: readByte(pod, 25) === 1,
    unreadCount: readInt32(pod, 12),
    lastMessageAt: readIsoDate64(pod, 16),
    messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob))
  };
}

export function mapConversationDetailV2FromPayload(payload: Uint8Array): ConversationDetailResponse {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(CONVERSATION_DETAIL_V2_POD_SIZE);
  const count = reader.readInt32();
  if (count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_message_count_invalid');
  }

  const readSnapshotMessageId = readInt64String(pod, 24);
  if (readSnapshotMessageId === '0') {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_read_snapshot_invalid');
  }

  const messagePods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
  }
  const blob = reader.readBlob();

  return {
    conversationId: readInt64String(pod, 0),
    idempotencyReplay: readByte(pod, 34) === 1,
    readSnapshotMessageId,
    subject: readBlobText(pod, blob, 36),
    status: readInt32(pod, 8) as 0 | 1 | 2,
    isSystemSource: readByte(pod, 32) === 1,
    canReply: readByte(pod, 33) === 1,
    unreadCount: readInt32(pod, 12),
    lastMessageAt: readIsoDate64(pod, 16),
    messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob))
  };
}

export function mapConversationDetailV3FromPayload(payload: Uint8Array): ConversationDetailResponse {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(CONVERSATION_DETAIL_V3_POD_SIZE);
  const count = reader.readInt32();
  if (count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_message_count_invalid');
  }

  const readSnapshotMessageId = readInt64String(pod, 24);
  const previousCursorValue = readInt64String(pod, 32);
  const hasOlder = readByte(pod, 42) === 1;
  if (readSnapshotMessageId === '0' || hasOlder !== (previousCursorValue !== '0')) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'conversation_message_cursor_invalid');
  }

  const messagePods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
  }
  const blob = reader.readBlob();

  return {
    conversationId: readInt64String(pod, 0),
    readSnapshotMessageId,
    previousCursor: hasOlder ? previousCursorValue : null,
    hasOlder,
    subject: readBlobText(pod, blob, 44),
    status: readInt32(pod, 8) as 0 | 1 | 2,
    isSystemSource: readByte(pod, 40) === 1,
    canReply: readByte(pod, 41) === 1,
    unreadCount: readInt32(pod, 12),
    lastMessageAt: readIsoDate64(pod, 16),
    messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob))
  };
}

export function mapAdminConversationDetailFromPayload(payload: Uint8Array): AdminConversationDetailResponse {
  const reader = new BinaryReader(payload);
  const adminPod = reader.readSpan(ADMIN_CONVERSATION_DETAIL_POD_SIZE);
  const pod = adminPod.subarray(0, CONVERSATION_DETAIL_V3_POD_SIZE);
  const count = reader.readInt32();
  if (count < 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'admin_conversation_message_count_invalid');
  }

  const readSnapshotMessageId = readInt64String(pod, 24);
  const previousCursorValue = readInt64String(pod, 32);
  const hasOlder = readByte(pod, 42) === 1;
  const counterpartyAccountId = readInt64String(adminPod, CONVERSATION_DETAIL_V3_POD_SIZE);
  const counterpartyAccountStatus = readInt32(adminPod, CONVERSATION_DETAIL_V3_POD_SIZE + 8) as 0 | 1 | 2 | 3;
  if (readSnapshotMessageId === '0' ||
      hasOlder !== (previousCursorValue !== '0') ||
      counterpartyAccountStatus < 0 ||
      counterpartyAccountStatus > 3 ||
      (counterpartyAccountId === '0' && counterpartyAccountStatus !== 3)) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'admin_conversation_projection_invalid');
  }

  const messagePods: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    messagePods.push(reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE));
  }
  const blob = reader.readBlob();
  return {
    conversationId: readInt64String(pod, 0),
    readSnapshotMessageId,
    previousCursor: hasOlder ? previousCursorValue : null,
    hasOlder,
    subject: readBlobText(pod, blob, 44),
    status: readInt32(pod, 8) as 0 | 1 | 2,
    isSystemSource: readByte(pod, 40) === 1,
    canReply: readByte(pod, 41) === 1,
    unreadCount: readInt32(pod, 12),
    lastMessageAt: readIsoDate64(pod, 16),
    messages: messagePods.map((messagePod) => readConversationMessage(messagePod, blob)),
    counterpartyAccountId,
    counterpartyAccountStatus
  };
}

export function mapConversationMessageFromPayload(payload: Uint8Array): ConversationMessageResponse {
  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(CONVERSATION_MESSAGE_POD_SIZE);
  const blob = reader.readBlob();
  return readConversationMessage(pod, blob);
}

function readConversationListItem(pod: Uint8Array, blob: Uint8Array): ConversationListItemResponse {
  const hasLastMessage = readByte(pod, 34) === 1;
  const lastMessagePod = pod.subarray(44, 44 + CONVERSATION_MESSAGE_PREVIEW_POD_SIZE);
  return {
    conversationId: readInt64String(pod, 0),
    subject: readBlobText(pod, blob, 36),
    status: readInt32(pod, 8) as 0 | 1 | 2,
    isSystemSource: readByte(pod, 32) === 1,
    canReply: readByte(pod, 33) === 1,
    unreadCount: readInt32(pod, 12),
    lastMessageAt: readIsoDate64(pod, 16),
    updatedAt: readIsoDate64(pod, 24),
    lastMessage: hasLastMessage ? readConversationPreview(lastMessagePod, blob) : null
  };
}

function readConversationPreview(pod: Uint8Array, blob: Uint8Array): ConversationMessagePreviewResponse {
  const hasSenderName = readByte(pod, 12) === 1;
  return {
    senderType: readInt32(pod, 0) as 0 | 1 | 2,
    senderName: hasSenderName ? readBlobText(pod, blob, 16) : null,
    bodyPreview: readBlobText(pod, blob, 24),
    createdAt: readIsoDate64(pod, 4)
  };
}

function readConversationMessage(pod: Uint8Array, blob: Uint8Array): ConversationMessageResponse {
  const hasSenderName = readByte(pod, 28) === 1;
  return {
    messageId: readInt64String(pod, 0),
    conversationId: readInt64String(pod, 8),
    idempotencyReplay: readByte(pod, 29) === 1,
    senderType: readInt32(pod, 16) as 0 | 1 | 2,
    senderName: hasSenderName ? readBlobText(pod, blob, 32) : null,
    body: readBlobText(pod, blob, 40),
    createdAt: readIsoDate64(pod, 20)
  };
}
