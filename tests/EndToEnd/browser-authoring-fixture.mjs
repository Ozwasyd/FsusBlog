import assert from 'node:assert/strict'
import { exactButton as button } from './role-locators.mjs'
import { randomUUID } from 'node:crypto'
import { requireWebPackage } from './web-package-fixture.mjs'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium, expect } = requireWebPackage('@playwright/test')
export { chromium, expect, button }

export const binary = { 'Content-Type': 'application/octet-stream' }

export async function createCanvasThroughUi(page, origin, title) {
  await page.goto(origin + '/admin/canvas')
  await button(page, 'New Canvas').click()
  const dialog = page.getByRole('dialog', { name: 'New Canvas', exact: true })
  await dialog.getByLabel('Canvas title').fill(title)
  await button(dialog, 'Save Canvas').click()
}

export function observePageErrors(page, diagnostics) {
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', entry => {
    if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) diagnostics.push(entry.text())
  })
  return page
}

export function deferResponse(fetchOptions) {
  const upstream = Promise.withResolvers()
  // A browser action may fail before the test can await the response.
  upstream.promise.catch(() => {})
  const release = Promise.withResolvers()
  const done = Promise.withResolvers()
  let started = false
  return {
    response: upstream.promise,
    release: release.resolve,
    done: done.promise,
    get started() { return started },
    async status() { return (await upstream.promise).status() },
    async forward(route) {
      started = true
      try {
        const response = await route.fetch(fetchOptions)
        upstream.resolve(response)
        await release.promise
        await route.fulfill({ response })
        done.resolve()
      } catch (error) {
        upstream.reject(error)
        done.resolve(error)
      }
    },
  }
}

export async function holdResponse(page, pattern, fetchOptions) {
  const held = deferResponse(fetchOptions)
  await page.route(pattern, held.forward, { times: 1 })
  return held
}

export function postFrame(request, url, type, payload, headers = binary) {
  return request.post(url, { data: Buffer.from(encodeFrame(type, payload)), headers })
}

export function submitArticle(request, url, command, headers) {
  return postFrame(request, url, FrameType.ArticleCommand,
    encodeArticleCommand({ idempotencyKey: randomUUID(), ...command }), headers)
}

export function submitPublicationMutation(request, path, id, expectedRevision, title, body) {
  const idempotencyKey = randomUUID()
  const command = encodeArticleCommand({ id, expectedRevision, idempotencyKey, title, body })
  return postFrame(request, path, FrameType.ArticleCommand, command,
    { ...binary, [WireHeaders.ClientMutationId]: idempotencyKey })
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

export async function journalContains(page, body) {
  await page.waitForFunction(source => new Promise(resolve => {
    const request = indexedDB.open('fsusblog-v2-draft-recovery')
    request.onerror = () => resolve(false)
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('recovery')) {
        database.close()
        resolve(false)
        return
      }
      const tx = database.transaction('recovery')
      const rows = tx.objectStore('recovery').getAll()
      rows.onsuccess = () => resolve(rows.result.some(row => row.body === source))
      rows.onerror = () => resolve(false)
      tx.oncomplete = () => database.close()
    }
  }), body)
}
