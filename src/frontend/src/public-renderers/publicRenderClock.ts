import { TimeUtils, type TimeRenderOptions } from '@/utils/time'

export const PUBLIC_AOT_RENDER_TIME_ZONE = 'UTC'

export type PublicRenderClock = Readonly<{
  renderTimestamp: string
  renderYear: number
  renderTimeZone: string
}>

function normalizeClockInput(value: unknown): string | Date | number | null {
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date ? value : null
}

export function createPublicRenderClock(input?: unknown): PublicRenderClock {
  const parsed = TimeUtils._parse(normalizeClockInput(input) ?? new Date()) ?? TimeUtils._parse(new Date(0))!
  const renderTime = parsed.utc()

  return {
    renderTimestamp: renderTime.toISOString(),
    renderYear: renderTime.year(),
    renderTimeZone: PUBLIC_AOT_RENDER_TIME_ZONE
  }
}

export function createPublicRenderTimeOptions(clock: PublicRenderClock): TimeRenderOptions {
  return {
    now: clock.renderTimestamp,
    timeZone: clock.renderTimeZone
  }
}
