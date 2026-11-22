import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { readEpubDownload, readMarkdownDownload, readPdfDownload, readWordDownload, verifyOfflineHtmlDownload } from './markdown-export-flow.mjs'
import { exactButton, roleWithExactName } from './role-locators.mjs'

export async function exerciseDraftRevision({ page, origin, articleId, sourceRevision, originalBody, publicArticle, screenshot, observations,
  pdfEnabled, pdfFixture }) {
  const currentBody = `${originalBody}\nNewer saved revision.`
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), currentBody)
  const pane = page.getByRole('complementary', { name: 'Article inspector' })
  await exactButton(page, 'Inspector').click()
  await pane.getByText('Revision history', { exact: true }).click()
  const comparePath = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(articleId))
    .replace('{sourceRevision:long}', String(sourceRevision))
  const currentDraftPath = WireRoutes.Draft.replace('{id:int}', String(articleId))
  const storedBefore = await page.request.get(`${origin}${currentDraftPath}`)
  assert.equal(storedBefore.status(), 200)
  const savedBefore = decodeDraft(decodeFrame(await storedBefore.body(), FrameType.Draft).payload)
  const staleBase = savedBefore.revision + 1n
  const stale = await page.request.get(`${origin}${comparePath}?revision=${staleBase}`)
  assert.equal(stale.status(), 409)
  assert.equal(decodeFrame(await stale.body()).type, FrameType.ApiError)
  const choose = exactButton(pane, `Compare revision ${sourceRevision}`)
  // Run the view's request against that mismatched coordinate without altering the server's response.
  await page.route(url => url.pathname === comparePath, route =>
    route.continue({ url: `${origin}${comparePath}?revision=${staleBase}` }), { times: 1 })
  await choose.click()
  const comparison = roleWithExactName(page, 'dialog', 'Revision comparison')
  await comparison.getByText('The saved draft changed. Load its current revision and compare again.', { exact: true }).waitFor()
  assert.equal(await comparison.locator('pre').count(), 0)
  await page.keyboard.press('Escape')
  await comparison.waitFor({ state: 'hidden' })
  await exactButton(pane, 'Reload revisions').click()
  await choose.click()
  const earlier = comparison.getByLabel('Earlier revision Markdown', { exact: true })
  const current = comparison.getByLabel('Current saved revision Markdown', { exact: true })
  await earlier.waitFor()
  await current.waitFor()
  assert.equal(await earlier.textContent(), originalBody)
  assert.equal(await current.textContent(), currentBody)
  await comparison.getByText('Title unchanged. Markdown changed.', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const earlier = document.querySelector('pre[aria-label="Earlier revision Markdown"]')?.getBoundingClientRect()
    const current = document.querySelector('pre[aria-label="Current saved revision Markdown"]')?.getBoundingClientRect()
    return earlier && current && earlier.width > 0 && current.width > 0 && Math.abs(earlier.y - current.y) <= 2 &&
      earlier.right <= current.left
  })
  const wide = page.viewportSize()
  assert(wide)
  await page.setViewportSize({ width: 375, height: 850 })
  await page.waitForFunction(() => matchMedia('(max-width: 740px)').matches)
  const drawer = roleWithExactName(page, 'dialog', 'Article inspector')
  await drawer.waitFor({ state: 'hidden' })
  const earlierNarrow = await earlier.boundingBox()
  const currentNarrow = await current.boundingBox()
  assert(earlierNarrow && currentNarrow && earlierNarrow.y + earlierNarrow.height < currentNarrow.y,
    'Narrow comparison must stack the exact sources without hiding either')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
  await comparison.getByRole('button', { name: 'Download revision Markdown' }).click({ trial: true })
  await verifyOfflineHtmlDownload(page, exactButton(comparison, 'Download revision HTML'),
    savedBefore.title, 'Draft milestone', 'Newer saved revision.')
  await readEpubDownload(page, exactButton(comparison, 'Download revision EPUB'))
  const revisionPdf = exactButton(comparison, 'Download revision PDF')
  if (pdfEnabled) {
    const pdf = await readPdfDownload(page, revisionPdf, articleId, savedBefore.revision, sourceRevision)
    if (pdfFixture) await pdf.saveAs(pdfFixture)
    observations.push('The narrow revision comparison downloads the selected historical PDF against the current saved revision.')
  } else assert.equal(await revisionPdf.count(), 0)
  await screenshot(page, 'editor-revision-comparison-mobile')
  await page.setViewportSize(wide)

  await earlier.focus()
  await page.keyboard.press('Escape')
  await comparison.waitFor({ state: 'hidden' })
  await choose.and(page.locator(':focus')).waitFor()

  // A compare opened from an existing compact Drawer owns Escape before the Inspector.
  await page.setViewportSize({ width: 375, height: 850 })
  await drawer.waitFor()
  const chooseCompact = exactButton(drawer, `Compare revision ${sourceRevision}`)
  await chooseCompact.click()
  await earlier.waitFor()
  await earlier.focus()
  await page.keyboard.press('Escape')
  await comparison.waitFor({ state: 'hidden' })
  await drawer.waitFor()
  await chooseCompact.and(page.locator(':focus')).waitFor()
  await chooseCompact.click()
  await earlier.waitFor()
  await page.setViewportSize(wide)
  await drawer.waitFor()
  await earlier.focus()
  await page.keyboard.press('Escape')
  await comparison.waitFor({ state: 'hidden' })
  await pane.waitFor()
  await choose.click()
  await earlier.waitFor()
  const attachment = await readMarkdownDownload(page, comparison.getByRole('button', { name: 'Download revision Markdown' }), originalBody)
  assert.equal(attachment.revision, sourceRevision)
  await readWordDownload(page, exactButton(comparison, 'Download revision Word'))
  const restore = exactButton(comparison, 'Restore as new draft')
  assert.equal(await restore.isDisabled(), true)
  const reason = 'Restore the initial published content as a draft.'
  await comparison.getByLabel('Reason for restoring this draft').fill(reason)
  await screenshot(page, 'editor-revision-comparison')
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.DraftRollback &&
    response.request().method() === 'POST')
  await restore.click()
  assert.equal((await completed).status(), 200)
  await page.getByRole('status').filter({ hasText: 'Revision restored to a new draft.' }).waitFor()
  await pane.getByText(reason, { exact: false }).waitFor()
  await page.waitForFunction(source => document.querySelector('#article-body')?.value === source, originalBody)
  const stored = await page.request.get(`${origin}${WireRoutes.Draft.replace('{id:int}', String(articleId))}`)
  assert.equal(stored.status(), 200)
  const restored = decodeDraft(decodeFrame(await stored.body(), FrameType.Draft).payload)
  assert.equal(restored.body, originalBody)
  assert(restored.revision > sourceRevision)
  const publicAfter = await publicArticle(articleId)
  assert.equal(publicAfter.revision, sourceRevision)
  assert.equal(publicAfter.body, originalBody)
  await exactButton(pane, 'Close').click()
  observations.push('The Inspector compares two saved revisions, records the reason, restores a new private draft, and preserves the prior public revision.')
}
