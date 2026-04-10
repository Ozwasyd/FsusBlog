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
  categoryBroadcast: 'bg-zinc-950 text-white border-zinc-950',
  categoryDefault: 'bg-white text-zinc-400 border-zinc-200',
  unreadDot: 'w-1.5 h-1.5 rounded-full bg-zinc-950 animate-pulse'
} as const

function toCategoryContract(category: MessageItem['category']): UserMessageCategoryContract {
  if (category === 1) {
    return {
      label: '公告',
      badgeClassName: userMessagesTokens.categoryBroadcast
    }
  }

  if (category === 2) {
    return {
      label: '系统',
      badgeClassName: userMessagesTokens.categoryDefault
    }
  }

  return {
    label: '管理员通知',
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
  return {
    id: String(message.id),
    category: toCategoryContract(message.category),
    time: toTimeContract(message.createTime),
    preview: {
      title: message.title,
      content: message.content
    },
    actions: {
      canMarkRead: !message.isRead,
      canDelete: message.category !== 1
    },
    isRead: message.isRead
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
