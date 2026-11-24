import assert from 'node:assert/strict'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import * as exportsFlow from './markdown-export-flow.mjs'
import { assertApiError, assertStatus, getFrame } from './response-status-fixture.mjs'
import { waitForPathResponse } from './response-wait-fixture.mjs'
import { exactButton, exactDialog, exactLabel, exactText } from './role-locators.mjs'

export async function exerciseDraftRevision({ page, origin, articleId, sourceRevision, originalBody, publicArticle, screenshot, observations,
  pdfEnabled, pdfFixture }) {
  const currentBody = `${originalBody}\nNewer saved revision.`
  assert.equal(await exactLabel(page, 'Body').inputValue(), currentBody)
  const pane = page.getByRole('complementary', { name: 'Article inspector' })
  await exactButton(page, 'Inspector').click()
  await exactText(pane, 'Revision history').click()
  const comparePath = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(articleId))
    .replace('{sourceRevision:long}', String(sourceRevision))
  const loadDraft = () => getFrame(page.request, `${origin}${WireRoutes.Draft.replace('{id:int}', String(articleId))}`, FrameType.Draft, decodeDraft)
  const savedBefore = await loadDraft()
  const staleBase = savedBefore.revision + 1n
  await assertApiError(await page.request.get(`${origin}${comparePath}?revision=${staleBase}`), 409)
  const choose = exactButton(pane, `Compare revision ${sourceRevision}`)
  // Run the view's request against that mismatched coordinate without altering the server's response.
  await page.route(url => url.pathname === comparePath, route =>
    route.continue({ url: `${origin}${comparePath}?revision=${staleBase}` }), { times: 1 })
  await choose.click()
  const comparison = exactDialog(page, 'Revision comparison')
  const earlier = exactLabel(comparison, 'Earlier revision Markdown')
  const current = exactLabel(comparison, 'Current saved revision Markdown')
  const openCompare = async trigger => {
    await trigger.click()
    await earlier.waitFor()
  }
  const closeComparison = async focusTarget => {
    await earlier.focus()
    await page.keyboard.press('Escape')
    await comparison.waitFor({ state: 'hidden' })
    if (focusTarget) await focusTarget.and(page.locator(':focus')).waitFor()
  }

  await exactText(comparison, 'The saved draft changed. Load its current revision and compare again.').waitFor()
  assert.equal(await comparison.locator('pre').count(), 0)
  await page.keyboard.press('Escape')
  await comparison.waitFor({ state: 'hidden' })
  await exactButton(pane, 'Reload revisions').click()
  await openCompare(choose)
  await current.waitFor()
  assert.equal(await earlier.textContent(), originalBody)
  assert.equal(await current.textContent(), currentBody)
  await exactText(comparison, 'Title unchanged. Markdown changed.').waitFor()
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
  const drawer = exactDialog(page, 'Article inspector')
  await drawer.waitFor({ state: 'hidden' })
  const [earlierNarrow, currentNarrow] = await Promise.all([earlier.boundingBox(), current.boundingBox()])
  assert(earlierNarrow && currentNarrow && earlierNarrow.y + earlierNarrow.height < currentNarrow.y,
    'Narrow comparison must stack the exact sources without hiding either')
  await page.waitForFunction(() => document.documentElement.scrollWidth === 375)
  await comparison.getByRole('button', { name: 'Download revision Markdown' }).click({ trial: true })
  await exportsFlow.verifyOfflineHtmlDownload(page, exactButton(comparison, 'Download revision HTML'),
    savedBefore.title, 'Draft milestone', 'Newer saved revision.')
  await exportsFlow.readEpubDownload(page, exactButton(comparison, 'Download revision EPUB'))
  const revisionPdf = exactButton(comparison, 'Download revision PDF')
  if (pdfEnabled) {
    const pdf = await exportsFlow.readPdfDownload(page, revisionPdf, articleId, savedBefore.revision, sourceRevision)
    if (pdfFixture) await pdf.saveAs(pdfFixture)
    observations.push('The narrow revision comparison downloads the selected historical PDF against the current saved revision.')
  } else assert.equal(await revisionPdf.count(), 0)
  await screenshot(page, 'editor-revision-comparison-mobile')
  await page.setViewportSize(wide)
  await closeComparison(choose)

  // A compare opened from an existing compact Drawer owns Escape before the Inspector.
  await page.setViewportSize({ width: 375, height: 850 })
  await drawer.waitFor()
  const chooseCompact = exactButton(drawer, `Compare revision ${sourceRevision}`)
  await openCompare(chooseCompact)
  await closeComparison(chooseCompact)
  await drawer.waitFor()
  await openCompare(chooseCompact)
  await page.setViewportSize(wide)
  await drawer.waitFor()
  await closeComparison()
  await pane.waitFor()
  await openCompare(choose)
  const attachment = await exportsFlow.readMarkdownDownload(page, comparison.getByRole('button', { name: 'Download revision Markdown' }), originalBody)
  assert.equal(attachment.revision, sourceRevision)
  await exportsFlow.readWordDownload(page, exactButton(comparison, 'Download revision Word'))
  const restore = exactButton(comparison, 'Restore as new draft')
  assert.equal(await restore.isDisabled(), true)
  const reason = 'Restore the initial published content as a draft.'
  await comparison.getByLabel('Reason for restoring this draft').fill(reason)
  await screenshot(page, 'editor-revision-comparison')
  const completed = waitForPathResponse(page, () => WireRoutes.DraftRollback, 'POST')
  await restore.click()
  assertStatus(await completed, 200)
  await page.getByRole('status').filter({ hasText: 'Revision restored to a new draft.' }).waitFor()
  await pane.getByText(reason, { exact: false }).waitFor()
  await page.waitForFunction(source => document.querySelector('#article-body')?.value === source, originalBody)
  const restored = await loadDraft()
  assert.equal(restored.body, originalBody)
  assert(restored.revision > sourceRevision)
  const publicAfter = await publicArticle(articleId)
  assert.deepEqual([publicAfter.revision, publicAfter.body], [sourceRevision, originalBody])
  await exactButton(pane, 'Close').click()
  observations.push('The Inspector compares two saved revisions, records the reason, restores a new private draft, and preserves the prior public revision.')
}
