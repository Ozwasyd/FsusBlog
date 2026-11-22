import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticleHot } from '../../src/Contracts/article-hot.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exercisePublicHotArticles } from './public-hot-articles-flow.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'
import { chromium, submitArticle } from './browser-authoring-fixture.mjs'

const { FSUSBLOG_TEST_URL: origin, FSUSBLOG_TEST_AUTHOR_BOOTSTRAP: bootstrap, FSUSBLOG_TEST_CHROME: executablePath,
  FSUSBLOG_TEST_EVIDENCE: evidence, FSUSBLOG_TEST_HOT_ENABLED: selected } = process.env
assert(origin && bootstrap && evidence)
const enabled = selected === '1'
const browser = await chromium.launch({ headless: true, executablePath })
const observations = []
const hot = new URL(WireRoutes.PublicArticleHot.replace('{size}', '10'), origin)
const expected = [[3, 20], [9, 10], [8, 10], [4, 5], [2, 2], [6, 1]]
  .map(([id, views]) => ({ id, views, title: `Browser fixture ${id}` }))
try {
  const owner = enabled ? await browser.newPage() : null
  if (owner) await signInFreshAdmin(owner, origin, bootstrap)
  await exercisePublicHotArticles({
    browser, origin, enabled, expected, observations,
    advance: owner && (async ({ generation }) => {
      const retracted = await submitArticle(owner.request, new URL(WireRoutes.Retract, origin).href,
        { id: expected[0].id, expectedRevision: 1n, title: '', body: '' })
      assert.equal(retracted.status(), 200)
      const stop = AbortSignal.timeout(2500)
      for (;;) {
        const current = await fetch(hot, { signal: stop })
        if (current.status === 503) {
          await current.body?.cancel()
          await delay(20, undefined, { signal: stop })
          continue
        }
        assert.equal(current.status, 200)
        assert.notEqual(current.headers.get(WireHeaders.SearchIndexGeneration), generation)
        const bytes = new Uint8Array(await current.arrayBuffer())
        const items = decodeArticleHot(decodeFrame(bytes, FrameType.ArticleHot).payload)
        assert(!items.some(item => item.id === expected[0].id))
        assert.deepEqual(items.slice(0, 5), expected.slice(1, 6))
        break
      }
    }),
    screenshot: (page, name) => page.screenshot({ path: join(evidence, `${name}.png`) }),
  })
} finally {
  await writeFile(join(evidence, 'public-hot-articles.json'), JSON.stringify({
    browser: browser.version(), enabled, observations,
  }, null, 2) + '\n')
  await browser.close()
}
