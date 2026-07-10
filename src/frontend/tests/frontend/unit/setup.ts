import { Window } from 'happy-dom'
import { vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

const unitWindow = new Window()
;(globalThis as { window?: Window }).window = unitWindow
;(globalThis as { document?: Document }).document = unitWindow.document
;(globalThis as { Node?: typeof Node }).Node = unitWindow.Node
;(globalThis as { Element?: typeof Element }).Element = unitWindow.Element
;(globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement = unitWindow.HTMLElement
;(globalThis as { SVGElement?: typeof SVGElement }).SVGElement = unitWindow.SVGElement
;(globalThis as { localStorage?: Storage }).localStorage = unitWindow.localStorage
;(globalThis as { sessionStorage?: Storage }).sessionStorage = unitWindow.sessionStorage
;(globalThis as { getComputedStyle?: typeof globalThis.getComputedStyle }).getComputedStyle =
  unitWindow.getComputedStyle.bind(unitWindow) as typeof globalThis.getComputedStyle
;(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
  (cb: FrameRequestCallback): number => setTimeout(() => cb(Date.now()), 0) as unknown as number
;(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame =
  (id: number): void => clearTimeout(id)

// ---------------------------------------------------------------------------
// @wasm/aeds — AEDS binary decoder
// ---------------------------------------------------------------------------
vi.mock('@wasm/aeds', () => ({
  initWasm: vi.fn().mockResolvedValue(true),
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
