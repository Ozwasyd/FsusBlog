import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, encodeArticleCommand, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const routes = {
  edit: articleId => `/user/manage/article/edit/${articleId}`,
  draft: articleId => WireRoutes.Draft.replace('{id:int}', String(articleId)),
}

function draft(bytes) {
  return decodeDraft(decodeFrame(bytes, FrameType.Draft).payload)
}

async function createDraft(page, origin, title) {
  const body = `Private seed for ${title}.`
  const command = encodeArticleCommand({ id: 0, expectedRevision: 0n, idempotencyKey: randomUUID(), title, body })
  const response = await page.request.post(`${origin}${WireRoutes.Save}`, {
    data: Buffer.from(encodeFrame(FrameType.ArticleCommand, command)),
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(response.status(), 200, 'Workspace fixture draft must exist in PostgreSQL')
  const saved = draft(await response.body())
  assert.equal(saved.title, title)
  assert.equal(saved.body, body)
  assert.equal(saved.published, false)
  return saved
}

function inputBody(page) {
  return page.getByLabel('Body', { exact: true })
}

function exactTab(page, title, state) {
  return workspaceList(page).getByRole('tab', { name: `${title} · ${state}`, exact: true })
}

function workspaceList(page) {
  return page.getByRole('tablist', { name: 'Open articles', exact: true })
}

function control(page, name) {
  return page.getByRole('button', { name, exact: true })
}

function gate() {
  let release
  const wait = new Promise(resolve => { release = resolve })
  return { wait, release }
}

async function expectEditor(page, origin, article, body = article.body) {
  await page.waitForURL(`${origin}${routes.edit(article.id)}`)
  const panel = page.locator('#workspace-editor')
  await panel.getByLabel('Title', { exact: true }).waitFor()
  await page.waitForFunction(source => document.querySelector('#article-body')?.value === source, body)
  assert.equal(await inputBody(page).inputValue(), body)
  assert.equal(await panel.getAttribute('role'), 'tabpanel')
  assert.equal(await page.locator('#article-body').count(), 1, 'Only the active article may mount an editor')
}

async function openById(page, articleId) {
  await page.getByLabel('Article ID', { exact: true }).fill(String(articleId))
  await control(page, 'Open article').click()
}

async function openWithDelayedResponse(page, origin, current, target) {
  const seen = gate()
  const pending = gate()
  const ordered = `${origin}${routes.draft(target.id)}`
  const routeBound = async route => {
    try {
      const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      seen.release(real.status())
      await pending.wait
      await route.fulfill({ response: real })
    } catch (error) {
      seen.release(error)
      throw error
    }
  }
  await page.route(ordered, routeBound, { times: 1 })
  const timer = new AbortController()
  try {
    await openById(page, target.id)
    assert.equal(await Promise.race([
      seen.wait,
      delay(10_000, 'no draft request', { signal: timer.signal }),
    ]), 200, 'Expected the real authenticated draft response before release')
    assert.equal(page.url(), `${origin}${routes.edit(current.id)}`, 'URL must stay on the ready editor until the target is ready')
    assert.equal(await exactTab(page, current.title, 'Pinned').getAttribute('aria-selected'), 'true')
    assert.equal(await workspaceList(page).getByRole('tab', { name: target.title, exact: false }).count(), 0, 'No target tab before a valid draft')
    assert.equal(await inputBody(page).inputValue(), current.body)
  } finally {
    pending.release()
    timer.abort()
  }
  await expectEditor(page, origin, target)
  await exactTab(page, target.title, 'Preview').waitFor()
}

export async function exerciseWorkspace({ page, origin, article, screenshot, monitor, token, observations }) {
  const primary = { ...article }
  const pinned = await createDraft(page, origin, `Workspace pinned ${token}`)
  const preview = await createDraft(page, origin, `Workspace preview ${token}`)
  const replacement = await createDraft(page, origin, `Workspace replacement ${token}`)
  const local = `Unconfirmed edit for ${pinned.title}.`

  await expectEditor(page, origin, primary)
  if (await exactTab(page, primary.title, 'Preview').count()) await control(page, `Pin ${primary.title}`).click()
  await exactTab(page, primary.title, 'Pinned').waitFor()

  await openWithDelayedResponse(page, origin, primary, pinned)
  await control(page, `Pin ${pinned.title}`).click()
  await exactTab(page, pinned.title, 'Pinned').waitFor()
  await inputBody(page).fill(local)
  await exactTab(page, pinned.title, 'Unsaved').waitFor()
  await exactTab(page, primary.title, 'Pinned').click()
  await expectEditor(page, origin, primary)
  await exactTab(page, pinned.title, 'Unsaved').click()
  await expectEditor(page, origin, pinned, local)
  assert.equal(await exactTab(page, pinned.title, 'Unsaved').getAttribute('aria-selected'), 'true')

  await openById(page, preview.id)
  await expectEditor(page, origin, preview)
  await exactTab(page, preview.title, 'Preview').waitFor()
  await openById(page, replacement.id)
  await expectEditor(page, origin, replacement)
  const replacementTab = exactTab(page, replacement.title, 'Preview')
  await replacementTab.waitFor()
  assert.equal(await workspaceList(page).getByRole('tab', { name: preview.title, exact: false }).count(), 0)
  assert.equal(await workspaceList(page).getByRole('tab').count(), 3)
  assert.equal(await exactTab(page, primary.title, 'Pinned').count(), 1)
  assert.equal(await exactTab(page, pinned.title, 'Unsaved').count(), 1)

  // A failed activation leaves the prior ready document and its route intact.
  const absentId = 0x7fffffff
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === routes.draft(absentId))
  await openById(page, absentId)
  assert.equal((await rejected).status(), 404)
  await page.getByText('The article is unavailable.', { exact: true }).waitFor()
  await expectEditor(page, origin, replacement)
  assert.equal(await replacementTab.getAttribute('aria-selected'), 'true')
  assert.equal(await workspaceList(page).getByRole('tab').count(), 3)

  await replacementTab.focus()
  await page.keyboard.press('Home')
  const primaryTab = exactTab(page, primary.title, 'Pinned')
  assert.equal(await primaryTab.evaluate(tab => tab === document.activeElement), true)
  assert.equal(await replacementTab.getAttribute('aria-selected'), 'true', 'Roving focus should not activate a different article')
  await page.keyboard.press('Enter')
  await expectEditor(page, origin, primary)
  await page.goBack()
  await expectEditor(page, origin, replacement)
  await page.goForward()
  await expectEditor(page, origin, primary)
  await screenshot(page, 'workspace-desktop')

  const restoreViewport = page.viewportSize()
  try {
    await page.setViewportSize({ width: 375, height: 850 })
    const launcher = page.locator('#workspace-mobile-tab')
    await launcher.waitFor()
    assert.equal(await workspaceList(page).count(), 0, 'Mobile must not expose the full desktop tablist')
    await launcher.focus()
    await page.keyboard.press('Space')
    const overflow = page.getByRole('region', { name: 'Article tabs', exact: true })
    await overflow.waitFor()
    const current = overflow.getByRole('button', { name: `${primary.title} · Pinned`, exact: true })
    await current.and(page.locator(':focus')).waitFor()
    const switcher = overflow.getByRole('button', { name: `${pinned.title} · Unsaved`, exact: true })
    await page.keyboard.press('ArrowDown')
    await switcher.and(page.locator(':focus')).waitFor()
    await page.keyboard.press('Enter')
    await expectEditor(page, origin, pinned, local)
    await overflow.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
    await screenshot(page, 'workspace-mobile')
  } finally {
    if (restoreViewport) await page.setViewportSize(restoreViewport)
  }

  await exactTab(page, pinned.title, 'Unsaved').waitFor()
  const close = control(page, `Close ${pinned.title}`)
  const protectedTab = exactTab(page, pinned.title, 'Unsaved')
  await protectedTab.focus()
  await page.keyboard.press('Delete')
  await page.getByText('Close article tab?', { exact: true }).waitFor()
  await control(page, 'Keep writing').click()
  await expectEditor(page, origin, pinned, local)
  await protectedTab.and(page.locator(':focus')).waitFor({ timeout: 3000 })
  await close.click()
  await control(page, 'Discard changes').click()
  await exactTab(page, pinned.title, 'Unsaved').waitFor({ state: 'detached' })
  assert.equal(await workspaceList(page).getByRole('tab', { name: pinned.title, exact: false }).count(), 0)
  await exactTab(page, primary.title, 'Pinned').click()
  await expectEditor(page, origin, primary)
  const persisted = await page.request.get(`${origin}${routes.draft(pinned.id)}`)
  assert.equal(persisted.status(), 200)
  assert.deepEqual(draft(await persisted.body()), pinned, 'Tab discard must leave the persistent private draft untouched')
  await page.getByText('Recently closed', { exact: true }).click()
  const reopen = control(page, `Reopen Article ${pinned.id}`)
  await reopen.click()
  await expectEditor(page, origin, pinned)
  await exactTab(page, pinned.title, 'Pinned').waitFor()
  await exactTab(page, primary.title, 'Pinned').click()
  await expectEditor(page, origin, primary)

  await page.getByLabel('Article ID', { exact: true }).fill(String(primary.id))
  const independent = page.context().waitForEvent('page')
  await page.getByRole('link', { name: 'Open in browser tab', exact: true }).click()
  const separate = await independent
  try {
    monitor(separate, 'workspace-independent')
    await expectEditor(separate, origin, primary)
    assert.equal(await workspaceList(separate).getByRole('tab').count(), 1, 'A native browser tab owns a separate article registry')
    await control(separate, `Close ${primary.title}`).click()
    await separate.waitForURL(`${origin}/user/manage/article/workspace`)
    await separate.getByText('Open an article or start a new draft.', { exact: true }).waitFor()
    assert.equal(await separate.locator('#article-body').count(), 0)
    await separate.getByLabel('Article ID', { exact: true }).and(separate.locator(':focus')).waitFor({ timeout: 3000 })
  } finally {
    await separate.close()
  }
  assert.equal(await workspaceList(page).getByRole('tab').count(), 3, 'Closing a separate browser tab must not change the original workspace')
  await expectEditor(page, origin, primary)
  observations.push('Workspace waits for the real draft before activation, keeps the active tab after failed opens, preserves pinned local edits across tabs, replaces clean previews, navigates by keyboard and history, renders one editor at 375px, protects tab closure, and reopens the stored draft. A separate browser tab can close its last article without changing the original workspace.')
}
