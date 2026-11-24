import assert from 'node:assert/strict'
import { authorFixture } from './browser-authoring-fixture.mjs'
import { launchChrome, saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { exercisePublicHotArticles } from './public-hot-articles-flow.mjs'
import { pollHotRanking } from './response-status-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { FSUSBLOG_TEST_URL: origin, FSUSBLOG_TEST_AUTHOR_BOOTSTRAP: bootstrap,
  FSUSBLOG_TEST_EVIDENCE: evidence, FSUSBLOG_TEST_HOT_ENABLED: selected } = process.env
assert(origin && bootstrap && evidence)
const enabled = selected === '1'
const browser = await launchChrome()
const observations = []
const author = authorFixture(new URL(origin).origin, [])
const expected = [[3, 20], [9, 10], [8, 10], [4, 5], [2, 2], [6, 1]]
  .map(([id, views]) => ({ id, views, title: `Browser fixture ${id}` }))

await withBrowserEvidence(
  browser,
  evidence,
  'public-hot-articles.json',
  () => ({ browser: browser.version(), enabled, observations }),
  async () => {
    const owner = enabled ? await browser.newPage() : null
    if (owner) await signInFreshAdmin(owner, origin, bootstrap)
    await exercisePublicHotArticles({
      browser, origin, enabled, expected, observations,
      advance: owner && (async ({ generation }) => {
        await author.retractDraft(owner, { id: expected[0].id, revision: 1n })
        const { items, generation: nextGeneration } = await pollHotRanking(origin)
        assert.notEqual(nextGeneration, generation)
        assert(!items.some(item => item.id === expected[0].id))
        assert.deepEqual(items.slice(0, 5), expected.slice(1, 6))
      }),
      screenshot: (page, name) => saveShot(page, evidence, `${name}.png`, {}),
    })
  },
  { newline: true },
)
