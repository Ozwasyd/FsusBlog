import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  WorkspaceRegistry,
  type DraftLoad,
  type DraftSave,
  type EditorTransport,
  type WorkspaceTab,
} from '../../src/Web/src/authoring/workspaceRegistry.ts'

type Draft = { id: number; revision: bigint; body: string }

const draft = (id: number, revision = 1n, body = 'same source'): Draft => ({ id, revision, body })
const author = { site: 'blog', principalId: 'author-id', generation: 1n }

function setup(transport: Partial<EditorTransport<Draft>> = {}, capacity?: number, now?: () => number) {
  const registry = new WorkspaceRegistry<Draft>({
    load: async id => ({ kind: 'ready', draft: draft(id) }),
    save: async item => ({ kind: 'saved', draft: { ...item, revision: item.revision + 1n } }),
    ...transport,
  }, capacity, now)
  registry.setIdentity(author)
  return registry
}

function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function activate(registry: WorkspaceRegistry<Draft>, id: number, group?: string): Promise<WorkspaceTab> {
  const result = await registry.openOrActivate(id, group)
  assert.equal(result.kind, 'ready')
  return result.tab
}

test('duplicate entrypoints await one ready receipt and activate the original group', async () => {
  const pending = deferred<DraftLoad<Draft>>()
  let loads = 0
  const registry = setup({ load: () => { loads++; return pending.promise } })
  const rail = registry.openOrActivate(12, 'primary')
  const route = registry.openOrActivate(12, 'other-group')
  assert.equal(registry.activeDraft, undefined)
  assert.deepEqual(registry.tabs, [])
  pending.resolve({ kind: 'ready', draft: draft(12) })
  assert.deepEqual(await rail, { kind: 'superseded' })
  const result = await route
  assert.equal(result.kind, 'ready')
  assert.equal(result.tab.group, 'primary')
  assert.equal(registry.activeTab?.sessionId, result.tab.sessionId)
  assert.equal(loads, 1)
  assert.equal((await activate(registry, 12, 'third-group')).sessionId, result.tab.sessionId)
  assert.equal(registry.tabs.length, 1)
})

test('crossed route navigation cancels old readiness and never creates a ghost tab', async () => {
  const pending = deferred<DraftLoad<Draft>>()
  let signal: AbortSignal | undefined
  const registry = setup({
    load: (id, candidate) => {
      if (id === 2) {
        signal = candidate
        return pending.promise
      }
      if (id === 3) return Promise.resolve({ kind: 'blocked', reason: 'missing' })
      return Promise.resolve({ kind: 'ready', draft: draft(id) })
    },
  })
  await activate(registry, 1)
  const second = registry.openOrActivate(2)
  await Promise.resolve()
  assert.equal(registry.activeTab?.articleId, 1)
  assert.deepEqual(await registry.openOrActivate(3), { kind: 'blocked', reason: 'missing' })
  assert.equal(signal?.aborted, true)
  assert.deepEqual(await second, { kind: 'superseded' })
  pending.resolve({ kind: 'ready', draft: draft(2) })
  assert.deepEqual(registry.tabs.map(tab => tab.articleId), [1])
})

test('clean preview replaces only after readiness while edits pin and stay isolated', async () => {
  const registry = setup()
  const first = await activate(registry, 1)
  await activate(registry, 2)
  assert.deepEqual(registry.tabs.map(tab => tab.articleId), [2])
  assert.equal(registry.updateDraft(first, draft(1, 1n, 'stale')), false)
  const second = registry.activeTab!
  assert.equal(registry.updateDraft(second, draft(2, 1n, 'working text')), true)
  assert.deepEqual(registry.requestClose(second), { kind: 'protected' })
  assert.equal(registry.tabs[0]?.mode, 'pinned')
  const third = await activate(registry, 3)
  assert.equal(registry.activeDraft?.body, 'same source')
  assert.equal(registry.updateDraft(second, draft(2, 1n, 'inactive callback')), false)
  await activate(registry, 2)
  assert.equal(registry.activeDraft?.body, 'working text')
  assert.equal(registry.requestClose(third).kind, 'closed')
})

test('confirmation planning is atomic and a later edit invalidates an earlier plan', async () => {
  const registry = setup()
  const first = await activate(registry, 1)
  registry.pin(first)
  const second = await activate(registry, 2)
  const plan = registry.planClose([first, second])!
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.tabs))
  registry.updateDraft(second, draft(2, 1n, 'new content'))
  assert.deepEqual(registry.applyClose(plan), { kind: 'stale' })
  assert.deepEqual(registry.applyClose(registry.planClose([first, second])!), { kind: 'protected' })
  assert.deepEqual(registry.tabs.map(tab => tab.articleId), [1, 2])
})

test('save handles edits during persistence, retaining newer text at the returned revision', async () => {
  const pending = deferred<DraftSave<Draft>>()
  let submitted: Draft | undefined
  const registry = setup({ save: item => { submitted = item; return pending.promise } })
  const tab = await activate(registry, 1)
  registry.updateDraft(tab, draft(1, 1n, 'first'))
  const save = registry.save(tab)
  assert.deepEqual(await registry.save(tab), { kind: 'busy' })
  assert.deepEqual(registry.requestClose(tab), { kind: 'protected' })
  registry.updateDraft(tab, draft(1, 1n, 'second'))
  pending.resolve({ kind: 'saved', draft: draft(1, 2n, 'first') })
  assert.deepEqual(await save, { kind: 'saved', articleId: 1, revision: 2n })
  assert.deepEqual(submitted, draft(1, 1n, 'first'))
  assert.deepEqual(registry.activeDraft, draft(1, 2n, 'second'))
  assert.equal(registry.activeTab?.risk, 'dirty')
})

test('an uncertain retry reuses its key and a conflict preserves the local draft', async () => {
  const keys: string[] = []
  const registry = setup({
    save: async (_item, _signal, key) => {
      keys.push(key)
      return keys.length === 1 ? { kind: 'blocked', reason: 'unavailable' } : { kind: 'conflict' }
    },
  })
  const tab = await activate(registry, 1)
  registry.updateDraft(tab, draft(1, 1n, 'keep this'))
  assert.deepEqual(await registry.save(tab), { kind: 'blocked', reason: 'unavailable' })
  assert.deepEqual(await registry.save(tab), { kind: 'conflict' })
  assert.equal(keys.length, 2)
  assert.ok(keys[0])
  assert.equal(keys[1], keys[0])
  assert.equal(registry.activeDraft?.body, 'keep this')
  assert.equal(registry.requestClose(tab).kind, 'protected')
  assert.equal(registry.activeTab?.risk, 'conflict')
})

test('a draft whose first creation response was lost keeps the exact key and payload after a new edit', async () => {
  const attempts: { item: Draft; key: string }[] = []
  const registry = setup({
    save: async (item, _signal, key) => {
      attempts.push({ item, key })
      return attempts.length === 1 ? { kind: 'blocked', reason: 'unavailable' }
        : { kind: 'saved', draft: { ...item, id: 42, revision: 1n } }
    },
  })
  const start = await registry.startDraft(draft(0, 0n, ''))
  assert.equal(start.kind, 'ready')
  const tab = start.tab
  registry.updateDraft(tab, draft(0, 0n, 'first edit'))
  assert.deepEqual(await registry.save(tab), { kind: 'blocked', reason: 'unavailable' })
  assert.equal(registry.discard(tab, registry.revision).kind, 'protected')
  assert.equal(registry.updateDraft(tab, draft(0, 0n, 'second edit')), true)
  assert.deepEqual(await registry.save(tab), { kind: 'saved', articleId: 42, revision: 1n })
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], attempts[1])
  assert.deepEqual(registry.activeDraft, draft(42, 1n, 'second edit'))
  assert.equal(registry.activeTab?.sessionId, tab.sessionId)
  assert.equal(registry.updateDraft(tab, draft(0, 0n, 'stale draft')), false)
  assert.deepEqual(await registry.openOrActivate(0), { kind: 'blocked', reason: 'missing' })
  assert.equal(registry.tabs.length, 1)
})

test('retry uses the exact original classification operation and key', async () => {
  const registry = setup()
  const tab = await activate(registry, 1)
  const keys: string[] = []
  const selected = async (item: Draft, _signal: AbortSignal, key: string): Promise<DraftSave<Draft>> => {
    keys.push(key)
    return keys.length === 1 ? { kind: 'blocked', reason: 'unavailable' }
      : { kind: 'saved', draft: { ...item, revision: 2n } }
  }
  const classification = await registry.commit(tab, 'assign-taxonomy', selected)
  assert.deepEqual(classification, { kind: 'blocked', reason: 'unavailable' })
  assert.equal(registry.activeTab?.retry, 'assign-taxonomy')
  assert.deepEqual(await registry.commit(tab, 'publish', async () => {
    throw new Error('unconfirmed metadata must block publishing')
  }), { kind: 'busy' })
  assert.deepEqual(await registry.retry(tab), { kind: 'saved', articleId: 1, revision: 2n })
  assert.deepEqual(keys, [keys[0], keys[0]])
})

test('a rejected draft keeps local edits and allows a corrected request with a new key', async () => {
  const keys: string[] = []
  const registry = setup({
    save: async (item, _signal, key) => {
      keys.push(key)
      return keys.length === 1 ? { kind: 'rejected' } : { kind: 'saved', draft: { ...item, revision: 2n } }
    },
  })
  const tab = await activate(registry, 1)
  registry.updateDraft(tab, draft(1, 1n, 'first edit'))
  assert.deepEqual(await registry.save(tab), { kind: 'rejected' })
  assert.equal(registry.activeDraft?.body, 'first edit')
  assert.equal(registry.activeTab?.risk, 'dirty')
  assert.equal(registry.activeTab?.retry, undefined)
  registry.updateDraft(tab, draft(1, 1n, 'corrected'))
  assert.deepEqual(await registry.save(tab), { kind: 'saved', articleId: 1, revision: 2n })
  assert.notEqual(keys[0], keys[1])
})

test('publication rejects dirty and unsaved drafts, and fences edits while writing', async () => {
  const pending = deferred<DraftSave<Draft>>()
  const registry = setup()
  const tab = await activate(registry, 1)
  const publish = registry.commit(tab, 'publish', () => pending.promise)
  assert.equal(registry.updateDraft(tab, draft(1, 1n, 'edit during publish')), false)
  assert.deepEqual(await registry.commit(tab, 'retract', () => pending.promise), { kind: 'busy' })
  pending.resolve({ kind: 'saved', draft: draft(1, 2n) })
  assert.deepEqual(await publish, { kind: 'saved', articleId: 1, revision: 2n })
  registry.updateDraft(tab, draft(1, 2n, 'dirty'))
  assert.deepEqual(await registry.commit(tab, 'retract', () => pending.promise), { kind: 'dirty' })
  const local = await registry.startDraft(draft(0, 0n))
  assert.equal(local.kind, 'ready')
  assert.deepEqual(await registry.commit(local.tab, 'publish', () => pending.promise), { kind: 'dirty' })
})

test('identity A to B to A cannot publish an old result or accept an old session reference', async () => {
  const pending = deferred<DraftSave<Draft>>()
  let saveSignal: AbortSignal | undefined
  const registry = setup({ save: (_item, signal) => { saveSignal = signal; return pending.promise } })
  const old = await activate(registry, 1)
  registry.updateDraft(old, draft(1, 1n, 'A private edit'))
  const save = registry.save(old)
  await Promise.resolve()
  registry.setIdentity({ ...author, principalId: 'another-id' })
  assert.equal(registry.activeDraft, undefined)
  assert.deepEqual(registry.tabs, [])
  registry.setIdentity(author)
  const current = await activate(registry, 1)
  assert.notEqual(current.sessionId, old.sessionId)
  assert.equal(saveSignal?.aborted, true)
  assert.deepEqual(await save, { kind: 'superseded' })
  pending.resolve({ kind: 'saved', draft: draft(1, 2n, 'A private edit') })
  assert.equal(registry.updateDraft(old, draft(1, 1n, 'stale')), false)
  assert.equal(registry.activeDraft?.revision, 1n)
})

test('observed expiry revokes pending operations and is sticky even if the clock regresses', async () => {
  let time = 4
  const pending = deferred<DraftLoad<Draft>>()
  const registry = setup({ load: () => pending.promise }, 100, () => time)
  const identity = { ...author, expiresAt: 5 }
  registry.setIdentity(identity)
  const open = registry.openOrActivate(2)
  time = 5
  assert.deepEqual(registry.tabs, [])
  time = 4
  assert.deepEqual(await open, { kind: 'superseded' })
  assert.deepEqual(await registry.openOrActivate(2), { kind: 'blocked', reason: 'expired' })
  registry.setIdentity(identity)
  assert.deepEqual(await registry.openOrActivate(2), { kind: 'blocked', reason: 'expired' })
})

test('revoking a session hides its content and ignores an old save result', async () => {
  const pending = deferred<DraftSave<Draft>>()
  const registry = setup({ save: () => pending.promise })
  const tab = await activate(registry, 1)
  registry.updateDraft(tab, draft(1, 1n, 'local text'))
  const save = registry.save(tab)
  assert.equal(registry.invalidate(tab, 'forbidden'), true)
  assert.equal(registry.activeDraft, undefined)
  assert.equal(registry.tabs[0]?.risk, 'blocked')
  assert.equal(registry.requestClose(tab).kind, 'protected')
  assert.deepEqual(await save, { kind: 'superseded' })
  pending.resolve({ kind: 'saved', draft: draft(1, 2n) })
  assert.deepEqual(await registry.openOrActivate(1), { kind: 'blocked', reason: 'forbidden' })
})

test('100 pinned tabs stay bounded and existing sessions still activate at capacity', async () => {
  const registry = setup()
  for (let id = 1; id <= 100; id++) assert.equal((await registry.openOrActivate(id, 'main', 'pinned')).kind, 'ready')
  assert.equal(registry.tabs.length, 100)
  assert.deepEqual(await registry.openOrActivate(101), { kind: 'capacity' })
  assert.equal((await activate(registry, 1, 'other-group')).group, 'main')
  assert.deepEqual(registry.tabs.filter(tab => tab.active).map(tab => tab.articleId), [1])
})
