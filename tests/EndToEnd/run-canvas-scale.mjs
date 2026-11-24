import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { sha256Hex } from './admin-workspace-fixture.mjs'
import { authorFixture } from './browser-authoring-fixture.mjs'
import { exerciseCanvasScale } from './canvas-scale-flow.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const bootstrap = process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP
const otherBootstrap = process.env.FSUSBLOG_TEST_OUTSIDER_BOOTSTRAP
const evidenceDir = process.env.FSUSBLOG_TEST_EVIDENCE
assert(bootstrap && otherBootstrap && evidenceDir)
const startedAt = new Date().toISOString()
const browser = await isolated.launchChrome()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
context.setDefaultTimeout(30_000)
const page = await context.newPage()
const observations = []
const diagnostics = []
const author = authorFixture(origin, diagnostics)
author.monitor(page)
let result, served, harnessDigests

await isolated.withBrowserEvidence(
  browser,
  evidenceDir,
  'canvas-scale-result.json',
  failure => ({
    startedAt, completedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    cpu: cpus()[0]?.model, node: process.version, chromium: browser.version(), served, harnessDigests,
    observations, diagnostics, failure: failure ? String(failure?.stack ?? failure) : null, result,
  }),
  async () => {
    // Artifacts contain hashes of served resources and non-secret machine/version metadata.
    const htmlResponse = await page.request.get(origin + '/admin/canvas')
    assertStatus(htmlResponse, 200)
    const html = await htmlResponse.text()
    const jsAsset = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1]
    assert(jsAsset)
    const js = await page.request.get(new URL(jsAsset, origin).href)
    assertStatus(js, 200)
    served = { html: sha256Hex(html), [jsAsset]: sha256Hex(await js.body()) }
    const sourceFiles = [
      'tests/EndToEnd/run-canvas-scale.mjs', 'tests/EndToEnd/canvas-scale-flow.mjs',
      'tests/EndToEnd/canvas-scale-corpus.mjs', 'tests/EndToEnd/canvas-scale-verify.sql', 'tests/EndToEnd/run-native.sh',
      'tests/EndToEnd/webauthn-fixture.mjs', 'tests/EndToEnd/browser-authoring-fixture.mjs',
    ]
    harnessDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, sha256Hex(await readFile(path))])))
    await signInFreshAdmin(page, origin, bootstrap)

    result = await exerciseCanvasScale({
      page, origin, evidenceDir, observations, monitor: author.monitor,
      async outsider() {
        const browserContext = await browser.newContext()
        const outsider = author.monitor(await browserContext.newPage())
        try {
          await signInFreshAdmin(outsider, origin, otherBootstrap)
          return { request: outsider.request, close: () => browserContext.close() }
        } catch (cause) {
          await browserContext.close()
          throw cause
        }
      },
      createDraft: (title, body) => author.createDraft(page, title, body),
      publishDraft: draft => author.publishDraft(page, draft),
      screenshot: (tab, name) => isolated.saveShot(tab, evidenceDir, name + '.png', {}),
    })
    assert.deepEqual(diagnostics, [])
  },
  {
    newline: true,
    replacer: (_, value) => typeof value === 'bigint' ? value.toString() : value,
    onError: () => isolated.saveShot(page, evidenceDir, 'canvas-scale-failed.png', { fullPage: true }).catch(() => {}),
    after: () => context.close(),
  },
)
console.log(observations.join('\n'))
