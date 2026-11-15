import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { api } from '../../src/Contracts/client.ts'
import { uploadMedia } from '../../src/Contracts/private-media.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(evidence, 'Provide an evidence directory for the native public image test.')
const publishPath = WireRoutes.ArticlePublishImages
const viewports = [{ width: 1280, height: 800 }, { width: 375, height: 850 }]
const expectedResourceStatuses = new Map([
  [WireRoutes.Session, '401'], [WireRoutes.SiteRefreshStatus, '404'], [WireRoutes.PasskeyAvailability, '404'],
  [WireRoutes.RecoveryKeyAvailability, '404'], ['/favicon.ico', '404'],
])
const pin = process.env.FSUSBLOG_TEST_TLS_SPKI
if (pin !== undefined) assert(origin.startsWith('https:') && /^[A-Za-z0-9+/]{43}=$/.test(pin))
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true,
  args: pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [] })
const assertions = []
let phase = 'fixtures'
let failure
try {
  for (const [index, viewport] of viewports.entries()) {
    const device = index === 0 ? 'desktop' : 'mobile'
    const colorScheme = index === 0 ? 'light' : 'dark'
    const author = await browser.newContext({ viewport, colorScheme })
    const anonymous = await browser.newContext({ viewport, colorScheme })
    try {
      phase = `${device}: fixtures`
      const page = await author.newPage()
      const publicPage = await anonymous.newPage()
      const errors = []
      for (const active of [page, publicPage]) {
        active.on('pageerror', error => errors.push(error.message))
        active.on('console', message => {
          if (message.type() !== 'error') return
          const url = URL.parse(message.location().url, origin)
          const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(message.text())?.[1]
          if (url?.origin === origin && status && expectedResourceStatuses.get(url.pathname) === status) return
          errors.push(`${url?.pathname ?? ''} ${message.text()}`)
        })
      }
      const explicitWrites = []
      page.on('request', request => {
        if (request.method() === 'POST' && request.url() === origin + publishPath) explicitWrites.push(request)
      })
      await page.goto(origin + '/login')
      const imageWidth = 640
      const chosen = await imageFixture(page, `publish-choice-${device}.png`, imageWidth, 80, '#2f5d96', '#e7aa70')
      const privateOnly = await imageFixture(page, `keep-private-${device}.png`, 100, 90, '#851d39', '#338758')
      const ticket = index === 0 ? process.env.FSUSBLOG_TEST_TICKET : process.env.FSUSBLOG_TEST_MOBILE_TICKET
      assert(ticket, 'Provide separate one-time author tickets for the desktop and mobile fixtures.')
      const title = `Explicit article images ${device}`
      const fixture = await createDraft(author, ticket, title, chosen, privateOnly)
      const articleId = fixture.draft.id
      const articlePath = `${origin}/article/${articleId}`
      const inspector = page.getByRole('button', { name: 'Inspector', exact: true })
      const manage = page.getByRole('button', { name: 'Manage private attachments', exact: true })
      const review = page.getByRole('button', { name: 'Review image publication', exact: true })
      const confirm = page.getByRole('button', { name: 'Publish article with selected images', exact: true })
      const confirmation = page.getByRole('heading', { name: 'Publish selected images?', exact: true })
      const gallery = publicPage.getByRole('region', { name: 'Published images', exact: true })

      await page.goto(`${origin}/user/manage/article/edit/${articleId}`)
      await inspector.click()
      await manage.click()
      await attach(page, chosen.name)
      await attach(page, privateOnly.name)
      const chosenPreview = await preview(page, chosen.name, imageWidth)
      const privatePreview = await preview(page, privateOnly.name, 100)
      assert.notEqual(chosenPreview.digest, privatePreview.digest, 'Fixture must have distinct canonical objects.')
      const privateRoute = origin + WireRoutes.ArticleMediaPreview
      const leakedTicket = await anonymous.request.get(privateRoute, { headers: { Authorization: privatePreview.authorization } })
      assert.equal(leakedTicket.status(), 404)
      assert.equal((await leakedTicket.body()).length, 0)

      phase = `${device}: cancel explicit publication`
      const choice = page.getByRole('checkbox', { name: `Publish ${chosen.name}`, exact: true })
      const unselected = page.getByRole('checkbox', { name: `Publish ${privateOnly.name}`, exact: true })
      await choice.waitFor({ state: 'attached' })
      await page.getByText(`Publish ${chosen.name}`, { exact: true }).waitFor()
      assert.equal(await choice.isChecked(), false)
      assert.equal(await unselected.isChecked(), false)
      assert.equal(await review.isEnabled(), false)
      await choice.press('Space')
      assert.equal(await choice.isChecked(), true)
      await review.press('Enter')
      await confirmation.waitFor()
      await page.screenshot({ path: join(evidence, `public-images-choice-${device}.png`), animations: 'disabled' })
      await page.getByRole('button', { name: 'Cancel image publication', exact: true }).press('Enter')
      await confirmation.waitFor({ state: 'hidden' })
      assert.equal(explicitWrites.length, 0, 'Cancel must not issue a publish-images request.')
      assert.equal((await anonymous.request.get(articlePath)).status(), 404)

      phase = `${device}: ordinary publication stays private`
      await closeInspector(page)
      const ordinary = page.waitForResponse(response => response.url() === origin + WireRoutes.Publish && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Publish article', exact: true }).click()
      assert.equal((await ordinary).status(), 200)
      await page.getByText('Article published.', { exact: false }).waitFor()
      const ordinaryRelease = await publicCoordinate(anonymous, articleId)
      assert.equal(ordinaryRelease.media, null)
      const ordinaryManifest = await readManifest(anonymous, articleId, ordinaryRelease.publication)
      assert.deepEqual(ordinaryManifest.images, [])
      assert.equal((await anonymous.request.get(rawUrl(articleId, ordinaryRelease.publication, chosenPreview.digest))).status(), 404)
      const manifestReads = []
      publicPage.on('request', request => {
        if (request.method() === 'GET' && request.url().startsWith(origin + '/api/v2/public/articles/') && request.url().endsWith('/media.aeds'))
          manifestReads.push(request.url())
      })
      const ordinaryPage = await publicPage.goto(articlePath)
      assert.equal(ordinaryPage.status(), 200)
      await publicPage.getByRole('heading', { name: title, exact: true }).waitFor()
      await publicPage.locator('#app[data-v-app]').waitFor()
      assert.equal(await gallery.count(), 0)
      assert.deepEqual(manifestReads, [], 'An ordinary publication has no browser manifest request.')

      phase = `${device}: explicit publication and anonymous access`
      await inspector.click()
      if (await manage.isVisible()) await manage.click()
      await choice.waitFor({ state: 'attached' })
      await page.getByText(`Publish ${chosen.name}`, { exact: true }).waitFor()
      assert.equal(await choice.isChecked(), false, 'A newly saved or published revision starts with no selections.')
      await choice.press('Space')
      assert.equal(await unselected.isChecked(), false)
      await review.press('Enter')
      await confirmation.waitFor()
      const explicit = page.waitForResponse(response => response.url() === origin + publishPath && response.request().method() === 'POST')
      await confirm.press('Enter')
      const receipt = await explicit
      assert.equal(receipt.status(), 200)
      assert.match(await receipt.request().headerValue(WireHeaders.CurrentSession) ?? '', /^[a-f0-9]{64}$/)
      const command = decodeFrame(receipt.request().postDataBuffer())
      assert.equal(command.type, FrameType.ArticlePublishImages)
      const fields = new PodReader(command.payload)
      assert.equal(fields.i32(), articleId)
      const revision = fields.i64()
      assert.equal(fields.uuid(), await receipt.request().headerValue(WireHeaders.ClientMutationId))
      assert.equal(fields.i32(), 1)
      assert.equal(fields.uuid(), fixture.chosen.id)
      fields.finish()
      const result = decodeFrame(await receipt.body())
      assert.equal(result.type, FrameType.Draft)
      const published = decodeDraft(result.payload)
      assert.equal(published.id, articleId)
      assert.equal(published.revision, revision + 1n)
      assert.equal(published.published, true)
      await page.getByText('Article and selected images published.', { exact: false }).waitFor()
      assert.equal(explicitWrites.length, 1)

      const online = await publicCoordinate(anonymous, articleId)
      assert.notEqual(online.publication, ordinaryRelease.publication)
      assert.equal(online.media, '1')
      const manifest = await readManifest(anonymous, articleId, online.publication)
      assert.deepEqual(manifest.images, [{ digest: chosenPreview.digest, format: 1,
        length: chosenPreview.length, width: imageWidth, height: 80 }])
      for (const asset of [fixture.chosen, fixture.privateOnly]) {
        assert.equal(manifest.bytes.includes(asset.name), false)
        assert.equal(manifest.bytes.includes(asset.id), false)
        assert.equal(manifest.bytes.includes(Buffer.from(asset.id.replaceAll('-', ''), 'hex')), false)
      }
      const publicUrl = rawUrl(articleId, online.publication, chosenPreview.digest)
      const raw = await anonymous.request.get(publicUrl)
      assert.equal(raw.status(), 200)
      assert.equal(raw.headers()['cache-control'], 'no-store')
      assert.equal(raw.headers()['content-type'], 'image/png')
      assert.equal(raw.headers()['x-content-type-options'], 'nosniff')
      assert.equal(raw.headers()['cross-origin-resource-policy'], 'same-origin')
      assert.equal(Number(raw.headers()['content-length']), chosenPreview.length)
      assert.equal(sha256(await raw.body()), chosenPreview.digest)
      const head = await anonymous.request.head(publicUrl)
      assert.equal(head.status(), 200)
      for (const header of ['cache-control', 'content-type', 'content-length', 'cross-origin-resource-policy']) {
        assert.equal(head.headers()[header], raw.headers()[header])
      }
      assert.equal((await head.body()).length, 0)
      assert.equal((await anonymous.request.get(rawUrl(articleId, online.publication, privatePreview.digest))).status(), 404)
      assert.equal((await anonymous.request.get(manifestUrl(articleId, ordinaryRelease.publication))).status(), 404)

      const loadedManifest = publicPage.waitForResponse(response => response.url() === manifestUrl(articleId, online.publication))
      const publicHtml = await publicPage.goto(articlePath)
      assert.equal(publicHtml.status(), 200)
      const source = await publicHtml.text()
      assert(source.includes('aria-label="Published images"') && source.includes(new URL(publicUrl).pathname), 'SSR must include the authorized image.')
      for (const asset of [fixture.chosen, fixture.privateOnly]) {
        assert(!source.includes(asset.name) && !source.includes(asset.id), 'Public HTML must not expose private attachment metadata.')
      }
      assert.equal((await loadedManifest).status(), 200)
      await publicPage.locator('#app[data-v-app]').getByRole('region', { name: 'Published images', exact: true }).waitFor()
      assert.deepEqual(manifestReads, [manifestUrl(articleId, online.publication)])
      assert.equal(await gallery.getByRole('img').count(), 1)
      assert.equal(await gallery.getAttribute('data-publication'), String(online.publication))
      if (process.env.FSUSBLOG_TEST_REQUIRE_NATIVE === '1') {
        assert.equal(await publicPage.getByText('Formatted view unavailable.', { exact: false }).count(), 0)
        await publicPage.getByText('The gallery holds only the images selected for this publication.', { exact: true }).waitFor()
      }
      const publicImage = gallery.getByRole('img', { name: 'Published image 1', exact: true })
      await publicImage.scrollIntoViewIfNeeded()
      await publicPage.waitForFunction(width => Array.from(document.images).some(image => image.alt === 'Published image 1' && image.naturalWidth === width), imageWidth)
      assert.equal(new URL(await publicImage.getAttribute('src'), origin).href, publicUrl)
      assert.equal(await publicPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await publicPage.screenshot({ path: join(evidence, `public-images-gallery-${device}.png`), animations: 'disabled' })
      if (device === 'mobile') {
        const serverRendered = await browser.newContext({ viewport, colorScheme, javaScriptEnabled: false })
        try {
          const staticPage = await serverRendered.newPage()
          assert.equal((await staticPage.goto(articlePath)).status(), 200)
          const staticImage = staticPage.getByRole('region', { name: 'Published images', exact: true }).getByRole('img')
          await staticImage.scrollIntoViewIfNeeded()
          const bounds = await staticImage.boundingBox()
          assert(bounds && bounds.width > 0 && bounds.width <= viewport.width, 'Server-rendered image must fit a narrow viewport before hydration.')
          assert.equal(await staticPage.locator('#app[data-v-app]').count(), 0)
        } finally { await serverRendered.close() }
      }

      phase = `${device}: withdrawal closes only public access`
      await closeInspector(page)
      const retract = page.waitForResponse(response => response.url() === origin + WireRoutes.Retract && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Withdraw', exact: true }).click()
      assert.equal((await retract).status(), 200)
      await page.getByText('Article withdrawn.', { exact: true }).waitFor()
      const withdrawn = await anonymous.request.get(publicUrl, { headers: { 'If-None-Match': '"' + chosenPreview.digest + '"' } })
      assert.equal(withdrawn.status(), 404)
      assert.equal(withdrawn.headers()['cache-control'], 'no-store')
      assert.equal((await withdrawn.body()).length, 0)
      assert.equal((await anonymous.request.head(publicUrl)).status(), 404)
      assert.equal((await anonymous.request.get(manifestUrl(articleId, online.publication))).status(), 404)
      assert.equal((await anonymous.request.get(articlePath)).status(), 404)
      await inspector.click()
      if (await manage.isVisible()) await manage.click()
      const stillPrivate = await preview(page, privateOnly.name, 100)
      const stillOwned = await preview(page, chosen.name, imageWidth)
      assert.equal(stillPrivate.digest, privatePreview.digest, 'Withdrawal must leave the owner’s private attachment available.')
      assert.equal(stillOwned.digest, chosenPreview.digest, 'Withdrawal must leave the previously published image available to its owner.')
      assert.deepEqual(errors, [])
      assertions.push({ device, viewport, title, articleId, previous: String(ordinaryRelease.publication), publication: String(online.publication),
        imageDigest: chosenPreview.digest, imageBytes: chosenPreview.length, explicitWrites: explicitWrites.length, cancellationKeptPrivate: true,
        ordinaryPublicationNoImages: true, unpublishedAssetHidden: true, publicHtmlAndHydratedGallery: true,
        anonymousGetHead: true, withdrawnConditionalDenied: true, privatePreviewRetained: true })
    } finally {
      await anonymous.close()
      await author.close()
    }
  }
  phase = 'passed'
} catch (error) { failure = error }
finally {
  await browser.close()
  await writeFile(join(evidence, 'public-article-media-browser.json'), JSON.stringify({ phase, assertions, failure: failure?.stack }, null, 2))
}
if (failure) throw failure
console.log('Explicit public article images, withdrawal, and private attachment access passed in desktop and narrow Chrome.')

async function imageFixture(page, name, width, height, background, accent) {
  const base64 = await page.evaluate(({ width, height, background, accent }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
    context.fillStyle = accent
    context.fillRect(18, 12, 39, 25)
    return canvas.toDataURL('image/png').split(',')[1]
  }, { width, height, background, accent })
  return new File([Buffer.from(base64, 'base64')], name, { type: 'image/png' })
}

async function createDraft(context, ticket, title, chosen, privateOnly) {
  let cookie
  const native = globalThis.fetch
  globalThis.fetch = async (path, options) => {
    const headers = new Headers(options.headers)
    if (cookie) headers.set('Cookie', `fsus-v2-session=${cookie}`)
    const response = await native(new URL(path, origin), { ...options, headers })
    cookie ??= response.headers.get('set-cookie')?.match(/\bfsus-v2-session=([a-f0-9]{64})\b/)?.[1]
    return response
  }
  try {
    const session = await api.signIn(ticket)
    assert(cookie)
    await context.addCookies([{ name: 'fsus-v2-session', value: cookie, url: origin, httpOnly: true, sameSite: 'Strict', secure: origin.startsWith('https:') }])
    const selectedAsset = await uploadMedia(chosen, crypto.randomUUID())
    const unselectedAsset = await uploadMedia(privateOnly, crypto.randomUUID())
    const draft = await api.save({ id: 0, expectedRevision: 0n, idempotencyKey: crypto.randomUUID(), title,
      body: 'The gallery holds only the images selected for this publication.' }, undefined, session.siteSessionId)
    return { draft, chosen: selectedAsset, privateOnly: unselectedAsset }
  } finally { globalThis.fetch = native }
}

async function attach(page, name) {
  await page.getByRole('combobox', { name: 'Choose a private image' }).press('Enter')
  await page.getByRole('option', { name, exact: true }).click()
  await page.getByRole('button', { name: 'Attach image', exact: true }).click()
  await page.getByRole('button', { name: `Preview ${name}`, exact: true }).waitFor()
}

async function preview(page, name, width) {
  const received = page.waitForResponse(response => response.url() === origin + WireRoutes.ArticleMediaPreview)
  await page.getByRole('button', { name: `Preview ${name}`, exact: true }).press('Enter')
  const response = await received
  assert.equal(response.status(), 200)
  const authorization = await response.request().headerValue('authorization')
  assert.match(authorization ?? '', /^Bearer [A-Za-z0-9_-]{91}$/)
  const image = page.getByRole('img', { name, exact: true })
  await image.waitFor()
  await page.waitForFunction(({ name, width }) => Array.from(document.images).some(image => image.alt === name && image.naturalWidth === width), { name, width })
  assert((await image.getAttribute('src'))?.startsWith('blob:' + origin + '/'))
  const authorizedBytes = await page.context().request.get(response.url(), { headers: { Authorization: authorization } })
  assert.equal(authorizedBytes.status(), 200)
  const bytes = await authorizedBytes.body()
  assert.equal(bytes.length, Number(response.headers()['content-length']))
  await page.getByRole('button', { name: 'Close image preview', exact: true }).click()
  return { digest: sha256(bytes), length: bytes.length, authorization }
}

async function closeInspector(page) {
  await page.keyboard.press('Escape')
  const opener = page.getByRole('button', { name: 'Inspector', exact: true, expanded: false })
  await opener.waitFor()
}

async function publicCoordinate(context, id) {
  const response = await context.request.get(origin + WireRoutes.PublicArticle.replace('{id}', String(id)))
  assert.equal(response.status(), 200)
  const frame = decodeFrame(await response.body())
  assert.equal(frame.type, FrameType.ArticleDetail)
  return { publication: decodeArticle(frame.payload).publication, media: response.headers()[WireHeaders.PublicArticleMediaPresent.toLowerCase()] ?? null }
}

async function readManifest(context, id, publication) {
  const response = await context.request.get(manifestUrl(id, publication))
  assert.equal(response.status(), 200)
  assert.equal(response.headers()['cache-control'], 'no-store')
  const bytes = await response.body()
  const frame = decodeFrame(bytes)
  assert.equal(frame.type, FrameType.PublicArticleMedia)
  const payload = Buffer.from(frame.payload)
  assert.equal(payload.readInt32LE(0), id)
  assert.equal(payload.readBigInt64LE(4), publication)
  const count = payload.readInt32LE(12)
  assert(count >= 0 && count <= 32)
  assert.equal(payload.length, 16 + count * 48)
  const images = []
  for (let index = 0; index < count; index++) {
    const offset = 16 + index * 48
    images.push({ digest: payload.subarray(offset, offset + 32).toString('hex'), format: payload.readInt32LE(offset + 32),
      length: payload.readInt32LE(offset + 36), width: payload.readInt32LE(offset + 40), height: payload.readInt32LE(offset + 44) })
  }
  return { images, bytes }
}

function mediaRoute(route, id, publication) {
  return origin + route.replace('{id:int}', String(id)).replace('{publication:long}', String(publication))
}

function manifestUrl(id, publication) { return mediaRoute(WireRoutes.PublicArticleMedia, id, publication) }
function rawUrl(id, publication, digest) { return mediaRoute(WireRoutes.PublicArticleMediaFile, id, publication).replace('{digest}', digest) }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
