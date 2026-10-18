import { createBrowserTaskScheduler, type BrowserTaskYieldPath } from '../../../../src/frontend/src/performance/browserTaskScheduler'

type ExperimentMode = 'control' | 'candidate' | 'fallback'

interface ExperimentResult {
  mode: ExperimentMode
  totalDurationMs: number
  probeInputDelayMs: number | null
  eventTiming: Array<{ inputDelayMs: number, processingMs: number, presentationMs: number, durationMs: number }>
  longTasks: number[]
  longTaskAttribution: Array<{ name: string, containerType: string, containerName: string, containerId: string, containerSrc: string }>
  yieldCount: number
  yieldPaths: Record<BrowserTaskYieldPath, number>
  itemCount: number
  checksum: number
  heapBeforeBytes: number | null
  heapAfterBytes: number | null
  visibility: DocumentVisibilityState
}

declare global {
  interface Window {
    __FSUSBLOG_SCHEDULER_YIELD_EXPERIMENT__?: {
      start: (probeTargetEpochMs?: number) => void
      result: ExperimentResult | null
      running: boolean
    }
  }
}

const parameters = new URLSearchParams(location.search)
const mode = (parameters.get('mode') ?? 'control') as ExperimentMode
const itemCount = Number(parameters.get('items') ?? 600)
const innerIterations = Number(parameters.get('inner') ?? 12_000)
const batchSize = Number(parameters.get('batch') ?? 20)
const workload = document.querySelector<HTMLElement>('#workload')!
const status = document.querySelector<HTMLOutputElement>('#status')!
const profile = document.querySelector<HTMLElement>('#profile')!
const startButton = document.querySelector<HTMLButtonElement>('#start')!
const probeButton = document.querySelector<HTMLButtonElement>('#probe')!
const longTasks: number[] = []
const longTaskAttribution: ExperimentResult['longTaskAttribution'] = []
const eventTiming: ExperimentResult['eventTiming'] = []
let probeInputDelayMs: number | null = null
let probeTargetEpochMs: number | null = null

profile.textContent = `mode=${mode}, items=${itemCount}, inner=${innerIterations}, batch=${batchSize}`

if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as Array<PerformanceEntry & {
      attribution?: Array<{ name: string, containerType: string, containerName: string, containerId: string, containerSrc: string }>
    }>) {
      longTasks.push(entry.duration)
      longTaskAttribution.push(...(entry.attribution ?? []).map(attribution => ({
        name: attribution.name,
        containerType: attribution.containerType,
        containerName: attribution.containerName,
        containerId: attribution.containerId,
        containerSrc: attribution.containerSrc
      })))
    }
  }).observe({ type: 'longtask', buffered: true })
}

if (PerformanceObserver.supportedEntryTypes.includes('event')) {
  const observerOptions: PerformanceObserverInit & { durationThreshold: number } = {
    type: 'event', buffered: true, durationThreshold: 16
  }
  new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceEventTiming[]) {
      if (entry.name !== 'click') continue
      eventTiming.push({
        inputDelayMs: Math.max(0, entry.processingStart - entry.startTime),
        processingMs: Math.max(0, entry.processingEnd - entry.processingStart),
        presentationMs: Math.max(0, entry.duration - (entry.processingEnd - entry.startTime)),
        durationMs: entry.duration
      })
    }
  }).observe(observerOptions)
}

function recordProbe(event: Event): void {
  if (probeInputDelayMs !== null) return
  probeInputDelayMs = probeTargetEpochMs === null
    ? Math.max(0, performance.now() - event.timeStamp)
    : Math.max(0, Date.now() - probeTargetEpochMs)
  const busyUntil = performance.now() + 18
  while (performance.now() < busyUntil) {
    Math.imul(17, 31)
  }
}

probeButton.addEventListener('click', recordProbe)
probeButton.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  recordProbe(event)
})

const candidateScheduler = createBrowserTaskScheduler({
  minimumIntervalMs: 0,
  ...(mode === 'fallback' ? { environment: { scheduler: null } } : {})
})

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
  return memory?.usedJSHeapSize ?? null
}

async function runExperiment(): Promise<ExperimentResult> {
  workload.replaceChildren()
  longTasks.length = 0
  longTaskAttribution.length = 0
  eventTiming.length = 0
  probeInputDelayMs = null
  candidateScheduler.reset()
  const yieldPaths: Record<BrowserTaskYieldPath, number> = { native: 0, fallback: 0, throttled: 0 }
  let checksum = 0
  let yieldCount = 0
  const heapBeforeBytes = heapBytes()
  const startedAt = performance.now()

  for (let offset = 0; offset < itemCount; offset += batchSize) {
    const fragment = document.createDocumentFragment()
    const end = Math.min(itemCount, offset + batchSize)
    for (let index = offset; index < end; index += 1) {
      let value = index + 1
      for (let iteration = 0; iteration < innerIterations; iteration += 1) {
        value = Math.imul(value ^ iteration, 1_664_525) + 1_013_904_223
      }
      checksum = (checksum + value) | 0
      const item = document.createElement('div')
      item.className = 'work-item'
      item.textContent = `${index}:${value >>> 0}`
      fragment.append(item)
    }
    workload.append(fragment)

    if (mode !== 'control' && end < itemCount) {
      const outcome = await candidateScheduler.yieldToBrowser({ force: true })
      yieldPaths[outcome.path] += 1
      yieldCount += 1
    }
  }

  const totalDurationMs = performance.now() - startedAt
  const probeDeadline = performance.now() + 2_000
  while (probeInputDelayMs === null && performance.now() < probeDeadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))))
  await new Promise<void>(resolve => setTimeout(resolve, 100))
  return {
    mode,
    totalDurationMs,
    probeInputDelayMs,
    eventTiming: [...eventTiming],
    longTasks: [...longTasks],
    longTaskAttribution: [...longTaskAttribution],
    yieldCount,
    yieldPaths,
    itemCount: workload.childElementCount,
    checksum,
    heapBeforeBytes,
    heapAfterBytes: heapBytes(),
    visibility: document.visibilityState
  }
}

const state = {
  result: null as ExperimentResult | null,
  running: false,
  start(nextProbeTargetEpochMs?: number) {
    if (state.running) return
    probeTargetEpochMs = Number.isFinite(nextProbeTargetEpochMs) ? nextProbeTargetEpochMs! : null
    state.running = true
    status.textContent = 'Running'
    setTimeout(() => {
      void runExperiment().then(result => {
        state.result = result
        state.running = false
        status.textContent = `Completed ${result.mode}: ${result.itemCount} items, ${result.yieldCount} yields`
      })
    }, 0)
  }
}

startButton.addEventListener('click', () => state.start())
window.__FSUSBLOG_SCHEDULER_YIELD_EXPERIMENT__ = state
