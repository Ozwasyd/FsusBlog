import { assertStatus } from './response-status-fixture.mjs'
import { roleWithExactName, exactText, exactLabel } from './role-locators.mjs'
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
    await roleWithExactName(author, 'button', 'Log in').click()
    await author.waitForURL(siteOrigin + '/user/manage/article/write')
    await author.goto(siteOrigin + '/user/comments')
    const ownCard = author.locator('li').filter({ has: exactText(author, rejectBody) })
    await roleWithExactName(ownCard, 'button', '发起申诉').click()
    const reason = '原评论内容有完整的事实与上下文，请独立复核。'
    await ownCard.getByLabel('申诉理由（10 至 1,000 字符）').fill(reason)
    const submitted = author.waitForResponse(response => response.url().endsWith('/author/appeal'))
    await roleWithExactName(ownCard, 'button', '提交申诉').click()
    assertStatus(await submitted, 200)
    await ownCard.getByText(/申诉待复核/).waitFor()
    await author.screenshot({ path: join(evidence, 'author-appeal-pending.png') })

    const original = roleWithExactName(page, 'region', 'Comment appeals')
    await roleWithExactName(original, 'button', 'Load appeal queue').click()
    await exactText(original, 'No appeals are waiting for your review.').waitFor()
    const second = await independent.newPage()
    await enableAuthenticator(independent, second)
    await second.goto(adminOrigin + '/admin/identity')
    await roleWithExactName(second, 'button', 'Set up administrator Passkey').click()
    await exactLabel(second, 'One-time administrator bootstrap key').fill(reviewerTicket)
    await roleWithExactName(second, 'button', 'Create administrator Passkey').click()
    await exactText(second, 'Administrator Passkey created. Log in with it to continue.').waitFor()
    await logIn(second)
    const queue = roleWithExactName(second, 'region', 'Comment appeals')
    await roleWithExactName(queue, 'button', 'Load appeal queue').click()
    await exactText(queue, reason).waitFor()
    await roleWithExactName(queue, 'button', 'Review appeal').click()
    const decision = 'Independent review confirms the original context.'
    await queue.getByLabel('Reason for appeal decision').fill(decision)
    const decided = second.waitForResponse(response => /\/appeals\/\d+\/decision\.aeds$/.test(response.url()))
    await roleWithExactName(queue, 'button', 'Grant with Passkey').click()
    assertStatus(await decided, 200)
    await exactText(queue, 'Appeal granted.').waitFor()
    await second.screenshot({ path: join(evidence, 'administrator-appeal-granted.png') })
    await roleWithExactName(author, 'button', '刷新评论与申诉').click()
    await ownCard.getByText(/申诉已通过/).waitFor()
    await exactText(ownCard, decision).waitFor()
    const anonymous = await browser.newContext()
    try {
      const response = await anonymous.request.get(publicRoute)
      assertStatus(response, 200)
      const frame = await response.body()
      assert(frame.includes(Buffer.from(rejectBody)))
      assert(!frame.includes(Buffer.from(reason)) && !frame.includes(Buffer.from(decision)))
    } finally { await anonymous.close() }
  } finally {
    await independent.close()
    await account.close()
  }
}
