import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { queryCorpusPage, searchTerms } from '../../src/Contracts/local-search.ts'
import { decodeArticle, decodeSearch } from '../../src/Contracts/public-articles.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForUrlResponse } from './response-wait-fixture.mjs'
import { exactButton, roleWithExactName } from './role-locators.mjs'

const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const articleSource = /Historical Markdown ready for restoration/
export const sourceTitle = 'Rollback fixture source title'

export function adminArticleFixture({ page, context, adminOrigin, siteOrigin }) {
  const admin = path => adminOrigin.origin + path
  const site = path => siteOrigin.origin + path
  const section = roleWithExactName(page, 'region', 'Restore a published article revision')
  const recoveryTab = roleWithExactName(page, 'tab', 'Publication recovery')
  async function openPublicationRecovery() {
    if (await recoveryTab.getAttribute('aria-selected') !== 'true') await recoveryTab.click()
  }
  const detailPath = WireRoutes.PublicArticle.replace('{id}', '1')
  const indexPath = WireRoutes.PublicIndex + '?page=1'
  const send = (path, data, headers = {}) => context.request.post(admin(path), {
    headers: { Origin: adminOrigin.origin, 'Content-Type': 'application/octet-stream', ...headers }, data,
  })

  async function grantAndSignIn(grant, logIn) {
    await promisify(execFile)(grant, [], { timeout: 8_000 })
    await page.reload()
    await logIn(page)
    await openPublicationRecovery()
  }

  async function previewRollback() {
    await openPublicationRecovery()
    await roleWithExactName(section, 'textbox', 'Article ID').fill('1')
    await roleWithExactName(section, 'textbox', 'Historical revision').fill('1')
    await exactButton(section, 'Preview publication rollback').press('Enter')
    await roleWithExactName(section, 'heading', sourceTitle).waitFor()
  }

  async function inspect() {
    const response = await context.request.get(site(detailPath))
    try {
      assert.equal(response.status(), 200)
      return decodeArticle(decodeFrame(await response.body(), FrameType.ArticleDetail).payload)
    } finally { await response.dispose() }
  }

  async function index() {
    const response = await context.request.get(site(indexPath))
    try {
      assert.equal(response.status(), 200)
      const generation = response.headers()[generationHeader]
      assert.match(generation, /^\d+$/)
      return { generation, items: decodeSearch(decodeFrame(await response.body(), FrameType.ArticleSearch).payload).articles }
    } finally { await response.dispose() }
  }

  async function expectStaleIndex(generation) {
    const response = await context.request.get(site(indexPath + '&generation=' + generation))
    try { assert.equal(response.status(), 409) }
    finally { await response.dispose() }
  }

  async function expectWithdrawnArticle() {
    const missing = await context.request.get(site(detailPath))
    try {
      assert.equal(missing.status(), 404)
      decodeFrame(await missing.body(), FrameType.ApiError)
    } finally { await missing.dispose() }
    const html = await context.request.get(site('/article/1'))
    try {
      assert.equal(html.status(), 404)
      assert.doesNotMatch(await html.text(), articleSource)
    } finally { await html.dispose() }
  }

  async function expectWithdrawnCorpus(generation) {
    const corpus = await context.request.get(site(WireRoutes.PublicSearchCorpus + '?page=1'))
    try {
      assert.equal(corpus.status(), 200)
      assert.equal(corpus.headers()[generationHeader], generation)
      assert(!queryCorpusPage(await corpus.body(), searchTerms('Historical Markdown')).documents.has(1))
    } finally { await corpus.dispose() }
  }

  return { admin, site, section, send, grantAndSignIn, previewRollback, inspect, index,
    expectStaleIndex, expectWithdrawnArticle, expectWithdrawnCorpus }
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
        assert.equal(actual.status(), 200)
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
  const [retry] = await Promise.all([
    waitForUrlResponse(page, () => url, 'POST'),
    check.press('Enter'),
  ])
  assert.equal(retry.status(), 200)
  assert.deepEqual(retry.request().postDataBuffer(), original.sent)
  assert.equal(await retry.request().headerValue(WireHeaders.MfaProof), null)
  assert.deepEqual(await retry.body(), original.bytes)
  return original.receipt
}
