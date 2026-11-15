import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  WorkspaceRegistry,
  type DraftLoad,
  type DraftSave,
  type EditorTransport,
  type SavedWorkspaceLayout,
  type WorkspaceGroup,
  type WorkspaceTab,
} from '../../src/Web/src/authoring/workspaceRegistry.ts'

type Draft = { id: number; revision: bigint; body: string }

const draft = (id: number, revision = 1n, body = 'same source'): Draft => ({ id, revision, body })
const author = { site: 'blog', principalId: 'author-id', generation: 1n }
const emptyLayout: SavedWorkspaceLayout = {
  activeArticleId: 0, tabs: [], inspectorOpen: false, secondaryActiveArticleId: 0, secondaryTabs: [], focusedGroup: 0,
}

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

async function activate(registry: WorkspaceRegistry<Draft>, id: number, group?: WorkspaceGroup): Promise<WorkspaceTab> {
  const result = await registry.openOrActivate(id, group)
  assert.equal(result.kind, 'ready')
  return result.tab
}

test('saved layout restores only ready drafts, retaining order, preview and selected article', async () => {
  const held = deferred<DraftLoad<Draft>>()
  const registry = setup({ load: async id => id === 2 ? held.promise : id === 3
    ? { kind: 'blocked', reason: 'forbidden' } : { kind: 'ready', draft: draft(id) } })
  const pending = registry.restoreLayout({ ...emptyLayout, tabs: [1, 3, -2], activeArticleId: 2 }, new AbortController().signal)
  assert.deepEqual(registry.tabs, [])
  held.resolve({ kind: 'ready', draft: draft(2) })
  assert.equal(await pending, 1)
  assert.deepEqual(registry.savedLayout, { ...emptyLayout, tabs: [1, -2], activeArticleId: 2 })
  assert.equal(registry.activeTab?.mode, 'preview')
  assert.equal(registry.activeDraft?.id, 2)
})

test('layout hydration loses authority on identity changes even if its draft request completes', async () => {
  const held = deferred<DraftLoad<Draft>>()
  const registry = setup({ load: () => held.promise })
  const pending = registry.restoreLayout({ ...emptyLayout, tabs: [1], activeArticleId: 1 }, new AbortController().signal)
  registry.setIdentity({ ...author, principalId: 'other-author' })
  held.resolve({ kind: 'ready', draft: draft(1) })
  assert.equal(await pending, undefined)
  assert.deepEqual(registry.savedLayout, emptyLayout)
})

test('the Inspector restores as workspace presentation and rejects another session or identity', async () => {
  const registry = setup()
  await registry.restoreLayout({ ...emptyLayout, tabs: [1, 2], activeArticleId: 2, inspectorOpen: true }, new AbortController().signal)
  assert.equal(registry.inspectorOpen, true)
  const first = registry.tabs.find(tab => tab.articleId === 1)!
  registry.setInspectorOpen(first, false)
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
  const registry = setup({ load: async id => id === 2 ? { kind: 'blocked', reason: 'unavailable' }
    : { kind: 'ready', draft: draft(id) } })
  assert.equal(await registry.restoreLayout({ ...emptyLayout, tabs: [1, -2], activeArticleId: 1 }, new AbortController().signal), undefined)
  assert.deepEqual(registry.tabs, [])
})

test('duplicate entrypoints await one ready receipt and activate the original group', async () => {
  const pending = deferred<DraftLoad<Draft>>()
  let loads = 0
  const registry = setup({ load: () => { loads++; return pending.promise } })
  const rail = registry.openOrActivate(12, 'main')
  const route = registry.openOrActivate(12, 'secondary')
  assert.equal(registry.activeDraft, undefined)
  assert.deepEqual(registry.tabs, [])
  pending.resolve({ kind: 'ready', draft: draft(12) })
  assert.deepEqual(await rail, { kind: 'superseded' })
  const result = await route
  assert.equal(result.kind, 'ready')
  assert.equal(result.tab.group, 'main')
  assert.equal(registry.activeTab?.sessionId, result.tab.sessionId)
  assert.equal(loads, 1)
  assert.equal((await activate(registry, 12, 'secondary')).sessionId, result.tab.sessionId)
  assert.deepEqual(await registry.openOrActivate(13, 'third-group' as WorkspaceGroup), { kind: 'blocked', reason: 'unavailable' })
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

test('extending the current authority retains dirty content and the same retry request', async () => {
  let time = 4
  const requestKeys: string[] = []
  const registry = setup({
    save: async (_, __, key) => {
      requestKeys.push(key)
      return { kind: 'blocked', reason: 'unavailable' }
    },
  }, 100, () => time)
  registry.setIdentity({ ...author, expiresAt: 5 })
  const tab = await activate(registry, 1)
  registry.updateDraft(tab, draft(1, 1n, 'local text'))
  await registry.save(tab)
  registry.updateIdentityExpiry(8)
  time = 6
  assert.equal(registry.activeDraft?.body, 'local text')
  assert.equal(registry.activeTab?.retry, 'save')
  await registry.retry(tab)
  assert.equal(requestKeys.length, 2)
  assert.equal(requestKeys[0], requestKeys[1])
  registry.setIdentity({ ...author, principalId: 'other', expiresAt: 8 })
  assert.deepEqual(registry.tabs, [])
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
  assert.equal((await activate(registry, 1, 'secondary')).group, 'main')
  assert.deepEqual(registry.tabs.filter(tab => tab.active).map(tab => tab.articleId), [1])
})

test('returning to an inactive session rechecks authority without overwriting dirty text', async () => {
  let revision = 1n
  let permission = true
  const registry = setup({
    load: async id => id === 1 && !permission ? { kind: 'blocked', reason: 'forbidden' } :
      { kind: 'ready', draft: draft(id, id === 1 ? revision : 1n, 'server') },
  })
  const one = await activate(registry, 1, 'main')
  registry.updateDraft(one, draft(1, 1n, 'local'))
  const other = await activate(registry, 2)
  revision = 2n
  const reopened = await registry.openOrActivate(1)
  assert.equal(reopened.kind, 'ready')
  assert.equal(reopened.witnessedRevision, 2n)
  assert.equal(registry.activeDraft?.body, 'local')
  assert.equal(registry.activeDraft?.revision, 1n)
  assert.equal(registry.activeTab?.risk, 'conflict')
  const alreadyActive = await registry.openOrActivate(1)
  assert.equal(alreadyActive.kind, 'ready')
  assert.equal(alreadyActive.witnessedRevision, undefined)
  await activate(registry, 2)
  permission = false
  assert.deepEqual(await registry.openOrActivate(1), { kind: 'blocked', reason: 'forbidden' })
  assert.equal(registry.activeTab?.articleId, other.articleId)
  assert.equal(registry.tabs.find(tab => tab.articleId === 1)?.risk, 'blocked')
})

test('a superseded route guard cannot replace the existing preview', async () => {
  const pending = deferred<DraftLoad<Draft>>()
  const registry = setup({ load: async id => id === 2 ? pending.promise : { kind: 'ready', draft: draft(id) } })
  await activate(registry, 1)
  let admissible = true
  const activation = registry.openOrActivate(2, 'main', 'preview', () => admissible)
  admissible = false
  pending.resolve({ kind: 'ready', draft: draft(2) })
  assert.deepEqual(await activation, { kind: 'superseded' })
  assert.deepEqual(registry.tabs.map(tab => tab.articleId), [1])
  assert.equal(registry.activeTab?.articleId, 1)
})

test('idle retains scoped tabs and recently closed entries are bounded and never disclose old titles', async () => {
  const registry = new WorkspaceRegistry({
    load: async id => ({ kind: 'ready', draft: { id, revision: 1n, title: `Private ${id}` } }),
    save: async draft => ({ kind: 'saved', draft }),
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

test('both groups expose exactly their selected sessions while the credentialed focus owns draft writes', async () => {
  const registry = setup()
  const primary = await activate(registry, 1)
  assert.equal(registry.updateDraft(primary, draft(1, 1n, 'unsaved primary')), true)
  const secondary = await activate(registry, 2, 'secondary')
  assert.equal(registry.hasSecondaryGroup, true)
  assert.deepEqual(registry.sourcePanes.map(pane => [pane.tab.sessionId, pane.tab.active, pane.draft.body]), [
    [primary.sessionId, false, 'unsaved primary'], [secondary.sessionId, true, 'same source'],
  ])
  assert.equal(registry.updateDraft(primary, draft(1, 1n, 'incorrect session')), false)
  const original = await activate(registry, 1, 'secondary')
  assert.equal(original.group, 'main')
  assert.equal(original.sessionId, primary.sessionId)
  assert.equal(registry.activeDraft?.body, 'unsaved primary')
  assert.equal(registry.tabs.length, 2)
  assert.equal(registry.requestClose(secondary).kind, 'closed')
  assert.equal(registry.hasSecondaryGroup, false)
  assert.deepEqual(registry.sourcePanes.map(pane => pane.tab.sessionId), [primary.sessionId])
})

test('reexposing the comparison rechecks permission and retains dirty text across revision conflict', async () => {
  let permission = true
  let revision = 1n
  const registry = setup({ load: async id => id !== 1 || permission
    ? { kind: 'ready', draft: draft(id, id === 1 ? revision : 1n) } : { kind: 'blocked', reason: 'forbidden' } })
  const first = await activate(registry, 1)
  registry.updateDraft(first, draft(1, 1n, 'local only'))
  const second = await activate(registry, 2, 'secondary')
  revision++
  const signal = new AbortController().signal
  assert.equal(await registry.recheckComparison(first, signal), true)
  assert.equal(registry.sourcePanes[0].draft.body, 'local only')
  assert.equal(registry.sourcePanes[0].tab.risk, 'conflict')
  assert.equal(registry.activeTab?.sessionId, second.sessionId)
  permission = false
  assert.equal(await registry.recheckComparison(first, signal), false)
  assert.deepEqual(registry.sourcePanes.map(pane => pane.tab.sessionId), [second.sessionId])
  assert.equal(registry.tabs.find(tab => tab.sessionId === first.sessionId)?.risk, 'blocked')
})

test('the comparison cannot restore a response after authority changes', async () => {
  const pending = deferred<DraftLoad<Draft>>()
  let delayed = false
  const registry = setup({ load: async id => delayed && id === 1 ? pending.promise : { kind: 'ready', draft: draft(id) } })
  const first = await activate(registry, 1)
  await activate(registry, 2, 'secondary')
  delayed = true
  const exposed = registry.recheckComparison(first, new AbortController().signal)
  await Promise.resolve()
  registry.setIdentity({ ...author, generation: 2n })
  pending.resolve({ kind: 'ready', draft: draft(1, 2n, 'old identity private text') })
  assert.equal(await exposed, false)
  assert.deepEqual(registry.sourcePanes, [])
  assert.equal(registry.hasSecondaryGroup, false)
})

test('saved groups restore only current authorized drafts in their exact group, selection and order', async () => {
  const registry = setup()
  const layout: SavedWorkspaceLayout = { activeArticleId: 1, tabs: [1, -4], inspectorOpen: true,
    secondaryActiveArticleId: 2, secondaryTabs: [-3, 2], focusedGroup: 1 }
  assert.equal(await registry.restoreLayout(layout, new AbortController().signal), 0)
  assert.deepEqual(registry.savedLayout, layout)
  assert.deepEqual(registry.tabs.map(tab => [tab.articleId, tab.group, tab.active]), [[1, 'main', false], [4, 'main', false],
    [3, 'secondary', false], [2, 'secondary', true]])
  assert.deepEqual(registry.sourcePanes.map(pane => pane.draft.id), [1, 2])
  assert.equal((await activate(registry, 1, 'secondary')).group, 'main')
  assert.deepEqual(registry.savedLayout, { ...layout, focusedGroup: 0 })
})

test('restoring missing selected drafts only falls back to a surviving selected record', async () => {
  const registry = setup({ load: async id => id === 2 ? { kind: 'blocked', reason: 'missing' } : { kind: 'ready', draft: draft(id) } })
  const layout: SavedWorkspaceLayout = { ...emptyLayout, tabs: [1], activeArticleId: 1,
    secondaryActiveArticleId: 2, secondaryTabs: [2, -3], focusedGroup: 1 }
  assert.equal(await registry.restoreLayout(layout, new AbortController().signal), 1)
  assert.equal(registry.activeTab?.articleId, 1)
  assert.deepEqual(registry.sourcePanes.map(pane => pane.draft.id), [1])
  assert.deepEqual(registry.savedLayout, { ...layout, secondaryActiveArticleId: 0, secondaryTabs: [-3], focusedGroup: 0 })
})

test('malformed multi-group layouts fail before reading content', async () => {
  let reads = 0
  const registry = setup({ load: async id => { reads++; return { kind: 'ready', draft: draft(id) } } })
  const malformed = [
    { ...emptyLayout, tabs: [1], secondaryTabs: [-1] },
    { ...emptyLayout, secondaryTabs: [-2, -3] },
    { ...emptyLayout, tabs: [1], secondaryActiveArticleId: 1 },
    { ...emptyLayout, focusedGroup: 1 as const },
    { ...emptyLayout, tabs: Array.from({ length: 100 }, (_, index) => index + 1), secondaryTabs: [101] },
  ]
  for (const layout of malformed)
    assert.equal(await registry.restoreLayout(layout, new AbortController().signal), undefined)
  assert.equal(reads, 0)
  assert.deepEqual(registry.tabs, [])
})

test('moving a focused preview appends its exact session, protects both editors and rejects a stale repeat', async () => {
  const registry = setup()
  const layout: SavedWorkspaceLayout = { ...emptyLayout, tabs: [1, -2], activeArticleId: 2,
    secondaryTabs: [3, -4], secondaryActiveArticleId: 4, focusedGroup: 1 }
  assert.equal(await registry.restoreLayout(layout, new AbortController().signal), 0)
  const focused = registry.activeTab!
  const liveEditors = registry.sourcePanes.map(pane => pane.tab.sessionId)
  const revision = registry.revision
  const moved = registry.moveActiveTab(focused, 'main', revision)
  assert.equal(moved.kind, 'changed')
  assert.deepEqual([moved.tab.articleId, moved.tab.sessionId, moved.tab.mode, moved.tab.group], [4, focused.sessionId, 'pinned', 'main'])
  assert.equal(registry.activeDraft?.revision, 1n)
  assert.deepEqual(registry.savedLayout, { ...layout, tabs: [1, -2, 4], activeArticleId: 4,
    secondaryTabs: [3], secondaryActiveArticleId: 0, focusedGroup: 0 })
  assert.deepEqual(registry.sourcePanes.map(pane => pane.tab.sessionId), liveEditors)
  assert.equal(registry.sourcePanes[0].selected, false)
  assert.deepEqual(registry.moveActiveTab(focused, 'secondary', revision), { kind: 'stale' })
  assert.deepEqual(registry.moveActiveTab(moved.tab, 'main', registry.revision), { kind: 'unchanged' })

  assert.equal(registry.moveActiveTab(moved.tab, 'secondary', registry.revision).kind, 'changed')
  assert.deepEqual(registry.savedLayout, { ...layout, secondaryTabs: [3, 4] })
  assert.deepEqual(registry.sourcePanes.map(pane => [pane.tab.sessionId, pane.selected]), liveEditors.map(sessionId => [sessionId, true]))
})

test('merging groups keeps order and pending server commands on the same focused editor', async () => {
  const pending = deferred<DraftSave<Draft>>()
  const registry = setup({ save: () => pending.promise })
  const layout: SavedWorkspaceLayout = { ...emptyLayout, tabs: [1, -2], activeArticleId: 2,
    secondaryTabs: [-3, 4], secondaryActiveArticleId: 4, focusedGroup: 1 }
  await registry.restoreLayout(layout, new AbortController().signal)
  const focused = registry.activeTab!
  const liveEditors = registry.sourcePanes.map(pane => pane.tab.sessionId)
  assert.equal(registry.updateDraft(focused, draft(4, 1n, 'dirty secondary source')), true)
  const save = registry.save(focused)
  const merged = registry.mergeGroups(focused, registry.revision)
  assert.equal(merged.kind, 'changed')
  assert.equal(merged.tab.sessionId, focused.sessionId)
  assert.equal(merged.tab.group, 'main')
  assert.equal(merged.tab.risk, 'saving')
  assert.equal(registry.activeDraft?.body, 'dirty secondary source')
  assert.deepEqual(registry.savedLayout, { ...emptyLayout, tabs: [1, -2, 3, 4], activeArticleId: 4 })
  assert.deepEqual(registry.sourcePanes.map(pane => pane.tab.sessionId), liveEditors)
  assert.equal(registry.sourcePanes[0].selected, false)

  pending.resolve({ kind: 'saved', draft: draft(4, 2n, 'dirty secondary source') })
  assert.deepEqual(await save, { kind: 'saved', articleId: 4, revision: 2n })
  const previousSelection = await activate(registry, 2)
  assert.equal(previousSelection.sessionId, liveEditors[0])
  assert.deepEqual(registry.sourcePanes.map(pane => pane.tab.sessionId), liveEditors)
  registry.setIdentity({ ...author, generation: 2n })
  assert.deepEqual(registry.sourcePanes, [])
  assert.deepEqual(registry.mergeGroups(focused, registry.revision), { kind: 'stale' })
})
