#!/usr/bin/env node

const baseUrl = process.env.FSUSBLOG_API_BASE_URL || process.env.PLAYWRIGHT_API_BASE_URL || 'http://127.0.0.1:5000'
const email = `reader-${Date.now()}@example.invalid`

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })
  const text = await response.text()
  let payload = null
  if (text.length > 0) {
    payload = JSON.parse(text)
  }
  return { response, text, payload }
}

async function main() {
  const subscribe = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ email, channel: 'email' })
  })
  assert(subscribe.response.ok, `subscribe failed: ${subscribe.response.status} ${subscribe.text}`)
  assert(subscribe.payload?.data?.subscribed === true, 'subscribe response must confirm subscribed=true')
  assert(subscribe.payload?.data?.channel === 'email', 'subscribe response must preserve requested email channel')
  assert(!subscribe.text.includes(email), 'subscribe response must not echo raw email')

  const unsubscribe = await request('/api/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ email, channel: 'email' })
  })
  assert(unsubscribe.response.ok, `unsubscribe failed: ${unsubscribe.response.status} ${unsubscribe.text}`)
  assert(unsubscribe.payload?.data?.unsubscribed === true, 'unsubscribe response must confirm unsubscribed=true')
  assert(!unsubscribe.text.includes(email), 'unsubscribe response must not echo raw email')

  const invalid = await request('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ email: 'not-an-email', channel: 'email' })
  })
  assert(invalid.response.status === 400, `invalid email must be rejected with 400, got ${invalid.response.status}`)

  console.log(`[check-subscription-smoke] ok | base=${baseUrl}`)
}

main().catch((error) => {
  console.error('[check-subscription-smoke] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
