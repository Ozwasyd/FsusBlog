import assert from 'node:assert/strict'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { waitForPathResponse } from './response-wait-fixture.mjs'

export async function exerciseArticleSchedule(page, screenshot, observations) {
  const inspector = page.getByRole('complementary', { name: 'Article inspector' })
  await inspector.getByText('Scheduled publication', { exact: true }).click()
  const input = inspector.getByLabel('Publish at (UTC)')
  const firstDue = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const newerDue = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  async function writeSchedule(value, action) {
    if (value) await input.fill(value)
    const sent = waitForPathResponse(page, () => WireRoutes.DraftScheduleCommand, 'POST')
    await inspector.getByRole('button', { name: action, exact: true }).click()
    assert.equal((await sent).status(), 200)
    await page.getByRole('status').filter({ hasText: 'Publication schedule updated.' }).waitFor()
  }
  await writeSchedule(firstDue, 'Schedule publication')
  await inspector.getByText(`Scheduled for ${firstDue}.`, { exact: false }).waitFor()
  await writeSchedule(newerDue, 'Reschedule publication')
  await inspector.getByText(`Scheduled for ${newerDue}.`, { exact: false }).waitFor()
  await screenshot(page, 'editor-scheduled-publication')
  await writeSchedule(null, 'Cancel schedule')
  await inspector.getByRole('button', { name: 'Schedule publication', exact: true }).waitFor()
  await inspector.getByText('Scheduled publication', { exact: true }).click()
  observations.push('The FsusUI Inspector schedules and reschedules an exact UTC time, then cancels the pending saved revision.')
}
