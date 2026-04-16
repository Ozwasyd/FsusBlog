import { loadEmscriptenModule } from './runtime/emscripten'
import { resolveMarkdownAsset, type MarkdownAssetKind } from './runtime/assets'
import { createSerializedExecutor } from './runtime/serialized'
import { decodeUtf8, encodeUtf8 } from './runtime/utf8'
import { AppErrorCode, createAppError } from '@/utils/appError'
import {
  MARKDOWN_RENDERER_VERSION,
  buildMarkdownRenderResult,
  normalizeMarkdownSource,
  type MarkdownRenderMetadata,
  type MarkdownRenderPlaceholder,
  type MarkdownRenderRequest,
  type MarkdownRenderResult
} from './markdown'

export type MarkdownRuntimeKind = 'SIMD-128' | 'SCALAR-BASIC' | 'UNKNOWN'
export type MarkdownRuntimeRenderResult = MarkdownRenderResult & {
  engine: MarkdownRuntimeKind
}

type MarkdownModule = {
  HEAPU8: Uint8Array
  memory?: WebAssembly.Memory
  _markdown_render?: (ptr: number, len: number, allowHtml: number, allowLatex: number, allowMermaid: number) => number
  _markdown_get_last_html_ptr?: () => number
  _markdown_get_last_html_len?: () => number
  _markdown_get_last_error_ptr?: () => number
  _markdown_get_last_error_len?: () => number
  _markdown_get_last_error_code?: () => number
  _markdown_get_last_features_ptr?: () => number
  _markdown_get_last_features_len?: () => number
  _markdown_get_last_placeholders_ptr?: () => number
  _markdown_get_last_placeholders_len?: () => number
  _markdown_get_last_renderer_version_ptr?: () => number
  _markdown_get_last_renderer_version_len?: () => number
  _markdown_get_last_metadata_ptr?: () => number
  _markdown_get_last_metadata_len?: () => number
  _markdown_alloc_buffer?: (size: number) => number
  _markdown_free_buffer?: (ptr: number) => void
}

type MarkdownModuleFactoryResult = MarkdownModule & Record<string, unknown>

let runtimeModule: MarkdownModuleFactoryResult | null = null
let runtimePromise: Promise<{ module: MarkdownModuleFactoryResult | null; engine: MarkdownRuntimeKind }> | null = null
let runtimeEngine: MarkdownRuntimeKind = 'UNKNOWN'
const withMarkdownRuntimeLock = createSerializedExecutor()

function supportsSimdMarkdown(): boolean {
  try {
    const simdProbe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
      1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ])
    return WebAssembly.validate(simdProbe)
  } catch {
    return false
  }
}

function resolveMarkdownAssetKind(): MarkdownAssetKind {
  return supportsSimdMarkdown() ? 'simd' : 'basic'
}

function pickExport<T>(raw: Record<string, unknown>, ...names: string[]): T {
  for (const name of names) {
    const direct = raw[name]
    if (direct) {
      return direct as T
    }

    const underscored = raw[`_${name}`]
    if (underscored) {
      return underscored as T
    }
  }

  throw createAppError(AppErrorCode.InvariantViolation, `wasm_export_missing:${names[0] ?? 'unknown'}`)
}

function mapMarkdownErrorCode(code: number, fallback: string): AppErrorCode {
  switch (code) {
    case 1:
      return AppErrorCode.ProtocolFailure
    default:
      if (fallback.includes('source') || fallback.includes('input')) {
        return AppErrorCode.ProtocolFailure
      }
      return AppErrorCode.InfraFailure
  }
}

async function initMarkdownRuntimeModule(): Promise<{ module: MarkdownModuleFactoryResult | null; engine: MarkdownRuntimeKind }> {
  if (runtimeModule) {
    return { module: runtimeModule, engine: runtimeEngine }
  }

  if (!runtimePromise) {
    runtimePromise = (async () => {
      const assetKind = resolveMarkdownAssetKind()
      const engine: MarkdownRuntimeKind = assetKind === 'simd' ? 'SIMD-128' : 'SCALAR-BASIC'
      const asset = resolveMarkdownAsset(assetKind)
      const module = await loadEmscriptenModule<MarkdownModuleFactoryResult>(
        asset.moduleUrl,
        'createMarkdownModule',
        asset.wasmUrl
      )

      if (!module) {
        return { module: null, engine }
      }

      const raw = module as unknown as Record<string, unknown>
      runtimeModule = {
        ...module,
        _markdown_render: pickExport<(ptr: number, len: number, allowHtml: number, allowLatex: number, allowMermaid: number) => number>(raw, 'markdown_render', 'render_markdown'),
        _markdown_get_last_html_ptr: pickExport<() => number>(raw, 'markdown_get_last_html_ptr', 'get_last_html_ptr'),
        _markdown_get_last_html_len: pickExport<() => number>(raw, 'markdown_get_last_html_len', 'get_last_html_len'),
        _markdown_get_last_error_ptr: pickExport<() => number>(raw, 'markdown_get_last_error_ptr', 'get_last_error_ptr'),
        _markdown_get_last_error_len: pickExport<() => number>(raw, 'markdown_get_last_error_len', 'get_last_error_len'),
        _markdown_get_last_error_code: pickExport<() => number>(raw, 'markdown_get_last_error_code', 'get_last_error_code'),
        _markdown_get_last_features_ptr: pickExport<() => number>(raw, 'markdown_get_last_features_ptr', 'get_last_features_ptr'),
        _markdown_get_last_features_len: pickExport<() => number>(raw, 'markdown_get_last_features_len', 'get_last_features_len'),
        _markdown_get_last_placeholders_ptr: pickExport<() => number>(raw, 'markdown_get_last_placeholders_ptr', 'get_last_placeholders_ptr'),
        _markdown_get_last_placeholders_len: pickExport<() => number>(raw, 'markdown_get_last_placeholders_len', 'get_last_placeholders_len'),
        _markdown_get_last_renderer_version_ptr: pickExport<() => number>(raw, 'markdown_get_last_renderer_version_ptr', 'get_last_renderer_version_ptr'),
        _markdown_get_last_renderer_version_len: pickExport<() => number>(raw, 'markdown_get_last_renderer_version_len', 'get_last_renderer_version_len'),
        _markdown_get_last_metadata_ptr: pickExport<() => number>(raw, 'markdown_get_last_metadata_ptr', 'get_last_metadata_ptr'),
        _markdown_get_last_metadata_len: pickExport<() => number>(raw, 'markdown_get_last_metadata_len', 'get_last_metadata_len'),
        _markdown_alloc_buffer: pickExport<(size: number) => number>(raw, 'markdown_alloc_buffer', 'alloc_buffer'),
        _markdown_free_buffer: pickExport<(ptr: number) => void>(raw, 'markdown_free_buffer', 'free_buffer')
      }
      runtimeEngine = engine

      return { module: runtimeModule, engine }
    })().catch(() => ({ module: null, engine: 'UNKNOWN' as MarkdownRuntimeKind }))
  }

  return await runtimePromise
}

function readCString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (ptr <= 0 || len <= 0) {
    return ''
  }

  const view = new Uint8Array(memory.buffer, ptr, len)
  return decodeUtf8(view)
}

function resolveModuleMemory(module: MarkdownModuleFactoryResult): WebAssembly.Memory | null {
  if (module.memory) {
    return module.memory
  }

  const heapBuffer = module.HEAPU8?.buffer
  if (!heapBuffer) {
    return null
  }

  return { buffer: heapBuffer } as WebAssembly.Memory
}

function readJson<T>(memory: WebAssembly.Memory, ptr: number, len: number, fallback: T): T {
  const raw = readCString(memory, ptr, len)
  if (!raw) {
    return fallback
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function initMarkdownRuntime(): Promise<MarkdownRuntimeKind> {
  const result = await initMarkdownRuntimeModule()
  return result.engine
}

export async function renderMarkdownWithRuntime(request: MarkdownRenderRequest | string): Promise<string | null> {
  const result = await renderMarkdownResultWithRuntime(request)
  return result?.html ?? null
}

export async function renderMarkdownResultWithRuntime(
  request: MarkdownRenderRequest | string
): Promise<MarkdownRuntimeRenderResult | null> {
  return await withMarkdownRuntimeLock(async () => {
    const payload = typeof request === 'string' ? { source: request } : request
    const source = normalizeMarkdownSource(payload.source)
    const { module, engine } = await initMarkdownRuntimeModule()

    if (!module) {
      return null
    }

    const bytes = encodeUtf8(source)
    const alloc = module._markdown_alloc_buffer
    const free = module._markdown_free_buffer
    const render = module._markdown_render
    const getHtmlPtr = module._markdown_get_last_html_ptr
    const getHtmlLen = module._markdown_get_last_html_len
    const getErrorPtr = module._markdown_get_last_error_ptr
    const getErrorLen = module._markdown_get_last_error_len
    const getErrorCode = module._markdown_get_last_error_code
    const getFeaturesPtr = module._markdown_get_last_features_ptr
    const getFeaturesLen = module._markdown_get_last_features_len
    const getPlaceholdersPtr = module._markdown_get_last_placeholders_ptr
    const getPlaceholdersLen = module._markdown_get_last_placeholders_len
    const getRendererVersionPtr = module._markdown_get_last_renderer_version_ptr
    const getRendererVersionLen = module._markdown_get_last_renderer_version_len
    const getMetadataPtr = module._markdown_get_last_metadata_ptr
    const getMetadataLen = module._markdown_get_last_metadata_len

    if (
      !alloc || !free || !render || !getHtmlPtr || !getHtmlLen ||
      !getErrorPtr || !getErrorLen || !getErrorCode || !getFeaturesPtr || !getFeaturesLen ||
      !getPlaceholdersPtr || !getPlaceholdersLen || !getRendererVersionPtr || !getRendererVersionLen ||
      !getMetadataPtr || !getMetadataLen
    ) {
      return null
    }

    const ptr = alloc(bytes.byteLength)
    if (ptr <= 0) {
      return null
    }

    try {
      module.HEAPU8.set(bytes, ptr)
      const ok = render(ptr, bytes.byteLength, payload.allowHtml ? 1 : 0, payload.allowLatex === false ? 0 : 1, payload.allowMermaid === false ? 0 : 1)
      const memory = resolveModuleMemory(module)
      if (!memory) {
        return null
      }
      if (ok !== 1) {
        const error = readCString(memory, getErrorPtr(), getErrorLen())
        if (error) {
          throw createAppError(mapMarkdownErrorCode(getErrorCode(), error), `markdown_wasm_render_failed:${error}`)
        }
        return null
      }

      const html = readCString(memory, getHtmlPtr(), getHtmlLen())
      const features = readJson<MarkdownRenderResult['features']>(memory, getFeaturesPtr(), getFeaturesLen(), [])
      const placeholders = readJson<MarkdownRenderPlaceholder[]>(memory, getPlaceholdersPtr(), getPlaceholdersLen(), [])
      const rendererVersion = readCString(memory, getRendererVersionPtr(), getRendererVersionLen()) || MARKDOWN_RENDERER_VERSION
      const metadata = readJson<MarkdownRenderMetadata>(memory, getMetadataPtr(), getMetadataLen(), {
        mode: payload.mode ?? 'article',
        baseUrl: payload.baseUrl ?? null,
        allowHtml: !!payload.allowHtml,
        allowLatex: payload.allowLatex !== false,
        allowMermaid: payload.allowMermaid !== false,
        sourceLength: source.length,
        featureCount: features.length,
        placeholderCount: placeholders.length,
        rendererVersion
      })

      return {
        ...buildMarkdownRenderResult({
          html,
          source,
          features,
          placeholders,
          rendererVersion,
          metadata
        }),
        engine
      }
    } finally {
      free(ptr)
    }
  })
}

export { MARKDOWN_RENDERER_VERSION }
