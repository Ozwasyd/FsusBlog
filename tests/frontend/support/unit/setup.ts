import { Window } from 'happy-dom'
import { afterAll, beforeAll, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { createUnitAnimationFrameEnvironment } from './animationFrameEnvironment'

const unitWindow = new Window({ url: 'https://fsusblog.test/' })
const animationFrames = createUnitAnimationFrameEnvironment()
;(globalThis as { window?: Window }).window = unitWindow
;(globalThis as { document?: Document }).document = unitWindow.document
;(globalThis as { history?: History }).history = unitWindow.history
;(globalThis as { location?: Location }).location = unitWindow.location
;(globalThis as { Node?: typeof Node }).Node = unitWindow.Node
;(globalThis as { Element?: typeof Element }).Element = unitWindow.Element
;(globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement = unitWindow.HTMLElement
;(globalThis as { SVGElement?: typeof SVGElement }).SVGElement = unitWindow.SVGElement
;(globalThis as { localStorage?: Storage }).localStorage = unitWindow.localStorage
;(globalThis as { sessionStorage?: Storage }).sessionStorage = unitWindow.sessionStorage
;(globalThis as { getComputedStyle?: typeof globalThis.getComputedStyle }).getComputedStyle =
  unitWindow.getComputedStyle.bind(unitWindow) as typeof globalThis.getComputedStyle
;(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
  animationFrames.request
;(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame =
  animationFrames.cancel
unitWindow.requestAnimationFrame = animationFrames.request
unitWindow.cancelAnimationFrame = animationFrames.cancel

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
