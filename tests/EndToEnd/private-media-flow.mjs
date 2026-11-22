import assert from 'node:assert/strict'
import { requireWebPackage } from './web-package-fixture.mjs'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api } from '../../src/Contracts/client.ts'

const { chromium } = requireWebPackage('@playwright/test')
const url = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const storage = process.env.FSUSBLOG_PRIVATE_MEDIA_ROOT
const tickets = [process.env.FSUSBLOG_TEST_TICKET, process.env.FSUSBLOG_TEST_MOBILE_TICKET]
const resumableRoute = '**/api/v2/media/resumable/**'
const resumable = process.env.FSUSBLOG_TEST_RESUMABLE_MEDIA === '1'
assert(evidence && storage && tickets.every(Boolean))
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
const results = []
let failure
try {
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 375, height: 850 }].entries()) {
    const context = await browser.newContext({ viewport, colorScheme: index ? 'dark' : 'light' })
    const page = await context.newPage()
    const diagnostics = []
    const name = index ? 'mobile' : 'desktop'
    page.on('pageerror', error => diagnostics.push(error.message))
    page.on('console', info => {
      if (info.type() === 'error' && !info.text().startsWith('Failed to load resource:')) diagnostics.push(info.text())
    })
    page.on('response', response => {
      if (response.status() >= 500 || response.status() >= 400 && new URL(response.url()).pathname.startsWith('/assets/')) {
        diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`)
      }
    })

    await page.goto(`${url}/user/manage/assets`)
    await page.getByText('请使用作者账号登录', { exact: true }).waitFor()
    assert.match(await page.title(), /Media library/)
    assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex')
    assert.equal(await page.getByLabel('选择图片').count(), 0)

    await page.getByRole('link', { name: '登录', exact: true }).click()
    await page.getByLabel('Owner access key').fill(tickets[index])
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await page.getByRole('heading', { name: 'New article' }).waitFor()
    if (index) await page.getByRole('button', { name: 'Account menu' }).click()
    await page.getByRole('link', { name: 'Media library' }).filter({ visible: true }).click()
    await page.getByText('还没有图片', { exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, `private-media-${name}-empty.png`) })

    const fileName = `integration-${name}.png`
    const imageBytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 180
      canvas.height = 90
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#374f6b'
      draw.fillRect(0, 0, 180, 90)
      draw.fillStyle = '#cddfef'
      draw.fillRect(25, 20, 80, 50)
      return canvas.toDataURL('image/png').split(',')[1]
    }), 'base64')
    let continuation
    if (resumable) {
      const file = { name: fileName, mimeType: 'image/png', buffer: Buffer.concat([imageBytes, Buffer.alloc(512 * 1024, 1)]) }
      continuation = await verifyContinuation(page, file, name)
    } else {
      await page.getByLabel('选择图片').setInputFiles({ name: fileName, mimeType: 'image/png', buffer: imageBytes })
      const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/media/upload.aeds')
      await page.getByRole('button', { name: '上传图片' }).click()
      assert.equal((await upload).status(), 200)
      assert.equal(await page.getByText(/当前标签页重新选择/).count(), 0)
    }
    await page.getByRole('status').getByText('图片已保存。').waitFor()
    const show = page.getByRole('button', { name: `查看 ${fileName}` })
    await show.focus()
    await page.keyboard.press('Enter')
    const preview = page.getByRole('img', { name: fileName })
    await preview.waitFor()
    await page.waitForFunction(name => [...document.images].find(image => image.alt === name)?.naturalWidth === 180, fileName)
    assert.equal(await page.getByRole('heading', { name: fileName }).evaluate(node => node === document.activeElement), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    const imageHref = await preview.getAttribute('src')
    const forbidden = await fetch(new URL(imageHref, url))
    assert.equal(forbidden.status, 404)
    assert.equal((await forbidden.arrayBuffer()).byteLength, 0)
    assert.equal((await readdir(storage)).length, 1)
    await page.screenshot({ path: join(evidence, `private-media-${name}-view.png`) })

    await page.getByRole('button', { name: '关闭预览' }).click()
    assert.equal(await show.evaluate(node => node === document.activeElement), true)
    const remove = page.getByRole('button', { name: `删除 ${fileName}` })
    await remove.click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await show.waitFor()
    await remove.click()
    const deletion = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/remove.aeds'))
    await page.getByRole('button', { name: '删除图片', exact: true }).click()
    assert.equal((await deletion).status(), 200)
    await page.getByRole('status').getByText('图片已删除。').waitFor()
    await show.waitFor({ state: 'hidden' })
    const removed = await context.request.get(new URL(imageHref, url).href)
    assert.equal(removed.status(), 404)
    assert.deepEqual(await readdir(storage), [])
    if (resumable && name === 'desktop') {
      await verifyAccountSwitch(page, { name: 'account-switch.png', mimeType: 'image/png',
        buffer: Buffer.concat([imageBytes, Buffer.alloc(512 * 1024, 1)]) }, context)
      continuation.accountSwitchIsolated = true
    }
    assert.deepEqual(diagnostics, [])
    results.push({ name, viewport, title: await page.title(), upload: true, privateRead: true,
      keyboardFocus: true, remove: true, assetFileRemoved: true, continuation, diagnostics })
    await context.close()
  }
} catch (error) { failure = error }
finally {
  await browser.close()
  await writeFile(join(evidence, 'private-media-browser.json'), JSON.stringify({ results, failure: failure?.stack }, null, 2))
}
if (failure) throw failure
console.log('Private PNG upload, authorized image read and file removal verified in desktop and mobile Chrome.')

function beginMutation(requests) {
  return requests.find(([path]) => path.endsWith('/begin.aeds'))[1]
}

async function submitInterruptedUpload(page, choose, submit, file) {
  await choose.setInputFiles(file)
  await submit.click()
  await page.getByText('上传未完成。可以重试，已确认的分片会保留。', { exact: true }).waitFor()
}

async function completeResumableUpload(page, choose, submit, file) {
  const requests = []
  await page.route(resumableRoute, async route => {
    const request = route.request()
    requests.push([new URL(request.url()).pathname, request.headers()['x-fsus-client-mutation-id']])
    await route.continue()
  })
  await choose.setInputFiles(file)
  await submit.click()
  await page.getByText('图片已保存。', { exact: true }).waitFor()
  await page.unroute(resumableRoute)
  return requests
}

async function verifyContinuation(page, file, name) {
  const resumeUi = page.getByText(/当前标签页重新选择/)
  await resumeUi.waitFor()
  const submit = page.getByRole('button', { name: '上传图片' })
  const choose = page.getByLabel('选择图片')
  const first = []
  await page.route(resumableRoute, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    first.push([path, request.headers()['x-fsus-client-mutation-id']])
    if (path.endsWith('/parts/1.aeds')) await route.abort('failed')
    else await route.continue()
  })
  await submitInterruptedUpload(page, choose, submit, file)
  await page.getByText('1 / 2 个分片已确认', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '取消上传' }).count(), 1)
  await page.screenshot({ path: join(evidence, `private-media-${name}-interrupted.png`), animations: 'disabled' })
  await page.unroute(resumableRoute)
  await page.reload()
  await resumeUi.waitFor()
  const expected = beginMutation(first)
  if (name === 'mobile') {
    const changed = Buffer.from(file.buffer)
    changed[changed.length - 1] ^= 1
    let differentKey
    await page.route(resumableRoute, async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path.endsWith('/begin.aeds')) differentKey = request.headers()['x-fsus-client-mutation-id']
      if (path.endsWith('/parts/1.aeds')) await route.abort('failed')
      else await route.continue()
    })
    await submitInterruptedUpload(page, choose, submit, { ...file, buffer: changed })
    assert(differentKey && differentKey !== expected)
    await page.getByRole('button', { name: '取消上传' }).click()
    await page.getByText('已取消上传。', { exact: true }).waitFor()
    await page.unroute(resumableRoute)
  }
  const second = await completeResumableUpload(page, choose, submit, file)
  assert.equal(beginMutation(second), expected)
  assert.deepEqual(second.filter(([path]) => path.includes('/parts/')).map(([path]) => path.split('/').at(-1)), ['1.aeds'])
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('fsus.private-media.resume.v1:'))), false)

  return { acceptedBeforeFailure: [0], replayedAfterReload: [1], differentBytesIsolated: name === 'mobile' }
}

async function verifyAccountSwitch(page, uploadFile, context) {
  // Use a second real author in the same tab after one confirmed part. Exactly the original bytes select a new owner key.
  const submit = page.getByRole('button', { name: '上传图片' })
  const choose = page.getByLabel('选择图片')
  const resumeUi = page.getByText(/当前标签页重新选择/)
  const oldCookie = (await context.cookies()).find(cookie => cookie.name === 'fsus-v2-session')
  assert(oldCookie)
  let foreignCookie
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (path, options) => {
    const response = await nativeFetch(new URL(path, url), options)
    foreignCookie = response.headers.get('set-cookie')?.match(/\bfsus-v2-session=([a-f0-9]{64})\b/)?.[1]
    return response
  }
  try { await api.signIn(process.env.FSUSBLOG_TEST_MEDIA_SWITCH_TICKET) }
  finally { globalThis.fetch = nativeFetch }
  assert(foreignCookie)
  const switched = []
  await page.route(resumableRoute, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    switched.push([path, request.headers()['x-fsus-client-mutation-id']])
    if (path.endsWith('/parts/1.aeds')) {
      await context.addCookies([{ name: 'fsus-v2-session', value: foreignCookie, url, httpOnly: true, sameSite: 'Strict' }])
      await route.abort('failed')
    } else await route.continue()
  })
  await submitInterruptedUpload(page, choose, submit, uploadFile)
  const original = beginMutation(switched)
  await page.unroute(resumableRoute)
  const savedCookie = await context.cookies().then(cookies => cookies.find(cookie => cookie.name === 'fsus-v2-session'))
  assert.equal(savedCookie.value, foreignCookie)
  await page.reload()
  await resumeUi.waitFor()
  const received = await completeResumableUpload(page, choose, submit, uploadFile)
  assert.notEqual(beginMutation(received), original)
  assert.equal(received.filter(([path]) => path.includes('/parts/')).length, 2)
  await page.getByRole('button', { name: `删除 ${uploadFile.name}` }).click()
  await page.getByRole('button', { name: '删除图片', exact: true }).click()
  await page.getByText('图片已删除。', { exact: true }).waitFor()
  await context.addCookies([oldCookie])
  await page.route(resumableRoute, route => new URL(route.request().url()).pathname.endsWith('/parts/1.aeds') ? route.abort('failed') : route.continue())
  await page.reload()
  await resumeUi.waitFor()
  await submitInterruptedUpload(page, choose, submit, uploadFile)
  await page.getByText('1 / 2 个分片已确认', { exact: true }).waitFor()
  await page.getByRole('button', { name: '取消上传' }).click()
  await page.getByText('已取消上传。', { exact: true }).waitFor()
  await page.unroute(resumableRoute)
}
