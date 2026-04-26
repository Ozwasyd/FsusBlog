import type { MessageItem } from '@/api/message'
import { TimeUtils } from '@/utils/time'

export type UserMessageCategoryContract = Readonly<{
  label: string
  badgeClassName: string
}>

export type UserMessageTimeContract = Readonly<{
  isoTime: string
  smartText: string
  fullText: string
}>

export type UserMessagePreviewContract = Readonly<{
  title: string
  content: string
}>

export type UserMessageActionsContract = Readonly<{
  canMarkRead: boolean
  canDelete: boolean
}>

export type UserMessageItemViewContract = Readonly<{
  id: string
  category: UserMessageCategoryContract
  time: UserMessageTimeContract
  preview: UserMessagePreviewContract
  actions: UserMessageActionsContract
  isRead: boolean
}>

export type UserMessagesHeaderViewContract = Readonly<{
  unreadCount: number
  readAllText: string
  showReadAll: boolean
}>

export type UserMessagesEmptyStateViewContract = Readonly<{
  title: string
}>

export type UserMessagesListFooterViewContract = Readonly<{
  showLoadMoreButton: boolean
  showEndHint: boolean
  loadingMore: boolean
  loadMoreButtonText: string
  endHintText: string
}>

export type UserMessagesPageViewContract = Readonly<{
  header: UserMessagesHeaderViewContract
  items: readonly UserMessageItemViewContract[]
  emptyState: UserMessagesEmptyStateViewContract
  footer: UserMessagesListFooterViewContract
}>

export const userMessagesTokens = {
  categoryBroadcast: 'bg-[#0F0F11] text-white border-[#0F0F11]',
  categoryDefault: 'bg-white text-[#A1A1AA] border-[#E4E4E7]',
  unreadDot: 'w-1.5 h-1.5 rounded-full bg-[#0F0F11] animate-pulse'
} as const

function toCategoryContract(isSystemSource: boolean): UserMessageCategoryContract {
  if (isSystemSource) {
    return {
      label: '系统',
      badgeClassName: userMessagesTokens.categoryBroadcast
    }
  }

  return {
    label: '会话',
    badgeClassName: userMessagesTokens.categoryDefault
  }
}

function toTimeContract(createTime: string): UserMessageTimeContract {
  return {
    isoTime: createTime,
    smartText: TimeUtils.toSmartTime(createTime),
    fullText: TimeUtils.toFullLocalString(createTime)
  }
}

export function createUserMessageItemViewContract(message: MessageItem): UserMessageItemViewContract {
  const subject = message.subject ?? ''
  const preview = message.lastMessage?.bodyPreview ?? ''
  const unread = Number(message.unreadCount ?? 0) > 0

  return {
    id: String(message.conversationId ?? ''),
    category: toCategoryContract(Boolean(message.isSystemSource)),
    time: toTimeContract(message.lastMessageAt),
    preview: {
      title: subject,
      content: preview
    },
    actions: {
      canMarkRead: unread,
      canDelete: false
    },
    isRead: !unread
  }
}

export function createUserMessagesPageViewContract(view: {
  unreadCount: number
  messages: readonly MessageItem[]
  showLoadMoreButton: boolean
  showEndHint: boolean
  loadingMore: boolean
}): UserMessagesPageViewContract {
  const items = view.messages.map((message) => createUserMessageItemViewContract(message))

  return {
    header: {
      unreadCount: view.unreadCount,
      readAllText: '全部标记已读',
      showReadAll: view.unreadCount > 0
    },
    items,
    emptyState: {
      title: '无消息。'
    },
    footer: {
      showLoadMoreButton: view.showLoadMoreButton,
      showEndHint: view.showEndHint,
      loadingMore: view.loadingMore,
      loadMoreButtonText: view.loadingMore ? '同步中...' : '加载更多消息',
      endHintText: '上面的消息已为最后一条消息。'
    }
  }
}
