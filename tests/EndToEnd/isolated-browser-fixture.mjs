import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireWebPackage } from './web-package-fixture.mjs'

export async function launchChrome(args = []) {
  const browser = await requireWebPackage('@playwright/test').chromium.launch({
    executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true, ...(args.length && { args }),
  })
  return instrumentApiBodyCapture(browser)
}

function instrumentApiBodyCapture(browser) {
  const attached = new WeakSet()
  const instrumentContext = context => {
    const openPage = context.newPage.bind(context)
    context.newPage = async (...params) => {
      const page = await openPage(...params)
      await attachApiBodyCapture(context, page, attached)
      return page
    }
    context.on('page', page => { void attachApiBodyCapture(context, page, attached).catch(() => {}) })
    return context
  }
  const openContext = browser.newContext.bind(browser)
  browser.newContext = async (...params) => instrumentContext(await openContext(...params))
  const openPage = browser.newPage.bind(browser)
  browser.newPage = async (...params) => {
    const page = await openPage(...params)
    await attachApiBodyCapture(page.context(), page, attached)
    return page
  }
  return browser
}

async function attachApiBodyCapture(context, page, attached) {
  if (attached.has(page)) return
  attached.add(page)
  // Chromium 147 intermittently drops Blink Network.getResponseBody buffers when
  // page code drains fetch() via ReadableStream. Capture unmodified /api/*
  // bytes at CDP Fetch Response stage and fall back only on that protocol error.
  const cdp = await context.newCDPSession(page)
  const queues = new Map()
  const keyOf = (method, url) => `${method} ${url}`
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Response' }] })
  cdp.on('Fetch.requestPaused', async event => {
    try {
      const status = event.responseStatusCode ?? 0
      const headers = event.responseHeaders ?? []
      const type = headers.find(h => h.name.toLowerCase() === 'content-type')?.value?.split(';')[0].trim().toLowerCase() ?? ''
      const length = Number(headers.find(h => h.name.toLowerCase() === 'content-length')?.value ?? 0)
      if (!event.responseErrorReason && event.resourceType !== 'WebSocket' && event.request.method !== 'HEAD' &&
          status >= 200 && status !== 204 && !(status >= 300 && status < 400) &&
          type !== 'text/event-stream' && (!Number.isFinite(length) || length <= 16_000_000)) {
        const { body, base64Encoded } = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId })
        const key = keyOf(event.request.method, event.request.url)
        const queue = queues.get(key) ?? []
        queue.push({ status, bytes: Buffer.from(body, base64Encoded ? 'base64' : 'utf8') })
        if (queue.length > 32) queue.shift()
        queues.set(key, queue)
      }
    } catch {
      // Let continueResponse/failRequest resume the browser unchanged.
    } finally {
      const resume = event.responseErrorReason
        ? cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: event.responseErrorReason })
        : cdp.send('Fetch.continueResponse', { requestId: event.requestId })
      await resume.catch(() => {})
    }
  })
  page.on('response', response => {
    const key = keyOf(response.request().method(), response.url())
    const queue = queues.get(key)
    if (!queue?.length) return
    const index = queue.findIndex(item => item.status === response.status())
    if (index < 0) return
    const [{ bytes }] = queue.splice(index, 1)
    if (queue.length === 0) queues.delete(key)
    const originalBody = response.body.bind(response)
    response.body = () => originalBody().catch(error => {
      if (/No data found for resource with given identifier/.test(error?.message ?? '')) return bytes
      throw error
    })
  })
  page.on('close', () => { queues.clear(); void cdp.detach().catch(() => {}) })
}

export function launchIsolatedChromium() {
  return launchChrome(['--no-proxy-server'])
}

export function saveShot(page, evidence, filename, options = { animations: 'disabled' }) {
  return page.screenshot({ path: join(evidence, filename), ...options })
}

export function writeEvidenceJson(evidence, filename, payload, newline = true, replacer = null) {
  const body = JSON.stringify(payload, replacer, 2)
  return writeFile(join(evidence, filename), newline ? body + '\n' : body)
}

export async function assertNoOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
}

export async function assertScrollWidth(page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)
}

export async function openLocaleContext(browser, origins, options, locale = 'en') {
  const context = await browser.newContext(options)
  const list = Array.isArray(origins) ? origins : [origins]
  await context.addCookies(list.map(url => ({ name: 'fsus_locale', value: locale, url })))
  return context
}

export function restrictBrowserOrigins(context, ...origins) {
  return context.route('**/*', route => origins.some(origin => origin && route.request().url().startsWith(origin + '/')) ? route.continue() : route.abort())
}

export async function withBrowserEvidence(browser, evidence, filename, fields, run, options = {}) {
  if (options.mkdir) await mkdir(evidence, { recursive: true })
  let failure
  try {
    await run()
  } catch (error) {
    failure = error
    await options.onError?.(error)
  } finally {
    await options.after?.()
    await browser.close()
    const payload = typeof fields === 'function' ? fields(failure) : { ...fields, ...(failure && { failure: String(failure) }) }
    await writeEvidenceJson(evidence, filename, payload, Boolean(options.newline), options.replacer ?? null)
  }
  if (failure) throw failure
}

// Exercise the same normal desktop and dark narrow view in separate browser contexts.
export async function withDesktopAndNarrow(browser, run) {
  const devices = [
    { name: 'desktop', colorScheme: 'light', viewport: { width: 1280, height: 800 } },
    { name: 'mobile', colorScheme: 'dark', viewport: { width: 375, height: 850 } },
  ]
  for (const [index, device] of devices.entries()) {
    const { viewport, colorScheme } = device
    await withTempContext(browser, { viewport, colorScheme }, context => run(context, index, device))
  }
}

export async function withTempContext(browser, options, run) {
  if (typeof options === 'function') [run, options] = [options, undefined]
  const context = await browser.newContext(options)
  try { return await run(context) } finally { await context.close() }
}

export async function withViewport(page, width, height, run) {
  const previous = page.viewportSize()
  await page.setViewportSize({ width, height })
  try { return await run() } finally { if (previous) await page.setViewportSize(previous) }
}

export async function withZoomedContext(chromium, prefix, factor, cookies, run) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  let context
  try {
    await mkdir(join(directory, 'Default'))
    await writeFile(join(directory, 'Default', 'Preferences'), JSON.stringify({
      partition: { default_zoom_level: { x: Math.log(factor) / Math.log(1.2) } },
    }))
    context = await chromium.launchPersistentContext(directory, {
      executablePath: process.env.FSUSBLOG_TEST_CHROME, viewport: null, args: ['--window-size=1440,900'],
    })
    await context.addCookies(cookies)
    return await run(context)
  } finally {
    try { await context?.close() } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
