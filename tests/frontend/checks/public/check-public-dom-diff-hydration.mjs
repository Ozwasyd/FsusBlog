#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { decodePublicAotPayload } from '../../support/aeds-envelope.mjs'
import { PUBLIC_PAYLOAD_FIXTURES } from './check-public-payload-fixture-matrix.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

const DOM_DIFF_SCHEMA = 'fsusblog.public-hydration-dom-diff.v1'
const DOM_DIFF_SUMMARY_FILE = process.env.FSUSBLOG_PUBLIC_HYDRATION_DOM_DIFF_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-dom-diff-summary.json', import.meta.url))
const PUBLIC_SSR_BUNDLE_FILE = fileURLToPath(new URL('../../../../src/frontend/dist/server/public-ssr.mjs', import.meta.url))
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate))

const REQUIRED_PAGE_KINDS = ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright']
const COMPARED_ATTRIBUTE_TOKENS = [
  'id',
  'class',
  'href',
  'src',
  'alt',
  'title',
  'datetime',
  'role',
  'itemprop',
  'itemtype',
  'aria-',
  'data-public-',
  'data-aot-action',
  'data-aot-value',
  'data-related-role',
  'data-dynamic-island',
  'data-home-hot-articles-aside',
]
const EXACT_ATTRIBUTES = new Set(COMPARED_ATTRIBUTE_TOKENS.filter((token) => !token.endsWith('-')))

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function writeSummary(summary) {
  mkdirSync(dirname(DOM_DIFF_SUMMARY_FILE), { recursive: true })
  writeFileSync(DOM_DIFF_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}

function installSsrDomGlobals() {
  if (typeof globalThis.Element === 'undefined') {
    globalThis.Element = class Element {}
  }
  if (typeof globalThis.HTMLElement === 'undefined') {
    globalThis.HTMLElement = class HTMLElement extends globalThis.Element {}
  }
  if (typeof globalThis.SVGElement === 'undefined') {
    globalThis.SVGElement = class SVGElement extends globalThis.Element {}
  }
  if (typeof globalThis.ShadowRoot === 'undefined') {
    globalThis.ShadowRoot = class ShadowRoot extends globalThis.Element {}
  }
}

async function loadSsrBundle() {
  assert(existsSync(PUBLIC_SSR_BUNDLE_FILE), `missing public SSR bundle: ${PUBLIC_SSR_BUNDLE_FILE}`)
  installSsrDomGlobals()
  const bundle = await import(pathToFileURL(PUBLIC_SSR_BUNDLE_FILE).href)
  assert(typeof bundle.buildPublicEntry === 'function', 'public SSR bundle missing buildPublicEntry')
  assert(typeof bundle.renderPublicHydrationSnapshot === 'function', 'public SSR bundle missing renderPublicHydrationSnapshot')
  return bundle
}

function buildDocument(fragment) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>DOM diff</title></head>
<body><div id="app">${fragment}</div></body>
</html>`
}

async function readNormalizedTree(page, fragment) {
  await page.setContent(buildDocument(fragment), { waitUntil: 'domcontentloaded' })
  return await page.evaluate((comparedAttributeTokens) => {
    const exactAttributes = new Set(comparedAttributeTokens.filter((token) => !token.endsWith('-')))
    const prefixAttributes = comparedAttributeTokens.filter((token) => token.endsWith('-'))

    function normalizeText(value) {
      return String(value ?? '').replace(/\s+/gu, ' ').trim()
    }

    function shouldKeepAttribute(name) {
      if (name.startsWith('data-v-')) {
        return false
      }
      if (exactAttributes.has(name)) {
        return true
      }
      return prefixAttributes.some((prefix) => name.startsWith(prefix))
    }

    function normalizeAttributes(element) {
      const attributes = {}
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name
        if (!shouldKeepAttribute(name)) {
          continue
        }
        const value = name === 'class'
          ? normalizeText(attribute.value)
          : attribute.value
        attributes[name] = value
      }
      return Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)))
    }

    function normalizeDomNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = normalizeText(node.textContent)
        return text ? { type: 'text', text } : null
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return null
      }

      const element = node
      const children = []
      for (const child of Array.from(element.childNodes)) {
        const normalized = normalizeDomNode(child)
        if (normalized) {
          children.push(normalized)
        }
      }

      return {
        type: 'element',
        tag: element.tagName.toLowerCase(),
        attributes: normalizeAttributes(element),
        children,
      }
    }

    return normalizeDomNode(document.querySelector('#app'))
  }, COMPARED_ATTRIBUTE_TOKENS)
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function buildChildPath(parentPath, child, index) {
  if (child?.type === 'element') {
    const id = child.attributes?.id ? `#${child.attributes.id}` : ''
    return `${parentPath} > ${child.tag}${id}[${index}]`
  }
  return `${parentPath} > text[${index}]`
}

function recordDiff(diffs, path, kind, expected, actual) {
  diffs.push({
    path,
    kind,
    expected,
    actual,
  })
}

function compareNormalizedTrees(expected, actual, path = '#app', diffs = []) {
  if (!expected || !actual) {
    if (expected || actual) {
      recordDiff(diffs, path, 'node-presence', expected?.type ?? null, actual?.type ?? null)
    }
    return diffs
  }

  if (expected.type !== actual.type) {
    recordDiff(diffs, path, 'node-type', expected.type, actual.type)
    return diffs
  }

  if (expected.type === 'text') {
    if (expected.text !== actual.text) {
      recordDiff(diffs, path, 'text', expected.text, actual.text)
    }
    return diffs
  }

  if (expected.tag !== actual.tag) {
    recordDiff(diffs, path, 'tag', expected.tag, actual.tag)
  }

  const expectedAttributes = expected.attributes ?? {}
  const actualAttributes = actual.attributes ?? {}
  const attributeNames = Array.from(new Set([...Object.keys(expectedAttributes), ...Object.keys(actualAttributes)])).sort()
  for (const name of attributeNames) {
    if (expectedAttributes[name] !== actualAttributes[name]) {
      recordDiff(diffs, `${path}.${name}`, 'attribute', expectedAttributes[name] ?? null, actualAttributes[name] ?? null)
    }
  }

  const expectedChildren = expected.children ?? []
  const actualChildren = actual.children ?? []
  if (expectedChildren.length !== actualChildren.length) {
    recordDiff(diffs, `${path}.children`, 'child-count', expectedChildren.length, actualChildren.length)
  }

  const childCount = Math.max(expectedChildren.length, actualChildren.length)
  for (let index = 0; index < childCount; index += 1) {
    compareNormalizedTrees(
      expectedChildren[index] ?? null,
      actualChildren[index] ?? null,
      buildChildPath(path, expectedChildren[index] ?? actualChildren[index], index),
      diffs
    )
  }

  return diffs
}

function mutateFirstTextNode(node) {
  if (!node) {
    return false
  }
  if (node.type === 'text') {
    node.text = `${node.text} __dom_diff_canary__`
    return true
  }
  for (const child of node.children ?? []) {
    if (mutateFirstTextNode(child)) {
      return true
    }
  }
  return false
}

function runTextMismatchCanary(referenceTree) {
  const mutated = cloneJson(referenceTree)
  assert(mutateFirstTextNode(mutated), 'text mismatch canary could not find a text node')
  const diffs = compareNormalizedTrees(referenceTree, mutated)
  assert(diffs.length > 0, 'text mismatch canary did not fail the diff harness')
  return {
    status: 'success',
    diffCount: diffs.length,
    firstDiff: diffs[0],
  }
}

function countNodes(node) {
  if (!node) {
    return 0
  }
  return 1 + (node.children ?? []).reduce((total, child) => total + countNodes(child), 0)
}

async function runCase(bundle, page, fixture) {
  const result = await bundle.buildPublicEntry(fixture.kind, fixture.options)
  const entry = result.entry
  const hydrationPayload = decodePublicAotPayload(entry.hydrationPropsPayload)
  const hydrationHtml = await bundle.renderPublicHydrationSnapshot(hydrationPayload)
  const ssrTree = await readNormalizedTree(page, entry.html)
  const csrTree = await readNormalizedTree(page, hydrationHtml)
  const diffs = compareNormalizedTrees(ssrTree, csrTree)

  return {
    id: fixture.id,
    route: fixture.route,
    routeKey: entry.routeKey,
    pageKind: fixture.kind,
    status: diffs.length === 0 ? 'success' : 'failure',
    diffCount: diffs.length,
    firstDiff: diffs[0] ?? null,
    comparedAttributes: COMPARED_ATTRIBUTE_TOKENS,
    normalizedNodeCount: {
      ssr: countNodes(ssrTree),
      csr: countNodes(csrTree),
    },
    dimensions: fixture.dimensions,
    ssrTree,
    csrTree,
  }
}

async function main() {
  const summary = {
    schema: DOM_DIFF_SCHEMA,
    status: 'failure',
    generatedAt: new Date().toISOString(),
    allowlist: {
      cspNonce: true,
      generatedAssetHashes: true,
      whitespaceOnlyTextNodes: true,
      note: 'runtime-only islands are allowlisted explicitly',
    },
    coverage: {
      pageKinds: [],
      missingPageKinds: REQUIRED_PAGE_KINDS,
      fixtureCount: 0,
    },
    canary: null,
    cases: [],
  }

  let browser
  try {
    const bundle = await loadSsrBundle()
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(executablePath ? { executablePath } : {}),
    })
    const page = await browser.newPage()
    const pageKinds = new Set()

    for (const fixture of PUBLIC_PAYLOAD_FIXTURES) {
      process.stdout.write(`Testing DOM diff ${fixture.id}... `)
      const row = await runCase(bundle, page, fixture)
      summary.cases.push({
        ...row,
        ssrTree: undefined,
        csrTree: undefined,
      })
      pageKinds.add(row.pageKind)
      if (!summary.canary) {
        summary.canary = runTextMismatchCanary(row.ssrTree)
      }
      assert(row.diffCount === 0, `${fixture.id} DOM diff mismatch at ${row.firstDiff?.path}: ${row.firstDiff?.kind}`)
      process.stdout.write('PASS\n')
    }

    summary.coverage.pageKinds = Array.from(pageKinds).sort()
    summary.coverage.missingPageKinds = REQUIRED_PAGE_KINDS.filter((kind) => !pageKinds.has(kind))
    summary.coverage.fixtureCount = summary.cases.length
    assert(summary.coverage.missingPageKinds.length === 0, `missing DOM diff page kinds: ${summary.coverage.missingPageKinds.join(', ')}`)
    assert(summary.canary?.status === 'success' && summary.canary.diffCount > 0, 'deliberate text mismatch canary failed')

    summary.status = 'success'
    writeSummary(summary)
    console.log(`[public-dom-diff-hydration] ok (${summary.cases.length} case(s)); summary=${DOM_DIFF_SUMMARY_FILE}`)
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
    writeSummary(summary)
    console.error(`[public-dom-diff-hydration] failed: ${summary.error}`)
    process.exit(1)
  } finally {
    await browser?.close()
  }
}

main()
