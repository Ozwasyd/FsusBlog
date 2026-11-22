import { visitAdminWorkspace } from './admin-workspace-fixture.mjs'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request } from 'node:https'
import { join } from 'node:path'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { exactButton, roleWithExactName } from './role-locators.mjs'

const wakeProtocol = 'fsus-inbox-wake.v2'
const wakePathPattern = new RegExp(`^${WireRoutes.AdminInboxWake.replace('{id:long}', '[1-9]\\d*')}$`)

export async function verifyAdminInbox(page, context, adminOrigin, siteOrigin, siteCookie, adminCookieName, probe, evidence) {
  const queue = adminOrigin + WireRoutes.AdminInboxQueue
  const live = process.env.FSUSBLOG_TEST_ADMIN_INBOX_LIVE === '1'
  const shared = process.env.FSUSBLOG_TEST_ADMIN_INBOX_SHARED === '1'
  const panel = page.getByRole('region', { name: 'Support inbox' })
  await visitAdminWorkspace(page, '/admin/interaction')
  const [defaultPage] = await Promise.all([
    page.waitForResponse(response => isDefaultQueueResponse(response, queue, shared)),
    roleWithExactName(page, 'tab', 'Support inbox').click(),
  ])
  assert.equal((await context.request.get(siteOrigin + WireRoutes.AdminInboxQueue)).status(), 404)
  await probe(queue, siteCookie.name, siteCookie.value, 401)
  await probe(queue, adminCookieName, siteCookie.value, 401)

  const sockets = []
  const onSocket = socket => {
    const path = new URL(socket.url()).pathname
    if (path === WireRoutes.AdminInboxQueueWake || wakePathPattern.test(path)) sockets.push(socket)
  }
  page.on('websocket', onSocket)
  if (live) await captureInboxSocket(page, wakePathPattern.source)
  assert.equal(defaultPage.status(), 200)
  assert.equal(await defaultPage.headerValue(WireHeaders.AdminInboxLive), live ? '1' : null)
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
    await roleWithExactName(page, 'option', 'Latest visible message').click()
    const sorted = await activityPage
    assert.equal(sorted.status(), 200)
    assert.equal(await sorted.headerValue(WireHeaders.AdminInboxActivityOrder), '1')
    assert.equal(await sorted.headerValue(WireHeaders.AdminInboxLive), null)
    await first.filter({ hasText: 'Inbox QA support case' }).waitFor()
  } else assert.equal(await order.count(), 0)
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
    const systemViewer = live && shared ? await context.newPage() : null
    try {
      let systemSocket, systemRow
      if (systemViewer) {
        const wakeUrl = new URL(WireRoutes.AdminInboxQueueWake + '?status=system&shared=1', adminOrigin)
        wakeUrl.protocol = 'wss:'
        await systemViewer.goto(adminOrigin + '/admin/interaction')
        await captureInboxSocket(systemViewer, `^${wakeUrl.pathname}$`)
        await roleWithExactName(systemViewer, 'tab', 'Support inbox').click()
        const socket = systemViewer.waitForEvent('websocket', candidate => candidate.url() === wakeUrl.href)
        const systemPanel = systemViewer.getByRole('region', { name: 'Support inbox' })
        await systemPanel.getByRole('combobox', { name: 'Filter support inbox' }).click()
        await roleWithExactName(systemViewer, 'option', 'System notices').click()
        await waitForInboxSocket(systemViewer, wakeUrl.href)
        systemSocket = await socket
        systemRow = exactButton(systemPanel, title)
        assert.equal(await systemRow.count(), 0)
      }
      await reader.goto(`${siteOrigin}/user/messagebox`)
      await reader.getByRole('button', { name: /Inbox QA support case/ }).waitFor()
      await page.bringToFront()
      await exactButton(panel, 'Compose system notice').click()
      const submit = exactButton(panel, 'Send system notice')
      assert.equal(await submit.isEnabled(), false)
      await panel.getByLabel('Recipient account UUID').fill(accountId)
      await panel.getByLabel('Notice subject').fill(title)
      await panel.getByLabel('Notice message').fill(content)
      const challenge = page.waitForResponse(response => response.url().endsWith('/system-send-pow.aeds'))
      const send = page.waitForResponse(response => response.url().endsWith('/system-send.aeds'))
      const [challenged, sent, wake] = await Promise.all([
        challenge, send, systemSocket?.waitForEvent('framereceived', { timeout: 15_000 }), submit.click(),
      ])
      assert.equal(challenged.status(), 200)
      assert.equal(sent.status(), 200)
      await panel.getByText('System notice sent to the account.', { exact: true }).waitFor()
      if (wake && systemRow) {
        assert(Buffer.isBuffer(wake.payload))
        decodeSuccess(decodeFrame(wake.payload, FrameType.EmptySuccess).payload)
        await systemRow.waitFor()
      }
      await reader.bringToFront()
      await reader.getByRole('button', { name: new RegExp(title) }).click()
      await reader.getByText(content, { exact: true }).last().waitFor()
      await reader.screenshot({ path: join(evidence, 'admin-inbox-account-notice.png'), animations: 'disabled' })
    } finally { await Promise.all([reader.close(), systemViewer?.close()]) }
  } else {
    assert.equal(await exactButton(panel, 'Compose system notice').count(), 0)
  }
  const filter = panel.getByRole('combobox', { name: 'Filter support inbox' })
  await filter.click()
  const [filtered] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).searchParams.get('status') === 'open'),
    roleWithExactName(page, 'option', 'Open').click(),
  ])
  assert.equal(filtered.status(), 200)
  assert.equal(await filtered.headerValue(WireHeaders.AdminInboxLive), live && !activity ? '1' : null)
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
  assert.equal(await detail.headerValue(WireHeaders.AdminInboxLive), live ? '1' : null)
  assert.equal(decodeFrame(await detail.body()).type, shared ? FrameType.AdminInboxSharedThread : FrameType.AdminInboxThread)
  const heading = panel.getByRole('heading', { name: 'Inbox QA support case' })
  await heading.waitFor()
  assert(await heading.evaluate(node => document.activeElement === node))
  if (shared) {
    const retry = exactButton(panel, 'Retry marking as read')
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
  const wakeEndpoint = adminOrigin + WireRoutes.AdminInboxWake.replace('{id:long}', id)
  if (live) {
    try {
      const adminCookie = (await context.cookies(adminOrigin)).find(cookie => cookie.name === adminCookieName)
      assert(adminCookie)
      assert.equal(await upgradeStatus(wakeEndpoint, adminOrigin, `${adminCookieName}=${siteCookie.value}`), 401)
      assert.equal(await upgradeStatus(wakeEndpoint, siteOrigin, `${adminCookieName}=${adminCookie.value}`), 403)
      await verifyOpenedThreadUpdates(page, panel, context, wakeEndpoint, siteOrigin, id, detail.url(), sockets, evidence)
    } finally { await page.evaluate(() => window.fsusTestRestoreAdminInboxSocket()) }
    if (shared) {
      await panel.getByText('2 unread by support', { exact: true }).waitFor()
      const detailPath = new URL(detail.url()).pathname
      const readEndpoint = adminOrigin + WireRoutes.AdminInboxAcknowledge.replace('{id:long}', id)
      const [reloaded, acknowledged] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === detailPath && response.request().method() === 'GET'),
        page.waitForResponse(response => response.url() === readEndpoint && response.request().method() === 'POST'),
        exactButton(panel, 'Reload conversation').click(),
      ])
      assert.equal(reloaded.status(), 200)
      assert.equal(acknowledged.status(), 200)
      const snapshot = await reloaded.headerValue(WireHeaders.AdminInboxReadSnapshot)
      assert.match(snapshot, /^[a-zA-Z0-9_-]{64}$/)
      assert.equal(acknowledged.request().headers()[WireHeaders.AdminInboxReadSnapshot.toLowerCase()], snapshot)
      assert.equal(await acknowledged.headerValue(WireHeaders.AdminInboxUnread), '0')
    }
  } else assert.equal((await context.request.get(wakeEndpoint)).status(), 404)
  if (live || process.env.FSUSBLOG_TEST_ADMIN_INBOX_REPLY === '1') {
    const reply = 'Inbox QA reply sent by the current administrator.'
    await panel.getByLabel('Reply to the account', { exact: true }).fill(reply)
    await submitInboxAction(page, panel, '/reply-pow.aeds', '/reply.aeds', 'Send reply')
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
      await roleWithExactName(reader, 'heading', 'Inbox QA support case').waitFor()
      await reader.getByText(reply, { exact: true }).last().waitFor()
      assert.equal(await reader.getByText(marker, { exact: true }).count(), 0)
      await reader.screenshot({ path: join(evidence, 'admin-inbox-account-reply.png'), animations: 'disabled' })
    } finally { await reader.close() }
  } else {
    assert.equal(await exactButton(panel, 'Send reply').count(), 0)
  }
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_STATUS === '1') {
    assert.match(await detail.headerValue(WireHeaders.AdminInboxVersion), /^[1-9][0-9]{0,9}$/)
    const reason = 'Customer has yet to provide the private receipt.'
    const reader = await context.newPage()
    const peerPages = []
    try {
      let peerThread, peerQueue, peerDraft
      if (live && !activity) {
        peerThread = await peer(true)
        peerQueue = await peer(false)
        peerDraft = peerThread.getByLabel('Reply to the account', { exact: true })
        await peerDraft.fill('Unsaved reply in another administrator tab')
        await peerDraft.focus()
      }
      await reader.goto(`${siteOrigin}/user/messagebox`)
      await reader.getByRole('button', { name: /Inbox QA support case/ }).click()
      const accountThread = reader.getByRole('region', { name: 'Inbox QA support case' })
      await accountThread.getByText('进行中', { exact: true }).waitFor()
      await page.bringToFront()
      await panel.getByRole('combobox', { name: 'New conversation status' }).click()
      await roleWithExactName(page, 'option', 'Pending').click()
      await panel.getByLabel('Reason for changing status', { exact: true }).fill(reason)
      await submitInboxAction(page, panel, '/status-pow.aeds', '/status.aeds', 'Save status')
      await panel.getByText('Conversation status saved.', { exact: true }).waitFor()
      await accountThread.getByText('待处理', { exact: true }).waitFor()
      assert.equal(await accountThread.getByText(reason, { exact: true }).count(), 0)
      if (peerThread && peerQueue && peerDraft) {
        await peerThread.getByText('Pending · Account ticket', { exact: true }).waitFor()
        await exactButton(peerQueue, 'Inbox QA support case').waitFor({ state: 'hidden' })
        assert.equal(await peerDraft.inputValue(), 'Unsaved reply in another administrator tab')
        assert(await peerDraft.evaluate(node => document.activeElement === node))
        const queuePeerPage = peerPages[1]
        await peerQueue.getByRole('combobox', { name: 'Filter support inbox' }).click()
        await roleWithExactName(queuePeerPage, 'option', 'Pending').click()
        await exactButton(peerQueue, 'Inbox QA support case').waitFor()
        await peerPages[0].screenshot({ path: join(evidence, 'admin-inbox-peer-status.png'), animations: 'disabled' })
      }
      await reader.screenshot({ path: join(evidence, 'admin-inbox-account-status.png'), animations: 'disabled' })
    } finally {
      await Promise.all(peerPages.map(peerPage => peerPage.close()))
      await reader.close()
    }

    async function peer(openThread) {
      const peerPage = await context.newPage()
      peerPages.push(peerPage)
      await peerPage.goto(adminOrigin + '/admin/interaction')
      const endpoint = new URL(openThread ? wakeEndpoint : WireRoutes.AdminInboxQueueWake + '?status=open', adminOrigin)
      endpoint.protocol = 'wss:'
      await captureInboxSocket(peerPage, `^${endpoint.pathname}$`)
      await roleWithExactName(peerPage, 'tab', 'Support inbox').click()
      const peerPanel = peerPage.getByRole('region', { name: 'Support inbox' })
      if (openThread) await exactButton(peerPanel, 'Inbox QA support case').click()
      else {
        await peerPanel.getByRole('combobox', { name: 'Filter support inbox' }).click()
        await roleWithExactName(peerPage, 'option', 'Open').click()
        await exactButton(peerPanel, 'Inbox QA support case').waitFor()
      }
      await waitForInboxSocket(peerPage, endpoint.href)
      return peerPanel
    }
  } else {
    assert.equal(await detail.headerValue(WireHeaders.AdminInboxVersion), null)
    assert.equal(await exactButton(panel, 'Save status').count(), 0)
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
    await roleWithExactName(page, 'option', 'Pending').click()
  }
  await subject.waitFor()
  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_STATUS !== '1')
    assert(await subject.evaluate(node => document.activeElement === node))
  if (shared) {
    await visibleRow.getByText('1 unread by support', { exact: true }).waitFor({ state: 'hidden' })
    await filter.click()
    await roleWithExactName(page, 'option', 'Unread by support').click()
    await closed.waitFor()
    await subject.waitFor({ state: 'hidden' })
  }
  await roleWithExactName(page, 'tab', 'Moderation queue').click()
  assert.equal(await panel.getByText(marker, { exact: true }).count(), 0)
  if (live) {
    await verifyDefaultQueueUpdates(page, panel, context, adminOrigin, siteOrigin, subject, shared, sockets, evidence)
  } else {
    assert.equal(sockets.length, 0)
    assert.equal((await context.request.get(adminOrigin + WireRoutes.AdminInboxQueueWake)).status(), 404)
  }
  page.off('websocket', onSocket)
}

export async function prepareAdminInboxWakeProbe(context, adminOrigin) {
  const result = await context.request.get(adminOrigin + WireRoutes.AdminInboxQueue)
  assert.equal(result.status(), 200)
  const list = new PodReader(decodeFrame(await result.body(), FrameType.AdminInboxPage).payload)
  list.text(100)
  assert(list.i32() > 0)
  const path = WireRoutes.AdminInboxWake.replace('{id:long}', String(list.i64()))
  const wakeUrl = new URL(path, adminOrigin)
  wakeUrl.protocol = 'wss:'
  const page = await context.newPage()
  await page.goto(new URL('/admin/interaction', adminOrigin).href)
  const closed = () => page.evaluate(() => window.fsusTestInboxProbeClosed)

  await open(true)
  const rejected = await closed()
  assert(rejected, 'Client messages must close the receive-only inbox wake socket.')
  assert.equal(rejected.frames, 0)

  await open(false)
  return async () => {
    try { assert.deepEqual(await closed(), { code: 1008, frames: 0 }) }
    finally { await page.close() }
  }

  async function open(sendBody) {
    await page.evaluate(async ({ url, protocol, sendBody }) => {
      const socket = new WebSocket(url, protocol)
      let frames = 0
      socket.addEventListener('message', () => { frames++ })
      window.fsusTestInboxProbeClosed = new Promise(resolve => {
        const deadline = setTimeout(() => { socket.close(); resolve(null) }, 12_000)
        socket.addEventListener('close', event => {
          clearTimeout(deadline)
          resolve({ code: event.code, frames })
        }, { once: true })
      })
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('close', () => reject(new Error('Inbox wake probe closed before admission.')), { once: true })
      })
      if (sendBody) socket.send(new Uint8Array(1))
    }, { url: wakeUrl.href, protocol: wakeProtocol, sendBody })
  }
}

async function submitInboxAction(page, panel, proofPath, commandPath, button) {
  const waitForPost = path => page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST')
  const proof = waitForPost(proofPath)
  const saved = waitForPost(commandPath)
  await exactButton(panel, button).click()
  assert.equal((await proof).status(), 200)
  assert.equal((await saved).status(), 200)
}

function upgradeStatus(endpoint, origin, cookie) {
  return new Promise((resolve, reject) => {
    const upgrade = request(endpoint, {
      signal: AbortSignal.timeout(5_000),
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin, Cookie: cookie,
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Protocol': wakeProtocol,
      },
    }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    upgrade.once('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode)
    })
    upgrade.once('error', reject)
    upgrade.end()
  })
}

function captureInboxSocket(page, pattern) {
  return page.evaluate(source => {
    const NativeSocket = window.WebSocket
    const pathPattern = new RegExp(source)
    window.fsusTestAdminInboxSocket = null
    window.fsusTestRestoreAdminInboxSocket = () => {
      window.WebSocket = NativeSocket
      delete window.fsusTestAdminInboxSocket
      delete window.fsusTestRestoreAdminInboxSocket
    }
    window.WebSocket = class extends NativeSocket {
      constructor(url, protocols) {
        super(url, protocols)
        if (pathPattern.test(new URL(this.url).pathname)) window.fsusTestAdminInboxSocket = this
      }
    }
  }, pattern)
}

function waitForInboxSocket(page, url) {
  return page.waitForFunction(({ url, protocol }) => {
    const socket = window.fsusTestAdminInboxSocket
    return socket?.url === url && socket.readyState === WebSocket.OPEN && socket.protocol === protocol
  }, { url, protocol: wakeProtocol }, { timeout: 30_000 })
}

function isDefaultQueueResponse(response, queue, shared) {
  const url = new URL(response.url())
  return response.request().method() === 'GET' && url.origin + url.pathname === queue &&
    !url.searchParams.has('status') && !url.searchParams.has('order') && !url.searchParams.has('cursor') &&
    url.searchParams.get('shared') === (shared ? '1' : null)
}

async function verifyDefaultQueueUpdates(page, panel, context, adminOrigin, siteOrigin, existing, shared, sockets, evidence) {
  const queue = adminOrigin + WireRoutes.AdminInboxQueue
  const wakeUrl = new URL(WireRoutes.AdminInboxQueueWake, adminOrigin)
  wakeUrl.protocol = 'wss:'
  const subject = 'Inbox QA ticket created while support queue stays open'
  const body = 'The account opened this ticket with the normal proof flow.'
  const reader = await context.newPage()
  await captureInboxSocket(page, `^${wakeUrl.pathname}$`)
  try {
    await reader.goto(`${siteOrigin}/user/messagebox`)
    await exactButton(reader, '提交工单').click()
    await reader.getByLabel('主题（选填）', { exact: true }).fill(subject)
    await reader.getByLabel('工单内容', { exact: true }).fill(body)

    await page.bringToFront()
    await roleWithExactName(page, 'tab', 'Support inbox').click()
    await existing.waitFor()
    await existing.focus()
    const createdRow = exactButton(panel, subject)
    assert.equal(await createdRow.count(), 0)
    await waitForInboxSocket(page, wakeUrl.href)
    const socket = sockets.findLast(candidate => candidate.url() === wakeUrl.href)
    assert(socket)
    const [{ payload }, refreshed] = await Promise.all([
      socket.waitForEvent('framereceived', { timeout: 15_000 }),
      page.waitForResponse(async response => isDefaultQueueResponse(response, queue, shared) && response.ok() &&
        (await response.body()).includes(Buffer.from(subject)), { timeout: 15_000 }),
      sendTicket(),
    ])
    assert(Buffer.isBuffer(payload))
    decodeSuccess(decodeFrame(payload, FrameType.EmptySuccess).payload)
    assert.equal(refreshed.status(), 200)
    assert.equal(await refreshed.headerValue(WireHeaders.AdminInboxLive), '1')
    const list = new PodReader(decodeFrame(await refreshed.body(), shared ? FrameType.AdminInboxSharedPage : FrameType.AdminInboxPage).payload)
    list.text(100)
    assert(list.i32() >= 3)
    assert(list.i64() > 0n)
    list.uuid()
    assert.equal(list.text(640), subject)
    await createdRow.waitFor()
    assert.equal(await createdRow.count(), 1)
    if (shared) await createdRow.locator('..').getByText('1 unread by support', { exact: true }).waitFor()
    assert.equal(await existing.evaluate(node => document.activeElement === node), true)
    await page.screenshot({ path: join(evidence, 'admin-inbox-live-new-ticket.png'), animations: 'disabled' })
    await roleWithExactName(page, 'tab', 'Moderation queue').click()
  } finally {
    await page.evaluate(() => window.fsusTestRestoreAdminInboxSocket())
    await reader.close()
  }

  async function sendTicket() {
    const post = (response, path) => response.url() === siteOrigin + path && response.request().method() === 'POST'
    const [challenge, created] = await Promise.all([
      reader.waitForResponse(response => post(response, WireRoutes.InboxCreatePowChallenge)),
      reader.waitForResponse(response => post(response, WireRoutes.InboxList)),
      exactButton(reader, '发送工单').click(),
    ])
    assert.equal(challenge.status(), 200)
    assert.equal(created.status(), 200)
    await reader.getByText('工单已提交。', { exact: true }).waitFor()
    await page.bringToFront()
  }
}

async function verifyOpenedThreadUpdates(page, panel, context, wakeEndpoint, siteOrigin, id, detailUrl, sockets, evidence) {
  const wakeUrl = new URL(wakeEndpoint)
  wakeUrl.protocol = 'wss:'
  const threadPath = new URL(detailUrl).pathname
  const composer = panel.getByLabel('Reply to the account', { exact: true })
  const draft = 'Unsent administrator draft retained during account activity.'
  const reader = await context.newPage()
  try {
    await reader.goto(`${siteOrigin}/user/messagebox`)
    await reader.getByRole('button', { name: /Inbox QA support case/ }).click()
    const accountThread = reader.getByRole('region', { name: 'Inbox QA support case' })
    await accountThread.getByText('Inbox QA newest public reply', { exact: true }).waitFor()
    await page.bringToFront()
    await composer.fill(draft)
    await composer.focus()
    await waitForInboxSocket(page, wakeUrl.href)

    const socket = sockets.findLast(candidate => candidate.url() === wakeUrl.href)
    assert(socket)
    const firstReply = 'Inbox QA account reply while the administrator thread stays open.'
    const [{ payload }, refreshed] = await Promise.all([
      socket.waitForEvent('framereceived', { timeout: 15_000 }),
      waitForDetail(firstReply, 15_000),
      sendAccountReply(firstReply),
    ])
    assert(Buffer.isBuffer(payload))
    decodeSuccess(decodeFrame(payload, FrameType.EmptySuccess).payload)
    assert.equal(refreshed.status(), 200)
    await verifyDraftAfter(firstReply)

    const network = await context.newCDPSession(page)
    try {
      await network.send('Network.enable')
      // Keep this tab's real WSS transport down until the other tab commits a reply.
      await network.send('Network.setBlockedURLs', { urls: [wakeUrl.href] })
      const closing = socket.waitForEvent('close', { timeout: 10_000 })
      await page.evaluate(() => window.fsusTestAdminInboxSocket.close(4001))
      await closing
      const offlineReply = 'Inbox QA account reply committed during administrator reconnect.'
      await sendAccountReply(offlineReply)
      assert.equal(await page.evaluate(() => window.fsusTestAdminInboxSocket.readyState === WebSocket.OPEN), false)
      assert.equal(await panel.getByText(offlineReply, { exact: true }).count(), 0)
      const [recovered] = await Promise.all([
        waitForDetail(offlineReply, 30_000),
        network.send('Network.setBlockedURLs', { urls: [] }).then(() => waitForInboxSocket(page, wakeUrl.href)),
      ])
      assert.notEqual(sockets.findLast(candidate => candidate.url() === wakeUrl.href), socket)
      assert.equal(recovered.status(), 200)
      await verifyDraftAfter(offlineReply)
      assert.equal(await panel.getByText(firstReply, { exact: true }).count(), 1)
    } finally {
      await network.send('Network.setBlockedURLs', { urls: [] })
      await network.detach()
    }
    await page.screenshot({ path: join(evidence, 'admin-inbox-live-account-replies.png'), animations: 'disabled' })
  } finally { await reader.close() }

  function waitForDetail(message, timeout) {
    return page.waitForResponse(async response => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === threadPath && response.ok() &&
      (await response.body()).includes(Buffer.from(message)), { timeout })
  }

  async function sendAccountReply(body) {
    await reader.getByLabel('回复内容', { exact: true }).fill(body)
    const challenge = reader.waitForResponse(response => response.url() === siteOrigin +
      WireRoutes.InboxReplyPowChallenge.replace('{id:long}', id) && response.request().method() === 'POST')
    const reply = reader.waitForResponse(response => response.url() === siteOrigin +
      WireRoutes.InboxReply.replace('{id:long}', id) && response.request().method() === 'POST')
    await exactButton(reader, '发送回复').click()
    assert.equal((await challenge).status(), 200)
    assert.equal((await reply).status(), 200)
    await reader.getByText('回复已发送。', { exact: true }).waitFor()
    await page.bringToFront()
  }

  async function verifyDraftAfter(message) {
    const item = panel.getByText(message, { exact: true })
    await item.waitFor({ timeout: 15_000 })
    assert.equal(await item.count(), 1)
    assert.equal(await composer.inputValue(), draft)
    assert.equal(await composer.evaluate(node => document.activeElement === node), true)
  }
}
