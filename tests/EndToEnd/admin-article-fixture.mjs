import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { queryCorpusPage, searchTerms } from '../../src/Contracts/local-search.ts'
import { decodeArticle, decodeSearch } from '../../src/Contracts/public-articles.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { assertPasskeyProof, assertPostStatus, packFrame, postBinary } from './admin-workspace-fixture.mjs'
import { assertApiError, assertNoneIn, assertStatus, getFrame } from './response-status-fixture.mjs'
import { waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'

const { FrameType, WireHeaders, WireRoutes } = wire
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const articleSource = /Historical Markdown ready for restoration/
export const sourceTitle = 'Rollback fixture source title'

export function adminArticleFixture({ page, context, adminOrigin, siteOrigin }) {
  const admin = path => adminOrigin.origin + path
  const site = path => siteOrigin.origin + path
  const section = loc.exactRegion(page, 'Restore a published article revision')
  const recoveryTab = loc.exactTab(page, 'Publication recovery')
  const openPublicationRecovery = async () => {
    if (await recoveryTab.getAttribute('aria-selected') !== 'true') await recoveryTab.click()
  }
  const detailPath = WireRoutes.PublicArticle.replace('{id}', '1')
  const indexPath = WireRoutes.PublicIndex + '?page=1'
  const send = (path, data, headers = {}) => postBinary(context.request, admin(path), adminOrigin.origin, data, headers)
  const expectSend = (path, data, expected, headers = {}) =>
    assertPostStatus(context.request, admin(path), adminOrigin.origin, data, expected, headers)
  async function withGet(url, run) {
    const response = await context.request.get(url)
    try { return await run(response) } finally { await response.dispose() }
  }

  async function previewRollback() {
    await openPublicationRecovery()
    await loc.roleWithExactName(section, 'textbox', 'Article ID').fill('1')
    await loc.roleWithExactName(section, 'textbox', 'Historical revision').fill('1')
    await loc.exactButton(section, 'Preview publication rollback').press('Enter')
    await loc.exactHeading(section, sourceTitle).waitFor()
  }

  const inspect = () => getFrame(context.request, site(detailPath), FrameType.ArticleDetail, decodeArticle)

  const index = () => withGet(site(indexPath), async response => {
    assertStatus(response, 200)
    const generation = response.headers()[generationHeader]
    assert.match(generation, /^\d+$/)
    return { generation, items: decodeSearch(decodeFrame(await response.body(), FrameType.ArticleSearch).payload).articles }
  })

  const expectStaleIndex = generation => withGet(site(indexPath + '&generation=' + generation), r => assertStatus(r, 409))

  const expectPublicHtml = (forbidden = []) => withGet(site('/article/1'), async response => {
    assertStatus(response, 200)
    const html = await response.text()
    assert.match(html, articleSource)
    assertNoneIn(Buffer.from(html), ...forbidden)
  })

  async function expectWithdrawnArticle() {
    await withGet(site(detailPath), missing => assertApiError(missing, 404))
    await withGet(site('/article/1'), async html => {
      assertStatus(html, 404)
      assert.doesNotMatch(await html.text(), articleSource)
    })
  }

  const expectWithdrawnCorpus = generation => withGet(site(WireRoutes.PublicSearchCorpus + '?page=1'), async corpus => {
    assertStatus(corpus, 200)
    assert.equal(corpus.headers()[generationHeader], generation)
    assert(!queryCorpusPage(await corpus.body(), searchTerms('Historical Markdown')).documents.has(1))
  })

  const ownerArticles = (owner, query) =>
    getFrame(owner.request, admin(WireRoutes.AuthorArticles + query), FrameType.AuthorArticlePage, decodeAuthorArticlePage)

  function commitMfaCommand({ schema, route = WireRoutes[schema + 'Execute'], button, check,
    intentType = FrameType[schema + 'Intent'], decodeIntent = wire['decode' + schema + 'Intent'],
    encodeIntent = wire['encode' + schema + 'Intent'], verifyIntent, tamperIntent, checkMutationId = false, extraTamper,
    receiptType = FrameType[schema + 'Receipt'], decodeReceipt = wire['decode' + schema + 'Receipt'], verifyReceipt }) {
    return commitWithLostReceipt({
      page, url: admin(route), button, check,
      async verifyRequest(request, sent) {
        assert(sent)
        const intent = decodeIntent ? decodeIntent(decodeFrame(sent, intentType).payload) : undefined
        if (verifyIntent) verifyIntent(intent)
        const proof = await request.headerValue(WireHeaders.MfaProof)
        assertPasskeyProof(proof)
        const headers = { [WireHeaders.MfaProof]: proof }
        if (checkMutationId) {
          const mutation = await request.headerValue(WireHeaders.ClientMutationId)
          assert.equal(mutation, intent.idempotencyKey)
          headers[WireHeaders.ClientMutationId] = mutation
        }
        if (extraTamper) await extraTamper(intent, headers)
        await expectSend(route, packFrame(intentType, encodeIntent(tamperIntent(intent))), 403, headers)
      },
      readReceipt(bytes) {
        const receipt = decodeReceipt(decodeFrame(bytes, receiptType).payload)
        if (verifyReceipt) verifyReceipt(receipt)
        return receipt
      },
    })
  }

  return { admin, site, section, send, expectSend, openPublicationRecovery, previewRollback, inspect, index,
    expectStaleIndex, expectPublicHtml, expectWithdrawnArticle, expectWithdrawnCorpus, ownerArticles, commitMfaCommand }
}

export async function commitWithLostReceipt({ page, url, button, check, verifyRequest, readReceipt }) {
  const committed = Promise.withResolvers()
  const loseResponse = async route => {
    try {
      const request = route.request()
      const sent = request.postDataBuffer()
      await verifyRequest(request, sent)
      const actual = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      try {
        assertStatus(actual, 200)
        const bytes = await actual.body()
        const receipt = readReceipt(bytes)
        await route.abort('connectionreset')
        committed.resolve({ sent, bytes, receipt })
      } finally { await actual.dispose() }
    } catch (error) {
      await route.abort('failed').catch(() => {})
      committed.reject(error)
    }
  }
  await page.route(url, loseResponse, { times: 1 })
  let original
  try { [original] = await Promise.all([committed.promise, button.press('Enter')]) }
  finally { await page.unroute(url, loseResponse) }

  await check.waitFor()
  const [retry] = await Promise.all([waitForUrlResponse(page, () => url, 'POST'), check.press('Enter')])
  assertStatus(retry, 200)
  assert.deepEqual(retry.request().postDataBuffer(), original.sent)
  assert.equal(await retry.request().headerValue(WireHeaders.MfaProof), null)
  assert.deepEqual(await retry.body(), original.bytes)
  return original.receipt
}
