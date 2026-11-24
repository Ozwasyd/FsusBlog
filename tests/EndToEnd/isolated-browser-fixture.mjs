import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireWebPackage } from './web-package-fixture.mjs'

export function launchChrome(args = []) {
  return requireWebPackage('@playwright/test').chromium.launch({
    executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true, ...(args.length && { args }),
  })
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
