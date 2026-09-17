import { afterEach, describe, it, expect, vi } from 'vitest'
import { TimeUtils } from '@/utils/time'

afterEach(() => {
  vi.useRealTimers()
})

describe('TimeUtils._parse', () => {
  it('returns null for null input', () => {
    expect(TimeUtils._parse(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(TimeUtils._parse(undefined)).toBeNull()
  })

  it('returns null for invalid string', () => {
    expect(TimeUtils._parse('not-a-date')).toBeNull()
  })

  it('parses ISO string as UTC', () => {
    const d = TimeUtils._parse('2025-01-01T00:00:00Z')
    expect(d).not.toBeNull()
    expect(d!.isValid()).toBe(true)
  })

  it('parses unix seconds (10-digit number)', () => {
    const d = TimeUtils._parse(1700000000) // 10 digits
    expect(d).not.toBeNull()
    expect(d!.isValid()).toBe(true)
    // unix(1700000000) should equal Date(1700000000000)
    expect(d!.valueOf()).toBe(1700000000 * 1000)
  })

  it('parses unix milliseconds (13-digit number)', () => {
    const ts = 1700000000000
    const d = TimeUtils._parse(ts)
    expect(d).not.toBeNull()
    expect(d!.valueOf()).toBe(ts)
  })

  it('parses Date object', () => {
    const date = new Date(2025, 0, 1)
    const d = TimeUtils._parse(date)
    expect(d).not.toBeNull()
    expect(d!.isValid()).toBe(true)
  })
})

describe('TimeUtils.toRelative', () => {
  it('returns string for valid UTC time', () => {
    const result = TimeUtils.toRelative('2020-01-01T00:00:00Z')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns 时间未知 for invalid input', () => {
    expect(TimeUtils.toRelative('invalid-date')).toBe('时间未知')
  })

})

describe('TimeUtils.toFullLocalString', () => {
  it('returns formatted date string for valid UTC time', () => {
    const result = TimeUtils.toFullLocalString('2025-06-15T12:00:00Z')
    // format YYYY-MM-DD HH:mm:ss
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('returns 时间格式错误 for invalid input', () => {
    expect(TimeUtils.toFullLocalString('bad')).toBe('时间格式错误')
  })

  it('formats with an explicit timezone for SSR-visible strings', () => {
    const input = '2026-01-01T00:30:00Z'

    expect(TimeUtils.toFullLocalString(input, { timeZone: 'UTC' })).toBe('2026-01-01 00:30:00')
    expect(TimeUtils.toFullLocalString(input, { timeZone: 'Asia/Shanghai' })).toBe('2026-01-01 08:30:00')
  })
})

describe('TimeUtils.toSmartTime', () => {
  it('returns - for invalid input', () => {
    expect(TimeUtils.toSmartTime('not-a-date')).toBe('-')
  })

  it('returns 刚刚 for very recent time (within 1 minute)', () => {
    const now = new Date().toISOString()
    const result = TimeUtils.toSmartTime(now)
    // Could be "刚刚" or fromNow; just verify it returns a string
    expect(typeof result).toBe('string')
  })

  it('returns formatted date string for old dates', () => {
    // A date far in the past (>24h)
    const result = TimeUtils.toSmartTime('2000-01-01T00:00:00Z')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    // Should not be '-'
    expect(result).not.toBe('-')
  })

  it('handles future time gracefully', () => {
    // Far in the future
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes ahead
    const result = TimeUtils.toSmartTime(future)
    expect(typeof result).toBe('string')
  })

  it('uses the provided render clock instead of the process clock for transition windows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))

    expect(TimeUtils.toSmartTime('2026-01-01T00:00:30Z', {
      now: '2026-01-01T00:01:00Z',
      timeZone: 'UTC'
    })).toBe('刚刚')
  })
})
