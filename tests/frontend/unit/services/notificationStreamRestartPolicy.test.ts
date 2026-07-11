import { describe, expect, it } from 'vitest'
import {
  NotificationStreamReplayMissedCloseCode,
  NotificationStreamRestartCloseCode,
  resolveNotificationStreamCloseRecovery
} from '@/services/notificationStreamRestartPolicy'

describe('notificationStreamRestartPolicy', () => {
  it('uses bounded fast reconnect and preserves the cursor for service restart', () => {
    const recovery = resolveNotificationStreamCloseRecovery(
      NotificationStreamRestartCloseCode,
      'fsus_service_restart',
      () => 0
    )

    expect(recovery).toEqual({
      kind: 'service_restart',
      preserveCursor: true,
      requireFullResync: false,
      reconnectDelayMs: 250
    })
  })

  it('clears the stale cursor and requests full resync after a replay miss', () => {
    const recovery = resolveNotificationStreamCloseRecovery(
      NotificationStreamReplayMissedCloseCode,
      'fsus_replay_miss',
      () => 1
    )

    expect(recovery).toEqual({
      kind: 'replay_missed',
      preserveCursor: false,
      requireFullResync: true,
      reconnectDelayMs: 1250
    })
  })

  it('leaves unrelated abnormal closures on the normal backoff policy', () => {
    expect(resolveNotificationStreamCloseRecovery(1006, '')).toBeNull()
  })
})
