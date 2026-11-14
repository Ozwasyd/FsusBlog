import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { api } from '../../src/Contracts/client.ts'

const { chromium } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const tickets = [process.env.FSUSBLOG_INBOX_DESKTOP_TICKET, process.env.FSUSBLOG_INBOX_MOBILE_TICKET]
const recipients = [process.env.FSUSBLOG_INBOX_DESKTOP_ID, process.env.FSUSBLOG_INBOX_MOBILE_ID]
assert(evidence && tickets.every(Boolean) && recipients.every(Boolean), 'Set local inbox fixture identities, tickets and evidence directory')
assert(/(?:^|;)Database=fsusv2_inbox_[a-f0-9]{32}(?:;|$)/.test(process.env.FSUSBLOG_DB ?? ''), 'Expected an owned disposable inbox database')
const fetchAt = globalThis.fetch
await mkdir(evidence, { recursive: true })

const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
const diagnostics = []
const observations = []
let failure
try {
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 375, height: 850 }].entries()) {
    const name = index === 0 ? 'desktop' : 'mobile'
    let session
    // The fixture issues a real one-use access key. Authenticate through the real API and carry its HttpOnly cookie into Chrome.
    globalThis.fetch = async (path, options) => {
      const response = await fetchAt(new URL(path, origin), options)
      session = response.headers.get('set-cookie')?.match(/\bfsus-v2-session=([a-f0-9]{64})\b/)?.[1]
      return response
    }
    try { await api.signIn(tickets[index]) } finally { globalThis.fetch = fetchAt }
    assert(session)
    const context = await browser.newContext({ viewport, colorScheme: index === 0 ? 'light' : 'dark' })
    try {
      const page = await context.newPage()
      const ready = page.getByRole('heading', { name: '我的站内信' })
      const anonymous = await page.goto(`${origin}/user/messagebox`)
      assert.equal(anonymous.status(), 200)
      await ready.waitFor()
      await page.getByText('请先登录', { exact: true }).waitFor()
      assert.equal(await page.getByText('Integration fixture notice', { exact: true }).count(), 0)
      const browserErrors = []
      const challenges = []
      page.on('pageerror', error => browserErrors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (response.status() === 500 || (response.status() >= 400 && path.startsWith('/assets/')))
          browserErrors.push(`${response.status()} ${path}`)
        if (path.includes('/pow-') && response.request().method() === 'POST') challenges.push([path, response.status()])
      })
      await context.addCookies([{ name: 'fsus-v2-session', value: session, url: origin, httpOnly: true, sameSite: 'Strict' }])
      await page.reload()
      const row = page.getByRole('button', { name: /Integration fixture notice/ })
      await row.waitFor()
      assert.match(await page.title(), /我的站内信/)
      assert.equal(new URL(page.url()).pathname, '/user/messagebox')
      assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'), 'noindex')
      assert.equal(await row.getByText('1 条未读', { exact: true }).count(), 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.screenshot({ path: join(evidence, `inbox-${name}-list.png`) })
      appendFixtureNotice(recipients[index])
      const update = page.getByRole('button', { name: /New notification after opening/ })
      await update.waitFor({ timeout: 15_000 })
      await row.focus()
      await page.keyboard.press('Enter')
      const heading = page.getByRole('heading', { name: 'Integration fixture notice' })
      await heading.waitFor()
      assert.equal(await heading.evaluate(element => element === document.activeElement), true)
      await page.getByText('Integration fixture private body', { exact: true }).last().waitFor()
      const marked = page.waitForResponse(response => response.url().endsWith('/read') && response.request().method() === 'POST')
      await page.getByRole('button', { name: '标记已读' }).click()
      assert.equal((await marked).status(), 200)
      await page.getByRole('button', { name: '标记已读' }).waitFor({ state: 'hidden' })
      await page.screenshot({ path: join(evidence, `inbox-${name}-read.png`) })
      if (index === 1) {
        await page.getByRole('button', { name: '返回消息列表' }).click()
        await row.waitFor()
        assert.equal(await row.evaluate(element => element === document.activeElement), true)
      }
      assert.equal(await row.getByText('1 条未读', { exact: true }).count(), 0)
      const subject = `Native support ${name}`
      await page.getByRole('button', { name: '提交工单' }).click()
      await page.getByLabel('主题（选填）', { exact: true }).fill(subject)
      await page.getByLabel('工单内容', { exact: true }).fill('Native proof sent this ticket.')
      await page.getByRole('button', { name: '发送工单' }).click()
      await page.getByText('工单已提交。', { exact: true }).waitFor()
      await page.getByRole('heading', { name: subject, exact: true }).waitFor()
      await page.getByLabel('回复内容', { exact: true }).fill('Native proof sent this reply.')
      await page.getByRole('button', { name: '发送回复' }).click()
      await page.getByText('回复已发送。', { exact: true }).waitFor()
      await page.getByRole('region', { name: subject }).getByText('Native proof sent this reply.', { exact: true }).waitFor()
      assert.equal(challenges.length, 2)
      assert.deepEqual(challenges.map(([path, status]) => [path.split('/').at(-1), status]), [['pow-create.aeds', 200], ['pow-reply.aeds', 200]])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await page.screenshot({ path: join(evidence, `inbox-${name}-write.png`) })
      assert.deepEqual(browserErrors, [])
      observations.push({ name, viewport, url: page.url(), title: await page.title(), anonymous: 'private list hidden',
        replay: 'a new notice appeared without navigating or reloading',
        keyboard: 'Enter opened the thread and moved focus', markedRead: true, focusRestored: index === 1, challenges })
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

function appendFixtureNotice(recipient) {
  const printed = execFileSync(process.env.FSUSBLOG_INBOX_DOTNET,
    [process.env.FSUSBLOG_INBOX_MIGRATE_DLL, 'notify', recipient, 'while-open'], {
      encoding: 'utf8',
      input: JSON.stringify({ subject: 'New notification after opening', body: 'This update came from PostgreSQL.' }),
    })
  const result = JSON.parse(printed)
  assert.equal(result.accountId, recipient)
  assert.equal(result.replayed, false)
}
