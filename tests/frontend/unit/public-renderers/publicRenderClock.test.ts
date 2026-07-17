import { describe, expect, it } from 'vitest'
import {
  createPublicLocaleContext,
  createPublicRenderClock,
  createPublicRenderTimeOptions
} from '@/public-renderers/publicRenderClock'
import { TimeUtils } from '@/utils/time'

describe('public renderer clock and locale context', () => {
  it('uses an injected clock without mutating global time', () => {
    const clock = createPublicRenderClock(undefined, {
      now: () => new Date('2027-01-01T00:00:01.000Z')
    })

    expect(clock).toEqual({
      renderTimestamp: '2027-01-01T00:00:01.000Z',
      renderYear: 2027,
      renderTimeZone: 'UTC'
    })
  })

  it('canonicalizes locale/timezone and fails safely for invalid context', () => {
    expect(createPublicLocaleContext({ locale: 'en-us', timeZone: 'America/New_York' })).toEqual({
      locale: 'en-US',
      timeZone: 'America/New_York'
    })
    expect(createPublicLocaleContext({ locale: 'not a locale', timeZone: 'Not/AZone' })).toEqual({
      locale: 'zh-CN',
      timeZone: 'UTC'
    })
  })

  it('keeps relative/full time deterministic across locale and timezone boundaries', () => {
    const clock = createPublicRenderClock('2026-06-16T16:00:40.000Z')
    const shanghai = createPublicRenderTimeOptions(clock, createPublicLocaleContext({
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai'
    }))
    const newYork = createPublicRenderTimeOptions(clock, createPublicLocaleContext({
      locale: 'en-US',
      timeZone: 'America/New_York'
    }))

    expect(TimeUtils.toFullLocalString('2026-06-16T15:59:30.000Z', shanghai)).toBe('2026-06-16 23:59:30')
    expect(TimeUtils.toFullLocalString('2026-06-16T15:59:30.000Z', newYork)).toBe('2026-06-16 11:59:30')
    expect(TimeUtils.toSmartTime('2026-06-16T15:59:30.000Z', shanghai)).toContain('分钟')
    expect(TimeUtils.toSmartTime('2026-06-16T15:59:30.000Z', newYork)).toContain('minute')
  })
})
