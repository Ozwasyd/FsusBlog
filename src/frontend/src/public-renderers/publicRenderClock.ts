import { TimeUtils, type TimeRenderOptions } from '@/utils/time'

export const PUBLIC_AOT_RENDER_TIME_ZONE = 'UTC'
export const PUBLIC_AOT_RENDER_LOCALE = 'zh-CN'

export interface Clock {
  now(): Date
}

export interface LocaleContext {
  locale: string
  timeZone: string
}

export const SYSTEM_CLOCK: Clock = Object.freeze({
  now: () => new Date()
})

export type PublicRenderClock = Readonly<{
  renderTimestamp: string
  renderYear: number
  renderTimeZone: string
}>

type PublicRenderTimeOptionsSource = Readonly<{
  renderTimestamp?: string | null
  generatedAt?: string | null
  renderTimeZone?: string | null
  renderLocale?: string | null
}>

function normalizeClockInput(value: unknown): string | Date | number | null {
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date ? value : null
}

function readClockNow(clock: Clock): Date {
  const value = clock.now()
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date(0)
}

function normalizeLocale(value: unknown): string {
  const locale = typeof value === 'string' ? value.trim() : ''
  if (!locale) return PUBLIC_AOT_RENDER_LOCALE
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? PUBLIC_AOT_RENDER_LOCALE
  } catch {
    return PUBLIC_AOT_RENDER_LOCALE
  }
}

function normalizeTimeZone(value: unknown): string {
  const timeZone = typeof value === 'string' ? value.trim() : ''
  if (!timeZone) return PUBLIC_AOT_RENDER_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0))
    return timeZone
  } catch {
    return PUBLIC_AOT_RENDER_TIME_ZONE
  }
}

export function createPublicLocaleContext(input: Partial<LocaleContext> = {}): LocaleContext {
  return Object.freeze({
    locale: normalizeLocale(input.locale),
    timeZone: normalizeTimeZone(input.timeZone)
  })
}

export function createPublicRenderClock(input?: unknown, clock: Clock = SYSTEM_CLOCK): PublicRenderClock {
  const parsed = TimeUtils._parse(normalizeClockInput(input) ?? readClockNow(clock)) ?? TimeUtils._parse(new Date(0))!
  const renderTime = parsed.utc()

  return {
    renderTimestamp: renderTime.toISOString(),
    renderYear: renderTime.year(),
    renderTimeZone: PUBLIC_AOT_RENDER_TIME_ZONE
  }
}

export function createPublicRenderTimeOptions(
  clock: PublicRenderClock,
  localeContext: LocaleContext = createPublicLocaleContext()
): TimeRenderOptions {
  return {
    now: clock.renderTimestamp,
    timeZone: localeContext.timeZone,
    locale: localeContext.locale
  }
}

export function createPublicSeedRenderTimeOptions(
  ...sources: readonly (PublicRenderTimeOptionsSource | null | undefined)[]
): TimeRenderOptions | undefined {
  const source = sources.find((candidate) => Boolean(candidate?.renderTimestamp || candidate?.generatedAt))
  if (!source) {
    return undefined
  }

  const clock = createPublicRenderClock(source.renderTimestamp ?? source.generatedAt)
  const localeContext = createPublicLocaleContext({
    locale: source.renderLocale ?? PUBLIC_AOT_RENDER_LOCALE,
    timeZone: source.renderTimeZone ?? clock.renderTimeZone
  })
  return {
    now: clock.renderTimestamp,
    timeZone: localeContext.timeZone,
    locale: localeContext.locale
  }
}
