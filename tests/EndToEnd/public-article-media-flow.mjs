import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { api } from '../../src/Contracts/client.ts'
import { decodeMediaItems, uploadMedia } from '../../src/Contracts/private-media.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { sha256Hex } from './admin-workspace-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as media from './media-session-fixture.mjs'
import { assertFields, assertHeaders, assertStatus, readFrame } from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(evidence, 'Provide an evidence directory for the native public image test.')
const publishPath = WireRoutes.ArticlePublishImages
const webp = process.env.FSUSBLOG_TEST_MEDIA_WEBP === '1'
const chosenContentType = webp ? 'image/webp' : 'image/png'
const expectedResourceStatuses = new Map([
  [WireRoutes.Session, '401'], [WireRoutes.SiteRefreshStatus, '404'], [WireRoutes.PasskeyAvailability, '404'],
  [WireRoutes.RecoveryKeyAvailability, '404'], ['/favicon.ico', '404'],
])
const pin = process.env.FSUSBLOG_TEST_TLS_SPKI
if (pin !== undefined) assert(origin.startsWith('https:') && /^[A-Za-z0-9+/]{43}=$/.test(pin))
const browser = await isolated.launchChrome(pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [])
const assertions = []
let phase = 'fixtures'

async function verifyDevice(index, { name: device, colorScheme, viewport }) {
  await isolated.withTempContext(browser, { viewport, colorScheme }, author =>
    isolated.withTempContext(browser, { viewport, colorScheme, locale: 'en-US' }, async anonymous => {
      await anonymous.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
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
          if (active === page && phase === `${device}: fixtures` && url?.origin === origin &&
              url.pathname === WireRoutes.AdminSession && status === '401') return
          errors.push(`${url?.pathname ?? ''} ${message.text()}`)
        })
      }
      const explicitWrites = []
      page.on('request', request => {
        if (request.method() === 'POST' && request.url() === origin + publishPath) explicitWrites.push(request)
      })
      await page.goto(origin + '/login')
      const imageWidth = 640
      const galleryWidth = 240
      const rect = [18, 12, 39, 25]
      const chosen = await media.imageFile(page, `publish-choice-${device}.${webp ? 'webp' : 'png'}`, [imageWidth, 80], ['#2f5d96', '#e7aa70'], rect, chosenContentType)
      const galleryFile = await media.imageFile(page, `gallery-image-${device}.png`, [galleryWidth, 60], ['#32573e', '#b08ba6'], rect)
      const privateOnly = await media.imageFile(page, `keep-private-${device}.png`, [100, 90], ['#851d39', '#338758'], rect)
      const title = `Explicit article images ${device}`
      const fixture = await createDraft(page, media.mediaBootstraps[index], title, chosen, galleryFile, privateOnly)
      const articleId = fixture.draft.id
      const articlePath = `${origin}/article/${articleId}`
      const inspector = loc.exactButton(page, 'Inspector')
      const manage = loc.exactButton(page, 'Manage private attachments')
      const review = loc.exactButton(page, 'Review image publication')
      const confirm = loc.exactButton(page, 'Publish article with selected images')
      const confirmation = loc.exactHeading(page, 'Publish selected images?')
      const reviewPanel = loc.exactRegion(page, 'Confirm image publication')
      const gallery = loc.exactRegion(publicPage, 'Published images')
      const cover = loc.roleWithExactName(publicPage, 'img', 'Article cover')

      const assertNotPublic = async url => assertStatus(await anonymous.request.get(url), 404)
      const waitForPost = path => waitForUrlResponse(page, () => origin + path, 'POST')

      await page.goto(`${origin}/admin/articles/edit/${articleId}`)
      await inspector.click()
      await manage.click()
      for (const file of [chosen, galleryFile, privateOnly]) await media.attachPrivateImage(page, file.name)
      const chosenPreview = await media.openPrivatePreview(page, origin, chosen.name, imageWidth)
      const galleryPreview = await media.openPrivatePreview(page, origin, galleryFile.name, galleryWidth)
      const privatePreview = await media.openPrivatePreview(page, origin, privateOnly.name, 100)
      assert.equal(new Set([chosenPreview.digest, galleryPreview.digest, privatePreview.digest]).size, 3)
      const leakedTicket = await anonymous.request.get(origin + WireRoutes.ArticleMediaPreview, { headers: { Authorization: privatePreview.authorization } })
      assertStatus(leakedTicket, 404)
      assert.equal((await leakedTicket.body()).length, 0)
      const { draft: privateCover } = await media.saveDraftCover(page, articleId, privateOnly.name, fixture.privateOnly.id, true)

      phase = `${device}: cancel explicit publication`
      const choice = loc.exactCheckbox(page, `Publish ${chosen.name}`)
      const galleryChoice = loc.exactCheckbox(page, `Publish ${galleryFile.name}`)
      const unselected = loc.exactCheckbox(page, `Publish ${privateOnly.name}`)
      await choice.waitFor({ state: 'attached' })
      await loc.exactText(page, `Publish ${chosen.name}`).waitFor()
      assert.equal(await choice.isChecked(), false)
      assert.equal(await unselected.isChecked(), false)
      assert.equal(await review.isEnabled(), false)
      await choice.press('Space')
      assert.equal(await choice.isChecked(), true)
      await review.press('Enter')
      await confirmation.waitFor()
      await isolated.saveShot(page, evidence, `public-images-choice-${device}.png`)
      await loc.exactButton(page, 'Cancel image publication').press('Enter')
      await confirmation.waitFor({ state: 'hidden' })
      assert.equal(explicitWrites.length, 0, 'Cancel must not issue a publish-images request.')
      await assertNotPublic(articlePath)

      phase = `${device}: ordinary publication stays private`
      await closeInspector(page)
      const ordinary = waitForPost(WireRoutes.Publish)
      await loc.exactButton(page, 'Publish article').click()
      assertStatus(await ordinary, 200)
      await page.getByText('Article published.', { exact: false }).waitFor()
      const ordinaryRelease = await publicCoordinate(anonymous, articleId)
      assertFields(ordinaryRelease, { media: null, revision: privateCover.revision + 1n, cover: '' })
      const ordinaryManifest = await readManifest(anonymous, articleId, ordinaryRelease.publication)
      assert.deepEqual(ordinaryManifest.images, [])
      await assertNotPublic(rawUrl(articleId, ordinaryRelease.publication, chosenPreview.digest))
      const manifestReads = []
      publicPage.on('request', request => {
        if (request.method() === 'GET' && request.url().startsWith(origin + '/api/v2/public/articles/') && request.url().endsWith('/media.aeds'))
          manifestReads.push(request.url())
      })
      assertStatus(await publicPage.goto(articlePath), 200)
      await loc.exactHeading(publicPage, title).waitFor()
      await publicPage.locator('#app[data-v-app]').waitFor()
      assert.equal(await gallery.count(), 0)
      assert.equal(await cover.count(), 0)
      assert.deepEqual(manifestReads, [], 'An ordinary publication has no browser manifest request.')

      phase = `${device}: explicit publication and anonymous access`
      await inspector.click()
      if (await manage.isVisible()) await manage.click()
      async function publishChosen(revision, asCover) {
        await loc.exactText(page, `Publish ${chosen.name}`).waitFor()
        assert.equal(await choice.isChecked(), false, 'A newly saved or published revision starts with no selections.')
        await choice.press('Space')
        assert.equal(await galleryChoice.isChecked(), false)
        if (asCover) await galleryChoice.press('Space')
        assert.equal(await unselected.isChecked(), false)
        await review.press('Enter')
        await confirmation.waitFor()
        assert.equal(await reviewPanel.getByText('Article cover', { exact: false }).count(), asCover ? 1 : 0)
        const [receipt] = await Promise.all([waitForPost(publishPath), confirm.press('Enter')])
        assertStatus(receipt, 200)
        assert.match(await receipt.request().headerValue(WireHeaders.CurrentSession) ?? '', /^[a-f0-9]{64}$/)
        const fields = new PodReader(decodeFrame(receipt.request().postDataBuffer(), FrameType.ArticlePublishImages).payload)
        assert.equal(fields.i32(), articleId)
        assert.equal(fields.i64(), revision)
        assert.equal(fields.uuid(), await receipt.request().headerValue(WireHeaders.ClientMutationId))
        assert.equal(fields.i32(), asCover ? 2 : 1)
        assert.equal(fields.uuid(), fixture.chosen.id)
        if (asCover) assert.equal(fields.uuid(), fixture.gallery.id)
        fields.finish()
        const published = await readFrame(receipt, FrameType.Draft, decodeDraft)
        assertFields(published, { id: articleId, revision: revision + 1n, published: true })
        await page.getByText('Article and selected images published.', { exact: false }).waitFor()
        return published
      }

      const galleryOnly = await publishChosen(ordinaryRelease.revision, false)
      assert.equal(explicitWrites.length, 1)
      const omitted = await publicCoordinate(anonymous, articleId)
      assertFields(omitted, { revision: galleryOnly.revision, cover: '', media: '1' })
      assert.notEqual(omitted.publication, ordinaryRelease.publication)
      assert.equal((await readManifest(anonymous, articleId, omitted.publication)).images[0].digest, chosenPreview.digest)
      await assertNotPublic(rawUrl(articleId, omitted.publication, privatePreview.digest))

      phase = `${device}: the explicit cover matches the published media coordinate`
      const { draft: selectedCover } = await media.saveDraftCover(page, articleId, chosen.name, fixture.chosen.id, true)
      assert.equal(selectedCover.revision, galleryOnly.revision + 1n)
      assert.deepEqual(await publicCoordinate(anonymous, articleId), omitted, 'Saving a draft cover must leave the live release unchanged.')
      const published = await publishChosen(selectedCover.revision, true)
      assert.equal(explicitWrites.length, 2)

      const online = await publicCoordinate(anonymous, articleId)
      assert.notEqual(online.publication, omitted.publication)
      assertFields(online, { revision: published.revision, media: '1' })
      const manifest = await readManifest(anonymous, articleId, online.publication)
      const expectedById = new Map([
        [fixture.chosen.id, { digest: chosenPreview.digest, format: webp ? 3 : 1, length: chosenPreview.length, width: imageWidth, height: 80 }],
        [fixture.gallery.id, { digest: galleryPreview.digest, format: 1, length: galleryPreview.length, width: galleryWidth, height: 60 }],
      ])
      // Publication ordinals use canonical UUID order so reordered commands keep the same identity.
      assert.deepEqual(manifest.images, [...expectedById.keys()].sort().map(id => expectedById.get(id)))
      const assets = [fixture.chosen, fixture.gallery, fixture.privateOnly]
      for (const asset of assets) {
        assert.equal(manifest.bytes.includes(asset.name), false)
        assert.equal(manifest.bytes.includes(asset.id), false)
        assert.equal(manifest.bytes.includes(Buffer.from(asset.id.replaceAll('-', ''), 'hex')), false)
      }
      const publicUrl = rawUrl(articleId, online.publication, chosenPreview.digest)
      const galleryUrl = rawUrl(articleId, online.publication, galleryPreview.digest)
      assert.equal(online.cover, new URL(publicUrl).pathname)
      await assertNotPublic(rawUrl(articleId, omitted.publication, chosenPreview.digest))
      const raw = await anonymous.request.get(publicUrl)
      assertStatus(raw, 200)
      assertHeaders(raw, {
        'cache-control': 'no-store', 'content-type': chosenContentType,
        'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
        'content-length': String(chosenPreview.length),
      })
      const publicBytes = await raw.body()
      assert.equal(sha256Hex(publicBytes), chosenPreview.digest)
      if (webp) {
        assert.equal(publicBytes.subarray(0, 4).toString('ascii'), 'RIFF')
        assert.equal(publicBytes.readUInt32LE(4), publicBytes.length - 8)
        assert.equal(publicBytes.subarray(8, 12).toString('ascii'), 'WEBP')
      }
      const head = await anonymous.request.head(publicUrl)
      assertStatus(head, 200)
      for (const header of ['cache-control', 'content-type', 'content-length', 'cross-origin-resource-policy']) {
        assert.equal(head.headers()[header], raw.headers()[header])
      }
      assert.equal((await head.body()).length, 0)
      await assertNotPublic(rawUrl(articleId, online.publication, privatePreview.digest))
      await assertNotPublic(manifestUrl(articleId, ordinaryRelease.publication))

      const loadedManifest = waitForUrlResponse(publicPage, () => manifestUrl(articleId, online.publication))
      const publicHtml = await publicPage.goto(articlePath)
      assertStatus(publicHtml, 200)
      const source = await publicHtml.text()
      assert(source.includes('aria-label="Published images"') && source.includes(new URL(galleryUrl).pathname), 'SSR must include the authorized gallery image.')
      assert.equal(Array.from(source.matchAll(/alt="Article cover"/g)).length, 1)
      for (const asset of assets) {
        assert(!source.includes(asset.name) && !source.includes(asset.id), 'Public HTML must not expose private attachment metadata.')
      }
      assertStatus(await loadedManifest, 200)
      await loc.exactRegion(publicPage.locator('#app[data-v-app]'), 'Published images').waitFor()
      assert.deepEqual(manifestReads, [manifestUrl(articleId, online.publication)])
      assert.equal(await cover.count(), 1)
      assert.equal(await gallery.getByRole('img').count(), 1)
      assert.equal(await gallery.getAttribute('data-publication'), String(online.publication))
      if (process.env.FSUSBLOG_TEST_REQUIRE_NATIVE === '1') {
        assert.equal(await publicPage.getByText('Formatted view unavailable.', { exact: false }).count(), 0)
        await loc.exactText(publicPage, 'The gallery holds only the images selected for this publication.').waitFor()
      }
      const publicImage = loc.roleWithExactName(gallery, 'img', 'Published image 1')
      await publicImage.scrollIntoViewIfNeeded()
      await publicPage.waitForFunction(dimensions => Object.entries(dimensions).every(([label, width]) =>
        Array.from(document.images).some(image => image.alt === label && image.naturalWidth === width)),
      { 'Article cover': imageWidth, 'Published image 1': galleryWidth })
      await assertImageSource(publicImage, galleryUrl)
      await assertImageSource(cover, publicUrl)
      await isolated.assertNoOverflow(publicPage)
      await isolated.saveShot(publicPage, evidence, `public-images-gallery-${device}.png`)
      if (device === 'mobile') {
        await isolated.withTempContext(browser, { viewport, colorScheme, javaScriptEnabled: false }, async serverRendered => {
          const staticPage = await serverRendered.newPage()
          assertStatus(await staticPage.goto(articlePath), 200)
          const staticImage = loc.exactRegion(staticPage, 'Published images').getByRole('img')
          await staticImage.scrollIntoViewIfNeeded()
          const bounds = await staticImage.boundingBox()
          assert(bounds && bounds.width > 0 && bounds.width <= viewport.width, 'Server-rendered image must fit a narrow viewport before hydration.')
          const staticCover = loc.roleWithExactName(staticPage, 'img', 'Article cover')
          await staticCover.waitFor()
          assert.equal(await staticCover.count(), 1)
          await assertImageSource(staticCover, publicUrl)
          await assertImageSource(staticImage, galleryUrl)
          assert.equal(await staticPage.locator('#app[data-v-app]').count(), 0)
        })
      }

      phase = `${device}: withdrawal closes only public access`
      await closeInspector(page)
      const retract = waitForPost(WireRoutes.Retract)
      await loc.exactButton(page, 'More actions').click()
      await loc.exactMenuItem(page, 'Withdraw').click()
      assertStatus(await retract, 200)
      await loc.exactText(page, 'Article withdrawn.').waitFor()
      const withdrawn = await anonymous.request.get(publicUrl, { headers: { 'If-None-Match': '"' + chosenPreview.digest + '"' } })
      assertStatus(withdrawn, 404)
      assert.equal(withdrawn.headers()['cache-control'], 'no-store')
      assert.equal((await withdrawn.body()).length, 0)
      assertStatus(await anonymous.request.head(publicUrl), 404)
      await assertNotPublic(galleryUrl)
      await assertNotPublic(manifestUrl(articleId, online.publication))
      await assertNotPublic(articlePath)
      await inspector.click()
      if (await manage.isVisible()) await manage.click()
      const stillPrivate = await media.openPrivatePreview(page, origin, privateOnly.name, 100)
      const stillOwned = await media.openPrivatePreview(page, origin, chosen.name, imageWidth)
      assert.equal(stillPrivate.digest, privatePreview.digest, 'Withdrawal must leave the owner’s private attachment available.')
      assert.equal(stillOwned.digest, chosenPreview.digest, 'Withdrawal must leave the previously published image available to its owner.')
      assert.deepEqual(errors, [])
      assertions.push({ device, viewport, title, articleId, imageContentType: chosenContentType,
        previous: String(ordinaryRelease.publication), publication: String(online.publication),
        imageDigest: chosenPreview.digest, imageBytes: chosenPreview.length, explicitWrites: explicitWrites.length, cancellationKeptPrivate: true,
        ordinaryPublicationNoImages: true, unpublishedAssetHidden: true, omittedDraftCoverStayedPrivate: true,
        approvedCoverRendersOnce: true, independentGalleryImageRenders: true,
        anonymousGetHead: true, withdrawnConditionalDenied: true, privatePreviewRetained: true })
    }))
}

await isolated.withBrowserEvidence(
  browser,
  evidence,
  'public-article-media-browser.json',
  failure => ({ phase, assertions, failure: failure?.stack }),
  async () => {
    for (const [index, entry] of media.mediaViewports.entries()) await verifyDevice(index, entry)
    phase = 'passed'
  },
)
console.log('Explicit public article images, withdrawal, and private attachment access passed in desktop and narrow Chrome.')

function createDraft(page, bootstrap, title, chosen, galleryFile, privateOnly) {
  return media.withMediaSession(page, origin, bootstrap, async current => {
    const selectedAsset = webp ? await uploadWebpInLibrary(page, chosen) : await uploadMedia(chosen, crypto.randomUUID())
    const galleryAsset = await uploadMedia(galleryFile, crypto.randomUUID())
    const unselectedAsset = await uploadMedia(privateOnly, crypto.randomUUID())
    const draft = await api.save({ id: 0, expectedRevision: 0n, idempotencyKey: crypto.randomUUID(), title,
      body: 'The gallery holds only the images selected for this publication.' }, undefined, current)
    return { draft, chosen: selectedAsset, gallery: galleryAsset, privateOnly: unselectedAsset }
  })
}

async function uploadWebpInLibrary(page, file) {
  const listed = waitForUrlResponse(page, () => origin + WireRoutes.PrivateMediaList)
  await page.goto(origin + '/admin/assets')
  const listing = await listed
  assertStatus(listing, 200)
  assert.equal(listing.headers()[WireHeaders.PrivateMediaWebp.toLowerCase()], '1')
  const chooser = page.locator('#private-media-file[accept*="image/webp"]')
  await chooser.setInputFiles({ name: file.name, mimeType: file.type, buffer: Buffer.from(await file.arrayBuffer()) })
  const stored = waitForPathResponse(page, () => WireRoutes.PrivateMediaUpload)
  await loc.exactButton(page, 'Upload image').click()
  const { items } = await readFrame(await stored, FrameType.PrivateMediaItems, decodeMediaItems)
  assert.equal(items.length, 1)
  assertFields(items[0], { name: file.name, format: 3 })
  await loc.exactText(page, 'Image saved.').waitFor()
  return items[0]
}

async function assertImageSource(image, expected) {
  assert.equal(new URL(await image.getAttribute('src'), origin).href, expected)
}

async function closeInspector(page) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Inspector', exact: true, expanded: false }).waitFor()
}

async function publicCoordinate(context, id) {
  const response = await context.request.get(origin + WireRoutes.PublicArticle.replace('{id}', String(id)))
  const article = await readFrame(response, FrameType.ArticleDetail, decodeArticle)
  return { publication: article.publication, revision: article.revision, cover: article.coverImageUrl,
    media: response.headers()[WireHeaders.PublicArticleMediaPresent.toLowerCase()] ?? null }
}

async function readManifest(context, id, publication) {
  const response = await context.request.get(manifestUrl(id, publication))
  assertStatus(response, 200)
  assert.equal(response.headers()['cache-control'], 'no-store')
  const bytes = await response.body()
  const payload = Buffer.from(decodeFrame(bytes, FrameType.PublicArticleMedia).payload)
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

const mediaRoute = (route, id, publication) => origin + route.replace('{id:int}', String(id)).replace('{publication:long}', String(publication))
const manifestUrl = (id, publication) => mediaRoute(WireRoutes.PublicArticleMedia, id, publication)
const rawUrl = (id, publication, digest) => mediaRoute(WireRoutes.PublicArticleMediaFile, id, publication).replace('{digest}', digest)
