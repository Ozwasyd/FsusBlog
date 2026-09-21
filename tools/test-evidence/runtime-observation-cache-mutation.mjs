import { randomUUID } from 'node:crypto'

import {
  authBinary,
  loginWithFixtureSessionBypass
} from '../../tests/frontend/support/auth-helpers.mjs'
import {
  fail,
  frontendUrl,
  timeoutMs
} from './runtime-observation-probe-io.mjs'

export async function createObservedArticle(context, categoryId, tagId)
{
  const deviceFingerprint = `cache-probe-${context.identity.runId}`
  const admin = await loginWithFixtureSessionBypass(
    'binaryadmin',
    '',
    false,
    deviceFingerprint,
    timeoutMs
  )
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const marker = `dc${stamp}alpha`
  const title = `Distribution Coherence ${stamp} Alpha`
  const create = await authBinary('/api/Article', {
    method: 'POST',
    cookieHeader: admin.cookieHeader,
    requiresPow: true,
    deviceFingerprint,
    timeoutMs,
    headers: { Origin: frontendUrl, 'X-Fsus-Client-Mutation-Id': randomUUID() },
    body: {
      title,
      content: `# ${title}\n\n这是一段普通的文章内容，用于验证发布版本一致性。标识：${marker}`,
      summary: `用于验证订阅与搜索版本一致性的普通摘要。标识：${marker}`,
      categoryId,
      tagIds: [tagId],
      status: 2,
      scheduledPublishAt: null
    }
  })
  if (!create.response.ok || !Number.isSafeInteger(Number(create.payload?.id)))
  {
    fail(`article mutation failed HTTP ${create.response.status}: ${JSON.stringify({
      payload: create.payload,
      payloadError: create.payloadError,
      responseBody: create.responseBody
    })}`)
  }
  return {
    articleId: Number(create.payload.id),
    create,
    marker,
    title
  }
}
