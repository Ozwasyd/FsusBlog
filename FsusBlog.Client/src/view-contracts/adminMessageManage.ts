import type { MessageItem } from '@/api/message'
import { TimeUtils } from '@/utils/time'

export type AdminMessageMode = 'broadcast' | 'direct'

export type AdminMessageModeOptionContract = Readonly<{
  value: AdminMessageMode
  label: string
}>

export type AdminMessagePreviewContract = Readonly<{
  modeLabel: string
  targetUserText: string
  isEmpty: boolean
  emptyLabel: string
  titleText: string
  contentText: string
}>

export type AdminMessageHistoryItemContract = Readonly<{
  id: string
  categoryLabel: string
  title: string
  createdAtText: string
}>

export type AdminMessageManageViewContract = Readonly<{
  title: string
  adminBadge: string
  safetyNotice: string
  modeLabel: string
  modeOptions: readonly AdminMessageModeOptionContract[]
  targetUserLabel: string
  targetUserPlaceholder: string
  titleLabel: string
  titlePlaceholder: string
  contentLabel: string
  contentPlaceholder: string
  submitText: string
  submitProcessingText: string
  historyTitle: string
  historyRefreshLabel: string
  historyEmptyDescription: string
  revokeConfirmTitle: string
  revokeConfirmContent: string
  revokeConfirmText: string
  revokeCancelText: string
  preview: AdminMessagePreviewContract
  history: readonly AdminMessageHistoryItemContract[]
}>

function createHistoryItem(message: MessageItem): AdminMessageHistoryItemContract {
  return {
    id: String(message.id),
    categoryLabel: message.category === 1 ? '公告' : '私信',
    title: message.title,
    createdAtText: TimeUtils.toFullLocalString(message.createTime)
  }
}

export function createAdminMessageManageViewContract(view: {
  sendType: AdminMessageMode
  targetUserId: string
  title: string
  content: string
  broadcastCooldown: number
  isPowCalculating: boolean
  isProcessing: boolean
  loadingHistory: boolean
  history: readonly MessageItem[]
}): AdminMessageManageViewContract {
  const isBroadcastMode = view.sendType === 'broadcast'
  const isDirectMode = view.sendType === 'direct'
  const previewEmpty = !view.title && !view.content

  return {
    title: '站内信分发中心',
    adminBadge: 'Admin',
    safetyNotice: '安全提示：全站广播及撤回操作属于高危动作，将触发强制算力校验机制。',
    modeLabel: '分发模式',
    modeOptions: [
      { value: 'broadcast', label: '全站公告' },
      { value: 'direct', label: '定向私信' }
    ],
    targetUserLabel: '目标用户 ID (UID)',
    targetUserPlaceholder: '请输入接收者的数字 ID',
    titleLabel: '消息标题',
    titlePlaceholder: '输入消息摘要',
    contentLabel: '消息内容',
    contentPlaceholder: '支持文本分段...',
    submitText: view.isPowCalculating
      ? '安全计算中...'
      : isBroadcastMode && view.broadcastCooldown > 0
      ? `广播冷却中 (${view.broadcastCooldown}s)`
      : isBroadcastMode
        ? '立即全站广播'
        : '确认发送私信',
    submitProcessingText: '安全计算中...',
    historyTitle: '最近分发记录',
    historyRefreshLabel: '刷新历史记录',
    historyEmptyDescription: '暂无发送记录',
    revokeConfirmTitle: '确认撤回此消息？该操作将从全网所有接收者的收件箱中物理抹除记录，并触发算力验证。',
    revokeConfirmContent: '确认撤回此消息？该操作将从全网所有接收者的收件箱中物理抹除记录，并触发算力验证。',
    revokeConfirmText: '强制撤回',
    revokeCancelText: '保留',
    preview: {
      modeLabel: isBroadcastMode ? 'Announcement' : 'Private Notice',
      targetUserText: isDirectMode ? `UID: ${view.targetUserId || '?'}` : '',
      isEmpty: previewEmpty,
      emptyLabel: 'Preview Area',
      titleText: view.title || '标题预览',
      contentText: view.content || '内容预览...'
    },
    history: view.history.map(createHistoryItem)
  }
}
