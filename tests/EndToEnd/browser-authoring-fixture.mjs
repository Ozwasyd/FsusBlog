import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
export { chromium, expect }

export const binary = { 'Content-Type': 'application/octet-stream' }
export const button = (scope, name) => scope.getByRole('button', { name, exact: true })

export function observePageErrors(page, diagnostics) {
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', entry => {
    if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) diagnostics.push(entry.text())
  })
  return page
}

export function postFrame(request, url, type, payload, headers = binary) {
  return request.post(url, { data: Buffer.from(encodeFrame(type, payload)), headers })
}

export function submitArticle(request, url, command, headers) {
  return postFrame(request, url, FrameType.ArticleCommand,
    encodeArticleCommand({ idempotencyKey: randomUUID(), ...command }), headers)
}

export async function readDraft(response, message) {
  assert.equal(response.status(), 200, message)
  return decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
}

export async function postReceipt(context, origin, path, type, payload, expected, credential) {
  const headers = credential ? { ...binary, [WireHeaders.CurrentSession]: credential } : binary
  const response = await postFrame(context.request, origin + path, type, payload, headers)
  try {
    assert.equal(response.status(), 200, path)
    return { payload: decodeFrame(await response.body(), expected).payload, headers: response.headers() }
  } finally {
    await response.dispose()
  }
}

export function authorFixture(origin, diagnostics) {
  async function signIn(context, ticket) {
    const response = await postFrame(context.request, origin + WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }))
    assert.equal(response.status(), 200)
    return response.headers()[WireHeaders.CurrentSession.toLowerCase()]
  }
  const saveDraft = async (context, draft, body) => readDraft(await submitArticle(context.request, origin + WireRoutes.Save,
    { id: draft.id, expectedRevision: draft.revision, title: draft.title, body }))
  const createDraft = (context, title, body) => saveDraft(context, { id: 0, revision: 0n, title }, body)
  const monitor = page => observePageErrors(page, diagnostics)
  return { signIn, saveDraft, createDraft, monitor }
}
