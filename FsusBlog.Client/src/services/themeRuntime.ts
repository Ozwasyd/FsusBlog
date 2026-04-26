import { computed, readonly, ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'fsus:theme-mode'
export const THEME_CHANGE_EVENT = 'fsus:theme-change'

const VALID_THEME_MODES = new Set<ThemeMode>(['light', 'dark', 'system'])
const THEME_MODE_ORDER: ThemeMode[] = ['light', 'dark', 'system']

const themeModeState = ref<ThemeMode>('system')
const resolvedThemeState = ref<ResolvedTheme>('light')
const isThemeRuntimeReady = ref(false)

let prefersDarkQuery: MediaQueryList | null = null
let mediaListenerBound = false

function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return Boolean(value && VALID_THEME_MODES.has(value as ThemeMode))
}

function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') {
    return prefersDark ? 'dark' : 'light'
  }

  return mode
}

function readStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'system'
  }

  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

function writeStoredThemeMode(mode: ThemeMode): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Ignore storage failures in private mode or restricted environments.
  }
}

function readPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  prefersDarkQuery ??= window.matchMedia('(prefers-color-scheme: dark)')
  return prefersDarkQuery.matches
}

function updateColorSchemeMeta(resolvedTheme: ResolvedTheme): void {
  if (typeof document === 'undefined') {
    return
  }

  let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'color-scheme'
    document.head.appendChild(meta)
  }

  meta.content = resolvedTheme
}

function applyThemeToDom(mode: ThemeMode, resolvedTheme: ResolvedTheme): void {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement
  const body = document.body
  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.dataset.theme = resolvedTheme
  root.dataset.themeMode = mode
  root.style.colorScheme = resolvedTheme

  if (body) {
    body.dataset.theme = resolvedTheme
    body.dataset.themeMode = mode
    body.style.colorScheme = resolvedTheme
  }

  updateColorSchemeMeta(resolvedTheme)
}

function emitThemeChange(mode: ThemeMode, resolvedTheme: ResolvedTheme): void {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
    detail: {
      mode,
      resolvedTheme
    }
  }))
}

function syncThemeRuntime(mode: ThemeMode, persist: boolean): void {
  const resolvedTheme = resolveTheme(mode, readPrefersDark())
  themeModeState.value = mode
  resolvedThemeState.value = resolvedTheme
  applyThemeToDom(mode, resolvedTheme)

  if (persist) {
    writeStoredThemeMode(mode)
  }

  emitThemeChange(mode, resolvedTheme)
}

function bindMediaListener(): void {
  if (mediaListenerBound || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return
  }

  prefersDarkQuery ??= window.matchMedia('(prefers-color-scheme: dark)')

  const handleChange = () => {
    if (themeModeState.value !== 'system') {
      return
    }

    syncThemeRuntime('system', false)
  }

  if (typeof prefersDarkQuery.addEventListener === 'function') {
    prefersDarkQuery.addEventListener('change', handleChange)
  } else if (typeof prefersDarkQuery.addListener === 'function') {
    prefersDarkQuery.addListener(handleChange)
  }

  mediaListenerBound = true
}

export function ensureThemeRuntime(): void {
  if (isThemeRuntimeReady.value) {
    return
  }

  const root = typeof document !== 'undefined' ? document.documentElement : null
  const modeFromDom = root?.dataset.themeMode
  const initialMode = isThemeMode(modeFromDom) ? modeFromDom : readStoredThemeMode()
  syncThemeRuntime(initialMode, false)
  bindMediaListener()
  isThemeRuntimeReady.value = true
}

export function setThemeMode(mode: ThemeMode): void {
  ensureThemeRuntime()
  syncThemeRuntime(mode, true)
}

export function cycleThemeMode(): ThemeMode {
  ensureThemeRuntime()
  const currentIndex = THEME_MODE_ORDER.indexOf(themeModeState.value)
  const nextMode = THEME_MODE_ORDER[(currentIndex + 1) % THEME_MODE_ORDER.length] ?? 'system'
  setThemeMode(nextMode)
  return nextMode
}

export function useThemeRuntime() {
  ensureThemeRuntime()

  return {
    mode: readonly(themeModeState),
    resolvedTheme: readonly(resolvedThemeState),
    isDark: computed(() => resolvedThemeState.value === 'dark'),
    setThemeMode,
    cycleThemeMode
  }
}
