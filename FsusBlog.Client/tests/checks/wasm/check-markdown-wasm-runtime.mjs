#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function readCString(module, ptr, len) {
  if (ptr <= 0 || len <= 0) {
    return ''
  }

  const memory = module.memory ?? (module.HEAPU8 ? { buffer: module.HEAPU8.buffer } : null)
  if (!memory) {
    throw new Error('[markdown-wasm-runtime] module memory unavailable')
  }

  const view = new Uint8Array(memory.buffer, ptr, len)
  return new TextDecoder().decode(view)
}

function pickExport(raw, name) {
  const direct = raw[name]
  if (direct) {
    return direct
  }

  const underscored = raw[`_${name}`]
  if (underscored) {
    return underscored
  }

  throw new Error(`wasm_export_missing:${name}`)
}

function resolveMarkdownAsset(kind) {
  const fileBase = kind === 'simd' ? 'markdown_simd' : 'markdown_basic'
  const cwd = process.cwd().replace(/\\/g, '/').replace(/\/+$/, '')
  return {
    moduleUrl: pathToFileURL(`${cwd}/public/wasm/${fileBase}.js`).href,
    wasmUrl: pathToFileURL(`${cwd}/public/wasm/${fileBase}.wasm`).href
  }
}

async function loadMarkdownModule(kind) {
  const asset = resolveMarkdownAsset(kind)
  const moduleRef = await import(asset.moduleUrl)
  const factory = moduleRef.default ?? moduleRef.createMarkdownModule
  assert(typeof factory === 'function', `[markdown-wasm-runtime] missing factory: ${kind}`)
  return await factory({
    locateFile: (path) => path.endsWith('.wasm') ? asset.wasmUrl : path,
    print: () => {},
    printErr: () => {}
  })
}

async function renderWithKind(kind) {
  const module = await loadMarkdownModule(kind)
  const raw = module

  const render = pickExport(raw, 'markdown_render')
  const getHtmlPtr = pickExport(raw, 'markdown_get_last_html_ptr')
  const getHtmlLen = pickExport(raw, 'markdown_get_last_html_len')
  const getFeaturesPtr = pickExport(raw, 'markdown_get_last_features_ptr')
  const getFeaturesLen = pickExport(raw, 'markdown_get_last_features_len')
  const getPlaceholdersPtr = pickExport(raw, 'markdown_get_last_placeholders_ptr')
  const getPlaceholdersLen = pickExport(raw, 'markdown_get_last_placeholders_len')
  const getRendererVersionPtr = pickExport(raw, 'markdown_get_last_renderer_version_ptr')
  const getRendererVersionLen = pickExport(raw, 'markdown_get_last_renderer_version_len')
  const getMetadataPtr = pickExport(raw, 'markdown_get_last_metadata_ptr')
  const getMetadataLen = pickExport(raw, 'markdown_get_last_metadata_len')
  const alloc = pickExport(raw, 'markdown_alloc_buffer')
  const free = pickExport(raw, 'markdown_free_buffer')

  const source = [
    '# Markdown Wasm',
    '',
    'Paragraph with [link](https://example.com), `code`, **strong**, *emphasis*, ***combo***, inline math \\(x^2\\), and mermaid/latex placeholders.',
    '',
    '- item one',
    '- item two',
    '',
    '```mermaid',
    'flowchart LR;',
    'A[Start Node]-->B(Mid Step)-->C[Finish Node];',
    '```',
    '',
    '$$',
    '\\sum_{i=1}^{n} \\frac{1}{n}',
    '$$'
  ].join('\n')

  const bytes = new TextEncoder().encode(source)
  const ptr = alloc(bytes.byteLength)
  assert(ptr > 0, `[markdown-wasm-runtime] alloc failed: ${kind}`)

  try {
    module.HEAPU8.set(bytes, ptr)
    const ok = render(ptr, bytes.byteLength, 0, 1, 1)
    assert(ok === 1, `[markdown-wasm-runtime] render failed: ${kind}`)

    const html = readCString(module, getHtmlPtr(), getHtmlLen())
    const features = readCString(module, getFeaturesPtr(), getFeaturesLen())
    const placeholders = readCString(module, getPlaceholdersPtr(), getPlaceholdersLen())
    const rendererVersion = readCString(module, getRendererVersionPtr(), getRendererVersionLen())
    const metadata = readCString(module, getMetadataPtr(), getMetadataLen())

    assert(html.includes('<h1>Markdown Wasm</h1>'), `[markdown-wasm-runtime] missing heading: ${kind}`)
    assert(html.includes('<a href="https://example.com"'), `[markdown-wasm-runtime] missing link: ${kind}`)
    assert(html.includes('<code>code</code>'), `[markdown-wasm-runtime] missing inline code: ${kind}`)
    assert(html.includes('<strong>strong</strong>'), `[markdown-wasm-runtime] missing strong emphasis: ${kind}`)
    assert(html.includes('<em>emphasis</em>'), `[markdown-wasm-runtime] missing em emphasis: ${kind}`)
    assert(html.includes('<strong><em>combo</em></strong>'), `[markdown-wasm-runtime] missing combined emphasis: ${kind}`)
    assert(html.includes('markdown-renderer__mermaid'), `[markdown-wasm-runtime] missing mermaid host: ${kind}`)
    assert(html.includes('data-mermaid-rendered="true"'), `[markdown-wasm-runtime] missing rendered mermaid marker: ${kind}`)
    assert(html.includes('<svg class="mermaid"'), `[markdown-wasm-runtime] missing mermaid svg: ${kind}`)
    assert(!html.includes('data-mermaid-placeholder="true"'), `[markdown-wasm-runtime] mermaid unexpectedly fell back to placeholder: ${kind}`)
    assert(html.includes('markdown-renderer__latex'), `[markdown-wasm-runtime] missing latex host: ${kind}`)
    assert(html.includes('data-latex-rendered="mathml"'), `[markdown-wasm-runtime] missing rendered latex marker: ${kind}`)
    assert(html.includes('<math xmlns="http://www.w3.org/1998/Math/MathML"'), `[markdown-wasm-runtime] missing mathml output: ${kind}`)
    assert(features.includes('mermaid') && features.includes('latex') && features.includes('emphasis'), `[markdown-wasm-runtime] missing feature metadata: ${kind}`)
    assert(placeholders.includes('mermaid_block') && placeholders.includes('latex_block'), `[markdown-wasm-runtime] missing placeholder metadata: ${kind}`)
    assert(rendererVersion.length > 0, `[markdown-wasm-runtime] missing renderer version: ${kind}`)
    assert(metadata.includes('"mode"'), `[markdown-wasm-runtime] missing metadata: ${kind}`)
    assert(metadata.includes('"featureCount"'), `[markdown-wasm-runtime] missing metadata counts: ${kind}`)
  } finally {
    free(ptr)
  }
}

async function main() {
  await renderWithKind('basic')
  await renderWithKind('simd')
  console.log('[markdown-wasm-runtime] ok basic+simd')
}

main().catch((error) => {
  console.error('[markdown-wasm-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
