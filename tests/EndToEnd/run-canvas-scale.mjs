import assert from 'node:assert/strict'
import { requireWebPackage } from './web-package-fixture.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cpus } from 'node:os'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, encodeArticleCommand, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exerciseCanvasScale } from './canvas-scale-flow.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { chromium } = requireWebPackage('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const bootstrap = process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP
const otherBootstrap = process.env.FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP
const evidenceDir = process.env.FSUSBLOG_TEST_EVIDENCE
assert(bootstrap && otherBootstrap && evidenceDir)
const startedAt = new Date().toISOString()
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
context.setDefaultTimeout(30_000)
const page = await context.newPage()
const observations = []
const diagnostics = []
let failure
let result
let served
let harnessDigests

function monitor(tab) {
  tab.on('pageerror', error => diagnostics.push(error.message))
  tab.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) diagnostics.push(message.text())
  })
}
monitor(page)
try {
  // Artifacts contain hashes of served resources and non-secret machine/version metadata.
  const htmlResponse = await page.request.get(origin + '/admin/canvas')
  assert.equal(htmlResponse.status(), 200)
  const html = await htmlResponse.text()
  const jsAsset = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1]
  assert(jsAsset)
  const js = await page.request.get(new URL(jsAsset, origin).href)
  assert.equal(js.status(), 200)
  const digest = value => createHash('sha256').update(value).digest('hex')
  served = { html: digest(html), [jsAsset]: digest(await js.body()) }
  const sourceFiles = [
    'tests/EndToEnd/run-canvas-scale.mjs', 'tests/EndToEnd/canvas-scale-flow.mjs',
    'tests/EndToEnd/canvas-scale-corpus.mjs', 'tests/EndToEnd/canvas-scale-verify.sql', 'tests/EndToEnd/run-native.sh',
    'tests/EndToEnd/webauthn-fixture.mjs',
  ]
  harnessDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, digest(await readFile(path))])))

  await signInFreshAdmin(page, origin, bootstrap)

  async function article(action, draft) {
    const body = encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({
      id: draft.id ?? 0, expectedRevision: draft.revision ?? 0n, idempotencyKey: randomUUID(),
      title: draft.title ?? '', body: draft.body ?? '',
    }))
    const response = await page.request.post(origin + WireRoutes[action], {
      data: Buffer.from(body), headers: { 'Content-Type': 'application/octet-stream' },
    })
    assert.equal(response.status(), 200)
    return decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
  }

  result = await exerciseCanvasScale({
    page, origin, evidenceDir, observations, monitor,
    async outsider() {
      const browserContext = await browser.newContext()
      const outsider = await browserContext.newPage()
      monitor(outsider)
      try {
        await signInFreshAdmin(outsider, origin, otherBootstrap)
        return { request: outsider.request, close: () => browserContext.close() }
      } catch (cause) {
        await browserContext.close()
        throw cause
      }
    },
    createDraft: (title, body) => article('Save', { title, body }),
    publishDraft: ({ id, revision }) => article('Publish', { id, revision }),
    screenshot: (tab, name) => tab.screenshot({ path: join(evidenceDir, name + '.png') }),
  })
  assert.deepEqual(diagnostics, [])
} catch (cause) {
  failure = String(cause?.stack ?? cause)
  await page.screenshot({ path: join(evidenceDir, 'canvas-scale-failed.png'), fullPage: true }).catch(() => {})
} finally {
  await context.close()
  await browser.close()
  await writeFile(join(evidenceDir, 'canvas-scale-result.json'), JSON.stringify({
    startedAt, completedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model, node: process.version,
    chromium: browser.version(), served, harnessDigests,
    observations, diagnostics, failure: failure ?? null, result,
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n')
}
if (failure) throw new Error(failure)
console.log(observations.join('\n'))
