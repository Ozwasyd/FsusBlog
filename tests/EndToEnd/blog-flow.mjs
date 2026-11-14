import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { api } from '../../src/Contracts/client.ts'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'

const tools = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = tools('@playwright/test')

const config = {
  origin: process.env.FSUSBLOG_TEST_URL,
  ticket: process.env.FSUSBLOG_TEST_TICKET,
  evidence: resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/browser'),
  browserPath: process.env.FSUSBLOG_TEST_CHROME,
  requireNative: process.env.FSUSBLOG_TEST_REQUIRE_NATIVE === '1',
}
assert(config.origin && config.ticket, 'Provide FSUSBLOG_TEST_URL and FSUSBLOG_TEST_TICKET for an isolated server fixture.')
await mkdir(config.evidence, { recursive: true })

const token = `fsusv2${Date.now()}`
const title = `Browser flow ${token}`
const body = `## Draft milestone\n\nThis release note contains ${token}.\n`
const origin = new URL(config.origin).origin
const nativeFetch = globalThis.fetch
globalThis.fetch = (path, init) => nativeFetch(new URL(path, origin), init)

const browser = await chromium.launch({
  executablePath: config.browserPath,
  headless: true,
})
const observations = []
const diagnostics = []
const responses = []
const startedAt = new Date().toISOString()
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' })
const mobile = await browser.newContext({ viewport: { width: 375, height: 850 }, colorScheme: 'light' })
const publisher = await desktop.newPage()
const visitor = await mobile.newPage()
function monitor(page, name) {
  page.on('pageerror', error => diagnostics.push({ name, kind: 'uncaught', message: error.message }))
  page.on('console', info => {
    if (info.type() === 'error' && !info.text().startsWith('Failed to load resource:')) {
      diagnostics.push({ name, kind: 'console', message: info.text() })
    }
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/')) {
      responses.push({ name, method: response.request().method(), path: url.pathname, status: response.status() })
      if (response.status() >= 500) {
        diagnostics.push({ name, kind: 'server', path: url.pathname, status: response.status() })
      }
    }
  })
}
monitor(publisher, 'publisher')
monitor(visitor, 'visitor')
const visible = async locator => locator.waitFor({ state: 'visible' })
const hidden = async locator => locator.waitFor({ state: 'hidden' })
const button = (page, name) => page.getByRole('button', { name, exact: true })
const screen = (page, name) => page.screenshot({ path: join(config.evidence, `${name}.png`) })

async function search(page, value) {
  await page.goto(`${origin}/search`)
  await page.getByRole('textbox', { name: 'Search articles' }).fill(value)
  await page.locator('form.search-form').getByRole('button', { name: 'Search', exact: true }).click()
}

let writtenId
let failure
try {
  await visitor.goto(`${origin}/user/manage/article/write`)
  await visible(visitor.getByText('Log in with an author account to write an article.'))
  await hidden(visitor.getByLabel('Title', { exact: true }))
  observations.push('Anonymous write route hides the draft and exposes login.')

  await publisher.goto(`${origin}/login`)
  await visible(publisher.getByRole('heading', { name: 'Log in', exact: true }))
  assert.match(await publisher.title(), /Log in/)
  await publisher.getByLabel('Owner access key').fill(config.ticket)
  await button(publisher, 'Log in').click()
  await visible(publisher.getByRole('heading', { name: 'New article' }))
  await publisher.getByLabel('Title', { exact: true }).fill(title)
  await publisher.getByLabel('Body', { exact: true }).fill(body)
  if (config.requireNative) {
    await visible(publisher.locator('.el-markdown-editor'))
    await hidden(publisher.getByText('Rich editing unavailable.', { exact: false }))
  }

  // Try leaving once; the registered draft should survive the cancel.
  await publisher.getByRole('link', { name: 'Back', exact: true }).click()
  await visible(publisher.getByText('Discard unsaved changes?', { exact: true }))
  await button(publisher, 'Keep writing').click()
  assert.equal(await publisher.getByLabel('Title', { exact: true }).inputValue(), title)

  await button(publisher, 'Save draft').click()
  await publisher.waitForURL(/\/user\/manage\/article\/edit\/\d+$/)
  writtenId = Number(new URL(publisher.url()).pathname.split('/').at(-1))
  await visible(publisher.getByText('Draft saved.', { exact: true }))
  assert(!(await api.publicIndex()).items.some(item => item.id === writtenId))
  await screen(publisher, 'editor-desktop')
  observations.push('Login, draft navigation protection, durable save, and unpublished omission from index.')

  await button(publisher, 'Publish article').click()
  await visible(publisher.getByText('Article published.', { exact: false }))
  const published = await api.publicIndex()
  assert(published.items.some(item => item.id === writtenId))

  const homeHtml = await nativeFetch(`${origin}/`).then(response => response.text())
  assert(homeHtml.includes(title))
  await visitor.goto(`${origin}/`)
  await visible(visitor.getByRole('heading', { name: 'Latest posts' }))
  await visible(visitor.getByRole('link', { name: title, exact: true }))
  assert.equal(await visitor.locator('vite-error-overlay').count(), 0)
  await visitor.getByRole('button', { name: 'Menu', exact: true }).click()
  await visitor.getByRole('button', { name: /Theme mode/ }).click()
  await visitor.getByRole('menuitemradio', { name: 'Dark', exact: true }).click()
  await visitor.waitForFunction(() => document.documentElement.classList.contains('dark'))
  assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth), 375)
  await screen(visitor, 'home-mobile-dark')
  await visitor.getByRole('link', { name: title, exact: true }).click()
  await visible(visitor.getByRole('heading', { name: title, exact: true }))
  if (config.requireNative) {
    await visible(visitor.getByRole('heading', { name: 'Draft milestone', exact: true }))
    await hidden(visitor.getByText('Formatted view unavailable.', { exact: false }))
  } else {
    await visible(visitor.getByText(token, { exact: false }))
  }
  assert.match(await visitor.title(), new RegExp(title))
  assert.equal(await visitor.evaluate(() => document.documentElement.scrollWidth), 375)
  await screen(visitor, 'article-mobile-dark')

  await search(visitor, 'release note')
  await visible(visitor.getByRole('link', { name: title, exact: true }))
  await screen(visitor, 'search-mobile-dark')
  observations.push('Published snapshot visible in HTML, AEDS public detail, and search on a dark 375px viewport.')

  const stale = await desktop.newPage()
  monitor(stale, 'stale-editor')
  await stale.goto(publisher.url())
  await visible(stale.getByLabel('Body', { exact: true }))
  await stale.getByLabel('Body', { exact: true }).fill(`${body}\nStale edit.`)
  await publisher.getByLabel('Body', { exact: true }).fill(`${body}\nNewer saved revision.`)
  await button(publisher, 'Save draft').click()
  await visible(publisher.getByText('Draft saved.', { exact: false }))
  await button(stale, 'Save draft').click()
  await visible(stale.getByText('The server has a newer revision.', { exact: false }))
  assert.match(await stale.getByLabel('Body', { exact: true }).inputValue(), /Stale edit/)
  await button(stale, 'Load latest revision').click()
  await button(stale, 'Discard changes').click()
  await stale.waitForFunction(() => document.querySelector('#article-body')?.value?.includes('Newer saved revision.'))
  await stale.close()

  await button(publisher, 'Withdraw').click()
  await visible(publisher.getByText('Article withdrawn.', { exact: true }))
  const withdrawn = await api.publicIndex()
  assert.notEqual(withdrawn.generation, published.generation)
  assert(!withdrawn.items.some(item => item.id === writtenId))
  const absent = await visitor.goto(`${origin}/article/${writtenId}`)
  assert.equal(absent.status(), 404)
  assert(!(await absent.text()).includes(token))
  await search(visitor, token)
  await visible(visitor.getByText('No articles match your search.', { exact: true }))
  await button(publisher, 'Log out').click()
  await publisher.waitForURL(`${origin}/`)
  await visible(publisher.getByRole('link', { name: 'Log in', exact: true }))
  observations.push('CAS rejects stale edit, reload reads the durable winner, withdrawal removes public access and index entry, logout returns to anonymous shell.')
  assert(responses.some(response => response.path === WireRoutes.Save && response.status === 409))
  assert.deepEqual(diagnostics, [])
} catch (error) {
  failure = error
  await screen(publisher, 'publisher-failed').catch(() => {})
  await screen(visitor, 'visitor-failed').catch(() => {})
} finally {
  await browser.close()
  await writeFile(join(config.evidence, 'browser-result.json'), JSON.stringify({
    origin, writtenId, startedAt, completedAt: new Date().toISOString(), exitCode: failure ? 1 : 0,
    chromium: browser.version(), playWright: tools('@playwright/test/package.json').version,
    requireNative: config.requireNative, observations, diagnostics, responses,
    failure: failure ? String(failure) : undefined,
    cleanup: 'Playwright browser closed. Database and server fixture are owned by the caller.',
  }, null, 2))
}
if (failure) throw failure
console.log(observations.join('\n'))
