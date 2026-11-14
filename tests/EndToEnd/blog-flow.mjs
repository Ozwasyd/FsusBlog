import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api } from '../../src/Contracts/client.ts'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exerciseWorkspace } from './workspace-flow.mjs'

const tools = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = tools('@playwright/test')

const config = {
  origin: process.env.FSUSBLOG_TEST_URL,
  ticket: process.env.FSUSBLOG_TEST_TICKET,
  evidence: resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/browser'),
  browserPath: process.env.FSUSBLOG_TEST_CHROME,
  requireNative: process.env.FSUSBLOG_TEST_REQUIRE_NATIVE === '1',
  publicFixture: process.env.FSUSBLOG_TEST_PUBLIC_FIXTURE === '1',
}
assert(config.origin && config.ticket, 'Provide FSUSBLOG_TEST_URL and FSUSBLOG_TEST_TICKET for an isolated server fixture.')
await mkdir(config.evidence, { recursive: true })

const token = `fsusv2${Date.now()}`
const title = `Browser flow ${token}`
const bodyTerm = `publicationneedle${Date.now()}`
const body = `## Draft milestone\n\nThis release note contains ${token}.\n${'Padding paragraph. '.repeat(15)}\n${bodyTerm}.\n`
const origin = new URL(config.origin).origin
const nativeFetch = globalThis.fetch
const repository = fileURLToPath(new URL('../../', import.meta.url))
const git = (...args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' }).stdout.trim()
const sha256 = input => createHash('sha256').update(input).digest('hex')
const artifactDigests = Object.fromEntries(await Promise.all(
  ['src/Web/pnpm-lock.yaml', 'src/Server/packages.lock.json'].map(async path =>
    [path, sha256(await readFile(join(repository, path)))]),
))
if (process.env.FSUSBLOG_WEB_DIST) {
  artifactDigests['web/index.html'] = sha256(await readFile(join(process.env.FSUSBLOG_WEB_DIST, 'index.html')))
}
const served = await nativeFetch(`${origin}/health/ready`)
assert.equal(served.status, 204, 'The isolated V2 server is not ready.')
const serverHome = await nativeFetch(`${origin}/`).then(async response => {
  assert.equal(response.status, 200)
  return response.text()
})
artifactDigests['GET /'] = sha256(serverHome)
const asset = serverHome.match(/<script type="module"[^>]+src="([^"]+)"/)?.[1]
assert(asset, 'Server did not serve a Web production entry point.')
const servedBuild = await nativeFetch(new URL(asset, origin))
assert.equal(servedBuild.status, 200)
artifactDigests[asset] = sha256(Buffer.from(await servedBuild.arrayBuffer()))
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
let publisher = await desktop.newPage()
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
    if (url.origin === origin && url.pathname.startsWith('/assets/') && response.status() >= 400) {
      diagnostics.push({ name, kind: 'asset', path: url.pathname, status: response.status() })
    }
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
let stalePageUrl
let failure
try {
  if (config.publicFixture) {
    await visitor.goto(`${origin}/`)
    await visible(visitor.getByRole('link', { name: 'Browser fixture 12', exact: true }))
    await visitor.getByRole('link', { name: 'Next', exact: true }).click()
    await visible(visitor.getByText('Page 2', { exact: true }))
    await visible(visitor.getByRole('link', { name: 'Browser fixture 2', exact: true }))
    stalePageUrl = visitor.url()
    const cursor = new URL(stalePageUrl).searchParams.get('cursor')
    assert(cursor, 'Page 2 needs the server-issued cursor')
    await visitor.getByRole('link', { name: 'Previous', exact: true }).click()
    await visible(visitor.getByRole('link', { name: 'Browser fixture 12', exact: true }))
    await visitor.getByRole('link', { name: 'Web engineering', exact: true }).click()
    await visible(visitor.getByRole('heading', { name: 'Web engineering', exact: true }))
    await visible(visitor.getByText('Published implementation notes.', { exact: true }))
    await visible(visitor.getByRole('link', { name: 'Browser fixture 12', exact: true }))
    await hidden(visitor.getByRole('link', { name: 'Browser fixture 11', exact: true }))
    await screen(visitor, 'taxonomy-mobile')
    await visitor.goto(`${origin}/category/2`)
    await visible(visitor.getByRole('heading', { name: 'Empty category', exact: true }))
    await visible(visitor.getByText('There are no published articles here yet.', { exact: true }))
    const alias = await nativeFetch(`${origin}/tag/ancienne`, { redirect: 'manual' })
    assert.equal(alias.status, 301)
    assert.equal(alias.headers.get('location'), '/tag/4')
    await visitor.goto(`${origin}/tag/ancienne`)
    await visitor.waitForURL(`${origin}/tag/4`)
    await visible(visitor.getByRole('heading', { name: 'Café', exact: true }))
    await visible(visitor.getByRole('link', { name: 'Browser fixture 12', exact: true }))
    observations.push('Signed home cursor traverses forward and back. Category data and empty state render. The old tag URL redirects to the numeric page.')
  }
  await visitor.goto(`${origin}/user/manage/article/write`)
  await visible(visitor.getByText('Log in with an author account to write an article.'))
  await hidden(visitor.getByLabel('Title', { exact: true }))
  observations.push('Anonymous write route hides the draft and exposes login.')

  await publisher.goto(`${origin}/login`)
  await visible(publisher.getByRole('heading', { name: 'Log in', exact: true }))
  assert.match(await publisher.title(), /Log in/)
  await screen(publisher, 'login-desktop')
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

  const unsavedRecovery = `Recovery text ${token}`
  const editorUrl = publisher.url()
  const durableRecords = () => publisher.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('fsusblog-v2-draft-recovery')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('recovery')
      const read = transaction.objectStore('recovery').getAll()
      read.onerror = () => reject(read.error)
      read.onsuccess = () => resolve(read.result.map(item => ({ document: item.document, body: item.body })))
      transaction.oncomplete = () => database.close()
    }
  }))
  // Wait for the author-only scope and its storage connection before creating the recovery copy.
  const scopeLoaded = await publisher.request.get(`${origin}${WireRoutes.DraftRecoveryScope}`)
  assert.equal(scopeLoaded.status(), 200)
  await publisher.getByLabel('Body', { exact: true }).fill(unsavedRecovery)
  await publisher.waitForFunction(source => new Promise(resolve => {
    const request = indexedDB.open('fsusblog-v2-draft-recovery')
    request.onerror = () => resolve(false)
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('recovery')) {
        database.close()
        resolve(false)
        return
      }
      const tx = database.transaction('recovery')
      const rows = tx.objectStore('recovery').getAll()
      rows.onsuccess = () => resolve(rows.result.some(row => row.body === source))
      rows.onerror = () => resolve(false)
      tx.oncomplete = () => database.close()
    }
  }), unsavedRecovery)
  // Release the old editor page without taking its explicit discard route.
  await publisher.close({ runBeforeUnload: false })
  publisher = await desktop.newPage()
  monitor(publisher, 'publisher-recovered')
  await publisher.goto(editorUrl)
  await visible(publisher.getByRole('heading', { name: 'Recover an unsaved draft' }))
  assert.equal(await publisher.getByLabel('Body', { exact: true }).inputValue(), body)
  await button(publisher, 'Restore draft').click()
  await publisher.waitForFunction(source => document.querySelector('#article-body')?.value === source, unsavedRecovery)
  await publisher.getByLabel('Body', { exact: true }).fill(body)
  await button(publisher, 'Save draft').click()
  await visible(publisher.getByText('Draft saved.', { exact: true }))
  assert(!(await durableRecords()).some(item => item.document === `article:${writtenId}`))
  observations.push('The author inspects and restores an unconfirmed IndexedDB draft in a new page. Server acknowledgement purges it.')

  await exerciseWorkspace({ page: publisher, origin, article: { id: writtenId, title, body }, screenshot: screen, monitor, token, observations })

  if (config.publicFixture) {
    await publisher.getByRole('combobox', { name: 'Category', exact: true }).click()
    await publisher.getByRole('option', { name: 'Web engineering', exact: true }).click()
    await publisher.getByRole('heading', { name: 'Classification', exact: true }).click()
    await publisher.getByRole('combobox', { name: 'Tags', exact: true }).and(publisher.locator(':not([readonly])')).click()
    await publisher.getByRole('option', { name: 'Café', exact: true }).click()
    await publisher.getByRole('heading', { name: 'Classification', exact: true }).click()
    await button(publisher, 'Save classification').click()
    await visible(publisher.getByText('Classification saved.', { exact: true }))
    assert(!(await api.publicIndex()).items.some(item => item.id === writtenId))
    observations.push('Save classification commits against the current article revision and remains private until publication.')
  }

  await button(publisher, 'Add property').click()
  await publisher.getByLabel('Property label').fill('Article subtitle')
  await publisher.getByLabel('Property key').fill('article-subtitle')
  await button(publisher, 'Create property').click()
  await button(publisher, 'Edit Article subtitle').click()
  await publisher.getByLabel('Article subtitle value').fill(`Private subtitle ${token}`)
  await button(publisher, 'Save property').click()
  await visible(publisher.getByText(`Private subtitle ${token}`, { exact: true }))

  await button(publisher, 'Add property').click()
  await publisher.getByLabel('Property label').fill('Editorial score')
  await publisher.getByLabel('Property key').fill('editorial-score')
  await publisher.getByRole('combobox', { name: 'Property type' }).click()
  await publisher.getByRole('option', { name: 'Number', exact: true }).click()
  await button(publisher, 'Create property').click()
  await button(publisher, 'Edit Editorial score').click()
  const exactScore = '12345678901234567890.12345678'
  await publisher.getByLabel('Editorial score value').fill(exactScore)
  await button(publisher, 'Save property').click()
  await visible(publisher.getByText(exactScore, { exact: true }))

  await button(publisher, 'Add property').click()
  await publisher.getByLabel('Property label').fill('Editorial approval')
  await publisher.getByLabel('Property key').fill('editorial-approval')
  await publisher.getByRole('combobox', { name: 'Property type' }).click()
  await publisher.getByRole('option', { name: 'Boolean', exact: true }).click()
  await button(publisher, 'Create property').click()
  await button(publisher, 'Edit Editorial approval').click()
  const approval = publisher.getByRole('radiogroup', { name: 'Editorial approval value' })
  await approval.getByText('False', { exact: true }).click()
  assert.equal(await approval.getByRole('radio', { name: 'False', exact: true }).isChecked(), true)
  await button(publisher, 'Save property').click()

  await publisher.reload()
  await visible(publisher.getByText(`Private subtitle ${token}`, { exact: true }))
  await visible(publisher.getByText(exactScore, { exact: true }))
  await visible(publisher.getByText('False', { exact: true }))
  await screen(publisher, 'editor-properties')
  observations.push('The editor reloads a private text value, an exact decimal and a false Boolean without coercion.')

  await button(publisher, 'Publish article').click()
  await visible(publisher.getByText('Article published.', { exact: false }))
  const published = await api.publicIndex()
  const indexEntry = published.items.find(item => item.id === writtenId)
  assert(indexEntry)
  const publicArticle = await api.publicArticle(writtenId)
  assert.equal(publicArticle.title, title)
  assert.equal(publicArticle.body, body)
  assert.equal(indexEntry.publication, publicArticle.publication)
  if (config.publicFixture) {
    assert.equal(publicArticle.category.id, 1)
    assert(publicArticle.tags.some(tag => tag.id === 4))
  }

  if (stalePageUrl) {
    await visitor.goto(stalePageUrl)
    await visible(visitor.getByText('This page link has expired.', { exact: false }))
    await visitor.getByRole('link', { name: 'First page', exact: true }).click()
    await visible(visitor.getByRole('link', { name: title, exact: true }))
    observations.push('Public generation changes invalidate old page cursors and offer a working first-page recovery link.')
  }

  const homeHtml = await nativeFetch(`${origin}/`).then(response => response.text())
  assert(homeHtml.includes(title))
  assert(!homeHtml.includes(`Private subtitle ${token}`))
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
  await hidden(visitor.getByText(`Private subtitle ${token}`, { exact: true }))
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
  assert(!indexEntry.summary.includes(bodyTerm), 'The full-text term must fall outside the index summary')
  const corpusResponse = mobile.waitForEvent('response', response => new URL(response.url()).pathname === WireRoutes.PublicSearchCorpus && response.request().method() === 'GET')
  const generationCheck = visitor.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PublicSearchCorpus && response.request().method() === 'HEAD')
  await search(visitor, bodyTerm)
  await visible(visitor.getByRole('link', { name: title, exact: true }))
  const corpus = await corpusResponse
  assert.equal(corpus.status(), 200)
  const corpusBytes = await nativeFetch(corpus.url()).then(response => response.arrayBuffer())
  assert.equal(Buffer.from(corpusBytes, 0, 4).toString('ascii'), 'FSPK')
  assert.equal((await generationCheck).status(), 204)
  assert.equal((await api.search(bodyTerm)).items[0].id, writtenId)
  await screen(visitor, 'search-mobile-dark')
  observations.push('Published snapshot visible in HTML, AEDS public detail, and local full-text search on a dark 375px viewport. A body-only term passed through the FSPK worker and generation recheck.')

  const stale = await desktop.newPage()
  monitor(stale, 'stale-editor')
  await stale.goto(publisher.url())
  await visible(stale.getByLabel('Body', { exact: true }))
  await stale.getByLabel('Body', { exact: true }).fill(`${body}\nStale edit.`)
  await publisher.getByLabel('Body', { exact: true }).fill(`${body}\nNewer saved revision.`)
  await button(publisher, 'Save draft').click()
  await visible(publisher.getByText('Draft saved.', { exact: false }))
  assert.equal((await api.publicArticle(writtenId)).body, body)
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
  await assert.rejects(api.publicArticle(writtenId), { status: 404 })
  const absent = await visitor.goto(`${origin}/article/${writtenId}`)
  assert.equal(absent.status(), 404)
  assert(!(await absent.text()).includes(token))
  const priorSearchGeneration = corpus.headers()['x-fsus-search-index-generation']
  assert(priorSearchGeneration)
  const priorSearch = await nativeFetch(`${origin}${WireRoutes.PublicSearchCorpus}?generation=${priorSearchGeneration}`, { method: 'HEAD' })
  assert.equal(priorSearch.status, 409)
  await search(visitor, bodyTerm)
  await visible(visitor.getByText('No articles match your search.', { exact: true }))
  const signOut = publisher.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.SignOut)
  await button(publisher, 'Log out').click()
  assert.equal((await signOut).status(), 200)
  await publisher.waitForURL(`${origin}/`)
  await visible(publisher.getByRole('link', { name: 'Log in', exact: true }))
  assert.equal((await publisher.request.get(`${origin}${WireRoutes.Session}`)).status(), 401)
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
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain'),
    artifactDigests,
    node: process.version,
    fixture: { articleTitle: title, initialBodyDigest: sha256(body) },
    chromium: browser.version(), playWright: tools('@playwright/test/package.json').version,
    requireNative: config.requireNative, publicFixture: config.publicFixture, observations, diagnostics, responses,
    failure: failure ? String(failure) : undefined,
    cleanup: 'Playwright browser closed. Database and server fixture are owned by the caller.',
  }, null, 2))
}
if (failure) throw failure
console.log(observations.join('\n'))
