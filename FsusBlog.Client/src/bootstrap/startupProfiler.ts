type StartupMetric = {
  name: string
  duration: number
}

type StartupWindow = Window & {
  __FSUS_STARTUP_METRICS__?: StartupMetric[]
}

const STARTUP_PREFIX = 'fsus:start'
const ENABLED = typeof window !== 'undefined' && typeof performance !== 'undefined'

function toMarkName(name: string): string {
  return `${STARTUP_PREFIX}:${name}`
}

export function markStartup(name: string): void {
  if (!ENABLED) {
    return
  }

  performance.mark(toMarkName(name))
}

export function measureStartup(name: string, startMark: string, endMark?: string): number | null {
  if (!ENABLED) {
    return null
  }

  const measureName = toMarkName(name)
  const startName = toMarkName(startMark)
  const endName = endMark ? toMarkName(endMark) : undefined

  try {
    performance.measure(measureName, startName, endName)
    const entries = performance.getEntriesByName(measureName, 'measure')
    const last = entries[entries.length - 1]
    if (!last) {
      return null
    }

    const metric: StartupMetric = {
      name,
      duration: Number(last.duration.toFixed(2))
    }

    const startupWindow = window as StartupWindow
    const existing = startupWindow.__FSUS_STARTUP_METRICS__ ?? []
    existing.push(metric)
    startupWindow.__FSUS_STARTUP_METRICS__ = existing

    return metric.duration
  } catch {
    return null
  }
}

