import { exactText, exactLabel, roleWithExactName } from './role-locators.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { requireWebPackage } from './web-package-fixture.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { signInFreshSite } from './webauthn-fixture.mjs'

const { chromium } = requireWebPackage('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const tickets = [process.env.FSUSBLOG_INBOX_DESKTOP_TICKET, process.env.FSUSBLOG_INBOX_MOBILE_TICKET]
const recipients = [process.env.FSUSBLOG_INBOX_DESKTOP_ID, process.env.FSUSBLOG_INBOX_MOBILE_ID]
assert(evidence && tickets.every(Boolean) && recipients.every(Boolean), 'Set local inbox fixture identities, tickets and evidence directory')
assert(/(?:^|;)Database=fsusv2_inbox_[a-f0-9]{32}(?:;|$)/.test(process.env.FSUSBLOG_DB ?? ''), 'Expected an owned disposable inbox database')
await mkdir(evidence, { recursive: true })

const tlsPin = process.env.FSUSBLOG_TEST_TLS_SPKI
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true,
  args: tlsPin ? [`--ignore-certificate-errors-spki-list=${tlsPin}`] : [] })
const diagnostics = []
const observations = []
let failure
try {
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 375, height: 850 }].entries()) {
    const name = index === 0 ? 'desktop' : 'mobile'
    const context = await browser.newContext({ viewport, colorScheme: index === 0 ? 'light' : 'dark' })
    await context.addInitScript(() => {
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends NativeSocket {
        constructor(url, protocols) {
          super(url, protocols)
          if (protocols === 'fsus-inbox-wake.v2') window.fsusTestInboxSocket = this
        }
      }
    })
    try {
      const page = await context.newPage()
      await context.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
      const ready = page.getByRole('heading', { name: 'My messages' })
      const anonymous = await page.goto(`${origin}/user/messagebox`)
      assertStatus(anonymous, 200)
      await ready.waitFor()
      await exactText(page, 'Please log in').waitFor()
      assert.equal(await exactText(page, 'Integration fixture notice').count(), 0)
      await signInFreshSite(page, origin, tickets[index])
      assertStatus(await context.request.get(origin + WireRoutes.Session), 200)
      const browserErrors = []
      const challenges = []
      const disabledAccountRoutes = new Set([WireRoutes.MfaProfile, WireRoutes.RecoveryKeyAvailability])
      page.on('pageerror', error => browserErrors.push(error.message))
      page.on('console', message => {
        if (message.type() !== 'error') return
        const source = URL.parse(message.location().url)
        // The Passkey enrollment redirect can still be probing these disabled account features.
        if (source?.origin === origin && disabledAccountRoutes.has(source.pathname) &&
          /^Failed to load resource: the server responded with a status of 404\b/.test(message.text())) return
        browserErrors.push({ path: source?.pathname, message: message.text() })
      })
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (response.status() === 500 || (response.status() >= 400 && path.startsWith('/assets/')))
          browserErrors.push(`${response.status()} ${path}`)
        if (path.includes('/pow-') && response.request().method() === 'POST') challenges.push([path, response.status()])
      })
      const wakePath = '/api/v2/notifications/inbox/wake'
      const socketOpening = page.waitForEvent('websocket', { predicate: socket => new URL(socket.url()).pathname === wakePath })
      assertStatus(await page.goto(origin + '/user/messagebox'), 200)
      const socket = await socketOpening
      const wakeFrame = socket.waitForEvent('framereceived')
      await page.waitForFunction(() => window.fsusTestInboxSocket?.readyState === WebSocket.OPEN)
      const row = page.getByRole('button', { name: /Integration fixture notice/ })
      await row.waitFor()
      assert.match(await page.title(), /^Messages · /)
      assert.equal(new URL(page.url()).pathname, '/user/messagebox')
      assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex')
      assert.equal(await exactText(row, '1 unread').count(), 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.screenshot({ path: join(evidence, `inbox-${name}-list.png`) })
      const accountMenu = page.getByRole('button', { name: 'Account menu' })
      if (index === 1) {
        const brand = page.getByRole('banner', { name: 'Site header' }).getByRole('link', { name: "Fsu's Blog" })
        const brandBox = await brand.boundingBox()
        const menuBox = await accountMenu.boundingBox()
        assert(brandBox && menuBox && brandBox.x + brandBox.width <= menuBox.x && menuBox.height >= 44)
        await accountMenu.focus()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', { name: 'Account menu' })
        await dialog.getByRole('link', { name: 'Account' }).waitFor()
        await dialog.getByRole('button', { name: 'Log out' }).waitFor()
        await page.screenshot({ path: join(evidence, 'inbox-mobile-account-menu.png'), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Account menu')
      } else {
        assert.equal(await accountMenu.count(), 0)
        await page.getByRole('link', { name: 'Account' }).waitFor()
      }
      appendFixtureNotice(recipients[index])
      const { payload } = await wakeFrame
      assert(Buffer.isBuffer(payload) && payload.length < 32)
      const update = page.getByRole('button', { name: /New notification after opening/ })
      await update.waitFor({ timeout: 15_000 })
      const closing = socket.waitForEvent('close')
      const reconnect = page.waitForEvent('websocket', { predicate: ws => new URL(ws.url()).pathname === wakePath })
      const recovered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v2/notifications/private.aeds')
      await page.evaluate(() => window.fsusTestInboxSocket.close(4001))
      await closing
      appendFixtureNotice(recipients[index], 'during-reconnect', 'Recovered notification after reconnect')
      await reconnect
      assertStatus(await recovered, 200)
      await page.getByRole('button', { name: /Recovered notification after reconnect/ }).waitFor({ timeout: 15_000 })
      await row.focus()
      await page.keyboard.press('Enter')
      const heading = page.getByRole('heading', { name: 'Integration fixture notice' })
      await heading.waitFor()
      assert.equal(await heading.evaluate(element => element === document.activeElement), true)
      await exactText(page, 'Integration fixture private body').last().waitFor()
      if (index === 1) {
        const headingBox = await heading.boundingBox()
        assert(headingBox && headingBox.width >= 140, `Narrow ElThreadPanel heading must wrap cleanly instead of crushing (got ${headingBox?.width}px)`)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
        await page.screenshot({ path: join(evidence, 'inbox-mobile-unread-header.png') })
      }
      const marked = page.waitForResponse(response => response.url().endsWith('/read') && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Mark as read' }).click()
      assertStatus(await marked, 200)
      await page.getByRole('button', { name: 'Mark as read' }).waitFor({ state: 'hidden' })
      await page.screenshot({ path: join(evidence, `inbox-${name}-read.png`) })
      if (index === 1) {
        await page.getByRole('button', { name: 'Back to message list' }).click()
        await row.waitFor()
        assert.equal(await row.evaluate(element => element === document.activeElement), true)
      }
      assert.equal(await exactText(row, '1 unread').count(), 0)
      const subject = `Native support ${name}`
      await page.getByRole('button', { name: 'Create ticket' }).click()
      await exactLabel(page, 'Subject (optional)').fill(subject)
      await exactLabel(page, 'Ticket content').fill('Native proof sent this ticket.')
      await page.getByRole('button', { name: 'Send ticket' }).click()
      await exactText(page, 'Ticket submitted.').waitFor()
      await roleWithExactName(page, 'heading', subject).waitFor()
      await exactLabel(page, 'Reply content').fill('Native proof sent this reply.')
      await page.getByRole('button', { name: 'Send reply' }).click()
      await exactText(page, 'Reply sent.').waitFor()
      await exactText(page.getByRole('region', { name: subject }), 'Native proof sent this reply.').waitFor()
      assert.equal(challenges.length, 2)
      assert.deepEqual(challenges.map(([path, status]) => [path.split('/').at(-1), status]), [['pow-create.aeds', 200], ['pow-reply.aeds', 200]])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.screenshot({ path: join(evidence, `inbox-${name}-write.png`) })
      assert.deepEqual(browserErrors, [])
      observations.push({ name, viewport, url: page.url(), title: await page.title(), anonymous: 'private list hidden',
        replay: 'a WebSocket wake led to a new notice without navigating or reloading',
        reconnect: 'fresh socket and authorized HTTP replay recovered a committed notice after the previous connection closed',
        keyboard: 'Enter opened the thread and moved focus', markedRead: true, focusRestored: index === 1, challenges,
        accountMenu: index === 1 ? 'opens with Enter and closes with Escape, returning focus' : 'direct desktop actions visible' })
    } catch (error) {
      diagnostics.push({ name, error: String(error) })
      throw error
    } finally {
      await context.close()
    }
  }
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'inbox-browser.json'), JSON.stringify({ observations, diagnostics, passed: !failure }, null, 2))
}
if (failure) throw failure
console.log('Native PostgreSQL communication flow passed in desktop and narrow Chrome.')

function appendFixtureNotice(recipient, event = 'while-open', subject = 'New notification after opening') {
  const printed = execFileSync(process.env.FSUSBLOG_INBOX_DOTNET,
    [process.env.FSUSBLOG_INBOX_CLI_DLL, 'notify', recipient, event], {
      encoding: 'utf8',
      input: JSON.stringify({ subject, body: 'This update came from PostgreSQL.' }),
    })
  const result = JSON.parse(printed)
  assert.equal(result.accountId, recipient)
  assert.equal(result.replayed, false)
}
