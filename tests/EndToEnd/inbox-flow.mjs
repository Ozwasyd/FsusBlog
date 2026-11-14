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
assert(evidence && tickets.every(Boolean), 'Set local inbox fixture tickets and evidence directory')
assert(/^fsusv2_inbox_[a-f0-9]{32}$/.test(process.env.FSUSBLOG_INBOX_TEST_DB_NAME ?? ''), 'Expected an owned disposable inbox database')
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
      page.on('pageerror', error => browserErrors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
      page.on('response', response => {
        if (response.status() === 500 || (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/assets/')))
          browserErrors.push(`${response.status()} ${new URL(response.url()).pathname}`)
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
      appendFixtureNotice(name)
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
      assert.deepEqual(browserErrors, [])
      observations.push({ name, viewport, url: page.url(), title: await page.title(), anonymous: 'private list hidden',
        replay: 'a new notice appeared without navigating or reloading',
        keyboard: 'Enter opened the thread and moved focus', markedRead: true, focusRestored: index === 1 })
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

function appendFixtureNotice(name) {
  const login = name === 'desktop' ? 'inbox-desktop' : 'inbox-mobile'
  const sql = `
    BEGIN;
    SELECT last_sequence FROM public.inbox_delivery
    WHERE account_id=(SELECT id FROM public.blog_user WHERE name='${login}') FOR UPDATE;
    WITH conversation AS (
      INSERT INTO public.inbox_conversation(account_id,subject,status,is_system,last_message_at)
      SELECT id,'New notification after opening',0,true,clock_timestamp() FROM public.blog_user WHERE name='${login}'
      RETURNING id,account_id,last_message_at
    ), message AS (
      INSERT INTO public.inbox_message(conversation_id,sender,is_internal,body,sent_at)
      SELECT id,2,false,'This update came from PostgreSQL.',last_message_at FROM conversation
      RETURNING id,conversation_id
    ), head AS (
      UPDATE public.inbox_delivery h SET last_sequence=last_sequence+2 FROM conversation c
      WHERE h.account_id=c.account_id RETURNING h.account_id,h.last_sequence
    )
    INSERT INTO public.inbox_event(account_id,sequence,kind,conversation_id,message_id,occurred_at)
    SELECT c.account_id,h.last_sequence-e.offset,e.kind,c.id,m.id,c.last_message_at
    FROM conversation c JOIN message m ON m.conversation_id=c.id JOIN head h ON h.account_id=c.account_id
    CROSS JOIN (VALUES (1,12),(0,13)) e(offset,kind);
    UPDATE public.inbox_conversation c SET last_message_id=m.id
    FROM public.inbox_message m WHERE m.conversation_id=c.id AND c.last_message_id IS NULL;
    COMMIT;`
  execFileSync(process.env.FSUSBLOG_INBOX_TEST_PSQL, ['-X', '--no-password', '-v', 'ON_ERROR_STOP=1',
    '-h', process.env.FSUSBLOG_TEST_PGHOST, '-p', process.env.FSUSBLOG_TEST_PGPORT, '-U', process.env.FSUSBLOG_TEST_PGUSER,
    '-d', process.env.FSUSBLOG_INBOX_TEST_DB_NAME, '-c', sql])
}
