export const NotificationStreamRestartCloseCode = 1012
export const NotificationStreamReplayMissedCloseCode = 4009

export const NotificationStreamRestartReason = 'fsus_service_restart'
export const NotificationStreamReplayMissedReason = 'fsus_replay_miss'

const MIN_FAST_RECONNECT_DELAY_MS = 250
const MAX_FAST_RECONNECT_DELAY_MS = 1250

export type NotificationStreamCloseRecovery = Readonly<{
  kind: 'service_restart' | 'replay_missed'
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
