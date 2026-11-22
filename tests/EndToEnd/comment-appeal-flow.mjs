import assert from 'node:assert/strict'
import { enableAuthenticator } from './webauthn-fixture.mjs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export async function verifyCommentAppeal({ page, context, siteOrigin, adminOrigin, publicRoute, rejectBody, evidence, logIn }) {
  const authorTicket = execFileSync(process.env.FSUSBLOG_TEST_APPEAL_OWNER_TICKET, [], { encoding: 'utf8' }).trim()
  const reviewerTicket = process.env.FSUSBLOG_TEST_APPEAL_REVIEWER_TICKET
  assert.match(authorTicket, /^[a-f0-9]{64}$/)
  assert.match(reviewerTicket, /^[a-f0-9]{64}$/)
  const browser = context.browser()
  assert(browser)
  const account = await browser.newContext()
  const independent = await browser.newContext()
  try {
    const author = await account.newPage()
    await author.goto(siteOrigin + '/login')
    await author.getByLabel('Owner access key').fill(authorTicket)
    await author.getByRole('button', { name: 'Log in', exact: true }).click()
    await author.waitForURL(siteOrigin + '/user/manage/article/write')
    await author.goto(siteOrigin + '/user/comments')
    const ownCard = author.locator('li').filter({ has: author.getByText(rejectBody, { exact: true }) })
    await ownCard.getByRole('button', { name: '发起申诉', exact: true }).click()
    const reason = '原评论内容有完整的事实与上下文，请独立复核。'
    await ownCard.getByLabel('申诉理由（10 至 1,000 字符）').fill(reason)
    const submitted = author.waitForResponse(response => response.url().endsWith('/author/appeal'))
    await ownCard.getByRole('button', { name: '提交申诉', exact: true }).click()
    assert.equal((await submitted).status(), 200)
    await ownCard.getByText(/申诉待复核/).waitFor()
    await author.screenshot({ path: join(evidence, 'author-appeal-pending.png') })

    const original = page.getByRole('region', { name: 'Comment appeals', exact: true })
    await original.getByRole('button', { name: 'Load appeal queue', exact: true }).click()
    await original.getByText('No appeals are waiting for your review.', { exact: true }).waitFor()
    const second = await independent.newPage()
    await enableAuthenticator(independent, second)
    await second.goto(adminOrigin + '/admin/identity')
    await second.getByRole('button', { name: 'Set up administrator Passkey', exact: true }).click()
    await second.getByLabel('One-time administrator bootstrap key', { exact: true }).fill(reviewerTicket)
    await second.getByRole('button', { name: 'Create administrator Passkey', exact: true }).click()
    await second.getByText('Administrator Passkey created. Log in with it to continue.', { exact: true }).waitFor()
    await logIn(second)
    const queue = second.getByRole('region', { name: 'Comment appeals', exact: true })
    await queue.getByRole('button', { name: 'Load appeal queue', exact: true }).click()
    await queue.getByText(reason, { exact: true }).waitFor()
    await queue.getByRole('button', { name: 'Review appeal', exact: true }).click()
    const decision = 'Independent review confirms the original context.'
    await queue.getByLabel('Reason for appeal decision').fill(decision)
    const decided = second.waitForResponse(response => /\/appeals\/\d+\/decision\.aeds$/.test(response.url()))
    await queue.getByRole('button', { name: 'Grant with Passkey', exact: true }).click()
    assert.equal((await decided).status(), 200)
    await queue.getByText('Appeal granted.', { exact: true }).waitFor()
    await second.screenshot({ path: join(evidence, 'administrator-appeal-granted.png') })
    await author.getByRole('button', { name: '刷新评论与申诉', exact: true }).click()
    await ownCard.getByText(/申诉已通过/).waitFor()
    await ownCard.getByText(decision, { exact: true }).waitFor()
    const anonymous = await browser.newContext()
    try {
      const response = await anonymous.request.get(publicRoute)
      assert.equal(response.status(), 200)
      const frame = await response.body()
      assert(frame.includes(Buffer.from(rejectBody)))
      assert(!frame.includes(Buffer.from(reason)) && !frame.includes(Buffer.from(decision)))
    } finally { await anonymous.close() }
  } finally {
    await independent.close()
    await account.close()
  }
}
