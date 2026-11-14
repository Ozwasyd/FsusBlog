import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseDraftRevision({ page, origin, articleId, sourceRevision, originalBody, publicArticle, screenshot, observations }) {
  assert.equal(await page.getByLabel('Body', { exact: true }).inputValue(), `${originalBody}\nNewer saved revision.`)
  const pane = page.getByRole('complementary', { name: 'Article inspector' })
  await page.getByRole('button', { name: 'Inspector', exact: true }).click()
  await pane.getByText('Revision history', { exact: true }).click()
  await pane.getByRole('button', { name: `Compare revision ${sourceRevision}`, exact: true }).click()
  const comparison = pane.getByRole('region', { name: 'Revision comparison', exact: true })
  await comparison.getByText('Earlier revision', { exact: false }).waitFor()
  const restore = comparison.getByRole('button', { name: 'Restore as new draft', exact: true })
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
  await pane.getByRole('button', { name: 'Close', exact: true }).click()
  observations.push('The Inspector compares two saved revisions, records the reason, restores a new private draft, and preserves the prior public revision.')
}
