#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import {
  buildMarkdownExtremeCorpus,
  describeMarkdownExtremeCorpus,
  normalizeMarkdownSource,
  normalizeMarkdownExtremeSize
} from '../../support/markdown-extreme-corpus.mjs'

const renderBudgetMs = Number(process.env.FSUSBLOG_MARKDOWN_EXTREME_RENDER_MS || '20000')
const targetSize = normalizeMarkdownExtremeSize(process.env.FSUSBLOG_MARKDOWN_EXTREME_SIZE)

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
    throw new Error('[markdown-extreme] module memory unavailable')
  }

  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
}

function readJson(raw, fallback, label) {
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`[markdown-extreme] invalid ${label} json: ${error instanceof Error ? error.message : String(error)}`)
  }
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
  assert(typeof factory === 'function', `[markdown-extreme] missing factory: ${kind}`)
  return await factory({
    locateFile: (path) => path.endsWith('.wasm') ? asset.wasmUrl : path,
    print: () => {},
    printErr: () => {}
  })
}

async function renderSnapshot(module, kind, source, flags) {
  const raw = module
  const render = pickExport(raw, 'markdown_render')
  const getHtmlPtr = pickExport(raw, 'markdown_get_last_html_ptr')
  const getHtmlLen = pickExport(raw, 'markdown_get_last_html_len')
  const getFeaturesPtr = pickExport(raw, 'markdown_get_last_features_ptr')
  const getFeaturesLen = pickExport(raw, 'markdown_get_last_features_len')
  const getPlaceholdersPtr = pickExport(raw, 'markdown_get_last_placeholders_ptr')
  const getPlaceholdersLen = pickExport(raw, 'markdown_get_last_placeholders_len')
  const getMetadataPtr = pickExport(raw, 'markdown_get_last_metadata_ptr')
  const getMetadataLen = pickExport(raw, 'markdown_get_last_metadata_len')
  const alloc = pickExport(raw, 'markdown_alloc_buffer')
  const free = pickExport(raw, 'markdown_free_buffer')
  const normalized = normalizeMarkdownSource(source)
  const bytes = new TextEncoder().encode(normalized)
  const ptr = alloc(bytes.byteLength)
  assert(ptr > 0, `[markdown-extreme] alloc failed: ${kind}`)

  const startedAt = performance.now()
  try {
    module.HEAPU8.set(bytes, ptr)
    const ok = render(ptr, bytes.byteLength, 0, flags.allowLatex ? 1 : 0, flags.allowMermaid ? 1 : 0)
    const elapsedMs = performance.now() - startedAt
    assert(ok === 1, `[markdown-extreme] render failed: ${kind}/${flags.label}`)
    assert(elapsedMs <= renderBudgetMs, `[markdown-extreme] ${kind}/${flags.label} exceeded budget ${elapsedMs.toFixed(1)}ms > ${renderBudgetMs}ms`)

    const html = readCString(module, getHtmlPtr(), getHtmlLen())
    const features = readJson(readCString(module, getFeaturesPtr(), getFeaturesLen()), [], 'features')
    const placeholders = readJson(readCString(module, getPlaceholdersPtr(), getPlaceholdersLen()), [], 'placeholders')
    const metadata = readJson(readCString(module, getMetadataPtr(), getMetadataLen()), {}, 'metadata')
    return { html, features, placeholders, metadata, elapsedMs }
  } finally {
    free(ptr)
  }
}

function assertSanitized(html, kind, label) {
  assert(!html.includes('<script>alert'), `[markdown-extreme] unsafe script leaked: ${kind}/${label}`)
  assert(!html.includes('<img src=x onerror='), `[markdown-extreme] unsafe img leaked: ${kind}/${label}`)
  assert(!html.includes('<iframe src="javascript:'), `[markdown-extreme] unsafe iframe leaked: ${kind}/${label}`)
  assert(html.includes('&lt;script&gt;') || html.includes('&lt;iframe'), `[markdown-extreme] dangerous html probes should be escaped: ${kind}/${label}`)
}

function assertSnapshot(snapshot, source, kind, flags) {
  const normalized = normalizeMarkdownSource(source)
  const byteLength = Buffer.byteLength(normalized, 'utf8')
  assert(snapshot.metadata.sourceLength === byteLength, `[markdown-extreme] sourceLength drift: ${kind}/${flags.label}`)
  assert(snapshot.metadata.normalizedSourceLength === byteLength, `[markdown-extreme] normalizedSourceLength drift: ${kind}/${flags.label}`)
  assert(snapshot.metadata.sourceLineCount === normalized.split('\n').length, `[markdown-extreme] lineCount drift: ${kind}/${flags.label}`)
  assert(snapshot.metadata.allowLatex === flags.allowLatex, `[markdown-extreme] allowLatex drift: ${kind}/${flags.label}`)
  assert(snapshot.metadata.allowMermaid === flags.allowMermaid, `[markdown-extreme] allowMermaid drift: ${kind}/${flags.label}`)
  assert(snapshot.metadata.featureCount === snapshot.features.length, `[markdown-extreme] featureCount drift: ${kind}/${flags.label}`)
  assert(snapshot.metadata.placeholderCount === snapshot.placeholders.length, `[markdown-extreme] placeholderCount drift: ${kind}/${flags.label}`)
  assert(snapshot.features.includes('heading'), `[markdown-extreme] heading feature missing: ${kind}/${flags.label}`)
  assert(snapshot.features.includes('latex'), `[markdown-extreme] latex feature missing: ${kind}/${flags.label}`)
  assert(snapshot.features.includes('mermaid'), `[markdown-extreme] mermaid feature missing: ${kind}/${flags.label}`)
  assert(snapshot.features.includes('table'), `[markdown-extreme] table feature missing: ${kind}/${flags.label}`)
  assert(snapshot.features.includes('link'), `[markdown-extreme] link feature missing: ${kind}/${flags.label}`)
  assert(snapshot.placeholders.some((item) => item.kind === 'latex_inline'), `[markdown-extreme] inline latex placeholder missing: ${kind}/${flags.label}`)
  assert(snapshot.placeholders.some((item) => item.kind === 'latex_block'), `[markdown-extreme] block latex placeholder missing: ${kind}/${flags.label}`)
  assert(snapshot.placeholders.some((item) => item.kind === 'mermaid_block'), `[markdown-extreme] mermaid placeholder missing: ${kind}/${flags.label}`)
  assertSanitized(snapshot.html, kind, flags.label)

  if (flags.allowLatex) {
    assert(snapshot.html.includes('data-latex-rendered="mathml"'), `[markdown-extreme] rendered latex missing: ${kind}/${flags.label}`)
  } else {
    assert(!snapshot.html.includes('data-latex-rendered="mathml"'), `[markdown-extreme] disabled latex rendered unexpectedly: ${kind}/${flags.label}`)
  }

  if (flags.allowMermaid) {
    assert(snapshot.html.includes('data-mermaid-rendered="true"') || snapshot.html.includes('data-mermaid-placeholder="true"'), `[markdown-extreme] mermaid output missing: ${kind}/${flags.label}`)
  } else {
    assert(!snapshot.html.includes('data-mermaid-rendered="true"'), `[markdown-extreme] disabled mermaid rendered unexpectedly: ${kind}/${flags.label}`)
  }
}

async function assertKind(kind, source) {
  const module = await loadMarkdownModule(kind)
  const enabled = await renderSnapshot(module, kind, source, { label: 'enabled', allowLatex: true, allowMermaid: true })
  const disabled = await renderSnapshot(module, kind, source, { label: 'disabled', allowLatex: false, allowMermaid: false })

  assertSnapshot(enabled, source, kind, { label: 'enabled', allowLatex: true, allowMermaid: true })
  assertSnapshot(disabled, source, kind, { label: 'disabled', allowLatex: false, allowMermaid: false })
  assert(JSON.stringify(enabled.features) === JSON.stringify(disabled.features), `[markdown-extreme] feature detection should not depend on enabled flags: ${kind}`)
  assert(enabled.placeholders.length === disabled.placeholders.length, `[markdown-extreme] placeholder count should not depend on enabled flags: ${kind}`)
  console.log(`[markdown-extreme] ok ${kind} | enabled=${enabled.elapsedMs.toFixed(1)}ms disabled=${disabled.elapsedMs.toFixed(1)}ms`)
}

async function main() {
  const source = buildMarkdownExtremeCorpus(targetSize)
  const stats = describeMarkdownExtremeCorpus(source)
  assert(stats.length >= targetSize, `[markdown-extreme] generated corpus too small: ${stats.length}`)
  assert(stats.hasMermaid && stats.hasLatex && stats.hasDangerousHtmlProbe, '[markdown-extreme] corpus missing required probes')

  await assertKind('basic', source)
  await assertKind('simd', source)
  console.log(`[markdown-extreme] ok | chars=${stats.length} bytes=${stats.byteLength} lines=${stats.lineCount} hash=${stats.hash}`)
}

main().catch((error) => {
  console.error('[markdown-extreme] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
