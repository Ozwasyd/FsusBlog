import { describe, expect, it } from 'vitest'
import {
  NotificationStreamFullResyncRequiredCloseCode,
  NotificationStreamReplayMissedCloseCode,
  NotificationStreamReplayRequiredCloseCode,
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

  it('preserves the cursor and immediately replays after an explicit backpressure instruction', () => {
    const recovery = resolveNotificationStreamCloseRecovery(
      NotificationStreamReplayRequiredCloseCode,
      'fsus_replay_required:connection_byte_budget',
      () => 0.5
    )

    expect(recovery).toEqual({
      kind: 'replay_required',
      preserveCursor: true,
      requireFullResync: false,
      reconnectDelayMs: 750
    })
  })

  it('clears the cursor when policy requires a full resync after backpressure', () => {
    const recovery = resolveNotificationStreamCloseRecovery(
      NotificationStreamFullResyncRequiredCloseCode,
      'fsus_full_resync_required:connection_byte_budget',
      () => 0
    )

    expect(recovery).toEqual({
      kind: 'full_resync_required',
      preserveCursor: false,
      requireFullResync: true,
      reconnectDelayMs: 250
    })
  })

  it('leaves unrelated abnormal closures on the normal backoff policy', () => {
    expect(resolveNotificationStreamCloseRecovery(1006, '')).toBeNull()
  })
})
