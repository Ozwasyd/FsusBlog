import assert from 'node:assert/strict'
import { visitAdminWorkspace } from './admin-workspace-fixture.mjs'
import { saveShot, withTempContext } from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { exactButton, exactText, roleWithExactName } from './role-locators.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

export function verifyCommentAppeal({ page, context, author, siteOrigin, adminOrigin, publicRoute, rejectBody, evidence }) {
  const reviewerTicket = process.env.FSUSBLOG_TEST_APPEAL_REVIEWER_TICKET
  assert.match(reviewerTicket, /^[a-f0-9]{64}$/)
  const browser = context.browser()
  assert(browser)
  return withTempContext(browser, async independent => {
    await author.context().addCookies([{ name: 'fsus_locale', value: 'zh-CN', url: siteOrigin }])
    await author.goto(siteOrigin + '/user/comments')
    const ownCard = author.locator('li').filter({ has: exactText(author, rejectBody) })
    await exactButton(ownCard, '发起申诉').click()
    const reason = '原评论内容有完整的事实与上下文，请独立复核。'
    await ownCard.getByLabel('申诉理由（10 至 1,000 字符）').fill(reason)
    const submitted = author.waitForResponse(response => response.url().endsWith('/author/appeal'))
    await exactButton(ownCard, '提交申诉').click()
    assertStatus(await submitted, 200)
    await ownCard.getByText(/申诉待复核/).waitFor()
    await saveShot(author, evidence, 'author-appeal-pending.png', {})

    await roleWithExactName(page, 'tab', 'Comment appeals').click()
    const original = roleWithExactName(page, 'region', 'Comment appeals')
    await exactButton(original, 'Refresh').click()
    await exactText(original, 'No appeals are waiting for your review.').waitFor()
    const second = await independent.newPage()
    await signInFreshAdmin(second, adminOrigin, reviewerTicket)
    await visitAdminWorkspace(second, '/admin/interaction')
    await roleWithExactName(second, 'tab', 'Comment appeals').click()
    const queue = roleWithExactName(second, 'region', 'Comment appeals')
    await exactButton(queue, 'Refresh').click()
    await exactText(queue, reason).waitFor()
    await exactButton(queue, 'Review appeal').click()
    const decision = 'Independent review confirms the original context.'
    await queue.getByLabel('Reason for appeal decision').fill(decision)
    const decided = second.waitForResponse(response => /\/appeals\/\d+\/decision\.aeds$/.test(response.url()))
    await exactButton(queue, 'Grant with Passkey').click()
    assertStatus(await decided, 200)
    await exactText(queue, 'Appeal granted.').waitFor()
    await saveShot(second, evidence, 'administrator-appeal-granted.png', {})
    await roleWithExactName(page, 'tab', 'Moderation queue').click()
    await exactButton(author, '刷新评论与申诉').click()
    await ownCard.getByText(/申诉已通过/).waitFor()
    await exactText(ownCard, decision).waitFor()
    await withTempContext(browser, async anonymous => {
      const response = await anonymous.request.get(publicRoute)
      assertStatus(response, 200)
      const frame = await response.body()
      assert(frame.includes(Buffer.from(rejectBody)))
      assert(!frame.includes(Buffer.from(reason)) && !frame.includes(Buffer.from(decision)))
    })
  })
}
