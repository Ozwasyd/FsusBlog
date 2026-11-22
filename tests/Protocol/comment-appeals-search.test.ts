import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import { PodWriter } from '../../src/Contracts/binary.ts'
import { readAuthorAppeals, validAuthorCommentQuery } from '../../src/Contracts/comment-appeals.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

function emptyAppealsResponse() {
  const writer = new PodWriter()
  writer.bool(false)
  writer.i32(0)
  return new Response(encodeFrame(FrameType.CommentAuthorAppeals, writer.finish()), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      [WireHeaders.CommentAuthorEditEnabled]: '1',
    },
  })
}

test('validAuthorCommentQuery enforces length, UTF-8 byte ceiling, and rejects control characters', () => {
  assert.equal(validAuthorCommentQuery(''), true)
  assert.equal(validAuthorCommentQuery('  PostgreSQL 18  '), true)
  assert.equal(validAuthorCommentQuery('a'.repeat(100)), true)
  assert.equal(validAuthorCommentQuery('a'.repeat(101)), false)
  assert.equal(validAuthorCommentQuery('中'.repeat(100)), true)
  assert.equal(validAuthorCommentQuery('hello\nworld'), false)
  assert.equal(validAuthorCommentQuery('bad\u0000text'), false)
})

test('readAuthorAppeals preserves bare route by default and encodes search/status/before filters cleanly', async t => {
  const originalFetch = globalThis.fetch
  const seenUrls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    seenUrls.push(String(input))
    return emptyAppealsResponse()
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const session = 'a'.repeat(64)
  const signal = new AbortController().signal

  const bare = await readAuthorAppeals(null, session, signal)
  assert.equal(bare.editEnabled, true)
  assert.equal(seenUrls.at(-1), WireRoutes.CommentAuthorAppeals)

  await readAuthorAppeals(null, session, signal, { q: '  ', status: 'all' })
  assert.equal(seenUrls.at(-1), WireRoutes.CommentAuthorAppeals)

  await readAuthorAppeals('42', session, signal, { q: '  AEDS v2  ', status: 'rejected' })
  assert.equal(seenUrls.at(-1), `${WireRoutes.CommentAuthorAppeals}?before=42&q=AEDS+v2&status=rejected`)

  assert.throws(() => readAuthorAppeals(null, session, signal, { q: 'bad\u0007' }), ProtocolError)
  assert.throws(() => readAuthorAppeals(null, session, signal, { status: 'bogus' as never }), ProtocolError)
})
