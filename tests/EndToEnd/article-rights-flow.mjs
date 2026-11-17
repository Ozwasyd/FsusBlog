import assert from 'node:assert/strict'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseArticleRights(page, observations) {
  const inspector = page.getByRole('complementary', { name: 'Article inspector' })
  await inspector.getByText('Publication rights', { exact: true }).click()
  await inspector.getByLabel('Copyright holder', { exact: true }).fill('Browser fixture owner & Co')
  await inspector.getByLabel('Copyright year', { exact: true }).fill('2026')
  await inspector.getByLabel('Rights statement', { exact: true }).fill('Publication rights browser statement.')
  const sent = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.DraftRightsCommand &&
    response.request().method() === 'POST')
  await inspector.getByRole('button', { name: 'Save publication rights', exact: true }).click()
  assert.equal((await sent).status(), 200)
  await page.getByRole('status').filter({ hasText: 'Publication rights saved.' }).waitFor()
  await inspector.getByText('Publication rights', { exact: true }).click()
  observations.push('The author uses FsusUI to persist rights and the exact publication retains rights in its public data frame without a reader-facing badge.')
}
