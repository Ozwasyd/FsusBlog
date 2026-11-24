import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { holdResponse, openWorkspaceDialog, readDraft, submitArticle } from './browser-authoring-fixture.mjs'
import { withViewport } from './isolated-browser-fixture.mjs'
import * as loc from './role-locators.mjs'

const routes = {
  edit: articleId => `/admin/articles/edit/${articleId}`,
  draft: articleId => WireRoutes.Draft.replace('{id:int}', String(articleId)),
}

async function createDraft(page, origin, title) {
  const body = `Private seed for ${title}.`
  const saved = await readDraft(await submitArticle(page.request, origin + WireRoutes.Save,
    { id: 0, expectedRevision: 0n, title, body }), 'Workspace fixture draft must exist in PostgreSQL')
  assert.deepEqual([saved.title, saved.body, saved.published], [title, body, false])
  return saved
}

const inputBody = page => loc.exactLabel(page, 'Body')
const workspaceList = page => loc.roleWithExactName(page, 'tablist', 'Open articles')
const exactTab = (page, title, state) => loc.exactTab(workspaceList(page), `${title} · ${state}`)

async function expectEditor(page, origin, article, body = article.body) {
  await page.waitForURL(`${origin}${routes.edit(article.id)}`)
  const panel = page.locator('#workspace-editor')
  await loc.exactLabel(panel, 'Title').waitFor()
  await page.waitForFunction(source => document.querySelector('#article-body')?.value === source, body)
  assert.equal(await inputBody(page).inputValue(), body)
  assert.equal(await panel.getAttribute('role'), 'tabpanel')
  assert.equal(await page.locator('#article-body').count(), 1, 'Only the active article may mount an editor')
}

export async function openById(page, articleId) {
  const dialog = await openWorkspaceDialog(page)
  const input = loc.exactLabel(dialog, 'Article ID')
  await input.fill(String(articleId))
  await input.press('Enter')
  return dialog
}

async function openWithDelayedResponse(page, origin, current, target) {
  const held = await holdResponse(page, `${origin}${routes.draft(target.id)}`, { maxRetries: 0, maxRedirects: 0 })
  const timer = new AbortController()
  let dialog
  try {
    dialog = await openById(page, target.id)
    assert.equal(await Promise.race([
      held.status().catch(error => error),
      delay(10_000, 'no draft request', { signal: timer.signal }),
    ]), 200, 'Expected the real authenticated draft response before release')
    assert.equal(page.url(), `${origin}${routes.edit(current.id)}`, 'URL must stay on the ready editor until the target is ready')
    if (await workspaceList(page).isVisible())
      assert.equal(await exactTab(page, current.title, 'Pinned').getAttribute('aria-selected'), 'true')
    assert.equal(await workspaceList(page).getByRole('tab', { name: target.title, exact: false }).count(), 0, 'No target tab before a valid draft')
    assert.equal(await inputBody(page).inputValue(), current.body)
  } finally {
    held.release()
    timer.abort()
  }
  await dialog.waitFor({ state: 'detached' })
  await expectEditor(page, origin, target)
  await exactTab(page, target.title, 'Preview').waitFor()
}

export async function exerciseWorkspace({ page, origin, article, screenshot, monitor, token, observations }) {
  const primary = { ...article }
  const pinned = await createDraft(page, origin, `Workspace pinned ${token}`)
  const preview = await createDraft(page, origin, `Workspace preview ${token}`)
  const replacement = await createDraft(page, origin, `Workspace replacement ${token}`)
  const local = `Unconfirmed edit for ${pinned.title}.`
  const switchTab = async (target, state, body = target.body) => {
    await exactTab(page, target.title, state).click()
    await expectEditor(page, origin, target, body)
  }

  await expectEditor(page, origin, primary)
  if (!await exactTab(page, primary.title, 'Pinned').count()) {
    const pinButton = loc.exactButton(page, `Pin ${primary.title}`)
    if (await pinButton.isVisible()) await pinButton.click()
    else {
      const dialog = await openWorkspaceDialog(page)
      if (!await loc.exactButton(dialog, `Unpin ${primary.title}`).isVisible())
        await loc.exactButton(dialog, `Pin ${primary.title}`).click()
      await loc.exactButton(dialog, `Unpin ${primary.title}`).waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
    }
  }

  await openWithDelayedResponse(page, origin, primary, pinned)
  await loc.exactButton(page, `Pin ${pinned.title}`).click()
  await exactTab(page, pinned.title, 'Pinned').waitFor()
  await inputBody(page).fill(local)
  await exactTab(page, pinned.title, 'Unsaved').waitFor()
  await switchTab(primary, 'Pinned')
  await switchTab(pinned, 'Unsaved', local)
  assert.equal(await exactTab(page, pinned.title, 'Unsaved').getAttribute('aria-selected'), 'true')

  for (const draft of [preview, replacement]) {
    const dialog = await openById(page, draft.id)
    await dialog.waitFor({ state: 'detached' })
    await expectEditor(page, origin, draft)
    await exactTab(page, draft.title, 'Preview').waitFor()
  }
  const replacementTab = exactTab(page, replacement.title, 'Preview')
  assert.equal(await workspaceList(page).getByRole('tab', { name: preview.title, exact: false }).count(), 0)
  assert.equal(await workspaceList(page).getByRole('tab').count(), 3)
  assert.equal(await exactTab(page, primary.title, 'Pinned').count(), 1)
  assert.equal(await exactTab(page, pinned.title, 'Unsaved').count(), 1)

  // A failed activation leaves the prior ready document and its route intact.
  const absentId = 0x7fffffff
  const [rejected, attempted] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === routes.draft(absentId)),
    openById(page, absentId),
  ])
  assert.equal(rejected.status(), 404)
  // Valid IDs close the launcher before activation; failures belong to the
  // still-mounted workspace, not the destroyed launcher dialog.
  await attempted.waitFor({ state: 'detached' })
  await loc.exactText(page.locator('main'), 'The article is unavailable.').waitFor()
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

  await withViewport(page, 375, 850, async () => {
    const launcher = page.locator('#workspace-mobile-tab')
    await launcher.waitFor()
    assert.equal(await workspaceList(page).count(), 0, 'Mobile must not expose the full desktop tablist')
    await launcher.focus()
    await page.keyboard.press('Space')
    const overflow = loc.exactRegion(page, 'Article tabs')
    await overflow.waitFor()
    await loc.exactButton(overflow, `${primary.title} · Pinned`).and(page.locator(':focus')).waitFor()
    await page.keyboard.press('ArrowDown')
    await loc.exactButton(overflow, `${pinned.title} · Unsaved`).and(page.locator(':focus')).waitFor()
    await page.keyboard.press('Enter')
    await expectEditor(page, origin, pinned, local)
    await overflow.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
    await screenshot(page, 'workspace-mobile')
  })

  const protectedTab = exactTab(page, pinned.title, 'Unsaved')
  await protectedTab.waitFor()
  const closeDialog = loc.exactDialog(page, 'Close tabs with unsaved edits?')
  await protectedTab.focus()
  await page.keyboard.press('Delete')
  await closeDialog.waitFor()
  await loc.exactButton(closeDialog, 'Keep writing').click()
  await expectEditor(page, origin, pinned, local)
  await protectedTab.and(page.locator(':focus')).waitFor({ timeout: 3000 })
  await closeDialog.waitFor({ state: 'detached' })
  await loc.exactButton(page, `Close ${pinned.title}`).click()
  const discardOption = 'Discard unsaved edits from this browser'
  await loc.exactText(closeDialog, discardOption).click()
  assert.equal(await loc.exactRadio(closeDialog, discardOption).isChecked(), true)
  await loc.exactButton(closeDialog, 'Close tabs').click()
  await protectedTab.waitFor({ state: 'detached' })
  assert.equal(await workspaceList(page).getByRole('tab', { name: pinned.title, exact: false }).count(), 0)
  await switchTab(primary, 'Pinned')
  assert.deepEqual(await readDraft(await page.request.get(`${origin}${routes.draft(pinned.id)}`)), pinned,
    'Tab discard must leave the persistent private draft untouched')
  const reopenDialog = await openWorkspaceDialog(page)
  await loc.exactButton(reopenDialog, `Reopen Article ${pinned.id}`).click()
  await reopenDialog.waitFor({ state: 'detached' })
  await expectEditor(page, origin, pinned)
  await exactTab(page, pinned.title, 'Pinned').waitFor()
  await switchTab(primary, 'Pinned')

  const openDialog = await openWorkspaceDialog(page)
  await loc.exactLabel(openDialog, 'Article ID').fill(String(primary.id))
  const independent = page.context().waitForEvent('page')
  await loc.exactLink(openDialog, 'Open in browser tab').click()
  await page.keyboard.press('Escape')
  await openDialog.waitFor({ state: 'detached' })
  const separate = await independent
  try {
    monitor(separate, 'workspace-independent')
    await expectEditor(separate, origin, primary)
    assert.equal(await workspaceList(separate).count(), 0, 'A single-article browser tab starts without the multi-tab strip')
    await loc.exactButton(await openWorkspaceDialog(separate), `Close ${primary.title}`).click()
    await separate.waitForURL(`${origin}/admin/articles/workspace`)
    await loc.exactText(separate, 'Open an article or start a new draft.').waitFor()
    assert.equal(await separate.locator('#article-body').count(), 0)
    await loc.exactLabel(separate, 'Article ID').and(separate.locator(':focus')).waitFor({ timeout: 3000 })
  } finally {
    await separate.close()
  }
  assert.equal(await workspaceList(page).getByRole('tab').count(), 3, 'Closing a separate browser tab must not change the original workspace')
  await expectEditor(page, origin, primary)
  observations.push('Workspace waits for the real draft before activation, keeps the active tab after failed opens, preserves pinned local edits across tabs, replaces clean previews, navigates by keyboard and history, renders one editor at 375px, protects tab closure, and reopens the stored draft. A separate browser tab can close its last article without changing the original workspace.')
}
