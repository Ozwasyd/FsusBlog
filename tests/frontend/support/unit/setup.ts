import { appendFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { createUnitAnimationFrameEnvironment } from './animationFrameEnvironment'

const unitWindow = new Window({ url: 'https://fsusblog.test/' })
const animationFrames = createUnitAnimationFrameEnvironment()
const runtimeTopologyEvidence = process.env.FSUSBLOG_VITEST_RUNTIME_TOPOLOGY_EVIDENCE

function recordRuntimeTopology(event: 'start' | 'finish', task: { id: string; name: string }) {
  if (!runtimeTopologyEvidence) return
  appendFileSync(runtimeTopologyEvidence, `${JSON.stringify({ event, workerProcessId: process.pid, task })}\n`)
}

beforeEach((context) => {
  recordRuntimeTopology('start', { id: context.task.id, name: context.task.name })
})

afterEach((context) => {
  recordRuntimeTopology('finish', { id: context.task.id, name: context.task.name })
})
// Install happy-dom's public objects on the Node host without claiming that they
// implement the complete lib.dom interfaces.
Object.assign(globalThis, {
  window: unitWindow,
  document: unitWindow.document,
  history: unitWindow.history,
  location: unitWindow.location,
  Node: unitWindow.Node,
  Element: unitWindow.Element,
  HTMLElement: unitWindow.HTMLElement,
  SVGElement: unitWindow.SVGElement,
  localStorage: unitWindow.localStorage,
  sessionStorage: unitWindow.sessionStorage,
  getComputedStyle: unitWindow.getComputedStyle.bind(unitWindow)
})
// Both targets use the same unit frame port. Happy-dom's native port instead
// returns NodeJS.Immediate; the unit environment owns its handles and disposal.
const animationFrameGlobals = {
  requestAnimationFrame: animationFrames.request,
  cancelAnimationFrame: animationFrames.cancel
}
Object.assign(globalThis, animationFrameGlobals)
Object.assign(unitWindow, animationFrameGlobals)

afterAll(() => {
  animationFrames.dispose()
})

beforeAll(async () => {
  // Import the application locale graph only after each test module has had a
  // chance to register its hoisted mocks. Static setup imports can otherwise
  // cache API and transport modules before file-local vi.mock calls apply.
  const [localeDomains, localeRuntime] = await Promise.all([
    vi.importActual<typeof import('@/locales/localeDomains')>('@/locales/localeDomains'),
    vi.importActual<typeof import('@/locales')>('@/locales')
  ])
  const { LOCALE_DOMAINS } = localeDomains
  const { activateLocaleRuntime, resetLocaleRuntimeForTests } = localeRuntime
  resetLocaleRuntimeForTests()
  await activateLocaleRuntime('zh-CN', LOCALE_DOMAINS)
})

// ---------------------------------------------------------------------------
// @wasm/aeds — AEDS binary decoder
// ---------------------------------------------------------------------------
vi.mock('@wasm/aeds', () => ({
  initWasm: vi.fn().mockResolvedValue(true),
  resolveAedsWorkerRuntimeModel: vi.fn().mockReturnValue({ activeRequests: 1 }),
  decode: vi.fn().mockReturnValue({
    ok: false,
    frameType: FrameType.Unknown,
    payload: new Uint8Array(0),
    textBlob: '',
    error: 'wasm not initialised in tests'
  })
}))

// ---------------------------------------------------------------------------
// @wasm/protocol/frame — FrameType enum + helpers (re-export real values
//   so tests that inspect FrameType.ArticleList still work)
// ---------------------------------------------------------------------------
// No mock needed — real module has no side-effects and no .wasm load.

// ---------------------------------------------------------------------------
// @wasm/pow — proof-of-work (not needed in unit tests)
// ---------------------------------------------------------------------------
vi.mock('@wasm/pow', () => ({
  initPow: vi.fn().mockResolvedValue(true),
  solvePow: vi.fn().mockResolvedValue('test-pow-solution')
}))

// ---------------------------------------------------------------------------
// @wasm/search — local search (not needed in unit tests)
// ---------------------------------------------------------------------------
vi.mock('@wasm/search', () => ({
  initSearch: vi.fn().mockResolvedValue(true),
  initSearchRuntime: vi.fn().mockResolvedValue('UNKNOWN'),
  loadSearchEntry: vi.fn().mockResolvedValue('UNKNOWN'),
  loadSearchIndex: vi.fn().mockResolvedValue('UNKNOWN'),
  searchArticles: vi.fn().mockReturnValue([]),
  searchIndexBinary: vi.fn().mockResolvedValue(new Uint8Array())
}))
