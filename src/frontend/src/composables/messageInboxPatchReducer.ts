import type {
  ConversationDetailResponse,
  ConversationListItemResponse,
  ConversationMessagePreviewResponse,
  InboxConversationStatusChangedPayload,
  InboxConversationUpsertPayload,
  InboxMessageAppendPayload,
  InboxReadUpdatedPayload
} from '@/api/message'
import { truncateMessagePreview } from '@/contracts/messageContentPolicy'
import { compareConversationByLastMessage } from '@/composables/messageConversationPagination'
import { compareMessageId, mergeConversationMessagePages } from '@/composables/messageThreadPagination'

export type InboxPatchVersion = Readonly<{ eventId?: number, time?: number }>

export type InboxPatchProjection<
  TList extends ConversationListItemResponse,
  TDetail extends ConversationDetailResponse
> = Readonly<{
  conversations: TList[]
  detail: TDetail | null
  targetInList: boolean
  complete: boolean
}>

export const toMessagePreview = (
  message: InboxMessageAppendPayload['message']
): ConversationMessagePreviewResponse => ({
  senderType: message.senderType,
  senderName: message.senderName,
  bodyPreview: truncateMessagePreview(message.body),
  createdAt: message.createdAt
})

export const latestMessageId = (value: ConversationDetailResponse | null): string | null =>
  value?.messages[value.messages.length - 1]?.messageId ?? value?.readSnapshotMessageId ?? null

export const newerMessageId = (left: string, right: string): string =>
  compareMessageId(left, right) >= 0 ? left : right

export const newerTimestamp = (left: string, right: string): string =>
  (Date.parse(left) || 0) >= (Date.parse(right) || 0) ? left : right

export const isOlderPatchVersion = (
  incoming: InboxPatchVersion | undefined,
  current: InboxPatchVersion | null
): boolean => {
  if (!incoming || !current) return false
  if (incoming.eventId !== undefined && current.eventId !== undefined) return incoming.eventId < current.eventId
  if (incoming.time !== undefined && current.time !== undefined) return incoming.time < current.time
  return false
}

export const upsertConversationListItem = <T extends ConversationListItemResponse>(
  items: readonly T[],
  item: T
): T[] => {
  const next = items.slice()
  const existingIndex = next.findIndex((it) => it.conversationId === item.conversationId)
  if (existingIndex >= 0) next.splice(existingIndex, 1)

  const insertIndex = next.findIndex((it) => compareConversationByLastMessage(item, it) < 0)
  if (insertIndex === -1) next.push(item)
  else next.splice(insertIndex, 0, item)
  return next
}

export const reduceConversationUpsert = <
  TList extends ConversationListItemResponse,
  TDetail extends ConversationDetailResponse
>(
  conversations: readonly TList[],
  detail: TDetail | null,
  payload: InboxConversationUpsertPayload,
  allowInsert: boolean
): InboxPatchProjection<TList, TDetail> => {
  const item = payload.conversation
  if (!item?.conversationId) {
    return { conversations: conversations.slice(), detail, targetInList: false, complete: false }
  }
  const index = conversations.findIndex((candidate) => candidate.conversationId === item.conversationId)
  if (index < 0 && !allowInsert) {
    return { conversations: conversations.slice(), detail, targetInList: false, complete: false }
  }
  const current = index >= 0 ? conversations[index]! : null
  if (current && compareConversationByLastMessage(item, current) > 0) {
    return { conversations: conversations.slice(), detail, targetInList: true, complete: true }
  }
  const merged = { ...current, ...item } as TList
  const nextDetail = detail?.conversationId === item.conversationId
    ? {
        ...detail,
        subject: item.subject,
        status: item.status,
        isSystemSource: item.isSystemSource,
        canReply: item.canReply,
        unreadCount: item.unreadCount,
        lastMessageAt: newerTimestamp(item.lastMessageAt, detail.lastMessageAt)
      }
    : detail
  return {
    conversations: upsertConversationListItem(conversations, merged),
    detail: nextDetail,
    targetInList: index >= 0,
    complete: true
  }
}

export const reduceMessageAppend = <
  TList extends ConversationListItemResponse,
  TDetail extends ConversationDetailResponse
>(
  conversations: readonly TList[],
  detail: TDetail | null,
  payload: InboxMessageAppendPayload,
  applyListProjection = true
): InboxPatchProjection<TList, TDetail> => {
  if (!payload?.conversationId || !payload.message) {
    return { conversations: conversations.slice(), detail, targetInList: false, complete: false }
  }
  const index = conversations.findIndex((candidate) => candidate.conversationId === payload.conversationId)
  let nextConversations = conversations.slice()
  const hasBody = payload.message.body.length > 0
  if (index >= 0 && applyListProjection) {
    const current = conversations[index]!
    const patched = {
      ...current,
      lastMessage: hasBody ? toMessagePreview(payload.message) : current.lastMessage,
      lastMessageAt: newerTimestamp(payload.message.createdAt, current.lastMessageAt),
      updatedAt: newerTimestamp(payload.message.createdAt, current.updatedAt),
      unreadCount: payload.conversationUnreadCount ?? current.unreadCount
    } as TList
    nextConversations = upsertConversationListItem(conversations, patched)
  }

  let nextDetail = detail
  if (hasBody && detail?.conversationId === payload.conversationId) {
    const currentLatest = latestMessageId(detail)
    const advances = !currentLatest || compareMessageId(payload.message.messageId, currentLatest) >= 0
    nextDetail = {
      ...detail,
      messages: mergeConversationMessagePages(detail.messages, [payload.message]),
      unreadCount: advances ? payload.conversationUnreadCount ?? detail.unreadCount : detail.unreadCount,
      lastMessageAt: advances
        ? newerTimestamp(payload.message.createdAt, detail.lastMessageAt)
        : detail.lastMessageAt
    }
  }

  return {
    conversations: nextConversations,
    detail: nextDetail,
    targetInList: index >= 0,
    complete: hasBody
  }
}

export const reduceReadUpdated = <
  TList extends ConversationListItemResponse,
  TDetail extends ConversationDetailResponse
>(
  conversations: readonly TList[],
  detail: TDetail | null,
  payload: InboxReadUpdatedPayload
): InboxPatchProjection<TList, TDetail> => {
  const index = conversations.findIndex((candidate) => candidate.conversationId === payload.conversationId)
  const nextConversations = conversations.slice()
  if (index >= 0) {
    nextConversations[index] = {
      ...nextConversations[index]!,
      unreadCount: Math.max(0, payload.conversationUnreadCount)
    }
  }
  const nextDetail = detail?.conversationId === payload.conversationId
    ? {
        ...detail,
        readSnapshotMessageId: payload.lastReadMessageId
          ? newerMessageId(detail.readSnapshotMessageId, payload.lastReadMessageId)
          : detail.readSnapshotMessageId,
        unreadCount: Math.max(0, payload.conversationUnreadCount)
      }
    : detail
  return { conversations: nextConversations, detail: nextDetail, targetInList: index >= 0, complete: true }
}

export const reduceStatusChanged = <
  TList extends ConversationListItemResponse,
  TDetail extends ConversationDetailResponse
>(
  conversations: readonly TList[],
  detail: TDetail | null,
  payload: InboxConversationStatusChangedPayload
): InboxPatchProjection<TList, TDetail> => {
  const index = conversations.findIndex((candidate) => candidate.conversationId === payload.conversationId)
  const nextConversations = conversations.slice()
  if (index >= 0) {
    nextConversations[index] = {
      ...nextConversations[index]!,
      status: payload.status,
      canReply: payload.status !== 2,
      updatedAt: newerTimestamp(payload.time, nextConversations[index]!.updatedAt)
    }
  }
  const nextDetail = detail?.conversationId === payload.conversationId
    ? { ...detail, status: payload.status, canReply: payload.status !== 2 }
    : detail
  return { conversations: nextConversations, detail: nextDetail, targetInList: index >= 0, complete: true }
}
