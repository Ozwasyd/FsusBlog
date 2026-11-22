import type { ComponentPublicInstance } from 'vue'

export type InboxBubbleVariant = 'self' | 'other' | 'system' | 'muted'
export type InboxStatusTagType = 'success' | 'warning' | 'info'
export type InboxPerspective = 'reader' | 'admin'

export interface InboxRenderedMessage {
  readonly id: string
  readonly variant: InboxBubbleVariant
  readonly author: string
  readonly meta: string
  readonly body: string
}

const statusTagTypes = ['success', 'warning', 'info'] as const

export function inboxStatusTagType(status: number): InboxStatusTagType {
  return statusTagTypes[status] ?? 'info'
}

export function inboxBubbleVariant(
  sender: number,
  perspective: InboxPerspective,
  internal = false,
): InboxBubbleVariant {
  if (internal) return 'muted'
  if (sender === 2) return 'system'
  if (perspective === 'admin') return sender === 1 ? 'self' : 'other'
  return sender === 0 ? 'self' : 'other'
}

export interface InboxTimeFormatter {
  full(value: number): string
  compact(value: number, reference?: Date): string
}

export function createInboxTimeFormatter(locale: string): InboxTimeFormatter {
  const fullFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
  const timeOnly = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  const monthDay = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' })
  const dateOnly = new Intl.DateTimeFormat(locale, { dateStyle: 'short' })

  return {
    full: value => fullFormat.format(value),
    compact: (value, reference = new Date()) => {
      const date = new Date(value)
      if (date.getFullYear() === reference.getFullYear()) {
        if (date.getMonth() === reference.getMonth() && date.getDate() === reference.getDate()) {
          return timeOnly.format(date)
        }
        return monthDay.format(date)
      }
      return dateOnly.format(date)
    },
  }
}

export function resolveElementRoot(target: ComponentPublicInstance | HTMLElement | null | undefined): HTMLElement | null {
  if (!target) return null
  if (target instanceof HTMLElement) return target
  return target.$el instanceof HTMLElement ? target.$el : null
}

export function focusInboxHeading(target: ComponentPublicInstance | HTMLElement | null | undefined): boolean {
  const root = resolveElementRoot(target)
  const heading = root?.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6')
  if (!heading) return false
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
  return true
}
