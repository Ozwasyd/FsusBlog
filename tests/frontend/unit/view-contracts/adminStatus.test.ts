import { describe, expect, expectTypeOf, it } from 'vitest'
import type { MetricPrimitiveTone } from '@ozwasyd/element-plus/es/components/metric-primitives/src/shared'
import type { AdminStatusTone, AdminSystemStatus } from '@/view-contracts/adminStatus'
import { adminStatusLabel, adminStatusTone } from '@/view-contracts/adminStatus'

const adminViewStatuses = [
  'ok',
  'ready',
  'success',
  'applied',
  'stale',
  'degraded',
  'warning',
  'not_ready',
  'queued',
  'failed',
  'failure',
  'missing',
  'unsupported',
  'unknown',
  'denied',
  'empty',
  'issue',
  'issues',
  'info',
  'error',
  'critical'
] as const satisfies readonly AdminSystemStatus[]

const fsusUiMetricTones = ['neutral', 'info', 'success', 'warning', 'danger'] as const

describe('admin status view contract', () => {
  it('covers every finite status currently rendered by the admin status views', () => {
    expect(Object.keys(adminStatusTone).sort()).toEqual([...adminViewStatuses].sort())
    expect(Object.keys(adminStatusLabel).sort()).toEqual([...adminViewStatuses].sort())
  })

  it('keeps tones inside the FsusUI metric primitive tone contract', () => {
    expectTypeOf<AdminStatusTone>().toMatchTypeOf<MetricPrimitiveTone>()

    const tones = new Set(fsusUiMetricTones)
    for (const status of adminViewStatuses) {
      expect(tones.has(adminStatusTone[status])).toBe(true)
    }
  })

  it('centralizes repeated admin status labels', () => {
    expect(adminStatusLabel.ok).toBe('正常')
    expect(adminStatusLabel.failed).toBe('失败')
    expect(adminStatusLabel.failure).toBe('失败')
    expect(adminStatusLabel.missing).toBe('缺失')
    expect(adminStatusLabel.unknown).toBe('未知')
    expect(adminStatusLabel.warning).toBe('警告')
    expect(adminStatusLabel.error).toBe('错误')
    expect(adminStatusLabel.critical).toBe('严重')
    expect(adminStatusLabel.degraded).toBe('降级')
  })
})
