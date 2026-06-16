import { computed, getCurrentInstance, onMounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  buildConsoleWelcomeCalloutLinks,
  resolveConsoleWelcomeCalloutConfig,
  shouldShowConsoleWelcomeCallout,
  type ConsoleWelcomeCalloutConfig
} from '@/config/consoleWelcomeCallout'

export const CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX = 'fsus:console-welcome-callout:dismissed:'

function storageKeyFor(userKey: unknown): string {
  const normalized = String(userKey ?? 'local')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .slice(0, 80) || 'local'
  return `${CONSOLE_WELCOME_DISMISS_STORAGE_PREFIX}${normalized}`
}

function readDismissed(storageKey: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(storageKey) === '1'
  } catch {
    return false
  }
}

function persistDismissed(storageKey: string): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, '1')
    }
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function useConsoleWelcomeCallout(options: {
  userKey?: MaybeRefOrGetter<string | number | null | undefined>
  config?: ConsoleWelcomeCalloutConfig
} = {}) {
  const config = options.config ?? resolveConsoleWelcomeCalloutConfig()
  const storageKey = computed(() => storageKeyFor(toValue(options.userKey)))
  const hasMounted = ref(false)
  const dismissed = ref(false)
  const links = computed(() => buildConsoleWelcomeCalloutLinks(config))
  const visible = computed(() => (
    shouldShowConsoleWelcomeCallout(config)
    && !dismissed.value
  ))

  watch(storageKey, (nextKey) => {
    dismissed.value = hasMounted.value ? readDismissed(nextKey) : false
  })

  if (getCurrentInstance()) {
    onMounted(() => {
      hasMounted.value = true
      dismissed.value = readDismissed(storageKey.value)
    })
  }

  function dismiss(): void {
    dismissed.value = true
    persistDismissed(storageKey.value)
  }

  return {
    config,
    dismissed,
    dismiss,
    links,
    storageKey,
    visible
  }
}
