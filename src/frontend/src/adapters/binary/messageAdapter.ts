import type { BinaryPageResponse as PageResponse, ConversationDetailResponse, ConversationListItemResponse, ConversationMessagePreviewResponse, ConversationMessageResponse } from '@/contracts/binaryApi';
import { createAppError, AppErrorCode } from '@/utils/appError';
import { BinaryReader, readBlobText, readByte, readInt32, readInt64String, readIsoDate64 } from '@/codecs/binary/reader';
import { CONVERSATION_DETAIL_POD_SIZE, CONVERSATION_DETAIL_V2_POD_SIZE, CONVERSATION_LIST_ITEM_POD_SIZE, CONVERSATION_MESSAGE_POD_SIZE, CONVERSATION_MESSAGE_PREVIEW_POD_SIZE } from './types';

export function mapConversationListFromPayload(payload: Uint8Array): PageResponse<ConversationListItemResponse> {
  const reader = new BinaryReader(payload);
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

  return {
    total,
    items: pods.map((pod) => readConversationListItem(pod, blob))
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
    senderType: readInt32(pod, 16) as 0 | 1 | 2,
    senderName: hasSenderName ? readBlobText(pod, blob, 32) : null,
    body: readBlobText(pod, blob, 40),
    createdAt: readIsoDate64(pod, 20)
  };
}
