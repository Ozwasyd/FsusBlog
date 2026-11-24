import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  WorkspaceRegistry,
  type DraftLoad,
  type DraftSave,
  type EditorTransport,
  type SavedWorkspaceLayout,
  type WorkspaceBlock,
  type WorkspaceGroup,
  type WorkspaceTab,
} from '../../src/Web/src/authoring/workspaceRegistry.ts'
import { expectFields } from './authoringFixture.ts'

type Draft = { id: number; revision: bigint; body: string }

const draft = (id: number, revision = 1n, body = 'same source'): Draft => ({ id, revision, body })
const author = { site: 'blog', principalId: 'author-id', generation: 1n }
const emptyLayout: SavedWorkspaceLayout = {
  activeArticleId: 0, tabs: [], inspectorOpen: false,
  secondaryActiveArticleId: 0, secondaryTabs: [], focusedGroup: 0,
}
const loadedDraft = (id: number, revision?: bigint, body?: string): DraftLoad<Draft> =>
  ({ kind: 'ready', draft: draft(id, revision, body) })
const savedDraft = (item: Draft): DraftSave<Draft> => ({ kind: 'saved', draft: item })
const blocked = (reason: WorkspaceBlock) => ({ kind: 'blocked' as const, reason })
const superseded = { kind: 'superseded' as const }
const savedResult = (articleId: number, revision = 2n) => ({ kind: 'saved' as const, articleId, revision })
const layoutWith = (patch: Partial<SavedWorkspaceLayout> = {}): SavedWorkspaceLayout => ({ ...emptyLayout, ...patch })
const splitLayout = (
  tabs: number[],
  activeArticleId: number,
  secondaryTabs: number[],
  secondaryActiveArticleId: number,
  options: Partial<Pick<SavedWorkspaceLayout, 'focusedGroup' | 'inspectorOpen'>> = {},
): SavedWorkspaceLayout => ({ ...emptyLayout, tabs, activeArticleId, secondaryTabs, secondaryActiveArticleId, ...options })
const restore = (registry: WorkspaceRegistry<Draft>, patch: Partial<SavedWorkspaceLayout>) =>
  registry.restoreLayout(layoutWith(patch), new AbortController().signal)

function setup(transport: Partial<EditorTransport<Draft>> = {}, capacity?: number, now?: () => number) {
  const registry = new WorkspaceRegistry<Draft>({
    load: async id => loadedDraft(id),
    save: async item => savedDraft({ ...item, revision: item.revision + 1n }),
    ...transport,
  }, capacity, now)
  registry.setIdentity(author)
  return registry
}

const tabIds = (registry: WorkspaceRegistry<Draft>) => registry.tabs.map(tab => tab.articleId)
const editorSessions = (registry: WorkspaceRegistry<Draft>) => registry.sourcePanes.map(pane => pane.tab.sessionId)
const paneArticleIds = (registry: WorkspaceRegistry<Draft>) => registry.sourcePanes.map(pane => pane.draft.id)
const byId = (registry: WorkspaceRegistry<Draft>, id: number) => registry.tabs.find(tab => tab.articleId === id)!
const edit = (
  registry: WorkspaceRegistry<Draft>,
  tab: WorkspaceTab,
  body: string,
  revision = 1n,
  edits?: Parameters<WorkspaceRegistry<Draft>['updateDraft']>[2],
) => registry.updateDraft(tab, draft(tab.articleId, revision, body), edits)

const expectBlocked = async (result: Promise<unknown>, reason: WorkspaceBlock) =>
  assert.deepEqual(await result, blocked(reason))
const expectSuperseded = async (result: Promise<unknown>) => assert.deepEqual(await result, superseded)
const expectSaved = async (result: Promise<unknown>, articleId: number, revision = 2n) =>
  assert.deepEqual(await result, savedResult(articleId, revision))

async function activate(registry: WorkspaceRegistry<Draft>, id: number, group?: WorkspaceGroup): Promise<WorkspaceTab> {
  const result = await registry.openOrActivate(id, group)
  assert.equal(result.kind, 'ready')
  return result.tab
}

test('an exact reference cannot replace a ready tab with an unwitnessed newer revision', async () => {
  const registry = setup({ load: async id => loadedDraft(id, id === 2 ? 4n : 1n) }, 1)
  const old = await activate(registry, 1)
  await expectBlocked(registry.openOrActivate(2, 'main', 'preview', undefined, 3n), 'stale-reference')
  assert.deepEqual(registry.tabs, [old])
  const ready = await registry.openOrActivate(2, 'main', 'preview', undefined, 4n)
  assert.equal(ready.kind, 'ready')
  assert.equal(ready.witnessedRevision, 4n)
  assert.equal(registry.activeDraft?.id, 2)
})

test('an uncertain save freezes its body edits and later changes cannot reuse the witnesses', async () => {
  const calls: Array<{ key: string; body: string; edits: unknown }> = []
  const registry = setup({
    save: async (item, _signal, key, edits) => {
      calls.push({ key, body: item.body, edits })
      return calls.length === 1 ? blocked('unavailable') : savedDraft({ ...item, revision: item.revision + 1n })
    },
  })
  const tab = await activate(registry, 1)
  const firstEdit = { offset: 0, removedLength: 0, insert: 'new ' }
  assert(edit(registry, tab, 'new same source', 1n, [firstEdit]))
  firstEdit.offset = 5
  assert.equal((await registry.save(tab)).kind, 'blocked')
  assert(edit(registry, tab, 'new same source plus unsaved changes', 1n, [{ offset: 15, removedLength: 0, insert: ' plus unsaved changes' }]))
  assert.equal((await registry.retry(tab)).kind, 'saved')
  assert.deepEqual(calls[0], { key: calls[1]!.key, body: 'new same source', edits: [{ offset: 0, removedLength: 0, insert: 'new ' }] })
  assert.deepEqual(calls[1], calls[0])
  assert.equal((await registry.save(tab)).kind, 'saved')
  expectFields(calls[2], { body: 'new same source plus unsaved changes', edits: undefined })
})

test('only uninterrupted body edits are carried into each saved revision, even if earlier bytes return', async () => {
  const written: unknown[] = []
  const registry = setup({
    save: async (item, _signal, _key, edits) => (written.push(edits), savedDraft({ ...item, revision: item.revision + 1n })),
  })
  const tab = await activate(registry, 1)
  const update = (patch: Partial<Draft> & { title?: string }, edits?: Parameters<typeof registry.updateDraft>[2]) =>
    assert(registry.updateDraft(tab, { ...registry.activeDraft!, ...patch }, edits))
  const saveOk = async () => assert.equal((await registry.save(tab)).kind, 'saved')
  const first = { offset: 0, removedLength: 0, insert: '中 ' }
  const second = { offset: 3, removedLength: 1, insert: '🧭' }
  update({ body: '中 ' + registry.activeDraft!.body }, [first])
  update({ title: 'New title' })
  const body = registry.activeDraft!.body
  update({ body: body.slice(0, 3) + '🧭' + body.slice(4) }, [second])
  await saveOk()
  assert.deepEqual(written[0], [first, second])

  update({ body: 'native edit' })
  update({ body: '# native edit' }, [{ offset: 0, removedLength: 0, insert: '# ' }])
  await saveOk()
  assert.equal(written[1], undefined)

  const next = { offset: 0, removedLength: 0, insert: 'Z' }
  const remove = { offset: 0, removedLength: 1, insert: '' }
  update({ body: 'Z# native edit' }, [next])
  await saveOk()
  assert.deepEqual(written[2], [next])
  update({ body: '# native edit' }, [remove])
  update({ body: 'Z# native edit' }, [next])
  await saveOk()
  assert.deepEqual(written[3], [remove, next])
})

test('an exact reference rechecks a ready source and preserves dirty and stale state', async () => {
  let currentRevision = 2n
  let loads = 0
  const registry = setup({ load: async id => (++loads, loadedDraft(id, currentRevision)) })
  const tab = await activate(registry, 2)
  assert.equal(edit(registry, tab, 'local source', 2n), true)
  await expectBlocked(registry.openOrActivate(2, 'main', 'preview', undefined, 2n), 'stale-reference')
  assert.equal(registry.activeDraft?.body, 'local source')
  currentRevision = 3n
  await expectBlocked(registry.openOrActivate(2, 'main', 'preview', undefined, 2n), 'stale-reference')
  assert.equal(registry.activeDraft?.revision, 2n)
  assert.equal(loads, 3)
})

test('an article selection rechecks its saved revision while retaining its existing group and local edits', async () => {
  let revision = 2n
  const registry = setup({ load: async id => loadedDraft(id, revision) })
  const target = await activate(registry, 2, 'secondary')
  assert(edit(registry, target, 'unsaved secondary text', 2n))
  const original = await activate(registry, 1, 'main')
  await expectSuperseded(registry.openOrActivate(2, 'main', 'preview', () => false, 2n, true))
  assert.equal(registry.activeTab?.sessionId, original.sessionId)
  revision = 3n
  await expectBlocked(registry.openOrActivate(2, 'main', 'preview', undefined, 2n, true), 'stale-reference')
  assert.equal(registry.activeTab?.sessionId, original.sessionId)
  revision = 2n
  assert.equal((await registry.openOrActivate(2, 'main', 'preview', undefined, 2n, true)).kind, 'ready')
  expectFields(registry.activeTab, { sessionId: target.sessionId, group: 'secondary', risk: 'dirty' })
  assert.equal(registry.activeDraft?.body, 'unsaved secondary text')
})

test('saved layout restores only ready drafts, retaining order, preview and selected article', async () => {
  const held = Promise.withResolvers<DraftLoad<Draft>>()
  const registry = setup({ load: async id => (id === 2 ? held.promise : id === 3 ? blocked('forbidden') : loadedDraft(id)) })
  const pending = restore(registry, { tabs: [1, 3, -2], activeArticleId: 2 })
  assert.deepEqual(registry.tabs, [])
  held.resolve(loadedDraft(2))
  assert.equal(await pending, 1)
  assert.deepEqual(registry.savedLayout, layoutWith({ tabs: [1, -2], activeArticleId: 2 }))
  assert.equal(registry.activeTab?.mode, 'preview')
  assert.equal(registry.activeDraft?.id, 2)
})

test('layout hydration loses authority on identity changes even if its draft request completes', async () => {
  const held = Promise.withResolvers<DraftLoad<Draft>>()
  const registry = setup({ load: () => held.promise })
  const pending = restore(registry, { tabs: [1], activeArticleId: 1 })
  registry.setIdentity({ ...author, principalId: 'other-author' })
  held.resolve(loadedDraft(1))
  assert.equal(await pending, undefined)
  assert.deepEqual(registry.savedLayout, emptyLayout)
})

test('the Inspector restores as workspace presentation and rejects another session or identity', async () => {
  const registry = setup()
  await restore(registry, { tabs: [1, 2], activeArticleId: 2, inspectorOpen: true })
  assert.equal(registry.inspectorOpen, true)
  registry.setInspectorOpen(byId(registry, 1), false)
  assert.equal(registry.inspectorOpen, true)
  const active = registry.activeTab!
  registry.setInspectorOpen(active, false)
  assert.equal(registry.inspectorOpen, false)
  registry.setInspectorOpen(active, true)
  registry.setIdentity({ ...author, generation: 2n })
  registry.setInspectorOpen(active, true)
  assert.equal(registry.inspectorOpen, false)
})

test('a transient failed read does not turn a recoverable layout into an authoritative partial one', async () => {
  const registry = setup({ load: async id => (id === 2 ? blocked('unavailable') : loadedDraft(id)) })
  assert.equal(await restore(registry, { tabs: [1, -2], activeArticleId: 1 }), undefined)
  assert.deepEqual(registry.tabs, [])
})

test('duplicate entrypoints await one ready receipt and activate the original group', async () => {
  const pending = Promise.withResolvers<DraftLoad<Draft>>()
  let loads = 0
  const registry = setup({ load: () => (loads++, pending.promise) })
  const rail = registry.openOrActivate(12, 'main')
  const route = registry.openOrActivate(12, 'secondary')
  assert.equal(registry.activeDraft, undefined)
  assert.deepEqual(registry.tabs, [])
  pending.resolve(loadedDraft(12))
  await expectSuperseded(rail)
  const result = await route
  assert.equal(result.kind, 'ready')
  assert.equal(result.tab.group, 'main')
  assert.equal(registry.activeTab?.sessionId, result.tab.sessionId)
  assert.equal(loads, 1)
  assert.equal((await activate(registry, 12, 'secondary')).sessionId, result.tab.sessionId)
  await expectBlocked(registry.openOrActivate(13, 'third-group' as WorkspaceGroup), 'unavailable')
  assert.equal(registry.tabs.length, 1)
})

test('crossed route navigation cancels old readiness and never creates a ghost tab', async () => {
  const pending = Promise.withResolvers<DraftLoad<Draft>>()
  let signal: AbortSignal | undefined
  const registry = setup({
    load: (id, candidate) => id === 2
      ? ((signal = candidate), pending.promise)
      : Promise.resolve(id === 3 ? blocked('missing') : loadedDraft(id)),
  })
  await activate(registry, 1)
  const second = registry.openOrActivate(2)
  await Promise.resolve()
  assert.equal(registry.activeTab?.articleId, 1)
  await expectBlocked(registry.openOrActivate(3), 'missing')
  assert.equal(signal?.aborted, true)
  await expectSuperseded(second)
  pending.resolve(loadedDraft(2))
  assert.deepEqual(tabIds(registry), [1])
})

test('clean preview replaces only after readiness while edits pin and stay isolated', async () => {
  const registry = setup()
  const first = await activate(registry, 1)
  await activate(registry, 2)
  assert.deepEqual(tabIds(registry), [2])
  assert.equal(edit(registry, first, 'stale'), false)
  const second = registry.activeTab!
  assert.equal(edit(registry, second, 'working text'), true)
  assert.deepEqual(registry.requestClose(second), { kind: 'protected' })
  assert.equal(registry.tabs[0]?.mode, 'pinned')
  const third = await activate(registry, 3)
  assert.equal(registry.activeDraft?.body, 'same source')
  assert.equal(edit(registry, second, 'inactive callback'), false)
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
  edit(registry, second, 'new content')
  assert.deepEqual(registry.applyClose(plan), { kind: 'stale' })
  assert.deepEqual(registry.applyClose(registry.planClose([first, second])!), { kind: 'protected' })
  assert.deepEqual(tabIds(registry), [1, 2])
})

test('save handles edits during persistence, retaining newer text at the returned revision', async () => {
  const pending = Promise.withResolvers<DraftSave<Draft>>()
  let submitted: Draft | undefined
  const registry = setup({ save: item => ((submitted = item), pending.promise) })
  const tab = await activate(registry, 1)
  edit(registry, tab, 'first')
  const save = registry.save(tab)
  assert.deepEqual(await registry.save(tab), { kind: 'busy' })
  assert.deepEqual(registry.requestClose(tab), { kind: 'protected' })
  edit(registry, tab, 'second')
  pending.resolve(savedDraft(draft(1, 2n, 'first')))
  await expectSaved(save, 1)
  assert.deepEqual(submitted, draft(1, 1n, 'first'))
  assert.deepEqual(registry.activeDraft, draft(1, 2n, 'second'))
  assert.equal(registry.activeTab?.risk, 'dirty')
})

test('an uncertain retry reuses its key and a conflict preserves the local draft', async () => {
  const keys: string[] = []
  const registry = setup({
    save: async (_item, _signal, key) => (keys.push(key), keys.length === 1 ? blocked('unavailable') : { kind: 'conflict' }),
  })
  const tab = await activate(registry, 1)
  edit(registry, tab, 'keep this')
  await expectBlocked(registry.save(tab), 'unavailable')
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
      return attempts.length === 1 ? blocked('unavailable') : savedDraft({ ...item, id: 42, revision: 1n })
    },
  })
  const start = await registry.startDraft(draft(0, 0n, ''))
  assert.equal(start.kind, 'ready')
  const tab = start.tab
  edit(registry, tab, 'first edit', 0n)
  await expectBlocked(registry.save(tab), 'unavailable')
  assert.equal(registry.discard(tab, registry.revision).kind, 'protected')
  assert.equal(edit(registry, tab, 'second edit', 0n), true)
  await expectSaved(registry.save(tab), 42, 1n)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], attempts[1])
  assert.deepEqual(registry.activeDraft, draft(42, 1n, 'second edit'))
  assert.equal(registry.activeTab?.sessionId, tab.sessionId)
  assert.equal(registry.updateDraft(tab, draft(0, 0n, 'stale draft')), false)
  await expectBlocked(registry.openOrActivate(0), 'missing')
  assert.equal(registry.tabs.length, 1)
})

test('retry uses the exact original classification operation and key', async () => {
  const registry = setup()
  const tab = await activate(registry, 1)
  const keys: string[] = []
  const selected = async (item: Draft, _signal: AbortSignal, key: string): Promise<DraftSave<Draft>> =>
    (keys.push(key), keys.length === 1 ? blocked('unavailable') : savedDraft({ ...item, revision: 2n }))
  await expectBlocked(registry.commit(tab, 'assign-taxonomy', selected), 'unavailable')
  assert.equal(registry.activeTab?.retry, 'assign-taxonomy')
  assert.deepEqual(await registry.commit(tab, 'publish', async () => { throw new Error('unconfirmed metadata must block publishing') }),
    { kind: 'busy' })
  await expectSaved(registry.retry(tab), 1)
  assert.deepEqual(keys, [keys[0], keys[0]])
})

test('a rejected draft keeps local edits and allows a corrected request with a new key', async () => {
  const keys: string[] = []
  const registry = setup({
    save: async (item, _signal, key) =>
      (keys.push(key), keys.length === 1 ? { kind: 'rejected' } : savedDraft({ ...item, revision: 2n })),
  })
  const tab = await activate(registry, 1)
  edit(registry, tab, 'first edit')
  assert.deepEqual(await registry.save(tab), { kind: 'rejected' })
  assert.equal(registry.activeDraft?.body, 'first edit')
  expectFields(registry.activeTab, { risk: 'dirty', retry: undefined })
  edit(registry, tab, 'corrected')
  await expectSaved(registry.save(tab), 1)
  assert.notEqual(keys[0], keys[1])
})

test('publication rejects dirty and unsaved drafts, and fences edits while writing', async () => {
  const pending = Promise.withResolvers<DraftSave<Draft>>()
  const registry = setup()
  const tab = await activate(registry, 1)
  const publish = registry.commit(tab, 'publish', () => pending.promise)
  assert.equal(edit(registry, tab, 'edit during publish'), false)
  assert.deepEqual(await registry.commit(tab, 'retract', () => pending.promise), { kind: 'busy' })
  pending.resolve(savedDraft(draft(1, 2n)))
  await expectSaved(publish, 1)
  edit(registry, tab, 'dirty', 2n)
  assert.deepEqual(await registry.commit(tab, 'retract', () => pending.promise), { kind: 'dirty' })
  const local = await registry.startDraft(draft(0, 0n))
  assert.equal(local.kind, 'ready')
  assert.deepEqual(await registry.commit(local.tab, 'publish', () => pending.promise), { kind: 'dirty' })
})

test('identity A to B to A cannot publish an old result or accept an old session reference', async () => {
  const pending = Promise.withResolvers<DraftSave<Draft>>()
  let saveSignal: AbortSignal | undefined
  const registry = setup({ save: (_item, signal) => ((saveSignal = signal), pending.promise) })
  const old = await activate(registry, 1)
  edit(registry, old, 'A private edit')
  const save = registry.save(old)
  await Promise.resolve()
  registry.setIdentity({ ...author, principalId: 'another-id' })
  assert.equal(registry.activeDraft, undefined)
  assert.deepEqual(registry.tabs, [])
  registry.setIdentity(author)
  const current = await activate(registry, 1)
  assert.notEqual(current.sessionId, old.sessionId)
  assert.equal(saveSignal?.aborted, true)
  await expectSuperseded(save)
  pending.resolve(savedDraft(draft(1, 2n, 'A private edit')))
  assert.equal(edit(registry, old, 'stale'), false)
  assert.equal(registry.activeDraft?.revision, 1n)
})

test('observed expiry revokes pending operations and is sticky even if the clock regresses', async () => {
  let time = 4
  const pending = Promise.withResolvers<DraftLoad<Draft>>()
  const registry = setup({ load: () => pending.promise }, 100, () => time)
  const identity = { ...author, expiresAt: 5 }
  registry.setIdentity(identity)
  const open = registry.openOrActivate(2)
  time = 5
  assert.deepEqual(registry.tabs, [])
  time = 4
  await expectSuperseded(open)
  await expectBlocked(registry.openOrActivate(2), 'expired')
  registry.setIdentity(identity)
  await expectBlocked(registry.openOrActivate(2), 'expired')
})

test('extending the current authority retains dirty content and the same retry request', async () => {
  let time = 4
  const requestKeys: string[] = []
  const registry = setup({ save: async (_, __, key) => (requestKeys.push(key), blocked('unavailable')) }, 100, () => time)
  registry.setIdentity({ ...author, expiresAt: 5 })
  const tab = await activate(registry, 1)
  edit(registry, tab, 'local text')
  await registry.save(tab)
  registry.updateIdentityExpiry(8)
  time = 6
  assert.equal(registry.activeDraft?.body, 'local text')
  assert.equal(registry.activeTab?.retry, 'save')
  await registry.retry(tab)
  assert.deepEqual(requestKeys, [requestKeys[0], requestKeys[0]])
  registry.setIdentity({ ...author, principalId: 'other', expiresAt: 8 })
  assert.deepEqual(registry.tabs, [])
})

test('revoking a session hides its content and ignores an old save result', async () => {
  const pending = Promise.withResolvers<DraftSave<Draft>>()
  const registry = setup({ save: () => pending.promise })
  const tab = await activate(registry, 1)
  edit(registry, tab, 'local text')
  const save = registry.save(tab)
  assert.equal(registry.invalidate(tab, 'forbidden'), true)
  assert.equal(registry.activeDraft, undefined)
  assert.equal(registry.tabs[0]?.risk, 'blocked')
  assert.equal(registry.requestClose(tab).kind, 'protected')
  await expectSuperseded(save)
  pending.resolve(savedDraft(draft(1, 2n)))
  await expectBlocked(registry.openOrActivate(1), 'forbidden')
})

test('100 pinned tabs stay bounded and existing sessions still activate at capacity', async () => {
  const registry = setup()
  for (let id = 1; id <= 100; id++) assert.equal((await registry.openOrActivate(id, 'main', 'pinned')).kind, 'ready')
  assert.equal(registry.tabs.length, 100)
  assert.deepEqual(await registry.openOrActivate(101), { kind: 'capacity' })
  assert.equal((await activate(registry, 1, 'secondary')).group, 'main')
  assert.deepEqual(registry.tabs.filter(tab => tab.active).map(tab => tab.articleId), [1])
})

test('returning to an inactive session rechecks authority without overwriting dirty text', async () => {
  let revision = 1n
  let permission = true
  const registry = setup({
    load: async id => (id === 1 && !permission ? blocked('forbidden') : loadedDraft(id, id === 1 ? revision : 1n, 'server')),
  })
  const one = await activate(registry, 1, 'main')
  edit(registry, one, 'local')
  const other = await activate(registry, 2)
  revision = 2n
  const reopened = await registry.openOrActivate(1)
  assert.equal(reopened.kind, 'ready')
  assert.equal(reopened.witnessedRevision, 2n)
  expectFields(registry.activeDraft, { body: 'local', revision: 1n })
  assert.equal(registry.activeTab?.risk, 'conflict')
  const alreadyActive = await registry.openOrActivate(1)
  assert.equal(alreadyActive.kind, 'ready')
  assert.equal(alreadyActive.witnessedRevision, undefined)
  await activate(registry, 2)
  permission = false
  await expectBlocked(registry.openOrActivate(1), 'forbidden')
  assert.equal(registry.activeTab?.articleId, other.articleId)
  assert.equal(byId(registry, 1).risk, 'blocked')
})

test('a superseded route guard cannot replace the existing preview', async () => {
  const pending = Promise.withResolvers<DraftLoad<Draft>>()
  const registry = setup({ load: async id => (id === 2 ? pending.promise : loadedDraft(id)) })
  await activate(registry, 1)
  let admissible = true
  const activation = registry.openOrActivate(2, 'main', 'preview', () => admissible)
  admissible = false
  pending.resolve(loadedDraft(2))
  await expectSuperseded(activation)
  assert.deepEqual(tabIds(registry), [1])
  assert.equal(registry.activeTab?.articleId, 1)
})

test('idle retains scoped tabs and recently closed entries are bounded and never disclose old titles', async () => {
  const registry = new WorkspaceRegistry({
    load: async id => ({ kind: 'ready', draft: { id, revision: 1n, title: `Private ${id}` } }),
    save: async item => ({ kind: 'saved', draft: item }),
  })
  registry.setIdentity(author)
  for (let id = 1; id < 18; id++) {
    const result = await registry.openOrActivate(id, 'main', 'pinned')
    assert.equal(result.kind, 'ready')
    assert.equal(result.tab.title, `Private ${id}`)
    assert.equal(registry.requestClose(result.tab).kind, 'closed')
  }
  assert.equal(registry.recentlyClosed.length, 12)
  assert.equal(registry.recentlyClosed[0].title, 'Article 17')
  const restored = await registry.openOrActivate(17, 'main', 'pinned')
  assert.equal(restored.kind, 'ready')
  assert.equal(restored.tab.title, 'Private 17')
  registry.idle()
  assert.equal(registry.activeTab, undefined)
  assert.equal(registry.tabs.length, 1)
  assert.equal(registry.recentlyClosed.length, 11)
  registry.setIdentity(null)
  assert.deepEqual(registry.tabs, [])
  assert.deepEqual(registry.recentlyClosed, [])
})

test('only a current terminal reopen failure removes its recently closed entry', async () => {
  let reason: WorkspaceBlock | undefined
  const registry = setup({ load: async id => (id === 1 && reason ? blocked(reason) : loadedDraft(id)) })
  registry.requestClose(await activate(registry, 1))
  const active = await activate(registry, 2)
  reason = 'unavailable'
  await expectBlocked(registry.openOrActivate(1), reason)
  assert.equal(registry.recentlyClosed[0].articleId, 1)
  reason = 'missing'
  await expectSuperseded(registry.openOrActivate(1, 'main', 'preview', () => false))
  assert.equal(registry.recentlyClosed[0].articleId, 1)
  await expectBlocked(registry.openOrActivate(1), reason)
  assert.deepEqual(registry.recentlyClosed, [])
  assert.deepEqual(registry.tabs, [active])
})

test('both groups expose exactly their selected sessions while the credentialed focus owns draft writes', async () => {
  const registry = setup()
  const primary = await activate(registry, 1)
  assert.equal(edit(registry, primary, 'unsaved primary'), true)
  const secondary = await activate(registry, 2, 'secondary')
  assert.equal(registry.hasSecondaryGroup, true)
  assert.deepEqual(registry.sourcePanes.map(p => [p.tab.sessionId, p.tab.active, p.draft.body]),
    [[primary.sessionId, false, 'unsaved primary'], [secondary.sessionId, true, 'same source']])
  assert.equal(edit(registry, primary, 'incorrect session'), false)
  const original = await activate(registry, 1, 'secondary')
  expectFields(original, { group: 'main', sessionId: primary.sessionId })
  assert.equal(registry.activeDraft?.body, 'unsaved primary')
  assert.equal(registry.tabs.length, 2)
  assert.equal(registry.requestClose(secondary).kind, 'closed')
  assert.equal(registry.hasSecondaryGroup, false)
  assert.deepEqual(editorSessions(registry), [primary.sessionId])
})

test('reexposing the comparison rechecks permission and retains dirty text across revision conflict', async () => {
  let permission = true
  let revision = 1n
  const registry = setup({ load: async id => (id !== 1 || permission ? loadedDraft(id, id === 1 ? revision : 1n) : blocked('forbidden')) })
  const first = await activate(registry, 1)
  edit(registry, first, 'local only')
  const second = await activate(registry, 2, 'secondary')
  revision++
  const signal = new AbortController().signal
  assert.equal(await registry.recheckComparison(first, signal), true)
  assert.equal(registry.sourcePanes[0].draft.body, 'local only')
  assert.equal(registry.sourcePanes[0].tab.risk, 'conflict')
  assert.equal(registry.activeTab?.sessionId, second.sessionId)
  permission = false
  assert.equal(await registry.recheckComparison(first, signal), false)
  assert.deepEqual(editorSessions(registry), [second.sessionId])
  assert.equal(byId(registry, 1).risk, 'blocked')
})

test('the comparison cannot restore a response after authority changes', async () => {
  const pending = Promise.withResolvers<DraftLoad<Draft>>()
  let delayed = false
  const registry = setup({ load: async id => (delayed && id === 1 ? pending.promise : loadedDraft(id)) })
  const first = await activate(registry, 1)
  await activate(registry, 2, 'secondary')
  delayed = true
  const exposed = registry.recheckComparison(first, new AbortController().signal)
  await Promise.resolve()
  registry.setIdentity({ ...author, generation: 2n })
  pending.resolve(loadedDraft(1, 2n, 'old identity private text'))
  assert.equal(await exposed, false)
  assert.deepEqual(registry.sourcePanes, [])
  assert.equal(registry.hasSecondaryGroup, false)
})

test('saved groups restore only current authorized drafts in their exact group, selection and order', async () => {
  const registry = setup()
  const layout = splitLayout([1, -4], 1, [-3, 2], 2, { focusedGroup: 1, inspectorOpen: true })
  assert.equal(await restore(registry, layout), 0)
  assert.deepEqual(registry.savedLayout, layout)
  assert.deepEqual(registry.tabs.map(t => [t.articleId, t.group, t.active]),
    [[1, 'main', false], [4, 'main', false], [3, 'secondary', false], [2, 'secondary', true]])
  assert.deepEqual(paneArticleIds(registry), [1, 2])
  assert.equal((await activate(registry, 1, 'secondary')).group, 'main')
  assert.deepEqual(registry.savedLayout, { ...layout, focusedGroup: 0 })
})

test('restoring missing selected drafts only falls back to a surviving selected record', async () => {
  const registry = setup({ load: async id => (id === 2 ? blocked('missing') : loadedDraft(id)) })
  const layout = splitLayout([1], 1, [2, -3], 2, { focusedGroup: 1 })
  assert.equal(await restore(registry, layout), 1)
  assert.equal(registry.activeTab?.articleId, 1)
  assert.deepEqual(paneArticleIds(registry), [1])
  assert.deepEqual(registry.savedLayout, { ...layout, secondaryActiveArticleId: 0, secondaryTabs: [-3], focusedGroup: 0 })
})

test('malformed multi-group layouts fail before reading content', async () => {
  let reads = 0
  const registry = setup({ load: async id => (reads++, loadedDraft(id)) })
  for (const patch of [
    { tabs: [1], secondaryTabs: [-1] },
    { secondaryTabs: [-2, -3] },
    { tabs: [1], secondaryActiveArticleId: 1 },
    { focusedGroup: 1 as const },
    { tabs: Array.from({ length: 100 }, (_, index) => index + 1), secondaryTabs: [101] },
  ]) assert.equal(await restore(registry, patch), undefined)
  assert.equal(reads, 0)
  assert.deepEqual(registry.tabs, [])
})

test('moving a focused preview appends its exact session, protects both editors and rejects a stale repeat', async () => {
  const registry = setup()
  const layout = splitLayout([1, -2], 2, [3, -4], 4, { focusedGroup: 1 })
  assert.equal(await restore(registry, layout), 0)
  const focused = registry.activeTab!
  const liveEditors = editorSessions(registry)
  const revision = registry.revision
  const moved = registry.moveActiveTab(focused, 'main', revision)
  assert.equal(moved.kind, 'changed')
  expectFields(moved.tab, { articleId: 4, sessionId: focused.sessionId, mode: 'pinned', group: 'main' })
  assert.equal(registry.activeDraft?.revision, 1n)
  assert.deepEqual(registry.savedLayout, splitLayout([1, -2, 4], 4, [3], 0))
  assert.deepEqual(editorSessions(registry), liveEditors)
  assert.equal(registry.sourcePanes[0].selected, false)
  assert.deepEqual(registry.moveActiveTab(focused, 'secondary', revision), { kind: 'stale' })
  assert.deepEqual(registry.moveActiveTab(moved.tab, 'main', registry.revision), { kind: 'unchanged' })

  assert.equal(registry.moveActiveTab(moved.tab, 'secondary', registry.revision).kind, 'changed')
  assert.deepEqual(registry.savedLayout, { ...layout, secondaryTabs: [3, 4] })
  assert.deepEqual(registry.sourcePanes.map(p => [p.tab.sessionId, p.selected]), liveEditors.map(id => [id, true]))
})

test('moving a background tab preserves both selected sessions and rejects old layout or identity', async () => {
  const registry = setup()
  const layout = splitLayout([1, 2], 1, [3, -4], 3)
  assert.equal(await restore(registry, layout), 0)
  const draftToMove = await activate(registry, 2, 'main')
  assert(edit(registry, draftToMove, 'background local source'))
  const focused = await activate(registry, 1, 'main')
  const editors = editorSessions(registry)
  const revision = registry.revision
  assert.equal(registry.canMoveBackgroundTab(byId(registry, 3)), false)
  assert.equal(registry.canMoveBackgroundTab(draftToMove), true)
  const moved = registry.moveBackgroundTab(draftToMove, 'secondary', revision)
  assert.equal(moved.kind, 'changed')
  expectFields(moved.tab, { sessionId: draftToMove.sessionId, group: 'secondary', risk: 'dirty' })
  assert.deepEqual(registry.savedLayout, { ...layout, tabs: [1], secondaryTabs: [3, -4, 2] })
  assert.equal(registry.activeTab?.sessionId, focused.sessionId)
  assert.deepEqual(editorSessions(registry), editors)
  assert.deepEqual(registry.moveBackgroundTab(draftToMove, 'main', revision), { kind: 'stale' })
  expectFields(await activate(registry, 2, 'main'), { group: 'secondary', sessionId: draftToMove.sessionId })
  assert.equal(registry.activeDraft?.body, 'background local source')
  registry.setIdentity(null)
  assert.deepEqual(registry.moveBackgroundTab(draftToMove, 'main', registry.revision), { kind: 'stale' })
})

test('merging groups keeps order and pending server commands on the same focused editor', async () => {
  const pending = Promise.withResolvers<DraftSave<Draft>>()
  const registry = setup({ save: () => pending.promise })
  await restore(registry, splitLayout([1, -2], 2, [-3, 4], 4, { focusedGroup: 1 }))
  const focused = registry.activeTab!
  const liveEditors = editorSessions(registry)
  assert.equal(edit(registry, focused, 'dirty secondary source'), true)
  const save = registry.save(focused)
  const merged = registry.mergeGroups(focused, registry.revision)
  assert.equal(merged.kind, 'changed')
  expectFields(merged.tab, { sessionId: focused.sessionId, group: 'main', risk: 'saving' })
  assert.equal(registry.activeDraft?.body, 'dirty secondary source')
  assert.deepEqual(registry.savedLayout, layoutWith({ tabs: [1, -2, 3, 4], activeArticleId: 4 }))
  assert.deepEqual(editorSessions(registry), liveEditors)
  assert.equal(registry.sourcePanes[0].selected, false)

  pending.resolve(savedDraft(draft(4, 2n, 'dirty secondary source')))
  await expectSaved(save, 4)
  assert.equal((await activate(registry, 2)).sessionId, liveEditors[0])
  assert.deepEqual(editorSessions(registry), liveEditors)
  registry.setIdentity({ ...author, generation: 2n })
  assert.deepEqual(registry.sourcePanes, [])
  assert.deepEqual(registry.mergeGroups(focused, registry.revision), { kind: 'stale' })
})
