type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
}

let hasScheduled = false

async function loadNonCriticalFonts(): Promise<void> {
  await Promise.allSettled([
    import('@fontsource/noto-sans-sc/700.css'),
    import('@fontsource/noto-sans-tc/400.css'),
    import('@fontsource/noto-sans-tc/500.css'),
    import('@fontsource/noto-sans-tc/700.css'),
    import('@fontsource/noto-sans-jp/400.css'),
    import('@fontsource/noto-sans-jp/500.css'),
    import('@fontsource/noto-sans-jp/700.css'),
    import('@fontsource/jetbrains-mono/400.css'),
    import('@fontsource/jetbrains-mono/500.css'),
    import('@fontsource/jetbrains-mono/700.css')
  ])
}

export function scheduleNonCriticalResources(): void {
  if (hasScheduled || typeof window === 'undefined') {
    return
  }

  hasScheduled = true

  const load = () => {
    void loadNonCriticalFonts()
    void import('@/services/telemetryService').then(({ initTelemetryService }) => {
      initTelemetryService()
    })
  }

  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => load(), { timeout: 1500 })
    return
  }

  window.setTimeout(load, 800)
}
