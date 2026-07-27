import { TimeUtils, type TimeRenderOptions } from '@/utils/time'
import { DEFAULT_LOCALE, isSupportedLocale } from '@/locales/keys'

export const PUBLIC_AOT_RENDER_TIME_ZONE = 'UTC'

export interface LocaleContext {
  locale: string
  timeZone: string
}

export type PublicRenderClock = Readonly<{
  renderTimestamp: string
  renderYear: number
  renderTimeZone: string
}>

type PublicRenderTimeOptionsSource = Readonly<{
  renderTimestamp?: string | null
  renderTimeZone?: string | null
  renderLocale?: string | null
}>

const CANONICAL_PUBLIC_RENDER_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3,7})Z$/

function normalizeLocale(value: unknown): string {
  const locale = typeof value === 'string' ? value.trim() : ''
  if (!locale) return DEFAULT_LOCALE
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
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

export function createPublicRenderClock(input: unknown): PublicRenderClock {
  const renderClock = createAuthoritativePublicRenderClock(input)
  if (!renderClock) {
    throw new Error('public_aot_render_timestamp_invalid')
  }
  return renderClock
}

export function createAuthoritativePublicRenderClock(input: unknown): PublicRenderClock | undefined {
  if (typeof input !== 'string' || input !== input.trim()) {
    return undefined
  }

  const match = CANONICAL_PUBLIC_RENDER_TIMESTAMP.exec(input)
  if (!match) {
    return undefined
  }

  const [, year, month, day, hour, minute, second, fraction] = match
  const instant = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.slice(0, 3)}Z`
  )
  if (!Number.isFinite(instant.getTime()) ||
      instant.getUTCFullYear() !== Number(year) ||
      instant.getUTCMonth() + 1 !== Number(month) ||
      instant.getUTCDate() !== Number(day) ||
      instant.getUTCHours() !== Number(hour) ||
      instant.getUTCMinutes() !== Number(minute) ||
      instant.getUTCSeconds() !== Number(second)) {
    return undefined
  }

  const renderTime = TimeUtils._parse(input)?.utc()
  if (!renderTime) {
    return undefined
  }

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
  const source = sources.find((candidate) => candidate != null)
  if (!source) {
    return undefined
  }

  if (!isSupportedLocale(source.renderLocale)) {
    return undefined
  }

  const clock = createAuthoritativePublicRenderClock(source.renderTimestamp)
  if (!clock) {
    return undefined
  }
  const localeContext = createPublicLocaleContext({
    locale: source.renderLocale,
    timeZone: source.renderTimeZone ?? clock.renderTimeZone
  })
  return {
    now: clock.renderTimestamp,
    timeZone: localeContext.timeZone,
    locale: localeContext.locale
  }
}

export function hasCanonicalPublicSeedRenderTimestamp(
  ...sources: readonly (PublicRenderTimeOptionsSource | null | undefined)[]
): boolean {
  const presentSources = sources.filter(
    (source): source is PublicRenderTimeOptionsSource => source != null
  )
  if (presentSources.length === 0) {
    return false
  }

  const renderTimestamp = presentSources[0]?.renderTimestamp
  if (!createAuthoritativePublicRenderClock(renderTimestamp)) {
    return false
  }

  return presentSources.every((source) =>
    source.renderTimestamp === renderTimestamp &&
    isSupportedLocale(source.renderLocale) &&
    createAuthoritativePublicRenderClock(source.renderTimestamp) != null
  )
}
