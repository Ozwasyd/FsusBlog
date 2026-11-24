import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request } from 'node:https'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { FrameType, WireHeaders, WireRoutes as R } from '../../src/Contracts/wire.generated.ts'
import * as adminFx from './admin-workspace-fixture.mjs'
import { assertNoOverflow, saveShot } from './isolated-browser-fixture.mjs'
import * as res from './response-status-fixture.mjs'
import { waitForPathResponse, waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'
import { findCookie } from './site-authentication-fixture.mjs'

const wakeProtocol = 'fsus-inbox-wake.v2'
const wakePathPattern = new RegExp(`^${R.AdminInboxWake.replace('{id:long}', '[1-9]\\d*')}$`)
const assertWakeEmpty = payload => {
  assert(Buffer.isBuffer(payload))
  decodeSuccess(decodeFrame(payload, FrameType.EmptySuccess).payload)
}

async function openLiveInboxTab(target, adminOrigin, wakeTarget, prepare) {
  const endpoint = new URL(wakeTarget, adminOrigin)
  endpoint.protocol = 'wss:'
  await target.goto(adminOrigin + '/admin/interaction')
  await captureInboxSocket(target, `^${endpoint.pathname}$`)
  await loc.exactTab(target, 'Support inbox').click()
  const panel = target.getByRole('region', { name: 'Support inbox' })
  const extra = await prepare(panel, endpoint)
  await waitForInboxSocket(target, endpoint.href)
  return { panel, extra }
}

async function submitAccountInboxAction(reader, page, powUrl, postUrl, label, notice) {
  const [challenge, reply] = await Promise.all([
    waitForUrlResponse(reader, () => powUrl, 'POST'),
    waitForUrlResponse(reader, () => postUrl, 'POST'),
    loc.exactButton(reader, label).click(),
  ])
  res.assertStatus(challenge, 200)
  res.assertStatus(reply, 200)
  await loc.exactText(reader, notice).waitFor()
  await page.bringToFront()
}

async function expectWakeRefresh(sockets, wakeUrl, waitResponse, action) {
  const socket = sockets.findLast(candidate => candidate.url() === wakeUrl.href)
  assert(socket)
  const [{ payload }, refreshed] = await Promise.all([
    socket.waitForEvent('framereceived', { timeout: 15_000 }), waitResponse(), action(),
  ])
  assertWakeEmpty(payload)
  return { socket, refreshed }
}

export async function verifyAdminInbox(page, context, adminOrigin, siteOrigin, siteCookie, adminCookieName, probe, evidence) {
  const queue = adminOrigin + R.AdminInboxQueue
  const live = process.env.FSUSBLOG_TEST_ADMIN_INBOX_LIVE === '1'
  const shared = process.env.FSUSBLOG_TEST_ADMIN_INBOX_SHARED === '1'
  const statusEnabled = process.env.FSUSBLOG_TEST_ADMIN_INBOX_STATUS === '1'
  const panel = page.getByRole('region', { name: 'Support inbox' })
  const withReader = async (openCase, run) => {
    const reader = await context.newPage()
    try {
      await reader.goto(`${siteOrigin}/user/messagebox`)
      if (openCase) await reader.getByRole('button', { name: /Inbox QA support case/ }).click()
      return await run(reader)
    } finally { await reader.close() }
  }
  await adminFx.visitAdminWorkspace(page, '/admin/interaction')
  const [defaultPage] = await Promise.all([
    page.waitForResponse(response => isDefaultQueueResponse(response, queue, shared)),
    loc.exactTab(page, 'Support inbox').click(),
  ])
  await res.assertGetStatus(context.request, siteOrigin + R.AdminInboxQueue, 404)
  await probe(queue, siteCookie.name, siteCookie.value, 401)
  await probe(queue, adminCookieName, siteCookie.value, 401)

  const sockets = []
  const onSocket = socket => {
    const path = new URL(socket.url()).pathname
    if (path === R.AdminInboxQueueWake || wakePathPattern.test(path)) sockets.push(socket)
  }
  page.on('websocket', onSocket)
  if (live) await captureInboxSocket(page, wakePathPattern.source)
  res.assertStatus(defaultPage, 200)
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
    const [sorted] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).searchParams.get('order') === 'activity'),
      loc.exactOption(page, 'Latest visible message').click(),
    ])
    res.assertStatus(sorted, 200)
    assert.equal(await sorted.headerValue(WireHeaders.AdminInboxActivityOrder), '1')
    assert.equal(await sorted.headerValue(WireHeaders.AdminInboxLive), null)
    await first.filter({ hasText: 'Inbox QA support case' }).waitFor()
  } else assert.equal(await order.count(), 0)
  const visibleRow = subject.locator('..')
  if (shared) await loc.exactText(visibleRow, '1 unread by support').waitFor()
  else assert.equal(await visibleRow.getByText(/unread by support/).count(), 0)

  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX_NOTICE === '1') {
    const queueRows = new PodReader(await res.getFrame(context.request, queue, FrameType.AdminInboxPage))
    queueRows.text(100)
    assert.equal(queueRows.i32(), 2)
    queueRows.i64()
    const accountId = queueRows.uuid()
    const title = 'QA targeted system notice', content = 'This is a system notice visible to its specified account.'
    const systemViewer = live && shared ? await context.newPage() : null
    try {
      await withReader(false, async reader => {
        let systemSocket, systemRow
        if (systemViewer) {
          const opened = await openLiveInboxTab(systemViewer, adminOrigin, R.AdminInboxQueueWake + '?status=system&shared=1', async (systemPanel, endpoint) => {
            const socket = systemViewer.waitForEvent('websocket', candidate => candidate.url() === endpoint.href)
            await adminFx.selectOption(systemViewer, systemPanel, 'Filter support inbox', 'System notices')
            return socket
          })
          systemSocket = await opened.extra
          systemRow = loc.exactButton(opened.panel, title)
          assert.equal(await systemRow.count(), 0)
        }
        await reader.getByRole('button', { name: /Inbox QA support case/ }).waitFor()
        await page.bringToFront()
        await loc.exactButton(panel, 'Compose system notice').click()
        const submit = loc.exactButton(panel, 'Send system notice')
        assert.equal(await submit.isEnabled(), false)
        await panel.getByLabel('Recipient account UUID').fill(accountId)
        await panel.getByLabel('Notice subject').fill(title)
        await panel.getByLabel('Notice message').fill(content)
        const wake = await submitInboxAction(page, panel, '/system-send-pow.aeds', '/system-send.aeds', 'Send system notice',
          systemSocket?.waitForEvent('framereceived', { timeout: 15_000 }))
        await loc.exactText(panel, 'System notice sent to the account.').waitFor()
        if (wake && systemRow) {
          assertWakeEmpty(wake.payload)
          await systemRow.waitFor()
        }
        await reader.bringToFront()
        await reader.getByRole('button', { name: new RegExp(title) }).click()
        await loc.exactText(reader, content).last().waitFor()
        await saveShot(reader, evidence, 'admin-inbox-account-notice.png')
      })
    } finally { await systemViewer?.close() }
  } else assert.equal(await loc.exactButton(panel, 'Compose system notice').count(), 0)

  await panel.getByRole('combobox', { name: 'Filter support inbox' }).click()
  const [filtered] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).searchParams.get('status') === 'open'),
    loc.exactOption(page, 'Open').click(),
  ])
  res.assertStatus(filtered, 200)
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
  assert.equal(await detail.headerValue(WireHeaders.AdminInboxLive), live ? '1' : null)
  await res.readNoStoreFrame(detail, shared ? FrameType.AdminInboxSharedThread : FrameType.AdminInboxThread)
  const heading = panel.getByRole('heading', { name: 'Inbox QA support case' })
  await heading.waitFor()
  await adminFx.assertFocused(heading)
  if (shared) {
    const retry = loc.exactButton(panel, 'Retry marking as read')
    await retry.waitFor()
    assert.equal(firstReadSnapshot, await detail.headerValue(WireHeaders.AdminInboxReadSnapshot))
    const [update] = await Promise.all([
      page.waitForResponse(reply => reply.url().endsWith('/read.aeds') && reply.request().method() === 'POST'),
      retry.click(),
    ])
    res.assertStatus(update, 200)
    assert.equal(update.request().headers()[WireHeaders.AdminInboxReadSnapshot.toLowerCase()], firstReadSnapshot)
    assert.equal(await update.headerValue(WireHeaders.AdminInboxUnread), '0')
  }
  const marker = 'Inbox QA internal note <strong>literal</strong>'
  await loc.exactText(panel, marker).waitFor()
  assert.equal(await panel.locator('strong').filter({ hasText: 'literal' }).count(), 0)
  await res.assertGetStatus(context.request, siteOrigin + R.InboxList, 200)
  const id = new URL(detail.url()).pathname.match(/\/(\d+)\.aeds$/)[1]
  const path = R.InboxDetail.replace('{id:long}', id)
  const account = await context.request.get(siteOrigin + path)
  res.assertStatus(account, 200)
  res.assertNoneIn(await account.body(), marker)
  const wakeEndpoint = adminOrigin + R.AdminInboxWake.replace('{id:long}', id)
  if (live) {
    try {
      const adminCookie = await findCookie(context, adminOrigin, adminCookieName)
      assert(adminCookie)
      assert.equal(await upgradeStatus(wakeEndpoint, adminOrigin, `${adminCookieName}=${siteCookie.value}`), 401)
      assert.equal(await upgradeStatus(wakeEndpoint, siteOrigin, `${adminCookieName}=${adminCookie.value}`), 403)
      await verifyOpenedThreadUpdates(page, panel, context, wakeEndpoint, siteOrigin, id, detail.url(), sockets, evidence, withReader)
    } finally { await page.evaluate(() => window.fsusTestRestoreAdminInboxSocket()) }
    if (shared) {
      await loc.exactText(panel, '2 unread by support').waitFor()
      const detailPath = new URL(detail.url()).pathname
      const readEndpoint = adminOrigin + R.AdminInboxAcknowledge.replace('{id:long}', id)
      const [reloaded, acknowledged] = await Promise.all([
        waitForPathResponse(page, () => detailPath, 'GET'),
        waitForUrlResponse(page, () => readEndpoint, 'POST'),
        loc.exactButton(panel, 'Reload conversation').click(),
      ])
      res.assertStatus(reloaded, 200)
      res.assertStatus(acknowledged, 200)
      const snapshot = await reloaded.headerValue(WireHeaders.AdminInboxReadSnapshot)
      assert.match(snapshot, /^[a-zA-Z0-9_-]{64}$/)
      assert.equal(acknowledged.request().headers()[WireHeaders.AdminInboxReadSnapshot.toLowerCase()], snapshot)
      assert.equal(await acknowledged.headerValue(WireHeaders.AdminInboxUnread), '0')
    }
  } else await res.assertGetStatus(context.request, wakeEndpoint, 404)

  if (live || process.env.FSUSBLOG_TEST_ADMIN_INBOX_REPLY === '1') {
    const reply = 'Inbox QA reply sent by the current administrator.'
    await loc.exactLabel(panel, 'Reply to the account').fill(reply)
    await submitInboxAction(page, panel, '/reply-pow.aeds', '/reply.aeds', 'Send reply')
    await loc.exactText(panel, 'Reply sent to the account.').waitFor()
    await loc.exactText(panel, reply).waitFor()
    const publicOrigin = await context.request.get(siteOrigin + path)
    res.assertStatus(publicOrigin, 200)
    const body = await publicOrigin.body()
    assert(body.includes(Buffer.from(reply)))
    res.assertNoneIn(body, marker)
    await withReader(true, async reader => {
      await loc.exactHeading(reader, 'Inbox QA support case').waitFor()
      await loc.exactText(reader, reply).last().waitFor()
      assert.equal(await loc.exactText(reader, marker).count(), 0)
      await saveShot(reader, evidence, 'admin-inbox-account-reply.png')
    })
  } else assert.equal(await loc.exactButton(panel, 'Send reply').count(), 0)

  if (statusEnabled) {
    assert.match(await detail.headerValue(WireHeaders.AdminInboxVersion), /^[1-9][0-9]{0,9}$/)
    const reason = 'Customer has yet to provide the private receipt.'
    const peerPages = []
    async function peer(openThread) {
      const peerPage = await context.newPage()
      peerPages.push(peerPage)
      const opened = await openLiveInboxTab(peerPage, adminOrigin, openThread ? wakeEndpoint : R.AdminInboxQueueWake + '?status=open', async peerPanel => {
        if (openThread) await loc.exactButton(peerPanel, 'Inbox QA support case').click()
        else {
          await adminFx.selectOption(peerPage, peerPanel, 'Filter support inbox', 'Open')
          await loc.exactButton(peerPanel, 'Inbox QA support case').waitFor()
        }
      })
      return opened.panel
    }
    try {
      await withReader(true, async reader => {
        let peerThread, peerQueue, peerDraft
        if (live && !activity) {
          peerThread = await peer(true)
          peerQueue = await peer(false)
          peerDraft = loc.exactLabel(peerThread, 'Reply to the account')
          await peerDraft.fill('Unsaved reply in another administrator tab')
          await peerDraft.focus()
        }
        const accountThread = reader.getByRole('region', { name: 'Inbox QA support case' })
        await loc.exactText(accountThread, 'Open').waitFor()
        await page.bringToFront()
        await adminFx.selectOption(page, panel, 'New conversation status', 'Pending')
        await loc.exactLabel(panel, 'Reason for changing status').fill(reason)
        await submitInboxAction(page, panel, '/status-pow.aeds', '/status.aeds', 'Save status')
        await loc.exactText(panel, 'Conversation status saved.').waitFor()
        await loc.exactText(accountThread, 'Pending').waitFor()
        assert.equal(await loc.exactText(accountThread, reason).count(), 0)
        if (peerThread && peerQueue && peerDraft) {
          const updatedThread = loc.exactRegion(peerThread, 'Inbox QA support case')
          await loc.exactText(updatedThread, 'Pending').waitFor()
          await loc.exactText(updatedThread, 'Account ticket').waitFor()
          await loc.exactButton(peerQueue, 'Inbox QA support case').waitFor({ state: 'hidden' })
          assert.equal(await peerDraft.inputValue(), 'Unsaved reply in another administrator tab')
          await adminFx.assertFocused(peerDraft)
          await adminFx.selectOption(peerPages[1], peerQueue, 'Filter support inbox', 'Pending')
          await loc.exactButton(peerQueue, 'Inbox QA support case').waitFor()
          await saveShot(peerPages[0], evidence, 'admin-inbox-peer-status.png')
        }
        await saveShot(reader, evidence, 'admin-inbox-account-status.png')
      })
    } finally { await Promise.all(peerPages.map(peerPage => peerPage.close())) }
  } else {
    assert.equal(await detail.headerValue(WireHeaders.AdminInboxVersion), null)
    assert.equal(await loc.exactButton(panel, 'Save status').count(), 0)
  }

  for (const [name, viewport] of Object.entries({ desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } })) {
    await page.setViewportSize(viewport)
    await panel.getByRole('heading', { name: 'Support inbox' }).evaluate(node => node.scrollIntoView({ block: 'start' }))
    await assertNoOverflow(page)
    await saveShot(page, evidence, `admin-inbox-${name}.png`)
  }
  await panel.getByRole('button', { name: 'Back to conversations' }).click()
  if (statusEnabled) {
    await subject.waitFor({ state: 'hidden' })
    await adminFx.selectOption(page, panel, 'Filter support inbox', 'Pending')
  }
  await subject.waitFor()
  if (!statusEnabled) await adminFx.assertFocused(subject)
  if (shared) {
    await loc.exactText(visibleRow, '1 unread by support').waitFor({ state: 'hidden' })
    await adminFx.selectOption(page, panel, 'Filter support inbox', 'Unread by support')
    await closed.waitFor()
    await subject.waitFor({ state: 'hidden' })
  }
  await loc.exactTab(page, 'Moderation queue').click()
  assert.equal(await loc.exactText(panel, marker).count(), 0)
  if (live) await verifyDefaultQueueUpdates(page, panel, adminOrigin, siteOrigin, subject, shared, sockets, evidence, withReader)
  else {
    assert.equal(sockets.length, 0)
    await res.assertGetStatus(context.request, adminOrigin + R.AdminInboxQueueWake, 404)
  }
  page.off('websocket', onSocket)
}

export async function prepareAdminInboxWakeProbe(context, adminOrigin) {
  const list = new PodReader(await res.getFrame(context.request, adminOrigin + R.AdminInboxQueue, FrameType.AdminInboxPage))
  list.text(100)
  assert(list.i32() > 0)
  const wakeUrl = new URL(R.AdminInboxWake.replace('{id:long}', String(list.i64())), adminOrigin)
  wakeUrl.protocol = 'wss:'
  const page = await context.newPage()
  await page.goto(new URL('/admin/interaction', adminOrigin).href)
  const closed = () => page.evaluate(() => window.fsusTestInboxProbeClosed)
  async function open(sendBody) {
    await page.evaluate(async ({ url, protocol, sendBody }) => {
      const socket = new WebSocket(url, protocol)
      let frames = 0
      socket.addEventListener('message', () => { frames++ })
      window.fsusTestInboxProbeClosed = new Promise(resolve => {
        const deadline = setTimeout(() => { socket.close(); resolve(null) }, 12_000)
        socket.addEventListener('close', event => { clearTimeout(deadline); resolve({ code: event.code, frames }) }, { once: true })
      })
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('close', () => reject(new Error('Inbox wake probe closed before admission.')), { once: true })
      })
      if (sendBody) socket.send(new Uint8Array(1))
    }, { url: wakeUrl.href, protocol: wakeProtocol, sendBody })
  }

  await open(true)
  const rejected = await closed()
  assert(rejected, 'Client messages must close the receive-only inbox wake socket.')
  assert.equal(rejected.frames, 0)
  await open(false)
  return async () => {
    try { assert.deepEqual(await closed(), { code: 1008, frames: 0 }) } finally { await page.close() }
  }
}

async function submitInboxAction(page, panel, proofPath, commandPath, button, extra) {
  const waitForPost = path => page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST')
  const [proof, saved, result] = await Promise.all([waitForPost(proofPath), waitForPost(commandPath), extra, loc.exactButton(panel, button).click()])
  res.assertStatus(proof, 200)
  res.assertStatus(saved, 200)
  return result
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
    }, response => { response.resume(); resolve(response.statusCode) })
    upgrade.once('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode) })
    upgrade.once('error', reject)
    upgrade.end()
  })
}

function captureInboxSocket(page, pattern) {
  return page.evaluate(source => {
    const NativeSocket = window.WebSocket, pathPattern = new RegExp(source)
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

async function verifyDefaultQueueUpdates(page, panel, adminOrigin, siteOrigin, existing, shared, sockets, evidence, withReader) {
  const queue = adminOrigin + R.AdminInboxQueue
  const wakeUrl = new URL(R.AdminInboxQueueWake, adminOrigin)
  wakeUrl.protocol = 'wss:'
  const subject = 'Inbox QA ticket created while support queue stays open'
  await captureInboxSocket(page, `^${wakeUrl.pathname}$`)
  try {
    await withReader(false, async reader => {
      await loc.exactButton(reader, 'Create ticket').click()
      await loc.exactLabel(reader, 'Subject (optional)').fill(subject)
      await loc.exactLabel(reader, 'Ticket content').fill('The account opened this ticket with the normal proof flow.')
      await page.bringToFront()
      await loc.exactTab(page, 'Support inbox').click()
      await existing.waitFor()
      await existing.focus()
      const createdRow = loc.exactButton(panel, subject)
      assert.equal(await createdRow.count(), 0)
      await waitForInboxSocket(page, wakeUrl.href)
      const { refreshed } = await expectWakeRefresh(sockets, wakeUrl, () => page.waitForResponse(async response =>
        isDefaultQueueResponse(response, queue, shared) && response.ok() && (await response.body()).includes(Buffer.from(subject)),
      { timeout: 15_000 }), () => submitAccountInboxAction(reader, page, siteOrigin + R.InboxCreatePowChallenge, siteOrigin + R.InboxList, 'Send ticket', 'Ticket submitted.'))
      assert.equal(await refreshed.headerValue(WireHeaders.AdminInboxLive), '1')
      const list = new PodReader(await res.readFrame(refreshed, shared ? FrameType.AdminInboxSharedPage : FrameType.AdminInboxPage))
      list.text(100)
      assert(list.i32() >= 3 && list.i64() > 0n)
      list.uuid()
      assert.equal(list.text(640), subject)
      await createdRow.waitFor()
      assert.equal(await createdRow.count(), 1)
      if (shared) await loc.exactText(createdRow.locator('..'), '1 unread by support').waitFor()
      await adminFx.assertFocused(existing)
      await saveShot(page, evidence, 'admin-inbox-live-new-ticket.png')
      await loc.exactTab(page, 'Moderation queue').click()
    })
  } finally { await page.evaluate(() => window.fsusTestRestoreAdminInboxSocket()) }
}

async function verifyOpenedThreadUpdates(page, panel, context, wakeEndpoint, siteOrigin, id, detailUrl, sockets, evidence, withReader) {
  const wakeUrl = new URL(wakeEndpoint)
  wakeUrl.protocol = 'wss:'
  const threadPath = new URL(detailUrl).pathname
  const composer = loc.exactLabel(panel, 'Reply to the account')
  const draft = 'Unsent administrator draft retained during account activity.'
  const waitForDetail = (message, timeout) => page.waitForResponse(async response => response.request().method() === 'GET' &&
    new URL(response.url()).pathname === threadPath && response.ok() && (await response.body()).includes(Buffer.from(message)), { timeout })
  const verifyDraftAfter = async message => {
    const item = loc.exactText(panel, message)
    await item.waitFor({ timeout: 15_000 })
    assert.equal(await item.count(), 1)
    assert.equal(await composer.inputValue(), draft)
    await adminFx.assertFocused(composer)
  }

  await withReader(true, async reader => {
    const sendAccountReply = async body => {
      await loc.exactLabel(reader, 'Reply content').fill(body)
      await submitAccountInboxAction(reader, page, siteOrigin + R.InboxReplyPowChallenge.replace('{id:long}', id),
        siteOrigin + R.InboxReply.replace('{id:long}', id), 'Send reply', 'Reply sent.')
    }
    await loc.exactText(reader.getByRole('region', { name: 'Inbox QA support case' }), 'Inbox QA newest public reply').waitFor()
    await page.bringToFront()
    await composer.fill(draft)
    await composer.focus()
    await waitForInboxSocket(page, wakeUrl.href)
    const firstReply = 'Inbox QA account reply while the administrator thread stays open.'
    const { socket, refreshed } = await expectWakeRefresh(sockets, wakeUrl, () => waitForDetail(firstReply, 15_000), () => sendAccountReply(firstReply))
    res.assertStatus(refreshed, 200)
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
      assert.equal(await loc.exactText(panel, offlineReply).count(), 0)
      const [recovered] = await Promise.all([
        waitForDetail(offlineReply, 30_000),
        network.send('Network.setBlockedURLs', { urls: [] }).then(() => waitForInboxSocket(page, wakeUrl.href)),
      ])
      assert.notEqual(sockets.findLast(candidate => candidate.url() === wakeUrl.href), socket)
      res.assertStatus(recovered, 200)
      await verifyDraftAfter(offlineReply)
      assert.equal(await loc.exactText(panel, firstReply).count(), 1)
    } finally {
      await network.send('Network.setBlockedURLs', { urls: [] })
      await network.detach()
    }
    await saveShot(page, evidence, 'admin-inbox-live-account-replies.png')
  })
}
