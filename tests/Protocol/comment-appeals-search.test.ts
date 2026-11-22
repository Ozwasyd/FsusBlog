import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import { PodWriter } from '../../src/Contracts/binary.ts'
import { readAuthorAppeals, validAuthorCommentQuery } from '../../src/Contracts/comment-appeals.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

type AppealRow = {
  article: number
  comment: bigint
  body: string
  status: number
  appeal: number
  reason: string
  editable: boolean
}

function appealsResponse(rows: AppealRow[] = []) {
  const writer = new PodWriter()
  writer.bool(false)
  writer.i32(rows.length)
  for (const row of rows) {
    writer.i32(row.article)
    writer.i64(row.comment)
    writer.text(row.body)
    writer.i32(row.status)
    writer.i32(row.appeal)
    writer.text(row.reason)
    writer.bool(row.editable)
  }
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
    return appealsResponse()
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

test('readAuthorAppeals decodes row editability and rejects contradictory editable flags', async t => {
  const originalFetch = globalThis.fetch
  let nextResponse: Response = appealsResponse()
  globalThis.fetch = (async () => nextResponse) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const session = 'b'.repeat(64)
  const signal = new AbortController().signal

  nextResponse = appealsResponse([
    { article: 1, comment: 10n, body: 'Fresh pending', status: 0, appeal: 0, reason: '', editable: true },
    { article: 1, comment: 9n, body: 'Expired pending', status: 0, appeal: 0, reason: '', editable: false },
    { article: 1, comment: 8n, body: 'Approved', status: 1, appeal: 0, reason: '', editable: false },
  ])
  const page = await readAuthorAppeals(null, session, signal)
  assert.deepEqual(page.rows.map(r => [r.comment, r.editable]), [['10', true], ['9', false], ['8', false]])

  // Contradictory: approved row marked editable must fail closed.
  nextResponse = appealsResponse([
    { article: 1, comment: 8n, body: 'Approved', status: 1, appeal: 0, reason: '', editable: true },
  ])
  await assert.rejects(() => readAuthorAppeals(null, session, signal), ProtocolError)

  // Contradictory: deleted empty body marked editable must fail closed.
  nextResponse = appealsResponse([
    { article: 1, comment: 7n, body: '', status: 0, appeal: 0, reason: '', editable: true },
  ])
  await assert.rejects(() => readAuthorAppeals(null, session, signal), ProtocolError)
})
