import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { observePageErrors } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as media from './media-session-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { exactButton, exactText } from './role-locators.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const url = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const storage = process.env.FSUSBLOG_PRIVATE_MEDIA_ROOT
const resumableRoute = '**/api/v2/media/resumable/**'
const resumable = process.env.FSUSBLOG_TEST_RESUMABLE_MEDIA === '1'
const chineseLocale = { name: 'fsus_locale', value: 'zh-CN', url }
assert(evidence && storage && media.mediaBootstraps.every(Boolean))
const browser = await isolated.launchChrome()
const results = []

const chunkedFile = (name, bytes) => ({ name, mimeType: 'image/png', buffer: Buffer.concat([bytes, Buffer.alloc(512 * 1024, 1)]) })

await isolated.withBrowserEvidence(
  browser,
  evidence,
  'private-media-browser.json',
  failure => ({ results, failure: failure?.stack }),
  async () => {
    for (const [index, entry] of media.mediaViewports.entries()) await verifyViewport(index, entry)
  },
)
console.log('Private PNG upload, authorized image read and file removal verified in desktop and mobile Chrome.')

async function verifyViewport(index, { name, colorScheme, viewport }) {
  await isolated.withTempContext(browser, { viewport, colorScheme }, async context => {
    const diagnostics = []
    const page = observePageErrors(await context.newPage(), diagnostics, true)

    await context.addCookies([chineseLocale])
    const anonymousLibrary = await page.goto(`${url}/admin/assets`)
    assertStatus(anonymousLibrary, 200)
    await exactText(page, '请使用作者账号登录').waitFor()
    assert.match(await page.title(), /资产库/)
    assert.equal(anonymousLibrary.headers()['x-robots-tag'], 'noindex')
    assert.equal(await page.getByLabel('选择图片').count(), 0)

    await signInFreshAdmin(page, url, media.mediaBootstraps[index])
    await context.addCookies([chineseLocale])
    await page.goto(`${url}/admin/assets`)
    await exactText(page, '还没有图片').waitFor()
    await isolated.saveShot(page, evidence, `private-media-${name}-empty.png`, {})

    const fileName = `integration-${name}.png`
    const imageBytes = await media.imageBytes(page, [180, 90], ['#374f6b', '#cddfef'], [25, 20, 80, 50])
    let continuation
    if (resumable) continuation = await verifyContinuation(page, chunkedFile(fileName, imageBytes), name)
    else {
      await page.getByLabel('选择图片').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: imageBytes })
      const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/media/upload.aeds')
      await page.getByRole('button', { name: '上传图片' }).click()
      assertStatus(await upload, 200)
      assert.equal(await page.getByText(/当前标签页重新选择/).count(), 0)
    }
    await page.getByRole('status').getByText('图片已保存。').waitFor()
    const show = page.getByRole('button', { name: `查看 ${fileName}` })
    await show.focus()
    await page.keyboard.press('Enter')
    const preview = page.getByRole('img', { name: fileName })
    await preview.waitFor()
    await page.waitForFunction(target => [...document.images].find(image => image.alt === target)?.naturalWidth === 180, fileName)
    assert.equal(await page.getByRole('heading', { name: fileName }).evaluate(node => node === document.activeElement), true)
    await isolated.assertNoOverflow(page)
    const imageHref = await preview.getAttribute('src')
    const forbidden = await fetch(new URL(imageHref, url))
    assert.equal(forbidden.status, 404)
    assert.equal((await forbidden.arrayBuffer()).byteLength, 0)
    assert.equal((await readdir(storage)).length, 1)
    await isolated.saveShot(page, evidence, `private-media-${name}-view.png`, {})

    await page.getByRole('button', { name: '关闭预览' }).click()
    assert.equal(await show.evaluate(node => node === document.activeElement), true)
    const remove = page.getByRole('button', { name: `删除 ${fileName}` })
    await remove.click()
    await exactButton(page, '取消').click()
    await show.waitFor()
    await remove.click()
    const deletion = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/remove.aeds'))
    await exactButton(page, '删除图片').click()
    assertStatus(await deletion, 200)
    await page.getByRole('status').getByText('图片已删除。').waitFor()
    await show.waitFor({ state: 'hidden' })
    assertStatus(await context.request.get(new URL(imageHref, url).href), 404)
    assert.deepEqual(await readdir(storage), [])
    if (resumable && name === 'desktop') {
      await verifyAccountSwitch(page, chunkedFile('account-switch.png', imageBytes), context)
      continuation.accountSwitchIsolated = true
    }
    assert.deepEqual(diagnostics, [])
    results.push({ name, viewport, title: await page.title(), upload: true, privateRead: true,
      keyboardFocus: true, remove: true, assetFileRemoved: true, continuation, diagnostics })
  })
}

function beginMutation(requests) { return requests.find(([path]) => path.endsWith('/begin.aeds'))[1] }

async function withResumableRoute(page, onPart1, run) {
  const requests = []
  await page.route(resumableRoute, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push([path, request.headers()['x-fsus-client-mutation-id']])
    if (onPart1 && path.endsWith('/parts/1.aeds')) await onPart1(route)
    else await route.continue()
  })
  try {
    await run(requests)
    return requests
  } finally {
    await page.unroute(resumableRoute)
  }
}

async function submitUpload(page, file, expectedText) {
  await page.getByLabel('选择图片').setInputFiles(file)
  await page.getByRole('button', { name: '上传图片' }).click()
  await exactText(page, expectedText).waitFor()
}

async function cancelUpload(page) {
  await page.getByRole('button', { name: '取消上传' }).click()
  await exactText(page, '已取消上传。').waitFor()
}

function abortPart1(page, run) { return withResumableRoute(page, route => route.abort('failed'), run) }
function submitInterrupted(page, file) { return submitUpload(page, file, '上传未完成。可以重试，已确认的分片会保留。') }
function completeResumable(page, file) { return withResumableRoute(page, null, () => submitUpload(page, file, '图片已保存。')) }

async function verifyContinuation(page, file, name) {
  const resumeUi = page.getByText(/当前标签页重新选择/)
  await resumeUi.waitFor()
  const first = await abortPart1(page, async () => {
    await submitInterrupted(page, file)
    await exactText(page, '1 / 2 个分片已确认').waitFor()
    assert.equal(await page.getByRole('button', { name: '取消上传' }).count(), 1)
    await isolated.saveShot(page, evidence, `private-media-${name}-interrupted.png`)
  })
  await page.reload()
  await resumeUi.waitFor()
  const expected = beginMutation(first)
  if (name === 'mobile') {
    const changed = Buffer.from(file.buffer)
    changed[changed.length - 1] ^= 1
    const changedRequests = await abortPart1(page, async () => {
      await submitInterrupted(page, { ...file, buffer: changed })
      await cancelUpload(page)
    })
    const differentKey = beginMutation(changedRequests)
    assert(differentKey && differentKey !== expected)
  }
  const second = await completeResumable(page, file)
  assert.equal(beginMutation(second), expected)
  assert.deepEqual(second.filter(([path]) => path.includes('/parts/')).map(([path]) => path.split('/').at(-1)), ['1.aeds'])
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('fsus.private-media.resume.v1:'))), false)
  return { acceptedBeforeFailure: [0], replayedAfterReload: [1], differentBytesIsolated: name === 'mobile' }
}

async function verifyAccountSwitch(page, uploadFile, context) {
  // Use a second real author in the same tab after one confirmed part. Exactly the original bytes select a new owner key.
  const resumeUi = page.getByText(/当前标签页重新选择/)
  const originalCookies = await context.cookies(url)
  const originalSession = await media.currentMediaSession(page, url)
  const { foreignCookies, foreignSession } = await isolated.withTempContext(browser, async peer => {
    const peerPage = await peer.newPage()
    await signInFreshAdmin(peerPage, url, process.env.FSUSBLOG_TEST_MEDIA_SWITCH_BOOTSTRAP)
    await peer.addCookies([chineseLocale])
    const session = await media.currentMediaSession(peerPage, url)
    assert.notEqual(session, originalSession)
    return { foreignCookies: await peer.cookies(url), foreignSession: session }
  })
  const switched = await withResumableRoute(page, async route => {
    await context.addCookies(foreignCookies)
    await route.abort('failed')
  }, () => submitInterrupted(page, uploadFile))
  const original = beginMutation(switched)
  assert.equal(await media.currentMediaSession(page, url), foreignSession)
  await page.reload()
  await resumeUi.waitFor()
  const received = await completeResumable(page, uploadFile)
  assert.notEqual(beginMutation(received), original)
  assert.equal(received.filter(([path]) => path.includes('/parts/')).length, 2)
  await page.getByRole('button', { name: `删除 ${uploadFile.name}` }).click()
  await exactButton(page, '删除图片').click()
  await exactText(page, '图片已删除。').waitFor()
  await context.addCookies(originalCookies)
  await abortPart1(page, async () => {
    await page.reload()
    await resumeUi.waitFor()
    await submitInterrupted(page, uploadFile)
    await exactText(page, '1 / 2 个分片已确认').waitFor()
    await cancelUpload(page)
  })
}
