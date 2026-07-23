export const NotificationStreamRestartCloseCode = 1012
export const NotificationStreamReplayMissedCloseCode = 4009
export const NotificationStreamReplayRequiredCloseCode = 4010
export const NotificationStreamFullResyncRequiredCloseCode = 4011

export const NotificationStreamRestartReason = 'fsus_service_restart'
export const NotificationStreamReplayMissedReason = 'fsus_replay_miss'
export const NotificationStreamReplayRequiredReason = 'fsus_replay_required'
export const NotificationStreamFullResyncRequiredReason = 'fsus_full_resync_required'

const MIN_FAST_RECONNECT_DELAY_MS = 250
const MAX_FAST_RECONNECT_DELAY_MS = 1250

export type NotificationStreamCloseRecovery = Readonly<{
  kind: 'service_restart' | 'replay_missed' | 'replay_required' | 'full_resync_required'
  preserveCursor: boolean
  requireFullResync: boolean
  reconnectDelayMs: number
}>

export function resolveNotificationStreamCloseRecovery(
  closeCode: number,
  reason = '',
  random: () => number = Math.random
): NotificationStreamCloseRecovery | null {
  if (closeCode === NotificationStreamReplayMissedCloseCode || reason === NotificationStreamReplayMissedReason) {
    return {
      kind: 'replay_missed',
      preserveCursor: false,
      requireFullResync: true,
      reconnectDelayMs: fastReconnectDelay(random)
    }
  }

  if (
    closeCode === NotificationStreamReplayRequiredCloseCode
    || reason === NotificationStreamReplayRequiredReason
    || reason.startsWith(`${NotificationStreamReplayRequiredReason}:`)
  ) {
    return {
      kind: 'replay_required',
      preserveCursor: true,
      requireFullResync: false,
      reconnectDelayMs: fastReconnectDelay(random)
    }
  }

  if (
    closeCode === NotificationStreamFullResyncRequiredCloseCode
    || reason === NotificationStreamFullResyncRequiredReason
    || reason.startsWith(`${NotificationStreamFullResyncRequiredReason}:`)
  ) {
    return {
      kind: 'full_resync_required',
      preserveCursor: false,
      requireFullResync: true,
      reconnectDelayMs: fastReconnectDelay(random)
    }
  }

  if (closeCode === NotificationStreamRestartCloseCode || reason === NotificationStreamRestartReason) {
    return {
      kind: 'service_restart',
      preserveCursor: true,
      requireFullResync: false,
      reconnectDelayMs: fastReconnectDelay(random)
    }
  }

  return null
}

function fastReconnectDelay(random: () => number): number {
  const sample = Math.max(0, Math.min(1, random()))
  return MIN_FAST_RECONNECT_DELAY_MS
    + Math.floor(sample * (MAX_FAST_RECONNECT_DELAY_MS - MIN_FAST_RECONNECT_DELAY_MS))
}
