import assert from 'node:assert/strict'
import { api } from '../../src/Contracts/client.ts'

export async function withMediaSession(origin, ticket, prepare) {
  let cookie
  const native = globalThis.fetch
  globalThis.fetch = async (path, options) => {
    const headers = new Headers(options.headers)
    if (cookie) headers.set('Cookie', `fsus-v2-session=${cookie}`)
    const response = await native(new URL(path, origin), { ...options, headers })
    cookie ??= response.headers.get('set-cookie')?.match(/\bfsus-v2-session=([a-f0-9]{64})\b/)?.[1]
    return response
  }
  try {
    const session = await api.signIn(ticket)
    assert(cookie)
    return await prepare(cookie, session)
  } finally { globalThis.fetch = native }
}
