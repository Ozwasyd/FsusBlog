#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const adapterFile = path.join(root, 'src/frontend/src/components/ui/MarkdownEditorAdapter.vue')
const activationFile = path.join(root, 'src/frontend/src/services/markdownActivationService.ts')
const outFile = path.join(root, '.tmp/frontend/markdown-render-budget.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/frontend-render-pressure-summary.json')

const corpus = {
  headings: Array.from({ length: 100 }, (_, index) => `# Heading ${index}`).join('\n'),
  codeBlocks: Array.from({ length: 100 }, (_, index) => `\`\`\`ts\nconst value${index} = "${'x'.repeat(120)}"\n\`\`\``).join('\n'),
  latexBlocks: Array.from({ length: 20 }, (_, index) => `$$ a_${index} + b_${index} = c_${index} $$`).join('\n'),
  mermaidDiagrams: Array.from({ length: 10 }, (_, index) => `\`\`\`mermaid\ngraph LR; A${index}-->B${index};\n\`\`\``).join('\n'),
  longLines: Array.from({ length: 50 }, () => 'x'.repeat(240)).join('\n'),
  listItems: Array.from({ length: 1000 }, (_, index) => `- item ${index}`).join('\n'),
  mixed: '中文 / emoji ✨ / RTL مثال / English / `inline code`'
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function estimateNodes(markdown) {
  return markdown.split(/\r?\n/u).length
    + (markdown.match(/^#{1,6}\s+/gmu) ?? []).length * 2
    + (markdown.match(/```/g) ?? []).length * 30
    + (markdown.match(/^\s*[-*+]\s+/gmu) ?? []).length * 2
}

function writeReleaseSummary(summary) {
  ensureDir(path.dirname(releaseSummaryFile))
  const existing = fs.existsSync(releaseSummaryFile)
    ? JSON.parse(fs.readFileSync(releaseSummaryFile, 'utf8'))
    : { status: 'ok', generatedAt: new Date().toISOString(), artifacts: {} }
  const next = {
    ...existing,
    status: existing.status === 'failed' || summary.status === 'failed' ? 'failed' : 'ok',
    generatedAt: new Date().toISOString(),
    markdownRenderBudget: {
      status: summary.status,
      corpusBytes: summary.corpusBytes,
      estimatedNodes: summary.estimatedNodes,
      artifact: relative(outFile)
    },
    artifacts: {
      ...(existing.artifacts ?? {}),
      markdownRenderBudget: relative(outFile)
    }
  }
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify(next, null, 2)}\n`)
}

const adapter = read(adapterFile)
const activation = read(activationFile)
const combinedCorpus = Object.values(corpus).join('\n\n')
const requirements = [
  ['preview debounced at 250ms', adapter.includes('MARKDOWN_PREVIEW_DEBOUNCE_MS = 250')],
  ['large document byte threshold', adapter.includes('LARGE_PREVIEW_CONTENT_BYTES = 80 * 1024')],
  ['large document node threshold', adapter.includes('LARGE_PREVIEW_NODE_ESTIMATE = 3000')],
  ['preview pane uses v-if', /v-if="isPreviewMounted"/u.test(adapter)],
  ['manual refresh for stale large preview', adapter.includes('refreshManualPreview')],
  ['CSS content visibility containment', adapter.includes('content-visibility: auto') && adapter.includes('contain-intrinsic-size: 900px')],
  ['single TreeWalker markdown scan', activation.includes('createTreeWalker') && activation.includes('collectMarkdownFeatureTargets')],
  ['chunked activation scheduler', activation.includes('processInChunks') && activation.includes('yieldToBrowser')],
  ['Shiki HTML cache', activation.includes('shikiHtmlCache') && activation.includes('rememberShikiHtml')],
  ['Mermaid render budget', activation.includes('MERMAID_RENDER_BUDGET')]
]
const failures = requirements.filter(([, ok]) => !ok).map(([label]) => label)
const summary = {
  status: failures.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  corpusBytes: Buffer.byteLength(combinedCorpus, 'utf8'),
  estimatedNodes: estimateNodes(combinedCorpus),
  renderMsBudget: 420,
  activationMsBudget: 180,
  longTaskBudget: 2,
  requirements: Object.fromEntries(requirements),
  failures
}

ensureDir(path.dirname(outFile))
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
writeReleaseSummary(summary)

if (summary.status !== 'ok') {
  for (const failure of failures) {
    console.error(`[markdown-render-budget] missing: ${failure}`)
  }
  process.exit(1)
}
console.log(`[markdown-render-budget] ok corpusBytes=${summary.corpusBytes} estimatedNodes=${summary.estimatedNodes}`)
