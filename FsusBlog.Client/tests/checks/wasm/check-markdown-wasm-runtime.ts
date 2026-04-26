import { loadEmscriptenModule } from '../../../wasm/web/runtime/emscripten'
import { resolveMarkdownAsset, type MarkdownAssetKind } from '../../../wasm/web/runtime/assets'
import { MARKDOWN_RENDERER_VERSION } from '../../../wasm/web/markdown'

type MarkdownModule = {
  HEAPU8: Uint8Array
  memory?: WebAssembly.Memory
}

type MarkdownModuleExports = MarkdownModule & {
  _markdown_render?: (ptr: number, len: number, allowHtml: number, allowLatex: number, allowMermaid: number) => number
  _markdown_get_last_html_ptr?: () => number
  _markdown_get_last_html_len?: () => number
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

type MarkdownPlaceholder = {
  kind: 'latex_inline' | 'latex_block' | 'mermaid_block'
  token: string
  label: string
  source: string
  line: number
  column: number
  endLine: number
  endColumn: number
  startOffset: number
  endOffset: number
}

type MarkdownMetadata = {
  mode: 'article' | 'about' | 'preview' | 'editor'
  baseUrl: string
  allowHtml: boolean
  allowLatex: boolean
  allowMermaid: boolean
  sourceLength: number
  sourceLineCount: number
  normalizedSourceLength: number
  featureCount: number
  placeholderCount: number
  rendererVersion: string
}

type RenderSnapshot = {
  html: string
  features: string[]
  placeholders: MarkdownPlaceholder[]
  rendererVersion: string
  metadata: MarkdownMetadata
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertIncludes(haystack: string, needle: string, message: string) {
  assert(haystack.includes(needle), `${message}: missing ${needle}`)
}

function assertDeepEqual<T>(actual: T, expected: T, message: string) {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  assert(actualJson === expectedJson, `${message}: expected ${expectedJson}, received ${actualJson}`)
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

  throw new Error(`wasm_export_missing:${names[0] ?? 'unknown'}`)
}

function normalizeSource(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function readCString(module: MarkdownModule, ptr: number, len: number): string {
  if (ptr <= 0 || len <= 0) {
    return ''
  }

  const memory = module.memory ?? (module.HEAPU8 ? ({ buffer: module.HEAPU8.buffer } as WebAssembly.Memory) : null)
  if (!memory) {
    throw new Error('[markdown-wasm-runtime] module memory unavailable')
  }

  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
}

function readJson<T>(raw: string, fallback: T): T {
  if (!raw) {
    return fallback
  }

  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`[markdown-wasm-runtime] invalid json payload: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function buildExpectedPlaceholders(source: string): MarkdownPlaceholder[] {
  const normalized = normalizeSource(source)
  const placeholders: MarkdownPlaceholder[] = []
  let lineNo = 1
  let lineStart = 0

  while (lineStart <= normalized.length) {
    const lineEnd = normalized.indexOf('\n', lineStart)
    const hasLineEnd = lineEnd !== -1
    const line = hasLineEnd ? normalized.slice(lineStart, lineEnd) : normalized.slice(lineStart)
    const trimmed = line.replace(/^[ \t\f\v\r\n]+/, '')
    const column = line.length - trimmed.length + 1

    if (trimmed.startsWith('```mermaid') || trimmed.startsWith(':::mermaid')) {
      let blockEndLine = lineNo
      let blockEndOffset = hasLineEnd ? lineEnd : normalized.length
      let mermaidSource = ''
      let scanLineNo = lineNo + 1
      let scanIndex = hasLineEnd ? lineEnd + 1 : normalized.length

      while (scanIndex <= normalized.length) {
        const nextEnd = normalized.indexOf('\n', scanIndex)
        const nextHasLineEnd = nextEnd !== -1
        const nextLine = nextHasLineEnd ? normalized.slice(scanIndex, nextEnd) : normalized.slice(scanIndex)
        const nextTrimmed = nextLine.replace(/^[ \t\f\v\r\n]+/, '')

        if (nextTrimmed === ':::' || nextTrimmed.startsWith('```')) {
          blockEndLine = scanLineNo
          blockEndOffset = nextHasLineEnd ? nextEnd : normalized.length
          break
        }

        mermaidSource += nextLine
        if (!nextHasLineEnd) {
          blockEndLine = scanLineNo
          blockEndOffset = normalized.length
          break
        }

        mermaidSource += '\n'
        scanIndex = nextEnd + 1
        scanLineNo += 1
        blockEndLine = scanLineNo
        blockEndOffset = nextEnd
      }

      placeholders.push({
        kind: 'mermaid_block',
        token: 'mermaid',
        label: 'Mermaid 图表将在 Wasm 渲染器中占位',
        source: mermaidSource,
        line: lineNo,
        column,
        endLine: blockEndLine,
        endColumn: 1,
        startOffset: lineStart,
        endOffset: blockEndOffset
      })
    } else if (trimmed === '$$' || trimmed.startsWith('$$ ')) {
      let blockEndLine = lineNo
      let blockEndOffset = hasLineEnd ? lineEnd : normalized.length
      let latexSource = ''
      let scanLineNo = lineNo + 1
      let scanIndex = hasLineEnd ? lineEnd + 1 : normalized.length

      while (scanIndex <= normalized.length) {
        const nextEnd = normalized.indexOf('\n', scanIndex)
        const nextHasLineEnd = nextEnd !== -1
        const nextLine = nextHasLineEnd ? normalized.slice(scanIndex, nextEnd) : normalized.slice(scanIndex)
        const nextTrimmed = nextLine.replace(/^[ \t\f\v\r\n]+/, '')

        if (nextTrimmed === '$$' || nextTrimmed.startsWith('$$ ')) {
          blockEndLine = scanLineNo
          blockEndOffset = nextHasLineEnd ? nextEnd : normalized.length
          break
        }

        latexSource += nextLine
        if (!nextHasLineEnd) {
          blockEndLine = scanLineNo
          blockEndOffset = normalized.length
          break
        }

        latexSource += '\n'
        scanIndex = nextEnd + 1
        scanLineNo += 1
        blockEndLine = scanLineNo
        blockEndOffset = nextEnd
      }

      placeholders.push({
        kind: 'latex_block',
        token: 'latex-block',
        label: 'LaTeX 块公式将在 Wasm 渲染器中占位',
        source: latexSource,
        line: lineNo,
        column,
        endLine: blockEndLine,
        endColumn: 1,
        startOffset: lineStart,
        endOffset: blockEndOffset
      })
    } else if (line.includes('\\(') || line.includes('\\[')) {
      const token = line.includes('\\(') ? '\\(' : '\\['
      const tokenColumn = line.indexOf(token) + 1
      const tokenOffset = lineStart + tokenColumn - 1

      placeholders.push({
        kind: 'latex_inline',
        token: 'latex-inline',
        label: 'LaTeX 行内公式将在 Wasm 渲染器中占位',
        source: line,
        line: lineNo,
        column: tokenColumn,
        endLine: lineNo,
        endColumn: tokenColumn + token.length,
        startOffset: tokenOffset,
        endOffset: tokenOffset + token.length
      })
    }

    if (!hasLineEnd) {
      break
    }

    lineStart = lineEnd + 1
    lineNo += 1
  }

  return placeholders
}

async function loadModule(kind: MarkdownAssetKind): Promise<MarkdownModuleExports> {
  const asset = resolveMarkdownAsset(kind)
  const module = await loadEmscriptenModule<MarkdownModuleExports>(
    asset.moduleUrl,
    'createMarkdownModule',
    asset.wasmUrl,
    { print: () => {}, printErr: () => {} }
  )

  assert(module, `[markdown-wasm-runtime] failed to load module: ${kind}`)
  const raw = module as unknown as Record<string, unknown>

  return {
    ...module,
    _markdown_render: pickExport<(ptr: number, len: number, allowHtml: number, allowLatex: number, allowMermaid: number) => number>(raw, 'markdown_render', 'render_markdown'),
    _markdown_get_last_html_ptr: pickExport<() => number>(raw, 'markdown_get_last_html_ptr', 'get_last_html_ptr'),
    _markdown_get_last_html_len: pickExport<() => number>(raw, 'markdown_get_last_html_len', 'get_last_html_len'),
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
}

async function renderSnapshot(
  module: MarkdownModuleExports,
  kind: MarkdownAssetKind,
  source: string,
  flags: { allowLatex: boolean; allowMermaid: boolean }
): Promise<RenderSnapshot> {
  const normalized = normalizeSource(source)
  const bytes = new TextEncoder().encode(normalized)
  const alloc = module._markdown_alloc_buffer
  const free = module._markdown_free_buffer
  const render = module._markdown_render
  const getHtmlPtr = module._markdown_get_last_html_ptr
  const getHtmlLen = module._markdown_get_last_html_len
  const getFeaturesPtr = module._markdown_get_last_features_ptr
  const getFeaturesLen = module._markdown_get_last_features_len
  const getPlaceholdersPtr = module._markdown_get_last_placeholders_ptr
  const getPlaceholdersLen = module._markdown_get_last_placeholders_len
  const getRendererVersionPtr = module._markdown_get_last_renderer_version_ptr
  const getRendererVersionLen = module._markdown_get_last_renderer_version_len
  const getMetadataPtr = module._markdown_get_last_metadata_ptr
  const getMetadataLen = module._markdown_get_last_metadata_len

  assert(alloc && free && render, `[markdown-wasm-runtime] missing wasm exports: ${kind}`)
  assert(
    getHtmlPtr && getHtmlLen && getFeaturesPtr && getFeaturesLen &&
    getPlaceholdersPtr && getPlaceholdersLen && getRendererVersionPtr &&
    getRendererVersionLen && getMetadataPtr && getMetadataLen,
    `[markdown-wasm-runtime] missing snapshot exports: ${kind}`
  )

  const ptr = alloc(bytes.byteLength)
  assert(ptr > 0, `[markdown-wasm-runtime] alloc failed: ${kind}`)

  try {
    module.HEAPU8.set(bytes, ptr)
    const ok = render(ptr, bytes.byteLength, 0, flags.allowLatex ? 1 : 0, flags.allowMermaid ? 1 : 0)
    assert(ok === 1, `[markdown-wasm-runtime] render failed: ${kind}`)

    const html = readCString(module, getHtmlPtr(), getHtmlLen())
    const features = readJson<string[]>(readCString(module, getFeaturesPtr(), getFeaturesLen()), [])
    const placeholders = readJson<MarkdownPlaceholder[]>(readCString(module, getPlaceholdersPtr(), getPlaceholdersLen()), [])
    const rendererVersion = readCString(module, getRendererVersionPtr(), getRendererVersionLen())
    const metadata = readJson<MarkdownMetadata>(readCString(module, getMetadataPtr(), getMetadataLen()), {
      mode: 'article',
      baseUrl: '',
      allowHtml: false,
      allowLatex: flags.allowLatex,
      allowMermaid: flags.allowMermaid,
      sourceLength: normalized.length,
      sourceLineCount: normalized.split('\n').length,
      normalizedSourceLength: normalized.length,
      featureCount: features.length,
      placeholderCount: placeholders.length,
      rendererVersion
    })

    return { html, features, placeholders, rendererVersion, metadata }
  } finally {
    free(ptr)
  }
}

function assertCommonSnapshot(
  snapshot: RenderSnapshot,
  source: string,
  kind: MarkdownAssetKind,
  flags: { allowLatex: boolean; allowMermaid: boolean }
) {
  const normalized = normalizeSource(source)
  assert(snapshot.rendererVersion === MARKDOWN_RENDERER_VERSION, `[markdown-wasm-runtime] renderer version drift: ${kind}`)
  assert(snapshot.metadata.mode === 'article', `[markdown-wasm-runtime] unexpected mode: ${kind}`)
  assert(snapshot.metadata.baseUrl === '', `[markdown-wasm-runtime] unexpected baseUrl: ${kind}`)
  assert(snapshot.metadata.allowHtml === false, `[markdown-wasm-runtime] unexpected allowHtml: ${kind}`)
  assert(snapshot.metadata.allowLatex === flags.allowLatex, `[markdown-wasm-runtime] unexpected allowLatex: ${kind}`)
  assert(snapshot.metadata.allowMermaid === flags.allowMermaid, `[markdown-wasm-runtime] unexpected allowMermaid: ${kind}`)
  assert(snapshot.metadata.sourceLength === normalized.length, `[markdown-wasm-runtime] sourceLength drift: ${kind}`)
  assert(snapshot.metadata.normalizedSourceLength === normalized.length, `[markdown-wasm-runtime] normalizedSourceLength drift: ${kind}`)
  assert(snapshot.metadata.sourceLineCount === normalized.split('\n').length, `[markdown-wasm-runtime] sourceLineCount drift: ${kind}`)
  assert(snapshot.metadata.featureCount === snapshot.features.length, `[markdown-wasm-runtime] featureCount drift: ${kind}`)
  assert(snapshot.metadata.placeholderCount === snapshot.placeholders.length, `[markdown-wasm-runtime] placeholderCount drift: ${kind}`)
  assert(snapshot.metadata.rendererVersion === MARKDOWN_RENDERER_VERSION, `[markdown-wasm-runtime] metadata rendererVersion drift: ${kind}`)
}

async function assertMermaidRendering(module: MarkdownModuleExports, kind: MarkdownAssetKind) {
  const source = [
    '# Mermaid subset',
    '',
    '```mermaid',
    'flowchart LR;',
    'Start["Alpha Node"] --> Decision("Beta Branch");',
    'Decision --> End[Gamma End];',
    '```'
  ].join('\n')

  const snapshot = await renderSnapshot(module, kind, source, { allowLatex: true, allowMermaid: true })
  assertCommonSnapshot(snapshot, source, kind, { allowLatex: true, allowMermaid: true })
  assertDeepEqual(snapshot.features, ['code_block', 'mermaid', 'heading'], `[markdown-wasm-runtime] mermaid features drift: ${kind}`)
  assertDeepEqual(snapshot.placeholders, buildExpectedPlaceholders(source), `[markdown-wasm-runtime] mermaid placeholder metadata drift: ${kind}`)
  assertIncludes(snapshot.html, '<h1>Mermaid subset</h1>', `[markdown-wasm-runtime] mermaid heading missing: ${kind}`)
  assertIncludes(snapshot.html, 'class="markdown-renderer__mermaid" data-mermaid-rendered="true"', `[markdown-wasm-runtime] mermaid host missing: ${kind}`)
  assertIncludes(snapshot.html, '<svg class="mermaid" xmlns="http://www.w3.org/2000/svg"', `[markdown-wasm-runtime] mermaid svg missing: ${kind}`)
  assertIncludes(snapshot.html, 'role="img" aria-label="Mermaid diagram"', `[markdown-wasm-runtime] mermaid accessibility missing: ${kind}`)
  assertIncludes(snapshot.html, '<defs><marker id="arrow"', `[markdown-wasm-runtime] mermaid marker missing: ${kind}`)
  assertIncludes(snapshot.html, 'marker-end="url(#arrow)"', `[markdown-wasm-runtime] mermaid edge marker missing: ${kind}`)
  assertIncludes(snapshot.html, '>Alpha Node</text>', `[markdown-wasm-runtime] mermaid bracket label missing: ${kind}`)
  assertIncludes(snapshot.html, '>Beta Branch</text>', `[markdown-wasm-runtime] mermaid paren label missing: ${kind}`)
  assertIncludes(snapshot.html, '>Gamma End</text>', `[markdown-wasm-runtime] mermaid tail label missing: ${kind}`)
  assert(!snapshot.html.includes('data-mermaid-placeholder="true"'), `[markdown-wasm-runtime] mermaid unexpectedly fell back: ${kind}`)
}

async function assertLatexRendering(module: MarkdownModuleExports, kind: MarkdownAssetKind) {
  const source = [
    '# MathML subset',
    '',
    'Inline math: \\(x_1^2 + \\alpha\\) stays in the paragraph.',
    '',
    '$$',
    '\\frac{a_1^2 + \\sqrt{b}}{\\alpha + 2}',
    '$$'
  ].join('\n')

  const snapshot = await renderSnapshot(module, kind, source, { allowLatex: true, allowMermaid: true })
  assertCommonSnapshot(snapshot, source, kind, { allowLatex: true, allowMermaid: true })
  assertDeepEqual(snapshot.features, ['latex', 'heading'], `[markdown-wasm-runtime] latex features drift: ${kind}`)
  assertDeepEqual(snapshot.placeholders, buildExpectedPlaceholders(source), `[markdown-wasm-runtime] latex placeholder metadata drift: ${kind}`)
  assertIncludes(snapshot.html, '<h1>MathML subset</h1>', `[markdown-wasm-runtime] math heading missing: ${kind}`)
  assertIncludes(snapshot.html, 'Inline math: <span class="markdown-renderer__latex" data-latex-rendered="mathml"><math xmlns="http://www.w3.org/1998/Math/MathML">', `[markdown-wasm-runtime] inline math host missing: ${kind}`)
  assertIncludes(snapshot.html, '<div class="markdown-renderer__latex" data-latex-rendered="mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block">', `[markdown-wasm-runtime] block math host missing: ${kind}`)
  assertIncludes(snapshot.html, '<msubsup><mi>x</mi><mn>1</mn><mn>2</mn></msubsup>', `[markdown-wasm-runtime] inline msubsup missing: ${kind}`)
  assertIncludes(snapshot.html, '<mfrac>', `[markdown-wasm-runtime] mfrac missing: ${kind}`)
  assertIncludes(snapshot.html, '<msubsup><mi>a</mi><mn>1</mn><mn>2</mn></msubsup>', `[markdown-wasm-runtime] block msubsup missing: ${kind}`)
  assertIncludes(snapshot.html, '<msqrt><mi>b</mi></msqrt>', `[markdown-wasm-runtime] msqrt missing: ${kind}`)
  assertIncludes(snapshot.html, '<mi>&#x03B1;</mi>', `[markdown-wasm-runtime] greek symbol missing: ${kind}`)
  assertIncludes(snapshot.html, '<mo>+</mo>', `[markdown-wasm-runtime] operator emission missing: ${kind}`)
  assert(!snapshot.html.includes('data-latex-placeholder="true"'), `[markdown-wasm-runtime] latex unexpectedly fell back: ${kind}`)
}

async function assertPlaceholderMetadataStability(module: MarkdownModuleExports, kind: MarkdownAssetKind) {
  const source = [
    '# Placeholder drift',
    '',
    'Paragraph with inline math \\(x_1^2 + \\alpha\\) before disable path.',
    '',
    '```mermaid',
    'flowchart LR;',
    'A["Alpha"] --> B("Beta");',
    '```',
    '',
    '$$',
    '\\frac{m_1^2}{n}',
    '$$'
  ].join('\n')

  const expectedPlaceholders = buildExpectedPlaceholders(source)
  const enabledSnapshot = await renderSnapshot(module, kind, source, { allowLatex: true, allowMermaid: true })
  const disabledSnapshot = await renderSnapshot(module, kind, source, { allowLatex: false, allowMermaid: false })

  assertCommonSnapshot(enabledSnapshot, source, kind, { allowLatex: true, allowMermaid: true })
  assertCommonSnapshot(disabledSnapshot, source, kind, { allowLatex: false, allowMermaid: false })
  assertDeepEqual(enabledSnapshot.features, ['code_block', 'latex', 'mermaid', 'heading'], `[markdown-wasm-runtime] placeholder features drift: ${kind}`)
  assertDeepEqual(disabledSnapshot.features, enabledSnapshot.features, `[markdown-wasm-runtime] disabled feature detection drift: ${kind}`)
  assertDeepEqual(enabledSnapshot.placeholders, expectedPlaceholders, `[markdown-wasm-runtime] enabled placeholder metadata drift: ${kind}`)
  assertDeepEqual(disabledSnapshot.placeholders, expectedPlaceholders, `[markdown-wasm-runtime] disabled placeholder metadata drift: ${kind}`)
  assertDeepEqual(disabledSnapshot.placeholders, enabledSnapshot.placeholders, `[markdown-wasm-runtime] placeholder token/source/line drift: ${kind}`)
  assertIncludes(disabledSnapshot.html, '<p>Paragraph with inline math (x_1^2 + alpha) before disable path.</p>', `[markdown-wasm-runtime] disabled inline latex output drift: ${kind}`)
  assertIncludes(disabledSnapshot.html, '<pre class="shiki"><code class="language-mermaid">flowchart LR;\nA[&quot;Alpha&quot;] --&gt; B(&quot;Beta&quot;);\n</code></pre>', `[markdown-wasm-runtime] disabled mermaid fallback drift: ${kind}`)
  assertIncludes(disabledSnapshot.html, '<pre class="shiki"><code class="language-latex">\\frac{m_1^2}{n}\n</code></pre>', `[markdown-wasm-runtime] disabled latex fallback drift: ${kind}`)
  assert(!disabledSnapshot.html.includes('data-mermaid-rendered="true"'), `[markdown-wasm-runtime] disabled mermaid still rendered: ${kind}`)
  assert(!disabledSnapshot.html.includes('data-latex-rendered="mathml"'), `[markdown-wasm-runtime] disabled latex still rendered: ${kind}`)
}

async function renderWithKind(kind: MarkdownAssetKind): Promise<void> {
  const module = await loadModule(kind)
  await assertMermaidRendering(module, kind)
  await assertLatexRendering(module, kind)
  await assertPlaceholderMetadataStability(module, kind)
}

async function main() {
  await renderWithKind('basic')
  await renderWithKind('simd')
  console.log('[markdown-wasm-runtime] ok basic+simd mermaid+latex+metadata')
  process.exit(0)
}

main().catch((error) => {
  console.error('[markdown-wasm-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
