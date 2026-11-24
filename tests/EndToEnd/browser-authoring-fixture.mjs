import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { encodeArticleSummaryCommand } from '../../src/Contracts/article-summary.ts'
import { decodeCanvasGraphPage } from '../../src/Contracts/canvas-graph.ts'
import { decodePowChallenge, encodePowProof } from '../../src/Contracts/pow.ts'
import { decodePropertyEditor, encodePropertySchemaCommand, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { withTempContext } from './isolated-browser-fixture.mjs'
import { assertNoStore, assertStatus, getFrame, readFrame } from './response-status-fixture.mjs'
import { exactButton as button, exactLabel, roleWithExactName } from './role-locators.mjs'
import { requireWebPackage } from './web-package-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { FrameType, WireHeaders, WireRoutes } = wire

const { chromium, expect } = requireWebPackage('@playwright/test')
export { chromium, expect, button }

export const binary = { 'Content-Type': 'application/octet-stream' }

export async function createCanvasThroughUi(page, origin, title) {
  await page.goto(origin + '/admin/canvas')
  await button(page, 'New Canvas').click()
  const dialog = roleWithExactName(page, 'dialog', 'New Canvas')
  await dialog.getByLabel('Canvas title').fill(title)
  await button(dialog, 'Save Canvas').click()
}

export function canvasFixture(page, origin) {
  const board = () => page.getByRole('region', { name: 'Interactive Canvas Viewport' })
  const outline = () => page.getByRole('region', { name: 'Canvas outline' })
  const dialog = name => roleWithExactName(page, 'dialog', name)
  const documentId = () => new URL(page.url()).pathname.split('/').at(-1)
  const draft = id => getFrame(page.request, origin + WireRoutes.Draft.replace('{id:int}', String(id)), FrameType.Draft, wire.decodeDraft)
  async function graph(id = documentId(), offset = 0, revision) {
    const address = new URL(WireRoutes.CanvasGraphPage.replace('{id:guid}', id), origin)
    if (offset) {
      address.searchParams.set('offset', String(offset))
      address.searchParams.set('revision', String(revision))
    } else if (revision !== undefined) {
      address.searchParams.set('revision', String(revision))
    }
    return getFrame(page.request, address.href, FrameType.CanvasGraphPage, payload => decodeCanvasGraphPage(payload, offset))
  }
  async function saveAddDialog(trigger, fill) {
    await button(page, trigger).click()
    const form = dialog('Add node')
    await fill(form)
    await button(form, 'Save node').click()
    await form.waitFor({ state: 'hidden' })
  }
  const addNote = text => saveAddDialog('Add note', form => form.getByLabel('Note text').fill(text))
  async function fillReference(kind, { articleId, anchor, pinned } = {}) {
    await button(page, 'Add reference').click()
    const form = dialog('Add node')
    if (kind && kind !== 'article-reference') await form.getByLabel('Reference type').selectOption(kind)
    await exactLabel(form, 'Article ID').fill(String(articleId))
    if (anchor !== undefined) await form.getByLabel('Anchor ID').fill(anchor)
    if (pinned !== undefined) await form.getByLabel('Pinned revision (optional)').fill(String(pinned))
    return form
  }
  async function addReference(kind, options) {
    const form = await fillReference(kind, options)
    await button(form, 'Save node').click()
    await form.waitFor({ state: 'hidden' })
  }
  function assertAnonymousDenied(url, title, ...apiPaths) {
    return withTempContext(page.context().browser(), async other => {
      await other.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
      const tab = await other.newPage()
      const shell = await tab.goto(url)
      assert.match(shell.headers()['x-robots-tag'], /noindex/)
      await roleWithExactName(tab, 'link', 'Log in to access Canvas').waitFor()
      assert.equal(await roleWithExactName(tab, 'heading', title).count(), 0)
      for (const path of apiPaths) assertStatus(await tab.request.get(origin + path), 401)
    })
  }
  return { board, outline, dialog, documentId, draft, graph, addNote, fillReference, addReference, assertAnonymousDenied }
}

export function observePageErrors(page, diagnostics, watchAssets = false) {
  page.on('pageerror', error => diagnostics.push(error.message))
  page.on('console', entry => {
    if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) diagnostics.push(entry.text())
  })
  if (watchAssets) {
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (response.status() >= 500 || response.status() >= 400 && path.startsWith('/assets/')) diagnostics.push(`${response.status()} ${path}`)
    })
  }
  return page
}

export async function pressKey(page, control, key = 'Enter') {
  await control.focus()
  await expect(control).toBeFocused()
  await page.keyboard.press(key)
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

export async function withHeldResponse(page, pattern, trigger, whileHeld, fetchOptions) {
  const held = await holdResponse(page, pattern, fetchOptions)
  try {
    await trigger()
    await whileHeld(held)
  } finally { held.release() }
  if (held.started) {
    const err = await held.done
    if (err) throw err
  }
}

export function postFrame(request, url, type, payload, headers = binary) {
  return request.post(url, { data: Buffer.from(encodeFrame(type, payload)), headers })
}

export function submitArticle(request, url, command, headers) {
  return postFrame(request, url, FrameType.ArticleCommand,
    wire.encodeArticleCommand({ idempotencyKey: randomUUID(), ...command }), headers)
}

export function submitPublicationMutation(request, path, id, expectedRevision, title, body) {
  const idempotencyKey = randomUUID()
  const command = wire.encodeArticleCommand({ id, expectedRevision, idempotencyKey, title, body })
  return postFrame(request, path, FrameType.ArticleCommand, command,
    { ...binary, [WireHeaders.ClientMutationId]: idempotencyKey })
}

export function solvePow({ salt, difficulty }, clientNonce) {
  const bytes = Math.floor(difficulty / 8)
  const bits = difficulty % 8
  for (let nonce = 0; nonce < 131_072; nonce++) {
    const digest = createHash('sha256').update(`${salt}:${nonce}:${clientNonce}`).digest()
    if (digest.subarray(0, bytes).every(byte => byte === 0) && (bits === 0 || digest[bytes] >>> (8 - bits) === 0)) return String(nonce)
  }
  throw new Error('No proof found in the fixture budget.')
}

export async function submitPublicCommentWithPow(request, origin, { articleId, publication, displayName, body }) {
  const idempotencyKey = randomUUID()
  const payload = wire.encodePublicCommentSubmission({ articleId, publication, displayName, body, idempotencyKey, explicitPublic: true })
  const clientNonce = randomBytes(16).toString('hex')
  const key = { ...binary, [WireHeaders.ClientMutationId]: idempotencyKey }
  const powResponse = await postFrame(request, origin + WireRoutes.PublicCommentPowChallenge,
    FrameType.PublicCommentSubmission, payload, { ...key, [WireHeaders.PowClientNonce]: clientNonce })
  await assertNoStore(powResponse)
  const challenge = await readFrame(powResponse, FrameType.PowChallenge, decodePowChallenge)
  const submitResponse = await postFrame(request, origin + WireRoutes.SubmitPublicComment,
    FrameType.PublicCommentSubmission, payload, { ...key, [WireHeaders.PowProof]: encodePowProof(challenge, solvePow(challenge, clientNonce), clientNonce) })
  await assertNoStore(submitResponse)
  const receipt = await readFrame(submitResponse, FrameType.PublicCommentSubmissionResult, wire.decodePublicCommentSubmissionResult)
  assert.equal(receipt.articleId, articleId)
  assert.equal(receipt.moderationStatus, 0)
  assert(receipt.commentId > 0n)
  return receipt.commentId
}

export async function readReaderSession(target, origin) {
  const response = await target.request.get(origin + WireRoutes.Session)
  try {
    const session = await readFrame(response, FrameType.OperatorSession, wire.decodeSession)
    assert.equal(session.canAuthor, false)
    const handle = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert.match(handle ?? '', /^[a-f0-9]{64}$/)
    return { name: session.name, handle }
  } finally { await response.dispose() }
}

export async function readDraft(response, message) {
  assert.equal(response.status(), 200, message)
  return wire.decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
}

export async function postReceipt(context, origin, path, type, payload, expected, credential, extraHeaders) {
  const headers = { ...binary, ...(credential && { [WireHeaders.CurrentSession]: credential }), ...extraHeaders }
  const response = await postFrame(context.request, origin + path, type, payload, headers)
  try {
    assert.equal(response.status(), 200, path)
    return { payload: decodeFrame(await response.body(), expected).payload, headers: response.headers() }
  } finally {
    await response.dispose()
  }
}

export async function openWorkspaceDialog(page) {
  const dialog = roleWithExactName(page, 'dialog', 'Workspace & open article')
  if (await dialog.isVisible()) return dialog
  await button(page, 'More actions').click()
  await roleWithExactName(page, 'menuitem', 'Workspace & open…').click()
  await dialog.waitFor()
  return dialog
}

export function authorFixture(origin, diagnostics) {
  async function signIn(context, ticket) {
    const response = await postFrame(context.request, origin + WireRoutes.SignIn, FrameType.OperatorSignIn, wire.encodeSignIn({ ticket }))
    assert.equal(response.status(), 200)
    return response.headers()[WireHeaders.CurrentSession.toLowerCase()]
  }
  const draftPath = id => `${origin}${WireRoutes.Draft.replace('{id:int}', String(id))}`
  const editPath = id => `${origin}/admin/articles/edit/${id}`
  async function getDraft(context, id) {
    const response = await context.request.get(draftPath(id))
    try { return await readDraft(response) } finally { await response.dispose() }
  }
  const sessionHeaders = credential => credential ? { ...binary, [WireHeaders.CurrentSession]: credential } : binary
  const submit = (context, route, command, credential) =>
    submitArticle(context.request, origin + route, command, sessionHeaders(credential))
  const saveDraft = async (context, draft, body, credential) =>
    readDraft(await submit(context, WireRoutes.Save, { id: draft.id, expectedRevision: draft.revision, title: draft.title, body }, credential))
  const createDraft = (context, title, body, credential) => saveDraft(context, { id: 0, revision: 0n, title }, body, credential)
  const lifecycle = route => async (context, draft, credential) =>
    readDraft(await submit(context, route, { id: draft.id, expectedRevision: draft.revision, title: '', body: '' }, credential))
  const publishDraft = lifecycle(WireRoutes.Publish)
  const retractDraft = lifecycle(WireRoutes.Retract)
  async function deleteDraft(context, draft, credential) {
    const response = await submit(context, WireRoutes.Delete, { id: draft.id, expectedRevision: draft.revision, title: '', body: '' }, credential)
    try { assert.equal(response.status(), 200); return decodeFrame(await response.body(), FrameType.EmptySuccess) }
    finally { await response.dispose() }
  }
  const monitor = page => observePageErrors(page, diagnostics)
  const post = (context, path, type, payload, expected, credential, extraHeaders) =>
    postReceipt(context, origin, path, type, payload, expected, credential, extraHeaders)
  const postDecoded = async (context, path, type, payload, expected, decode, credential, extra) =>
    decode((await post(context, path, type, payload, expected, credential, extra)).payload)
  function saveSummary(context, draft, text, credential) {
    const idempotencyKey = randomUUID()
    const payload = encodeArticleSummaryCommand({ id: draft.id, expectedRevision: draft.revision, idempotencyKey, text })
    return postDecoded(context, WireRoutes.ArticleSummarySave, FrameType.ArticleSummaryCommand,
      payload, FrameType.Draft, wire.decodeDraft, credential, { [WireHeaders.ClientMutationId]: idempotencyKey })
  }
  const assignTaxonomy = (context, draft, categoryId, tagIds, credential) =>
    postDecoded(context, WireRoutes.TaxonomyAssignment, FrameType.TaxonomyAssignment,
      wire.encodeTaxonomyAssignment({ id: draft.id, expectedRevision: draft.revision, idempotencyKey: randomUUID(), categoryId, tagIds }),
      FrameType.DraftTaxonomy, wire.decodeDraftTaxonomy, credential)
  const savePropertySchema = (context, command, credential) =>
    postDecoded(context, WireRoutes.PropertySchemaCommand, FrameType.PropertySchemaCommand,
      encodePropertySchemaCommand({ requestId: randomUUID(), ...command }),
      FrameType.PropertyCommandReceipt, wire.decodePropertyCommandReceipt, credential)
  const savePropertyValue = (context, command, credential) =>
    postDecoded(context, WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand,
      encodePropertyValueCommand({ requestId: randomUUID(), ...command }),
      FrameType.PropertyCommandReceipt, wire.decodePropertyCommandReceipt, credential)
  const readPropertyEditor = (context, params, credential) =>
    postDecoded(context, WireRoutes.PropertyEditor, FrameType.PropertyWorkspaceRequest,
      wire.encodePropertyWorkspaceRequest({ schemaRevision: 0n, valueRevision: 0n, afterKey: '', ...params }),
      FrameType.PropertyEditor, decodePropertyEditor, credential)

  async function readSession(context) {
    const response = await context.request.get(origin + WireRoutes.AuthoringSession)
    try {
      assert.equal(response.status(), 200)
      const session = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
      assert(session)
      return session
    } finally {
      await response.dispose()
    }
  }

  async function signInWithPasskey(context, bootstrap) {
    assert(bootstrap)
    const page = monitor(await context.newPage())
    try {
      await signInFreshAdmin(page, origin, bootstrap)
      return await readSession(context)
    } finally {
      await page.close()
    }
  }

  return { signIn, signInWithPasskey, readSession, saveDraft, createDraft, publishDraft, retractDraft, deleteDraft,
    getDraft, monitor, post, saveSummary, assignTaxonomy, savePropertySchema, savePropertyValue, readPropertyEditor, draftPath, editPath }
}

const recoveryMatches = match => new Promise((resolve, reject) => {
  const open = indexedDB.open('fsusblog-v2-draft-recovery')
  open.onerror = () => (match.strict ? reject(open.error) : resolve(false))
  open.onsuccess = () => {
    const db = open.result
    if (!db.objectStoreNames.contains('recovery')) { db.close(); resolve(false); return }
    const rows = db.transaction('recovery').objectStore('recovery').getAll()
    rows.onerror = () => { db.close(); match.strict ? reject(rows.error) : resolve(false) }
    rows.onsuccess = () => {
      const ok = rows.result.some(row => (match.body === undefined || row.body === match.body) &&
        (match.document === undefined || row.document === match.document) &&
        (match.title === undefined || row.title === match.title))
      db.close()
      resolve(ok)
    }
  }
})

export function journalContains(page, body, extra = {}) {
  return page.waitForFunction(recoveryMatches, { body, ...extra })
}

export function hasRecoveryCopy(page, id, body) {
  return page.evaluate(recoveryMatches, { document: `article:${id}`, body, strict: true })
}
