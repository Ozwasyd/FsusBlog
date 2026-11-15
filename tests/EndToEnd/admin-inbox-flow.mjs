import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { PodReader } from '../../src/Contracts/binary.ts'

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
  const activity = process.env.FSUSBLOG_TEST_ADMIN_INBOX_ACTIVITY === '1'
  const order = panel.getByRole('combobox', { name: 'Sort support inbox' })
  if (activity) {
    const first = panel.getByRole('list').getByRole('button').first()
    assert.equal(await first.textContent(), 'Inbox QA closed case')
    await order.click()
    const activityPage = page.waitForResponse(response => new URL(response.url()).searchParams.get('order') === 'activity')
    await page.getByRole('option', { name: 'Latest visible message', exact: true }).click()
    const sorted = await activityPage
    assert.equal(sorted.status(), 200)
    assert.equal(await sorted.headerValue(WireHeaders.AdminInboxActivityOrder), '1')
    await first.filter({ hasText: 'Inbox QA support case' }).waitFor()
  } else assert.equal(await order.count(), 0)
  const shared = process.env.FSUSBLOG_TEST_ADMIN_INBOX_SHARED === '1'
  const visibleRow = subject.locator('..')
  if (shared) await visibleRow.getByText('1 unread by support', { exact: true }).waitFor()
  else assert.equal(await visibleRow.getByText(/unread by support/).count(), 0)
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_NOTICE === '1') {
    const list = await context.request.get(queue)
    assert.equal(list.status(), 200)
    const queueRows = new PodReader(decodeFrame(await list.body(), FrameType.AdminInboxPage).payload)
    queueRows.text(100)
    assert.equal(queueRows.i32(), 2)
    queueRows.i64()
    const accountId = queueRows.uuid()
    const title = 'QA targeted system notice'
    const content = 'This is a system notice visible to its specified account.'
    const reader = await context.newPage()
    try {
      await reader.goto(`${siteOrigin}/user/messagebox`)
      await reader.getByRole('button', { name: /Inbox QA support case/ }).waitFor()
      await page.bringToFront()
      await panel.getByRole('button', { name: 'Compose system notice', exact: true }).click()
      const submit = panel.getByRole('button', { name: 'Send system notice', exact: true })
      assert.equal(await submit.isEnabled(), false)
      await panel.getByLabel('Recipient account UUID').fill(accountId)
      await panel.getByLabel('Notice subject').fill(title)
      await panel.getByLabel('Notice message').fill(content)
      const challenge = page.waitForResponse(response => response.url().endsWith('/system-send-pow.aeds'))
      const send = page.waitForResponse(response => response.url().endsWith('/system-send.aeds'))
      await submit.click()
      assert.equal((await challenge).status(), 200)
      assert.equal((await send).status(), 200)
      await panel.getByText('System notice sent to the account.', { exact: true }).waitFor()
      await reader.bringToFront()
      await reader.getByRole('button', { name: new RegExp(title) }).click()
      await reader.getByText(content, { exact: true }).last().waitFor()
      await reader.screenshot({ path: join(evidence, 'admin-inbox-account-notice.png'), animations: 'disabled' })
    } finally { await reader.close() }
  } else {
    assert.equal(await panel.getByRole('button', { name: 'Compose system notice', exact: true }).count(), 0)
  }
  const filter = panel.getByRole('combobox', { name: 'Filter support inbox' })
  await filter.click()
  await page.getByRole('option', { name: 'Open', exact: true }).click()
  await closed.waitFor({ state: 'hidden' })
  const response = page.waitForResponse(reply => reply.url().startsWith(adminOrigin + '/api/v2/admin/identity/inbox/') &&
    reply.request().method() === 'GET')
  let firstReadSnapshot = null
  if (shared) await page.route('**/read.aeds', route => {
    firstReadSnapshot = route.request().headers()[WireHeaders.AdminInboxReadSnapshot.toLowerCase()]
    return route.abort('failed')
  }, { times: 1 })
  await subject.focus()
  await page.keyboard.press('Enter')
  const detail = await response
  assert.equal(detail.status(), 200)
  assert((await detail.headerValue('Cache-Control'))?.includes('no-store'))
  assert.equal(decodeFrame(await detail.body()).type, shared ? FrameType.AdminInboxSharedThread : FrameType.AdminInboxThread)
  const heading = panel.getByRole('heading', { name: 'Inbox QA support case' })
  await heading.waitFor()
  assert(await heading.evaluate(node => document.activeElement === node))
  if (shared) {
    const retry = panel.getByRole('button', { name: 'Retry marking as read', exact: true })
    await retry.waitFor()
    assert.equal(firstReadSnapshot, await detail.headerValue(WireHeaders.AdminInboxReadSnapshot))
    const response = page.waitForResponse(reply => reply.url().endsWith('/read.aeds') && reply.request().method() === 'POST')
    await retry.click()
    const update = await response
    assert.equal(update.status(), 200)
    assert.equal(update.request().headers()[WireHeaders.AdminInboxReadSnapshot.toLowerCase()], firstReadSnapshot)
    assert.equal(await update.headerValue(WireHeaders.AdminInboxUnread), '0')
  }
  const marker = 'Inbox QA internal note <strong>literal</strong>'
  await panel.getByText(marker, { exact: true }).waitFor()
  assert.equal(await panel.locator('strong').filter({ hasText: 'literal' }).count(), 0)
  const row = await context.request.get(siteOrigin + WireRoutes.InboxList)
  assert.equal(row.status(), 200)
  const id = new URL(detail.url()).pathname.match(/\/(\d+)\.aeds$/)[1]
  const path = WireRoutes.InboxDetail.replace('{id:long}', id)
  const account = await context.request.get(siteOrigin + path)
  assert.equal(account.status(), 200)
  assert.equal((await account.body()).includes(Buffer.from(marker)), false)
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_REPLY === '1') {
    const reply = 'Inbox QA reply sent by the current administrator.'
    await panel.getByLabel('Reply to the account', { exact: true }).fill(reply)
    const proof = page.waitForResponse(response => response.url().endsWith('/reply-pow.aeds') && response.request().method() === 'POST')
    const saved = page.waitForResponse(response => response.url().endsWith('/reply.aeds') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: 'Send reply', exact: true }).click()
    assert.equal((await proof).status(), 200)
    assert.equal((await saved).status(), 200)
    await panel.getByText('Reply sent to the account.', { exact: true }).waitFor()
    await panel.getByText(reply, { exact: true }).waitFor()
    const publicOrigin = await context.request.get(siteOrigin + path)
    assert.equal(publicOrigin.status(), 200)
    const body = await publicOrigin.body()
    assert(body.includes(Buffer.from(reply)))
    assert(!body.includes(Buffer.from(marker)))
    const reader = await context.newPage()
    try {
      await reader.goto(`${siteOrigin}/user/messagebox`)
      await reader.getByRole('button', { name: /Inbox QA support case/ }).click()
      await reader.getByRole('heading', { name: 'Inbox QA support case', exact: true }).waitFor()
      await reader.getByText(reply, { exact: true }).last().waitFor()
      assert.equal(await reader.getByText(marker, { exact: true }).count(), 0)
      await reader.screenshot({ path: join(evidence, 'admin-inbox-account-reply.png'), animations: 'disabled' })
    } finally { await reader.close() }
  } else {
    assert.equal(await panel.getByRole('button', { name: 'Send reply', exact: true }).count(), 0)
  }
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_STATUS === '1') {
    assert.match(await detail.headerValue(WireHeaders.AdminInboxVersion), /^[1-9][0-9]{0,9}$/)
    const reason = 'Customer has yet to provide the private receipt.'
    const reader = await context.newPage()
    try {
      await reader.goto(`${siteOrigin}/user/messagebox`)
      await reader.getByRole('button', { name: /Inbox QA support case/ }).click()
      const accountThread = reader.getByRole('region', { name: 'Inbox QA support case' })
      await accountThread.getByText('进行中', { exact: true }).waitFor()
      await panel.getByRole('combobox', { name: 'New conversation status' }).click()
      await page.getByRole('option', { name: 'Pending', exact: true }).click()
      await panel.getByLabel('Reason for changing status', { exact: true }).fill(reason)
      const proof = page.waitForResponse(response => response.url().endsWith('/status-pow.aeds') && response.request().method() === 'POST')
      const saved = page.waitForResponse(response => response.url().endsWith('/status.aeds') && response.request().method() === 'POST')
      await panel.getByRole('button', { name: 'Save status', exact: true }).click()
      assert.equal((await proof).status(), 200)
      assert.equal((await saved).status(), 200)
      await panel.getByText('Conversation status saved.', { exact: true }).waitFor()
      await accountThread.getByText('待处理', { exact: true }).waitFor()
      assert.equal(await accountThread.getByText(reason, { exact: true }).count(), 0)
      await reader.screenshot({ path: join(evidence, 'admin-inbox-account-status.png'), animations: 'disabled' })
    } finally { await reader.close() }
  } else {
    assert.equal(await detail.headerValue(WireHeaders.AdminInboxVersion), null)
    assert.equal(await panel.getByRole('button', { name: 'Save status', exact: true }).count(), 0)
  }
  for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } })) {
    await page.setViewportSize(viewport)
    await panel.getByRole('heading', { name: 'Support inbox' }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(evidence, `admin-inbox-${name}.png`), animations: 'disabled' })
  }
  await panel.getByRole('button', { name: 'Back to conversations' }).click()
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_STATUS === '1') {
    await subject.waitFor({ state: 'hidden' })
    await filter.click()
    await page.getByRole('option', { name: 'Pending', exact: true }).click()
  }
  await subject.waitFor()
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_STATUS !== '1')
    assert(await subject.evaluate(node => document.activeElement === node))
  if (shared) {
    await visibleRow.getByText('1 unread by support', { exact: true }).waitFor({ state: 'hidden' })
    await filter.click()
    await page.getByRole('option', { name: 'Unread by support', exact: true }).click()
    await closed.waitFor()
    await subject.waitFor({ state: 'hidden' })
  }
  await panel.getByRole('button', { name: 'Close support inbox' }).click()
  assert.equal(await panel.getByText(marker, { exact: true }).count(), 0)
}
