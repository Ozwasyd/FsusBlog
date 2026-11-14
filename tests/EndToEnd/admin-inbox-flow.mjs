import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function verifyAdminInbox(page, context, adminOrigin, siteOrigin, siteCookie, adminCookieName, probe, evidence) {
  const queue = adminOrigin + WireRoutes.AdminInboxQueue
  assert.equal((await context.request.get(siteOrigin + WireRoutes.AdminInboxQueue)).status(), 404)
  await probe(queue, siteCookie.name, siteCookie.value, 401)
  await probe(queue, adminCookieName, siteCookie.value, 401)

  const panel = page.getByRole('region', { name: 'Support inbox' })
  await panel.getByRole('button', { name: 'Open support inbox' }).click()
  const subject = panel.getByRole('button', { name: 'Inbox QA support case' })
  const closed = panel.getByRole('button', { name: 'Inbox QA closed case' })
  await subject.waitFor()
  await closed.waitFor()
  const filter = panel.getByRole('combobox', { name: 'Filter support inbox' })
  await filter.click()
  await page.getByRole('option', { name: 'Open', exact: true }).click()
  await closed.waitFor({ state: 'hidden' })
  const response = page.waitForResponse(reply => reply.url().startsWith(adminOrigin + '/api/v2/admin/identity/inbox/'))
  await subject.focus()
  await page.keyboard.press('Enter')
  const detail = await response
  assert.equal(detail.status(), 200)
  assert((await detail.headerValue('Cache-Control'))?.includes('no-store'))
  assert.equal(decodeFrame(await detail.body()).type, FrameType.AdminInboxThread)
  const marker = 'Inbox QA internal note <strong>literal</strong>'
  const heading = panel.getByRole('heading', { name: 'Inbox QA support case' })
  await heading.waitFor()
  assert(await heading.evaluate(node => document.activeElement === node))
  await panel.getByText(marker, { exact: true }).waitFor()
  assert.equal(await panel.locator('strong').filter({ hasText: 'literal' }).count(), 0)
  const row = await context.request.get(siteOrigin + WireRoutes.InboxList)
  assert.equal(row.status(), 200)
  const id = new URL(detail.url()).pathname.match(/\/(\d+)\.aeds$/)[1]
  const path = WireRoutes.InboxDetail.replace('{id:long}', id)
  const account = await context.request.get(siteOrigin + path)
  assert.equal(account.status(), 200)
  assert.equal((await account.body()).includes(Buffer.from(marker)), false)
  for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } })) {
    await page.setViewportSize(viewport)
    await panel.getByRole('heading', { name: 'Support inbox' }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(evidence, `admin-inbox-${name}.png`), animations: 'disabled' })
  }
  await panel.getByRole('button', { name: 'Back to conversations' }).click()
  await subject.waitFor()
  assert(await subject.evaluate(node => document.activeElement === node))
  await panel.getByRole('button', { name: 'Close support inbox' }).click()
  assert.equal(await panel.getByText(marker, { exact: true }).count(), 0)
}
