import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { readDraft, submitArticle } from './browser-authoring-fixture.mjs'
import { exactButton, roleWithExactName } from './role-locators.mjs'

const routes = {
  edit: articleId => `/admin/articles/edit/${articleId}`,
  draft: articleId => WireRoutes.Draft.replace('{id:int}', String(articleId)),
}

async function createDraft(page, origin, title) {
  const body = `Private seed for ${title}.`
  const response = await submitArticle(page.request, origin + WireRoutes.Save, { id: 0, expectedRevision: 0n, title, body })
  const saved = await readDraft(response, 'Workspace fixture draft must exist in PostgreSQL')
  assert.equal(saved.title, title)
  assert.equal(saved.body, body)
  assert.equal(saved.published, false)
  return saved
}

function inputBody(page) {
  return page.getByLabel('Body', { exact: true })
}

function exactTab(page, title, state) {
  return roleWithExactName(workspaceList(page), 'tab', `${title} · ${state}`)
}

function workspaceList(page) {
  return roleWithExactName(page, 'tablist', 'Open articles')
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

async function openWorkspaceDialog(page) {
  const dialog = roleWithExactName(page, 'dialog', 'Workspace & open article')
  if (await dialog.isVisible()) return dialog
  await exactButton(page, 'More actions').click()
  await roleWithExactName(page, 'menuitem', 'Workspace & open…').click()
  await dialog.waitFor()
  return dialog
}

async function openById(page, articleId) {
  const dialog = await openWorkspaceDialog(page)
  const input = dialog.getByLabel('Article ID', { exact: true })
  await input.fill(String(articleId))
  await input.press('Enter')
  return dialog
}

async function openWithDelayedResponse(page, origin, current, target) {
  const seen = Promise.withResolvers()
  const pending = Promise.withResolvers()
  const ordered = `${origin}${routes.draft(target.id)}`
  const routeBound = async route => {
    try {
      const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 })
      seen.resolve(real.status())
      await pending.promise
      await route.fulfill({ response: real })
    } catch (error) {
      seen.resolve(error)
      throw error
    }
  }
  await page.route(ordered, routeBound, { times: 1 })
  const timer = new AbortController()
  try {
    await openById(page, target.id)
    assert.equal(await Promise.race([
      seen.promise,
      delay(10_000, 'no draft request', { signal: timer.signal }),
    ]), 200, 'Expected the real authenticated draft response before release')
    assert.equal(page.url(), `${origin}${routes.edit(current.id)}`, 'URL must stay on the ready editor until the target is ready')
    if (await workspaceList(page).isVisible())
      assert.equal(await exactTab(page, current.title, 'Pinned').getAttribute('aria-selected'), 'true')
    assert.equal(await workspaceList(page).getByRole('tab', { name: target.title, exact: false }).count(), 0, 'No target tab before a valid draft')
    assert.equal(await inputBody(page).inputValue(), current.body)
  } finally {
    pending.resolve()
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
  if (!await exactTab(page, primary.title, 'Pinned').count()) {
    const pinButton = exactButton(page, `Pin ${primary.title}`)
    if (await pinButton.isVisible()) {
      await pinButton.click()
    } else {
      const dialog = await openWorkspaceDialog(page)
      if (!await exactButton(dialog, `Unpin ${primary.title}`).isVisible())
        await exactButton(dialog, `Pin ${primary.title}`).click()
      await exactButton(dialog, `Unpin ${primary.title}`).waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
    }
  }

  await openWithDelayedResponse(page, origin, primary, pinned)
  await exactButton(page, `Pin ${pinned.title}`).click()
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
  const attempted = await openById(page, absentId)
  assert.equal((await rejected).status(), 404)
  await attempted.getByText('The article is unavailable.', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await attempted.waitFor({ state: 'detached' })
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
    const overflow = roleWithExactName(page, 'region', 'Article tabs')
    await overflow.waitFor()
    const current = exactButton(overflow, `${primary.title} · Pinned`)
    await current.and(page.locator(':focus')).waitFor()
    const switcher = exactButton(overflow, `${pinned.title} · Unsaved`)
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
  const close = exactButton(page, `Close ${pinned.title}`)
  const protectedTab = exactTab(page, pinned.title, 'Unsaved')
  const closeDialog = roleWithExactName(page, 'dialog', 'Close tabs with unsaved edits?')
  await protectedTab.focus()
  await page.keyboard.press('Delete')
  await closeDialog.waitFor()
  await exactButton(closeDialog, 'Keep writing').click()
  await expectEditor(page, origin, pinned, local)
  await protectedTab.and(page.locator(':focus')).waitFor({ timeout: 3000 })
  await closeDialog.waitFor({ state: 'detached' })
  await close.click()
  const discardOption = 'Discard unsaved edits from this browser'
  await closeDialog.getByText(discardOption, { exact: true }).click()
  assert.equal(await roleWithExactName(closeDialog, 'radio', discardOption).isChecked(), true)
  await exactButton(closeDialog, 'Close tabs').click()
  await exactTab(page, pinned.title, 'Unsaved').waitFor({ state: 'detached' })
  assert.equal(await workspaceList(page).getByRole('tab', { name: pinned.title, exact: false }).count(), 0)
  await exactTab(page, primary.title, 'Pinned').click()
  await expectEditor(page, origin, primary)
  const persisted = await page.request.get(`${origin}${routes.draft(pinned.id)}`)
  assert.deepEqual(await readDraft(persisted), pinned, 'Tab discard must leave the persistent private draft untouched')
  const recentDialog = await openWorkspaceDialog(page)
  const reopen = exactButton(recentDialog, `Reopen Article ${pinned.id}`)
  await reopen.click()
  await expectEditor(page, origin, pinned)
  await exactTab(page, pinned.title, 'Pinned').waitFor()
  await exactTab(page, primary.title, 'Pinned').click()
  await expectEditor(page, origin, primary)

  const openDialog = await openWorkspaceDialog(page)
  await openDialog.getByLabel('Article ID', { exact: true }).fill(String(primary.id))
  const independent = page.context().waitForEvent('page')
  await roleWithExactName(openDialog, 'link', 'Open in browser tab').click()
  await page.keyboard.press('Escape')
  await openDialog.waitFor({ state: 'detached' })
  const separate = await independent
  try {
    monitor(separate, 'workspace-independent')
    await expectEditor(separate, origin, primary)
    assert.equal(await workspaceList(separate).count(), 0, 'A single-article browser tab starts without the multi-tab strip')
    const separateDialog = await openWorkspaceDialog(separate)
    await exactButton(separateDialog, `Close ${primary.title}`).click()
    await separate.waitForURL(`${origin}/admin/articles/workspace`)
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
