import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import MarkdownEditor from '../src/markdown-editor.vue'
import { useMarkdownHeavyFeatureDocumentContext } from '../../../hooks/use-markdown-heavy-feature-lifecycle'
import { createMarkdownOutlineModel } from '../src/markdown-editor-outline'
import { createMarkdownEditorSessionBinding } from '../src/markdown-editor-session'
import { captureMarkdownEditorSessionAttachmentState } from '../src/markdown-editor-session-attachment-state'
import { createMarkdownAttachmentJob, runMarkdownAttachmentDispatch } from '../src/markdown-editor-attachment-lifecycle'
import { MarkdownEditorTransactionStore } from '../src/markdown-editor-transaction'
import {
  defaultMarkdownEditorCommands,
  markdownEditorEmits,
  markdownLiveCapabilities,
  resolveMarkdownLiveCapability,
  runMarkdownEditorCommand,
} from '../src/markdown-editor'
import type {
  MarkdownAttachmentProviderResult,
  MarkdownEditorAttachmentDispatch,
  MarkdownEditorCommand,
  MarkdownEditorInstance,
  MarkdownEditorProps,
  MarkdownEditorSelection,
  MarkdownEditorTransactionEvent,
} from '../src/markdown-editor'
import { getMarkdownXssSourceUrl } from '../../../../tests/support/markdown-xss-corpus'

describe('MarkdownEditor', () => {
  it('completes actual mounted undo model synchronization without a nested retirement callback', async () => {
    let authority: NonNullable<ReturnType<typeof useMarkdownHeavyFeatureDocumentContext>>['documentAuthority']
    const Probe = defineComponent({ setup() {
      authority = useMarkdownHeavyFeatureDocumentContext()?.documentAuthority
      return () => null
    } })
    const wrapper = mount(MarkdownEditor, { props: {
      modelValue: 'source', mode: 'source', statusDensity: 'minimal', documentIdentity: { id: 'nested-notification', epoch: 1 },
    }, slots: { status: () => h(Probe) } })
    await flushPromises()
    const vm = wrapper.vm as MarkdownEditorInstance
    expect(vm.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'seed ' }], history: 'separate', origin: 'programmatic' }).accepted).toBe(true)
    await nextTick()
    let calls = 0
    const cause = { tag: 'nested-notification-must-not-run' }
    const handle = authority!.subscribeRetirement(() => { if (++calls === 2) throw cause })
    expect(vm.undo().accepted).toBe(true)
    expect(calls).toBe(1)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['source'])
    expect(handle.hasCustody()).toBe(true)
    // Remove this ordinary control before actual unmount can trigger its next legitimate outer notification.
    let caught: unknown
    try { handle.unsubscribe() } catch (error) { caught = error }
    expect(caught).toBe(cause)
    expect(handle.hasCustody()).toBe(true)
    handle.unsubscribe()
    wrapper.unmount()
  })

  it('attempts original late unmount cleanup after receiver failure and retains its original cause/custody', async () => {
    let authority: NonNullable<ReturnType<typeof useMarkdownHeavyFeatureDocumentContext>>['documentAuthority']
    const Probe = defineComponent({ setup() {
      authority = useMarkdownHeavyFeatureDocumentContext()?.documentAuthority
      return () => null
    } })
    const errors: unknown[] = []
    const wrapper = mount(MarkdownEditor, { props: {
      modelValue: 'source', mode: 'source', statusDensity: 'minimal', documentIdentity: { id: 'cleanup-after-retirement-failure', epoch: 1 },
    }, slots: { status: () => h(Probe) }, global: { config: { errorHandler: error => { errors.push(error) } } } })
    await flushPromises()
    const cause = { tag: 'original-retirement-failure' }
    let fail = true
    const handle = authority!.subscribeRetirement(() => { if (fail) throw cause })
    const removals = vi.spyOn(window, 'removeEventListener')
    const release = vi.spyOn(MarkdownEditorTransactionStore.prototype, 'releaseRetainedSnapshot')
    try {
      wrapper.unmount()
      expect(errors).toContain(cause)
      expect(release).toHaveBeenCalled()
      expect(removals.mock.calls.some(([event]) => event === 'resize')).toBe(true)
      expect(handle.hasCustody()).toBe(true)
      expect(handle.failureCause()).toBe(cause)
      expect(authority!.capture()).toBeNull()
      fail = false
      expect(handle.unsubscribe()).toBe(true)
      expect(handle.hasCustody()).toBe(false)
      expect(authority!.capture()).toBeNull()
    } finally {
      removals.mockRestore()
      release.mockRestore()
    }
  })

  it('seals original native publication and checks/publishes without any external owner reader', () => {
    const identity = { id: 'sealed-native-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    let forbidReaders = false
    const read = () => { if (forbidReaders) throw new Error('publication-called-external-owner'); return false }
    const binding = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: read, isDisposed: read,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => { read(); return null },
    })
    const session = binding.getSession('session:sealed-native')
    const expected = { documentIdentity: identity, revision: 0 }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const preparation = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    const publication = session.sealPreparedSnapshot(preparation)
    expect(() => session.sealPreparedSnapshot(preparation)).toThrow('editor-session-snapshot-already-sealed')
    expect(session.hasSealedSnapshotCustody({ ...publication })).toBe(false)
    forbidReaders = true
    expect(session.hasSealedSnapshotCustody(publication)).toBe(true)
    expect(session.publishSealedSnapshot(publication)).toBe(preparation.snapshot)
    expect(session.hasSealedSnapshotCustody(publication)).toBe(false)
    expect(session.publishSealedSnapshot(publication)).toBeNull()
    forbidReaders = false
    expect(session.validateRetainedSnapshot(original, expected)).toBe(false)
    expect(session.validateRetainedSnapshot(preparation.snapshot, expected)).toBe(true)
  })

  it('retires a sealed native ticket on genuine private invalidation/cancel/lifetime events and preserves old refs', () => {
    const identity = { id: 'sealed-retirement-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    const binding = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    })
    const session = binding.getSession('session:sealed-retirement')
    const expected = { documentIdentity: identity, revision: 0 }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const preparation = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    const publication = session.sealPreparedSnapshot(preparation)
    binding.invalidatePublicationAuthority()
    expect(session.hasSealedSnapshotCustody(publication)).toBe(false)
    expect(session.publishSealedSnapshot(publication)).toBeNull()
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    expect(() => session.sealPreparedSnapshot(preparation)).toThrow('editor-session-publication-authority-retired')
    const cancelled = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    const cancelledPublication = session.sealPreparedSnapshot(cancelled)
    expect(session.discardPreparedSnapshot(cancelled)).toBe(true)
    expect(session.publishSealedSnapshot(cancelledPublication)).toBeNull()
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    const retired = session.prepareSnapshot(() => 'd'.repeat(64), expected)
    const retiredPublication = session.sealPreparedSnapshot(retired)
    binding.retirePublicationAuthority()
    expect(session.hasSealedSnapshotCustody(retiredPublication)).toBe(false)
    expect(session.publishSealedSnapshot(retiredPublication)).toBeNull()
    expect(session.discardPreparedSnapshot(retired)).toBe(true)
    expect(() => session.inspectDocumentState()).toThrow('editor-session-disposed')
  })

  it('invalidates actual mounted native publication synchronously on readonly transition and original unmount', async () => {
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '# Sealed original', documentIdentity: { id: 'sealed-mounted-document', epoch: 1 },
    } })
    await flushPromises()
    await nextTick()
    const session = (wrapper.vm as MarkdownEditorInstance).getSession('session:sealed-mounted')
    const original = session.captureSnapshot(() => 'a'.repeat(64))
    const expected = { documentIdentity: original.documentIdentity, revision: original.revision }
    const preparation = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    const publication = session.sealPreparedSnapshot(preparation)
    await wrapper.setProps({ readonly: true })
    expect(session.hasSealedSnapshotCustody(publication)).toBe(false)
    expect(session.publishSealedSnapshot(publication)).toBeNull()
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    expect(session.discardPreparedSnapshot(preparation)).toBe(true)
    await flushPromises()
    const closing = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    const closingPublication = session.sealPreparedSnapshot(closing)
    wrapper.unmount()
    expect(session.hasSealedSnapshotCustody(closingPublication)).toBe(false)
    expect(session.publishSealedSnapshot(closingPublication)).toBeNull()
    expect(session.discardPreparedSnapshot(closing)).toBe(false)
  })

  it('prepares and atomically commits actual native refs without replacing the previous token during preparation', () => {
    const identity = { id: 'prepared-native-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('original source', undefined, identity)
    store.dispatch({ changes: [{ from: 0, to: 0, insert: 'actual ' }], history: 'separate', origin: 'programmatic' })
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-native')
    const expected = { documentIdentity: identity, revision: store.revision }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const before = { history: store.history, selection: store.selection, value: store.value, revision: store.revision }
    const preparation = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    expect(session.validateRetainedSnapshot(preparation.snapshot, expected)).toBe(false)
    expect(() => session.captureSnapshot(() => 'c'.repeat(64), expected)).toThrow('editor-session-snapshot-preparation-pending')
    expect(() => session.commitPreparedSnapshot({ snapshot: preparation.snapshot })).toThrow('editor-session-snapshot-preparation-invalid')
    expect(session.discardPreparedSnapshot({ snapshot: preparation.snapshot })).toBe(false)
    const foreignStore = new MarkdownEditorTransactionStore(store.value, undefined, identity)
    const foreign = createMarkdownEditorSessionBinding({
      transactionStore: foreignStore, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-foreign')
    const foreignPreparation = foreign.prepareSnapshot(() => 'b'.repeat(64))
    expect(() => session.commitPreparedSnapshot(foreignPreparation)).toThrow('editor-session-snapshot-preparation-invalid')
    expect(session.discardPreparedSnapshot(foreignPreparation)).toBe(false)
    expect(foreign.discardPreparedSnapshot(foreignPreparation)).toBe(true)
    const committed = session.commitPreparedSnapshot(preparation)
    expect(committed).toBe(preparation.snapshot)
    expect(session.validateRetainedSnapshot(original, expected)).toBe(false)
    expect(session.validateRetainedSnapshot(committed, expected)).toBe(true)
    expect(committed.historyRef).toBe(`${committed.snapshotRef}:history`)
    expect(committed.selectionRef).toBe(`${committed.snapshotRef}:selection`)
    expect(committed.viewStateRef).toBe(`${committed.snapshotRef}:view`)
    expect({ history: store.history, selection: store.selection, value: store.value, revision: store.revision }).toEqual(before)
    expect(() => session.commitPreparedSnapshot(preparation)).toThrow('editor-session-snapshot-preparation-invalid')
    expect(session.discardPreparedSnapshot(preparation)).toBe(false)
  })

  it('preserves actual prior native token through preparation callback failure, commit admission failure and cancellation', () => {
    const identity = { id: 'prepared-failure-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    let failView = false
    let admitted = true
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => { if (failView) throw new Error('actual-view-failed'); return null }, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-failure')
    const expected = { documentIdentity: identity, revision: 0, assertAdmission: () => { if (!admitted) throw new Error('actual-admission-retired') } }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    failView = true
    expect(() => session.prepareSnapshot(() => 'b'.repeat(64), expected)).toThrow('actual-view-failed')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    failView = false
    const refused = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    admitted = false
    expect(() => session.commitPreparedSnapshot(refused)).toThrow('actual-admission-retired')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    admitted = true
    const cancelled = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    expect(session.discardPreparedSnapshot(cancelled)).toBe(true)
    expect(session.discardPreparedSnapshot(cancelled)).toBe(false)
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    expect(() => session.commitPreparedSnapshot(cancelled)).toThrow('editor-session-snapshot-preparation-invalid')
    expect(session.captureSnapshot(() => 'd'.repeat(64), expected).editorContentDigest).toBe('d'.repeat(64))
  })

  it('keeps native allocation failure and cancellation reentry before publication without losing original refs', () => {
    const identity = { id: 'prepared-unwind-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-unwind')
    const expected = { documentIdentity: identity, revision: 0 }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const allocation = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    const copy = vi.spyOn(Array.prototype, 'slice').mockImplementationOnce(() => { throw new Error('actual-retained-allocation-failed') })
    try {
      expect(() => session.commitPreparedSnapshot(allocation)).toThrow('actual-retained-allocation-failed')
    } finally { copy.mockRestore() }
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    const cancelled = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    expect(() => session.commitPreparedSnapshot(cancelled, () => { session.discardPreparedSnapshot(cancelled) }))
      .toThrow('editor-session-snapshot-preparation-stale')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    const reentrant = session.prepareSnapshot(() => 'd'.repeat(64), expected)
    expect(() => session.commitPreparedSnapshot(reentrant, () => { session.captureSnapshot(() => 'e'.repeat(64)) }))
      .toThrow('editor-session-snapshot-reentrant')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
  })

  it('revalidates full native admission and lifetime after allocation reentry that returns real arrays', () => {
    const identity = { id: 'prepared-allocation-admission-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    let admitted = true
    let disposed = false
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => disposed,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-allocation-admission')
    const expected = { documentIdentity: identity, revision: 0, assertAdmission: () => { if (!admitted) throw new Error('actual-allocation-retired') } }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const nativeBefore = { value: store.value, revision: store.revision, selection: store.selection, history: store.history }
    const intrinsicSlice = Array.prototype.slice
    const candidate = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    const retirement = vi.spyOn(Array.prototype, 'slice').mockImplementationOnce(function (this: unknown[]) {
      admitted = false
      return intrinsicSlice.call(this)
    })
    try {
      expect(() => session.commitPreparedSnapshot(candidate)).toThrow('actual-allocation-retired')
    } finally { retirement.mockRestore() }
    expect({ value: store.value, revision: store.revision, selection: store.selection, history: store.history }).toEqual(nativeBefore)
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    admitted = true
    const lifetime = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    const disposal = vi.spyOn(Array.prototype, 'slice').mockImplementationOnce(function (this: unknown[]) {
      disposed = true
      return intrinsicSlice.call(this)
    })
    try {
      expect(() => session.commitPreparedSnapshot(lifetime)).toThrow('editor-session-disposed')
    } finally { disposal.mockRestore() }
    disposed = false
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    const next = session.prepareSnapshot(() => 'd'.repeat(64), expected)
    expect(session.commitPreparedSnapshot(next)).toBe(next.snapshot)
  })

  it('refuses changed original selection and released ABA history custody without restoring a staged token', () => {
    const identity = { id: 'prepared-stale-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-stale')
    const expected = { documentIdentity: identity, revision: 0 }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const selection = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    store.setSelection({ start: 1, end: 1, direction: 'none' })
    const newerSelection = store.selection
    expect(() => session.commitPreparedSnapshot(selection)).toThrow('editor-session-snapshot-preparation-stale')
    expect(store.selection).toEqual(newerSelection)
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    const aba = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    store.switchDocument({ id: 'other-prepared-document', epoch: 2 }, 'other source')
    store.switchDocument(identity, 'source')
    expect(() => session.commitPreparedSnapshot(aba)).toThrow('editor-session-snapshot-preparation-stale')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(false)
    expect(store.history).toEqual(expect.objectContaining({ undoDepth: 0, redoDepth: 0 }))
  })

  it('cancels a genuine prepared native candidate after disposal and refuses composition admission', () => {
    const identity = { id: 'prepared-lifetime-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    let disposed = false
    let composing = false
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => composing, isDisposed: () => disposed,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:prepared-lifetime')
    const expected = { documentIdentity: identity, revision: 0 }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const composition = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    composing = true
    expect(() => session.commitPreparedSnapshot(composition)).toThrow('editor-session-composition-active')
    composing = false
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    const retired = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    disposed = true
    expect(session.discardPreparedSnapshot(retired)).toBe(true)
    expect(session.discardPreparedSnapshot(retired)).toBe(false)
    expect(() => session.commitPreparedSnapshot(retired)).toThrow('editor-session-snapshot-preparation-invalid')
    expect(() => session.inspectDocumentState()).toThrow('editor-session-disposed')
  })

  it('fences actual mounted openSearch work before committing prepared native panel refs', async () => {
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '# Original prepared panel', documentIdentity: { id: 'prepared-panel-document', epoch: 1 },
    } })
    await flushPromises()
    await nextTick()
    const editor = wrapper.vm as MarkdownEditorInstance
    const session = editor.getSession('session:prepared-panel')
    const original = session.captureSnapshot(() => 'a'.repeat(64))
    const expected = { documentIdentity: original.documentIdentity, revision: original.revision }
    const prepared = session.prepareSnapshot(() => 'b'.repeat(64), expected)
    expect(prepared.snapshot.panelRefs).not.toBeNull()
    expect(() => session.commitPreparedSnapshot(prepared, () => editor.openSearch())).toThrow('editor-session-panel-owner-stale')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    await nextTick()
    await flushPromises()
    const next = session.prepareSnapshot(() => 'c'.repeat(64), expected)
    expect(session.commitPreparedSnapshot(next)).toBe(next.snapshot)
    expect(session.readPanelState(next.snapshot)?.search).not.toBeNull()
    wrapper.unmount()
  })

  it('reads actual native content digest without replacing retained history and fences admission and reentrant capture', () => {
    const identity = { id: 'digest-source-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('original source', undefined, identity)
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    }).getSession('session:content-digest')
    const expected = { documentIdentity: identity, revision: 0 }
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64), expected)
    const before = { history: store.history, selection: store.selection, value: store.value }
    expect(session.inspectContentDigest((source) => { expect(source).toBe('original source'); return 'b'.repeat(64) }, expected))
      .toEqual({ documentIdentity: identity, revision: 0, editorContentDigest: 'b'.repeat(64) })
    expect({ history: store.history, selection: store.selection, value: store.value }).toEqual(before)
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
    expect(() => session.inspectContentDigest(() => { session.captureSnapshot(() => 'c'.repeat(64)); return 'b'.repeat(64) }, expected))
      .toThrow('editor-session-snapshot-reentrant')
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
    let admitted = true
    expect(() => session.inspectContentDigest(() => { admitted = false; return 'b'.repeat(64) }, {
      ...expected, assertAdmission: () => { if (!admitted) throw new Error('actual-owner-retired') },
    })).toThrow('actual-owner-retired')
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
  })

  it('rejects non-string native digests and session refs without invoking conversion callbacks', () => {
    const identity = { id: 'digest-conversion-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('original source', undefined, identity)
    const binding = createMarkdownEditorSessionBinding({
      transactionStore: store, isComposing: () => false, isDisposed: () => false,
      captureViewState: () => null, restoreViewState: () => {},
      resourceParticipants: () => [], captureLastValidRender: () => null,
    })
    const session = binding.getSession('session:digest-conversion')
    const expected = { documentIdentity: identity, revision: 0 }
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64), expected)
    let conversions = 0
    const hostile = { toString() {
      conversions += 1
      store.dispatch({ changes: [{ from: 0, to: 0, insert: 'changed ' }], history: 'separate', origin: 'programmatic' })
      return 'b'.repeat(64)
    } }
    const invalidDigest = (() => hostile) as unknown as (source: string) => string
    expect(() => session.inspectContentDigest(invalidDigest, expected)).toThrow('editor-session-content-digest-invalid')
    expect(() => session.captureSnapshot(invalidDigest, expected)).toThrow('editor-session-content-digest-invalid')
    expect(() => binding.getSession(hostile as unknown as string)).toThrow('editor-session-ref-invalid')
    expect(conversions).toBe(0)
    expect(store.value).toBe('original source')
    expect(store.revision).toBe(0)
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
  })

  it('retains only original settled attachment state and invalidates phase, signal and removal changes', async () => {
    const controller = new AbortController()
    const job = createMarkdownAttachmentJob('panel-item', {
      documentIdentity: { id: 'panel-document', epoch: 1 }, revision: 0, signalController: controller,
    })
    let jobs = [job]
    let finish!: (result: MarkdownAttachmentProviderResult) => void
    const future = new Promise<MarkdownAttachmentProviderResult>((resolve) => { finish = resolve })
    const pending = runMarkdownAttachmentDispatch(job, () => future)
    expect(captureMarkdownEditorSessionAttachmentState(() => jobs, () => {})).toBeNull()
    finish({ status: 'cancelled', batchId: 'panel-batch', itemId: 'panel-item',
      documentIdentity: { id: 'panel-document', epoch: 1 }, revision: 0 })
    await pending
    job.phase = 'cancelled'
    const captured = captureMarkdownEditorSessionAttachmentState(() => jobs, () => {})!
    expect(captured.isCurrent()).toBe(true)
    expect(Object.isFrozen(captured.state)).toBe(true)
    expect(Object.isFrozen(captured.state[0])).toBe(true)
    job.progress = 1
    expect(captured.state[0]!.progress).toBe(0)
    expect(captured.isCurrent()).toBe(false)
    job.progress = 0
    job.attempt += 1
    expect(captureMarkdownEditorSessionAttachmentState(() => jobs, () => {})).toBeNull()
    job.attempt -= 1
    controller.abort()
    expect(captured.isCurrent()).toBe(false)
    jobs = []
    expect(captured.isCurrent()).toBe(false)
    const legacy = createMarkdownAttachmentJob('legacy', { documentIdentity: { id: 'panel-document', epoch: 1 }, revision: 0 })
    legacy.phase = 'cancelled'
    expect(captureMarkdownEditorSessionAttachmentState(() => [legacy], () => {})).toBeNull()
  })

  it('refuses final admission openSearch continuations before native panel retain or restore', async () => {
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '# Original panel', documentIdentity: { id: 'panel-admission-document', epoch: 1 },
    } })
    await flushPromises()
    await nextTick()
    const editor = wrapper.vm as MarkdownEditorInstance
    const session = editor.getSession('session:panel-admission')
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64))
    expect(snapshot.panelRefs).not.toBeNull()
    const expected = { documentIdentity: snapshot.documentIdentity, revision: snapshot.revision }
    editor.dispatchTransaction({ changes: [], selection: { start: 0, end: 0, direction: 'none' }, history: 'skip', origin: 'programmatic' })
    await nextTick()
    await flushPromises()
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    const selection = { start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection }
    const proof = session.restoreSnapshot(snapshot, { ...expected, assertAdmission: () => editor.openSearch() })
    expect(proof.reason).toBe('editor-session-panel-owner-stale')
    expect({ start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection }).toEqual(selection)
    expect(editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic' }).selection).toEqual({ start: 0, end: 0, direction: 'none' })
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
    await nextTick()
    await flushPromises()
    let calls = 0
    expect(() => session.captureSnapshot(() => 'b'.repeat(64), {
      ...expected, assertAdmission: () => { if (++calls === 3) editor.openSearch() },
    })).toThrow('editor-session-panel-owner-stale')
    expect(calls).toBe(3)
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
    wrapper.unmount()
  })

  it('checks actual consumer admission after view capture and before replacing or restoring original custody', () => {
    const identity = { id: 'admission-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('source', undefined, identity)
    let active = true
    let retireDuringView = false
    let viewRestores = 0
    const session = createMarkdownEditorSessionBinding({
      transactionStore: store,
      isComposing: () => false,
      isDisposed: () => false,
      captureViewState: () => { if (retireDuringView) active = false; return null },
      restoreViewState: () => { viewRestores += 1 },
      resourceParticipants: () => [],
      captureLastValidRender: () => null,
    }).getSession('session:admission')
    const assertAdmission = () => { if (!active) throw new Error('actual-consumer-retired') }
    const expected = { documentIdentity: identity, revision: 0, assertAdmission }
    const original = session.captureSnapshot(() => 'a'.repeat(64), expected)
    retireDuringView = true
    expect(() => session.captureSnapshot(() => 'b'.repeat(64), expected)).toThrow('actual-consumer-retired')
    expect(session.validateRetainedSnapshot(original, expected)).toBe(true)
    store.setSelection({ start: 1, end: 1, direction: 'none' })
    const before = { history: store.history, selection: store.selection, source: store.value }
    expect(() => session.restoreSnapshot(original, expected)).toThrow('actual-consumer-retired')
    expect({ history: store.history, selection: store.selection, source: store.value }).toEqual(before)
    expect(viewRestores).toBe(0)
    active = true
    retireDuringView = false
    expect(session.restoreSnapshot(original, {
      ...expected,
      assertAdmission: () => { session.captureSnapshot(() => 'c'.repeat(64)) },
    }).reason).toBe('editor-session-snapshot-custody-invalid')
    expect({ history: store.history, selection: store.selection, source: store.value }).toEqual(before)
    expect(viewRestores).toBe(0)
  })

  it('rejects old outer custody after the original transaction store switches away and back to identical coordinates', () => {
    const identity = { id: 'aba-document', epoch: 1 }
    const store = new MarkdownEditorTransactionStore('same source', undefined, identity)
    const binding = createMarkdownEditorSessionBinding({
      transactionStore: store,
      isComposing: () => false,
      isDisposed: () => false,
      captureViewState: () => null,
      restoreViewState: () => {},
      resourceParticipants: () => [],
      captureLastValidRender: () => null,
    })
    const session = binding.getSession('session:aba')
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64))
    const expected = { documentIdentity: identity, revision: 0 }
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
    store.switchDocument({ id: 'other-document', epoch: 2 }, 'other source')
    store.switchDocument(identity, 'same source')
    expect(session.inspectDocumentState()).toEqual({ documentIdentity: identity, revision: 0 })
    const before = { history: store.history, selection: store.selection, source: store.value }
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(false)
    expect({ history: store.history, selection: store.selection, source: store.value }).toEqual(before)
    expect(session.restoreSnapshot(snapshot, expected).reason).toBe('editor-session-history-checkpoint-invalid')
    const originalToken = store.retainSnapshot()
    expect(store.validateRetainedSnapshot(originalToken)).toBe(true)
    expect(store.validateRetainedSnapshot({ ...originalToken })).toBe(false)
    store.releaseRetainedSnapshot()
    expect(store.validateRetainedSnapshot(originalToken)).toBe(false)
  })

  it.each(['renderer', 'attachment'] as const)('rejects %s source observation after same-source document epoch drift', (sourceOwner) => {
    const store = new MarkdownEditorTransactionStore('same source', undefined, { id: 'source-document', epoch: 1 })
    const binding = createMarkdownEditorSessionBinding({
      transactionStore: store,
      isComposing: () => false,
      isDisposed: () => false,
      captureViewState: () => null,
      restoreViewState: () => {},
      resourceParticipants: () => [],
      captureLastValidRender: () => null,
      [sourceOwner === 'renderer' ? 'inspectRendererResourceSource' : 'inspectAttachmentResourceSource']: () => {
        store.switchDocument({ id: 'source-document', epoch: 2 }, 'same source')
        return null
      },
    })
    const session = binding.getSession('session:resource-source')
    expect(() => sourceOwner === 'renderer' ? session.inspectRendererResourceSource() : session.inspectAttachmentResourceSource()).toThrow(`editor-session-${sourceOwner}-resource-source-stale`)
    expect(session.inspectDocumentState().documentIdentity.epoch).toBe(2)
    expect(() => session.inspectResources()).toThrow('editor-session-resource-owner-unavailable')
  })

  it('retains the actual public session and sole-owner history and rejects snapshot copies', () => {
    const wrapper = mount(MarkdownEditor, { props: {
      modelValue: 'first', documentIdentity: { id: 'session-document', epoch: 1 },
    } })
    const editor = wrapper.vm as MarkdownEditorInstance
    editor.dispatchTransaction({
      changes: [{ from: 5, to: 5, insert: ' second' }], history: 'separate', origin: 'programmatic',
    })
    const session = editor.getSession('session:article:one')
    expect(editor.getSession('session:article:one')).toBe(session)
    expect(() => editor.getSession('session:article:two')).toThrow('editor-session-owner-already-bound')
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64))
    expect(snapshot.history.undoDepth).toBe(1)
    expect(snapshot.lastValidRender).toBeNull()
    expect(session.captureLastValidRender()).toBeNull()
    expect(snapshot).not.toHaveProperty('value')
    const expected = { documentIdentity: snapshot.documentIdentity, revision: snapshot.revision }
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(true)
    expect(session.validateRetainedSnapshot({ ...snapshot }, expected)).toBe(false)
    const foreign = mount(MarkdownEditor, { props: { modelValue: 'first', documentIdentity: snapshot.documentIdentity } })
    foreign.vm.dispatchTransaction({
      changes: [{ from: 5, to: 5, insert: ' second' }], history: 'separate', origin: 'programmatic',
    })
    const foreignSession = foreign.vm.getSession(session.editorSessionRef)
    const foreignSnapshot = foreignSession.captureSnapshot(() => 'a'.repeat(64))
    expect(foreignSnapshot.snapshotRef).toBe(snapshot.snapshotRef)
    expect(foreignSnapshot.revision).toBe(snapshot.revision)
    expect(session.validateRetainedSnapshot(foreignSnapshot, expected)).toBe(false)
    expect(session.validateRetainedSnapshot(snapshot, { ...expected, revision: snapshot.revision + 1 })).toBe(false)
    expect(session.validateRetainedSnapshot(snapshot, {
      ...expected, documentIdentity: { ...snapshot.documentIdentity, epoch: snapshot.documentIdentity.epoch + 1 },
    })).toBe(false)
    foreign.unmount()
    expect(session.restoreSnapshot({ ...snapshot }, expected).status).toBe('blocked')
    expect(session.restoreSnapshot(snapshot, expected).status).toBe('restored')
    expect(editor.undo().value).toBe('first')
    expect(session.restoreSnapshot(snapshot, expected).reason).toBe('editor-session-revision-mismatch')
    expect(session.validateRetainedSnapshot(snapshot, expected)).toBe(false)
    wrapper.unmount()
  })

  it('keeps the retained snapshot after failed capture and missing resource disposal', () => {
    const wrapper = mount(MarkdownEditor, { props: {
      modelValue: 'retained', documentIdentity: { id: 'retained-document', epoch: 1 },
    } })
    const session = (wrapper.vm as MarkdownEditorInstance).getSession('session:retained')
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64))
    expect(() => session.captureSnapshot(() => 'invalid')).toThrow('editor-session-content-digest-invalid')
    const digest = vi.fn(() => 'a'.repeat(64))
    expect(() => session.captureSnapshot(digest, {
      documentIdentity: { id: 'other-document', epoch: 1 }, revision: snapshot.revision,
    })).toThrow('editor-session-snapshot-context-mismatch')
    expect(digest).not.toHaveBeenCalled()
    expect(() => session.captureSnapshot(digest, {
      documentIdentity: snapshot.documentIdentity, revision: snapshot.revision + 1,
    })).toThrow('editor-session-snapshot-context-mismatch')
    expect(digest).not.toHaveBeenCalled()
    const census = session.inspectResourceParticipants()
    expect(census.complete).toBe(false)
    expect(census.missingOwners).toContain('renderer-projection')
    expect(census.missingOwners).toContain('editor-surface')
    expect(census.participants.some((owner) => owner.ownerRef === 'editor-layout-callbacks')).toBe(true)
    expect(census.participants.some((owner) => owner.ownerRef === 'language-search')).toBe(true)
    expect(census.missingOwners).toContain('attachment-embed')
    expect(() => session.pauseResources()).toThrow('editor-session-resource-owner-unavailable')
    expect(session.inspectResourceParticipants().participants.every((owner) => !owner.paused)).toBe(true)
    expect(() => session.disposeAfterSnapshot(snapshot.snapshotRef)).toThrow('editor-session-resource-owner-unavailable')
    expect(session.restoreSnapshot(snapshot, { documentIdentity: snapshot.documentIdentity, revision: snapshot.revision }).status).toBe('restored')
    wrapper.unmount()
    expect(() => session.captureSnapshot(() => 'a'.repeat(64))).toThrow('editor-session-disposed')
  })

  it('rejects public session capture during IME and snapshots from an old document epoch', async () => {
    const wrapper = mount(MarkdownEditor, { props: {
      modelValue: 'same source', documentIdentity: { id: 'article-one', epoch: 1 },
    } })
    const session = (wrapper.vm as MarkdownEditorInstance).getSession('session:epoch')
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64))
    await wrapper.find('textarea').trigger('compositionstart')
    expect(() => session.captureSnapshot(() => 'a'.repeat(64))).toThrow('editor-session-composition-active')
    await wrapper.find('textarea').trigger('compositionend')
    await wrapper.setProps({ documentIdentity: { id: 'article-two', epoch: 2 } })
    expect(session.restoreSnapshot(snapshot, { documentIdentity: { id: 'article-two', epoch: 2 }, revision: 0 }).status).toBe('blocked')
    wrapper.unmount()
  })

  // Synthetic composition events in this suite are not native-IME evidence.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not expose the removed raw HTML preview prop', () => {
    const removedCapability = `allow${'Html'}` as const
    expectTypeOf<MarkdownEditorProps>().not.toHaveProperty(removedCapability)
  })

  it('requires an attachment batch for every upload-image emission', () => {
    expect(markdownEditorEmits['upload-image'].length).toBe(1)
  })

  it('runs built-in selection commands through the public context contract', async () => {
    const bold = defaultMarkdownEditorCommands.find(
      (item) => item.key === 'bold',
    )
    if (!bold) throw new Error('missing bold command')

    await expect(
      runMarkdownEditorCommand(bold, {
        dispatch: {
          dispatch: () => {
            throw new Error('not expected in command construction')
          },
        },
        documentIdentity: { epoch: 1, id: 'test-document' },
        mode: 'source',
        readonly: false,
        revision: 1,
        selection: { direction: 'forward', start: 5, end: 13 },
        signal: new AbortController().signal,
        syntax: {
          blockIdentity: 'block:0',
          contentRanges: [],
          diagnosticCode: null,
          markerRanges: [],
          nodeId: 'paragraph:0',
          range: { start: 5, end: 13 },
          status: 'valid',
          type: 'paragraph',
        },
        value: 'edit markdown',
      }),
    ).resolves.toEqual({
      transaction: expect.objectContaining({
        expectedRevision: undefined,
        selection: { direction: 'forward', start: 7, end: 15 },
      }),
    })
  })

  it('emits value, mode, and command events', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'initial',
      },
    })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('updated')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['updated'])
    expect(wrapper.emitted('change')?.[0]).toEqual(['updated'])

    await wrapper.find('[role="tab"][aria-selected="false"]').trigger('click')
    expect(wrapper.emitted('mode-change')).toBeTruthy()

    await wrapper.find('.el-markdown-editor__command').trigger('click')
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(
      expect.objectContaining({ key: 'bold' }),
    )
  })

  it('keeps secondary commands inside an expandable overflow menu', async () => {
    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: {
        modelValue: 'initial',
      },
    })

    const more = wrapper.find('.el-markdown-editor__command-more')
    expect(more.exists()).toBe(true)
    expect(more.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.el-markdown-editor__command-tray').exists()).toBe(
      false,
    )

    await more.trigger('click')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(
      wrapper
        .find('.el-markdown-editor__command-tray')
        .findAll('.el-markdown-editor__command'),
    ).toHaveLength(2)

    const firstOverflowCommand = wrapper.find(
      '.el-markdown-editor__command-tray .el-markdown-editor__command',
    )
    ;(firstOverflowCommand.element as HTMLButtonElement).focus()
    await wrapper
      .find('.el-markdown-editor__command-tray')
      .trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(document.activeElement).toBe(more.element)

    await more.trigger('click')
    await wrapper
      .find('.el-markdown-editor__command-tray .el-markdown-editor__command')
      .trigger('click')
    expect(wrapper.emitted('command')?.[0]?.[0]).toEqual(
      expect.objectContaining({ key: 'image' }),
    )
    expect(wrapper.find('.el-markdown-editor__command-tray').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('lets consumers choose primary commands and compact mobile behavior', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        commandOverflowLabel: '更多格式',
        defaultMode: 'split',
        mobileLayout: 'compact',
        modelValue: 'initial',
        primaryCommandKeys: ['heading', 'link'],
      },
    })

    expect(wrapper.classes()).toContain('el-markdown-editor--mobile-compact')
    expect(wrapper.classes()).toContain('el-markdown-editor--source')
    expect(
      wrapper
        .findAll('.el-markdown-editor__commands > .el-markdown-editor__command')
        .map((item) => item.text()),
    ).toEqual(['标题', '链接'])

    const more = wrapper.find('.el-markdown-editor__command-more')
    expect(more.text()).toContain('更多格式')
    expect(more.text()).toContain('6')
    expect(more.attributes('aria-label')).toContain('更多格式')
    expect(
      wrapper.findAll('.el-markdown-editor__mode').map((item) => item.text()),
    ).toEqual(['源码', '预览'])

    await more.trigger('click')
    const tray = wrapper.find('.el-markdown-editor__command-tray')
    expect(more.attributes('aria-controls')).toBe(tray.attributes('id'))
    expect(tray.findAll('.el-markdown-editor__command')).toHaveLength(6)
  })

  it('can move selected actions into the command overflow tray', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        actionOverflowKeys: ['image'],
        modelValue: 'draft',
        showSaveAction: false,
        showSubmitAction: false,
      },
    })

    expect(wrapper.find('.el-markdown-editor__actions').exists()).toBe(false)

    const more = wrapper.find('.el-markdown-editor__command-more')
    expect(more.exists()).toBe(true)
    expect(more.text()).toContain('3')

    await more.trigger('click')
    const trayButtons = wrapper
      .find('.el-markdown-editor__command-tray')
      .findAll('.el-markdown-editor__command')
    expect(trayButtons.map((button) => button.text())).toContain('上传图片')

    const uploadButton = trayButtons.find(
      (button) => button.text() === '上传图片',
    )
    if (!uploadButton) throw new Error('missing upload action in command tray')

    await uploadButton.trigger('click')
    const picker = wrapper.find<HTMLInputElement>(
      '.el-markdown-editor__attachment-picker',
    )
    Object.defineProperty(picker.element, 'files', {
      configurable: true,
      value: [new File(['image'], 'diagram.png', { type: 'image/png' })],
    })
    await picker.trigger('change')
    expect(wrapper.emitted('upload-image')).toHaveLength(1)
    expect(wrapper.find('.el-markdown-editor__command-tray').exists()).toBe(
      false,
    )
  })

  it('exposes prose writing and interaction profiles without changing legacy defaults', () => {
    const defaultWrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '',
      },
    })

    expect(defaultWrapper.classes()).toContain(
      'el-markdown-editor--profile-markdown',
    )
    expect(defaultWrapper.classes()).toContain(
      'el-markdown-editor--interaction-auto',
    )

    const proseWrapper = mount(MarkdownEditor, {
      props: {
        editorProfile: 'prose',
        interactionProfile: 'touch',
        modelValue: '',
        placeholder: 'fallback placeholder',
        writingPlaceholder: '写下正文，慢慢展开。',
      },
    })

    expect(proseWrapper.classes()).toContain(
      'el-markdown-editor--profile-prose',
    )
    expect(proseWrapper.classes()).toContain(
      'el-markdown-editor--interaction-touch',
    )
    expect(proseWrapper.find('textarea').attributes('placeholder')).toBe(
      '写下正文，慢慢展开。',
    )
  })

  it('continues and exits markdown structures from the keyboard', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        editorProfile: 'prose',
        modelValue: '- 第一段',
      },
    })
    const textarea = wrapper.find('textarea')

    const listLineEnd = '- 第一段'.length
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(
      listLineEnd,
      listLineEnd,
    )
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['- 第一段\n- '])

    await wrapper.setProps({ modelValue: '- ' })
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(2, 2)
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([''])
  })

  it('indents and outdents selected lines from the keyboard', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        editorProfile: 'prose',
        interactionProfile: 'keyboard',
        modelValue: '第一行\n第二行',
      },
    })
    const textarea = wrapper.find('textarea')

    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(0, 7)
    await textarea.trigger('keydown', { key: 'Tab' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      '  第一行\n  第二行',
    ])

    await wrapper.setProps({ modelValue: '  第一行\n  第二行' })
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(0, 11)
    await textarea.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([
      '第一行\n第二行',
    ])
  })

  it('exposes save, submit, upload, and preview shell events', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        defaultMode: 'split',
        modelValue: '# Preview',
      },
      global: {
        stubs: {
          ElMarkdownRenderer: {
            emits: ['features-activated', 'render-complete', 'render-error'],
            template:
              '<div data-stub-markdown-renderer @click="$emit(\'render-complete\', { html: content })"></div>',
            props: ['content'],
          },
        },
      },
    })

    await wrapper.find('[data-stub-markdown-renderer]').trigger('click')
    expect(wrapper.find('[data-stub-markdown-renderer]').classes()).toContain(
      'el-markdown-editor__preview',
    )
    expect(
      wrapper.findAll('.el-markdown-editor__action').map((item) => item.text()),
    ).toEqual(['上传图片', '保存', '提交'])
    await wrapper.findAll('.el-markdown-editor__action')[0].trigger('click')
    const picker = wrapper.find<HTMLInputElement>(
      '.el-markdown-editor__attachment-picker',
    )
    Object.defineProperty(picker.element, 'files', {
      configurable: true,
      value: [new File(['image'], 'preview.png', { type: 'image/png' })],
    })
    await picker.trigger('change')
    await wrapper.findAll('.el-markdown-editor__action')[1].trigger('click')
    await wrapper.findAll('.el-markdown-editor__action')[2].trigger('click')

    expect(wrapper.emitted('render-complete')?.[0]?.[0]).toEqual({
      html: '# Preview',
    })
    expect(wrapper.emitted('upload-image')).toHaveLength(1)
    expect(wrapper.emitted('save')?.[0]).toEqual([
      '# Preview![正在上传 preview.png…]()',
    ])
    expect(wrapper.emitted('submit')?.[0]).toEqual([
      '# Preview![正在上传 preview.png…]()',
    ])
  })

  it('renders attachment lifecycle state and commits provider results through the exposed adapter', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: { modelValue: 'Draft: ' },
    })
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    textarea.setSelectionRange(7, 7)

    const picker = wrapper.find<HTMLInputElement>(
      '.el-markdown-editor__attachment-picker',
    )
    Object.defineProperty(picker.element, 'files', {
      configurable: true,
      value: [new File(['report'], 'report.pdf', { type: 'application/pdf' })],
    })
    await picker.trigger('change')

    const batch = wrapper.emitted('upload-image')?.[0]?.[0] as {
      batchId: string
      documentIdentity: { id: string; epoch: number }
      items: readonly { itemId: string }[]
      revision: number
    }
    const itemId = batch.items[0]!.itemId
    const session = wrapper.vm.getSession('session:legacy-upload')
    expect(session.inspectResourceParticipants().missingOwners).toContain('attachment-embed')
    expect(wrapper.vm.applyAttachmentResult({
      status: 'progress', batchId: `${batch.batchId}:foreign`, itemId, ratio: 0.9,
    })).toBe(false)
    expect(wrapper.vm.applyAttachmentResult({
      status: 'progress', batchId: batch.batchId, itemId, ratio: 0.9,
      documentIdentity: { ...batch.documentIdentity, epoch: batch.documentIdentity.epoch + 1 },
    })).toBe(false)
    expect(wrapper.vm.applyAttachmentResult({
      status: 'rejected', batchId: batch.batchId, itemId, revision: batch.revision + 1,
    })).toBe(false)
    expect(wrapper.find('.el-markdown-editor__attachment').text()).toContain(
      'report.pdf',
    )

    expect(
      wrapper.vm.applyAttachmentResult({
        status: 'progress',
        batchId: batch.batchId,
        itemId,
        ratio: 0.51,
      }),
    ).toBe(true)
    await nextTick()
    expect(wrapper.find('.el-markdown-editor__attachment-status').text()).toBe(
      'report.pdf：已上传 50%',
    )

    expect(
      wrapper.vm.applyAttachmentResult({
        status: 'resolved',
        batchId: batch.batchId,
        itemId,
        documentIdentity: batch.documentIdentity,
        revision: batch.revision,
        payload: {
          markdownKind: 'file',
          href: 'https://cdn.example/report.pdf',
          mimeType: 'application/pdf',
          name: 'report.pdf',
        },
      }),
    ).toBe(true)
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(
      'Draft: [report.pdf](https://cdn.example/report.pdf)',
    )
    expect(wrapper.find('.el-markdown-editor__attachment-status').text()).toBe(
      'report.pdf 上传完成',
    )
    // Legal legacy content did not create a service future or lift resource admission.
    expect(session.inspectResourceParticipants().missingOwners).toContain('attachment-embed')
    expect(() => session.inspectResources()).toThrow('editor-session-resource-owner-unavailable')
    expect(wrapper.vm.applyAttachmentResult({
      status: 'progress', batchId: batch.batchId, itemId, ratio: 0.9,
    })).toBe(false)

    Object.defineProperty(picker.element, 'files', {
      configurable: true,
      value: [new File(['second'], 'second.pdf', { type: 'application/pdf' })],
    })
    await picker.trigger('change')
    const pending = wrapper.emitted('upload-image')?.at(-1)?.[0] as typeof batch
    const sameSource = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as string
    await wrapper.setProps({
      documentIdentity: { ...pending.documentIdentity, epoch: pending.documentIdentity.epoch + 1 },
      modelValue: sameSource,
    })
    const beforeLateReply = wrapper.emitted('update:modelValue')?.length
    // Same bytes/range and a still-pending job do not authorize the old epoch.
    expect(wrapper.vm.applyAttachmentResult({
      status: 'progress', batchId: pending.batchId, itemId: pending.items[0]!.itemId, ratio: 0.9,
    })).toBe(false)
    expect(wrapper.vm.applyAttachmentResult({
      status: 'resolved', batchId: pending.batchId, itemId: pending.items[0]!.itemId,
      documentIdentity: pending.documentIdentity, revision: pending.revision,
      payload: { markdownKind: 'file', href: 'https://cdn.example/second.pdf', mimeType: 'application/pdf', name: 'second.pdf' },
    })).toBe(false)
    expect(wrapper.emitted('update:modelValue')?.length).toBe(beforeLateReply)
  })

  it('keeps a started service future behind its proof gate after the dispatch prop is removed', async () => {
    let request: Parameters<MarkdownEditorAttachmentDispatch>[0] | undefined
    let finish!: (result: MarkdownAttachmentProviderResult) => void
    const future = new Promise<MarkdownAttachmentProviderResult>((resolve) => { finish = resolve })
    const attachmentDispatch: MarkdownEditorAttachmentDispatch = (input) => {
      request = input
      return future
    }
    const wrapper = mount(MarkdownEditor, {
      props: { modelValue: 'Draft: ', attachmentDispatch },
    })
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    textarea.setSelectionRange(7, 7)
    const picker = wrapper.find<HTMLInputElement>('.el-markdown-editor__attachment-picker')
    Object.defineProperty(picker.element, 'files', {
      configurable: true,
      value: [new File(['report'], 'report.pdf', { type: 'application/pdf' })],
    })
    await picker.trigger('change')
    expect(wrapper.emitted('upload-image')).toBeUndefined()
    const started = request!
    await wrapper.setProps({ attachmentDispatch: undefined })
    const result: MarkdownAttachmentProviderResult = {
      status: 'resolved', batchId: started.batch.batchId, itemId: started.item.itemId,
      documentIdentity: started.batch.documentIdentity, revision: started.batch.revision,
      payload: { markdownKind: 'file', href: 'https://cdn.example/report.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
    }
    expect(wrapper.vm.applyAttachmentResult(result)).toBe(false)
    expect(wrapper.vm.applyAttachmentResult({
      status: 'progress', batchId: started.batch.batchId, itemId: started.item.itemId, ratio: 0.51,
    })).toBe(false)
    expect(started.onProgress({
      status: 'progress', batchId: started.batch.batchId, itemId: started.item.itemId, ratio: 0.51,
    })).toBe(true)
    finish(result)
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('Draft: [report.pdf](https://cdn.example/report.pdf)')
    expect(wrapper.vm.getSession('session:future-upload').inspectResourceParticipants().missingOwners).toContain('attachment-embed')
  })

  it('retains nonempty original settled attachment state after terminal File custody release and keeps pending sibling custody', async () => {
    vi.useFakeTimers()
    const requests: Parameters<MarkdownEditorAttachmentDispatch>[0][] = []
    const completions: ((result: MarkdownAttachmentProviderResult) => void)[] = []
    const attachmentDispatch: MarkdownEditorAttachmentDispatch = (request) => {
      requests.push(request)
      return new Promise((resolve) => { completions.push(resolve) })
    }
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '', attachmentDispatch,
      documentIdentity: { id: 'settled-terminal-document', epoch: 1 },
    } })
    const editor = wrapper.vm as MarkdownEditorInstance
    const picker = wrapper.find<HTMLInputElement>('.el-markdown-editor__attachment-picker')
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [
      new File(['first'], 'first.pdf', { type: 'application/pdf' }),
      new File(['second'], 'second.pdf', { type: 'application/pdf' }),
    ] })
    await picker.trigger('change')
    expect(requests).toHaveLength(2)
    const session = editor.getSession('session:settled-terminal')
    const result = (index: number): MarkdownAttachmentProviderResult => ({
      status: 'resolved', batchId: requests[index]!.batch.batchId, itemId: requests[index]!.item.itemId,
      documentIdentity: requests[index]!.batch.documentIdentity, revision: requests[index]!.batch.revision,
      payload: { markdownKind: 'file', href: `https://cdn.example/${index}.pdf`, mimeType: 'application/pdf', name: requests[index]!.item.name },
    })
    completions[0]!(result(0))
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(editor.withAttachmentFile(requests[0]!.batch, requests[0]!.item, () => {})).toBe(false)
    expect(editor.withAttachmentFile(requests[1]!.batch, requests[1]!.item, () => {})).toBe(true)
    expect(session.captureSnapshot(() => 'a'.repeat(64)).panelRefs?.attachmentStateRef ?? null).toBeNull()
    completions[1]!(result(1))
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(editor.withAttachmentFile(requests[1]!.batch, requests[1]!.item, () => {})).toBe(false)
    const snapshot = session.captureSnapshot(() => 'b'.repeat(64))
    expect(snapshot.panelRefs?.attachmentStateRef).toBeTruthy()
    const state = session.readPanelState(snapshot)!
    expect(state.attachment).toHaveLength(2)
    expect(state.attachment!.map((job) => [job.name, job.kind, job.phase])).toEqual([
      ['first.pdf', 'file', 'resolved'], ['second.pdf', 'file', 'resolved'],
    ])
    expect(Object.isFrozen(state.attachment)).toBe(true)
    expect(session.restoreSnapshot(snapshot, { documentIdentity: snapshot.documentIdentity, revision: snapshot.revision }).status).toBe('restored')
    expect(() => session.pauseResources()).toThrow('editor-session-resource-owner-unavailable')
    wrapper.unmount()
    expect(() => session.readPanelState(snapshot)).toThrow('editor-session-disposed')
  })

  it.each([
    ['rejected', 'button'], ['cancelled', 'button'], ['rejected', 'input'], ['cancelled', 'input'],
  ] as const)('retires settled %s custody only after accepted %s deletion and preserves it through undo/redo', async (status, removal) => {
    vi.useFakeTimers()
    let request!: Parameters<MarkdownEditorAttachmentDispatch>[0]
    let finish!: (result: MarkdownAttachmentProviderResult) => void
    const work = new Promise<MarkdownAttachmentProviderResult>((resolve) => { finish = resolve })
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '', documentIdentity: { id: 'accepted-delete-document', epoch: 1 },
      attachmentDispatch: (input: Parameters<MarkdownEditorAttachmentDispatch>[0]) => { request = input; return work },
    } })
    const editor = wrapper.vm as MarkdownEditorInstance
    const picker = wrapper.find<HTMLInputElement>('.el-markdown-editor__attachment-picker')
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [new File(['source'], 'original.pdf', { type: 'application/pdf' })] })
    await picker.trigger('change')
    finish({ status, batchId: request.batch.batchId, itemId: request.item.itemId,
      documentIdentity: request.batch.documentIdentity, revision: request.batch.revision })
    await flushPromises()
    await vi.runAllTimersAsync()
    const session = editor.getSession('session:accepted-delete')
    expect(session.captureSnapshot(() => 'a'.repeat(64)).panelRefs?.attachmentStateRef ?? null).toBeNull()
    await wrapper.setProps({ readonly: true })
    const rejectedButtons = wrapper.findAll('.el-markdown-editor__attachment-actions button')
    await rejectedButtons[rejectedButtons.length - 1]!.trigger('click')
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(wrapper.find('.el-markdown-editor__attachment-status').exists()).toBe(true)
    expect(session.captureSnapshot(() => 'a'.repeat(64)).panelRefs?.attachmentStateRef ?? null).toBeNull()
    await wrapper.setProps({ readonly: false })
    if (removal === 'button') {
      const buttons = wrapper.findAll('.el-markdown-editor__attachment-actions button')
      await buttons[buttons.length - 1]!.trigger('click')
    } else {
      const textarea = wrapper.find<HTMLTextAreaElement>('textarea')
      textarea.element.value = ''
      await textarea.trigger('input')
    }
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(editor.withAttachmentFile(request.batch, request.item, () => {})).toBe(false)
    const snapshot = session.captureSnapshot(() => 'b'.repeat(64))
    expect(snapshot.panelRefs?.attachmentStateRef).toBeTruthy()
    expect(session.readPanelState(snapshot)!.attachment!.map((job) => [job.name, job.phase])).toEqual([['original.pdf', 'deleted']])
    expect(editor.undo().accepted).toBe(true)
    expect(session.readPanelState(snapshot)).toBeNull()
    expect(editor.withAttachmentFile(request.batch, request.item, () => {})).toBe(false)
    expect(editor.redo().accepted).toBe(true)
    await flushPromises()
    await vi.runAllTimersAsync()
    const after = session.captureSnapshot(() => 'c'.repeat(64))
    expect(session.readPanelState(after)!.attachment![0]!.phase).toBe('deleted')
    expect(() => session.pauseResources()).toThrow('editor-session-resource-owner-unavailable')
    wrapper.unmount()
  })

  it.each(['future', 'legacy'] as const)('keeps accepted deletion behind original %s settlement', async (source) => {
    vi.useFakeTimers()
    let request!: Parameters<MarkdownEditorAttachmentDispatch>[0]
    let finish!: (result: MarkdownAttachmentProviderResult) => void
    const work = new Promise<MarkdownAttachmentProviderResult>((resolve) => { finish = resolve })
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '', documentIdentity: { id: 'delete-settlement-document', epoch: 1 },
      attachmentDispatch: source === 'future' ? (input: Parameters<MarkdownEditorAttachmentDispatch>[0]) => { request = input; return work } : undefined,
    } })
    const editor = wrapper.vm as MarkdownEditorInstance
    const picker = wrapper.find<HTMLInputElement>('.el-markdown-editor__attachment-picker')
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [new File(['source'], 'pending.pdf', { type: 'application/pdf' })] })
    await picker.trigger('change')
    const session = editor.getSession('session:delete-settlement')
    const textarea = wrapper.find<HTMLTextAreaElement>('textarea')
    textarea.element.value = ''
    await textarea.trigger('input')
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(session.captureSnapshot(() => 'a'.repeat(64)).panelRefs?.attachmentStateRef ?? null).toBeNull()
    if (source === 'future') {
      finish({ status: 'cancelled', batchId: request.batch.batchId, itemId: request.item.itemId,
        documentIdentity: request.batch.documentIdentity, revision: request.batch.revision })
      await flushPromises()
      await vi.runAllTimersAsync()
      const snapshot = session.captureSnapshot(() => 'b'.repeat(64))
      expect(snapshot.panelRefs?.attachmentStateRef).toBeTruthy()
      expect(session.readPanelState(snapshot)!.attachment![0]!.phase).toBe('deleted')
      expect(editor.withAttachmentFile(request.batch, request.item, () => {})).toBe(false)
    } else {
      expect(() => session.inspectResources()).toThrow('editor-session-resource-owner-unavailable')
    }
    wrapper.unmount()
  })

  it('keeps late old future retirement out of replacement document custody with the same document id', async () => {
    vi.useFakeTimers()
    const requests: Parameters<MarkdownEditorAttachmentDispatch>[0][] = []
    const completions: ((result: MarkdownAttachmentProviderResult) => void)[] = []
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '', documentIdentity: { id: 'same-delete-document', epoch: 1 },
      attachmentDispatch: (input: Parameters<MarkdownEditorAttachmentDispatch>[0]) => {
        requests.push(input)
        return new Promise<MarkdownAttachmentProviderResult>((resolve) => { completions.push(resolve) })
      },
    } })
    const editor = wrapper.vm as MarkdownEditorInstance
    const picker = wrapper.find<HTMLInputElement>('.el-markdown-editor__attachment-picker')
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [new File(['source'], 'same.pdf', { type: 'application/pdf' })] })
    await picker.trigger('change')
    await wrapper.setProps({ modelValue: '', documentIdentity: { id: 'same-delete-document', epoch: 2 } })
    await picker.trigger('change')
    completions[1]!({ status: 'resolved', batchId: requests[1]!.batch.batchId, itemId: requests[1]!.item.itemId,
      documentIdentity: requests[1]!.batch.documentIdentity, revision: requests[1]!.batch.revision,
      payload: { markdownKind: 'file', href: 'https://cdn.example/current.pdf', mimeType: 'application/pdf', name: 'same.pdf' } })
    await flushPromises()
    await vi.runAllTimersAsync()
    completions[0]!({ status: 'cancelled', batchId: requests[0]!.batch.batchId, itemId: requests[0]!.item.itemId,
      documentIdentity: requests[0]!.batch.documentIdentity, revision: requests[0]!.batch.revision })
    await flushPromises()
    await vi.runAllTimersAsync()
    const session = editor.getSession('session:replacement-delete')
    const snapshot = session.captureSnapshot(() => 'a'.repeat(64))
    expect(snapshot.panelRefs?.attachmentStateRef).toBeTruthy()
    expect(session.readPanelState(snapshot)!.attachment!.map((job) => [job.itemId, job.documentIdentity.epoch])).toEqual([[requests[1]!.item.itemId, 2]])
    expect(editor.withAttachmentFile(requests[0]!.batch, requests[0]!.item, () => {})).toBe(false)
    wrapper.unmount()
  })

  it('publishes accepted abort-listener deletion before unwind retirement and preserves deleted state through outer cancel', async () => {
    vi.useFakeTimers()
    let editor!: MarkdownEditorInstance
    let request!: Parameters<MarkdownEditorAttachmentDispatch>[0]
    let finish!: (result: MarkdownAttachmentProviderResult) => void
    let nested!: ReturnType<MarkdownEditorInstance['dispatchTransaction']>
    const work = new Promise<MarkdownAttachmentProviderResult>((resolve) => { finish = resolve })
    const wrapper = mount(MarkdownEditor, { props: {
      mode: 'source', modelValue: '', documentIdentity: { id: 'unwind-delete-document', epoch: 1 },
      attachmentDispatch: (input: Parameters<MarkdownEditorAttachmentDispatch>[0]) => {
        request = input
        input.item.signal.addEventListener('abort', () => {
          const length = wrapper.find<HTMLTextAreaElement>('textarea').element.value.length
          nested = editor.dispatchTransaction({ changes: [{ from: 0, to: length, insert: '' }], history: 'separate', origin: 'programmatic' })
        }, { once: true })
        return work
      },
    } })
    editor = wrapper.vm as MarkdownEditorInstance
    const picker = wrapper.find<HTMLInputElement>('.el-markdown-editor__attachment-picker')
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [new File(['source'], 'unwind.pdf', { type: 'application/pdf' })] })
    await picker.trigger('change')
    await wrapper.find('.el-markdown-editor__attachment-actions button').trigger('click')
    expect(nested.accepted).toBe(true)
    expect(wrapper.emitted('transaction')?.at(-1)?.[0]).toMatchObject({ accepted: true, value: '' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('')
    const session = editor.getSession('session:unwind-delete')
    await flushPromises()
    await vi.runAllTimersAsync()
    expect(session.captureSnapshot(() => 'a'.repeat(64)).panelRefs?.attachmentStateRef ?? null).toBeNull()
    finish({ status: 'cancelled', batchId: request.batch.batchId, itemId: request.item.itemId,
      documentIdentity: request.batch.documentIdentity, revision: request.batch.revision })
    await flushPromises()
    await vi.runAllTimersAsync()
    const snapshot = session.captureSnapshot(() => 'b'.repeat(64))
    expect(snapshot.panelRefs?.attachmentStateRef).toBeTruthy()
    expect(session.readPanelState(snapshot)!.attachment![0]!.phase).toBe('deleted')
    expect(editor.withAttachmentFile(request.batch, request.item, () => {})).toBe(false)
    expect(() => session.pauseResources()).toThrow('editor-session-resource-owner-unavailable')
    wrapper.unmount()
  })

  it('edits active image and caption subranges through the compact property surface', async () => {
    const source =
      '![初始 alt](/old.png "old title")\n::caption[说明 😀 RTL אב]'
    const wrapper = mount(MarkdownEditor, {
      props: { modelValue: 'seed' },
    })
    await wrapper.setProps({ modelValue: source })
    await nextTick()
    const textarea = wrapper.find('textarea')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(5, 5)
    await textarea.trigger('select')
    await nextTick()

    const properties = wrapper.find('.el-markdown-editor__media-properties')
    expect(properties.exists()).toBe(true)
    const field = (label: string) => {
      const owner = properties
        .findAll('label')
        .find((candidate) => candidate.text().startsWith(label))
      if (!owner) throw new Error(`missing ${label} image property`)
      return owner.find('input')
    }

    await field('目标地址').setValue(
      getMarkdownXssSourceUrl('mxss-url-javascript-link'),
    )
    await properties.find('button[type="submit"]').trigger('submit')
    expect(properties.find('[role="alert"]').text()).toContain('blocked-scheme')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await field('替代文本').setValue('可访问 alt 😀')
    await field('目标地址').setValue('/safe/new.png')
    await field('标题').setValue('updated title')
    await field('题注').setValue('更新说明 😀 RTL אב')
    await properties.find('button[type="submit"]').trigger('submit')
    await nextTick()
    const edited =
      '![可访问 alt 😀](/safe/new.png "updated title")\n::caption[更新说明 😀 RTL אב]'
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(edited)

    const removeImage = properties
      .findAll('button')
      .find((button) => button.text() === '移除图像')
    if (!removeImage) throw new Error('missing remove image action')
    await removeImage.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('')
    wrapper.vm.undo()
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(edited)
  })

  it('supports controlled mode, action visibility, disabled state, and cursor insertion', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        disabled: true,
        mode: 'preview',
        modelValue: 'initial',
        showActions: false,
        showModeSwitcher: false,
        textareaId: 'markdown-body',
        textareaName: 'body',
      },
      global: {
        stubs: {
          ElMarkdownRenderer: {
            template: '<div data-stub-markdown-renderer></div>',
            props: ['content'],
          },
        },
      },
    })

    expect(wrapper.find('.el-markdown-editor--preview').exists()).toBe(true)
    expect(wrapper.find('.el-markdown-editor__actions').exists()).toBe(false)
    expect(wrapper.find('.el-markdown-editor__modes').exists()).toBe(false)

    await wrapper.setProps({ mode: 'source' })
    const textarea = wrapper.find('textarea')
    expect(textarea.attributes('id')).toBe('markdown-body')
    expect(textarea.attributes('name')).toBe('body')
    expect(textarea.attributes('disabled')).toBeDefined()
    expect(wrapper.vm.insertMarkdownAtCursor(' ignored')).toBe(false)

    await wrapper.setProps({ disabled: false })
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(7, 7)
    expect(wrapper.vm.insertMarkdownAtCursor(' text') === true).toBe(true)
    expect(wrapper.emitted('transaction')?.at(-1)?.[0]).toMatchObject({
      accepted: true,
      revision: 1,
      value: 'initial text',
    })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['initial text'])
  })

  it('exposes revision-checked programmatic transactions with independent undo units', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '',
      },
    })
    const textarea = wrapper.find('textarea')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(0, 0)

    const placeholder = wrapper.vm.dispatchTransaction({
      changes: [{ from: 0, insert: '![uploading]', to: 0 }],
      expectedRevision: 0,
      history: 'separate',
      metadata: { operation: 'placeholder' },
      origin: 'programmatic',
      selection: { start: 12, end: 12 },
    })
    expect(placeholder).toMatchObject({
      accepted: true,
      revision: 1,
      value: '![uploading]',
    })

    const replacement = wrapper.vm.dispatchTransaction({
      changes: [{ from: 0, insert: '![image](asset.png)', to: 12 }],
      expectedRevision: placeholder.revision,
      history: 'separate',
      metadata: { operation: 'async-replacement' },
      origin: 'programmatic',
      selection: { direction: 'none', start: 19, end: 19 },
    })
    expect(replacement).toMatchObject({
      accepted: true,
      revision: 2,
      value: '![image](asset.png)',
    })

    const stale = wrapper.vm.dispatchTransaction({
      changes: [{ from: 0, insert: 'stale', to: 0 }],
      expectedRevision: placeholder.revision,
      history: 'separate',
      origin: 'programmatic',
      selection: { direction: 'none', start: 5, end: 5 },
    })
    expect(stale).toMatchObject({
      accepted: false,
      reason: 'stale-revision',
      revision: 2,
      value: '![image](asset.png)',
    })

    expect(wrapper.vm.undo()).toMatchObject({
      accepted: true,
      value: '![uploading]',
    })
    expect(wrapper.vm.undo()).toMatchObject({ accepted: true, value: '' })
    expect(wrapper.vm.redo()).toMatchObject({
      accepted: true,
      value: '![uploading]',
    })

    expect(
      wrapper.emitted('transaction')?.map(([rawEvent]) => {
        const event = rawEvent as MarkdownEditorTransactionEvent
        return {
          accepted: event.accepted,
          origin: event.transaction.origin,
          reason: event.reason,
        }
      }),
    ).toEqual(
      expect.arrayContaining([
        { accepted: true, origin: 'programmatic', reason: undefined },
        {
          accepted: false,
          origin: 'programmatic',
          reason: 'stale-revision',
        },
      ]),
    )
  })

  it('treats parent echo as confirmation and a different prop as a hard reset', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'A',
      },
    })
    const textarea = wrapper.find('textarea')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(1, 1)

    const inserted = wrapper.vm.insertMarkdownAtCursor('B')
    expect(inserted).toBe(true)
    expect(wrapper.emitted('transaction')?.at(-1)?.[0]).toMatchObject({
      revision: 1,
      value: 'AB',
    })
    const transactionCount = wrapper.emitted('transaction')?.length

    await wrapper.setProps({ modelValue: 'AB' })
    expect(wrapper.emitted('transaction')).toHaveLength(transactionCount ?? 0)

    await wrapper.setProps({ modelValue: '外部重置' })
    expect(wrapper.find('textarea').element.value).toBe('外部重置')
    expect(wrapper.emitted('transaction')?.at(-1)?.[0]).toMatchObject({
      accepted: true,
      history: { canRedo: false, canUndo: false },
      transaction: { origin: 'external' },
      value: '外部重置',
    })
    expect(wrapper.vm.undo()).toMatchObject({
      accepted: false,
      reason: 'no-history',
      value: '外部重置',
    })
  })

  it('cancels pending commands and clears history when document identity changes', async () => {
    let commandSignal: AbortSignal | undefined
    let resolveCommand: (() => void) | undefined
    const pending = new Promise<void>((resolvePromise) => {
      resolveCommand = resolvePromise
    })
    const command: MarkdownEditorCommand = {
      group: 'test',
      key: 'pending-command',
      label: 'Pending command',
      presentation: ['toolbar'],
      run: async (context) => {
        commandSignal = context.signal
        await pending
        return {
          transaction: {
            changes: [{ from: 0, insert: 'late', to: 0 }],
            history: 'separate',
            origin: 'command',
          },
        }
      },
    }
    const wrapper = mount(MarkdownEditor, {
      props: {
        commands: [command],
        documentIdentity: { epoch: 1, id: 'document-a' },
        modelValue: 'A',
      },
    })
    ;(wrapper.find('textarea').element as HTMLTextAreaElement).setSelectionRange(
      1,
      1,
    )
    expect(wrapper.vm.insertMarkdownAtCursor('B')).toBe(true)
    const commandButton = wrapper.find('.el-markdown-editor__command')
    await commandButton.trigger('click')
    expect(commandSignal?.aborted).toBe(false)
    expect(commandButton.attributes('disabled')).toBeDefined()
    const pendingDescription = commandButton.attributes('aria-describedby')
    expect(pendingDescription).toBeTruthy()
    expect(wrapper.find(`#${pendingDescription}`).text()).toBe('执行中')

    await wrapper.setProps({
      documentIdentity: { epoch: 1, id: 'document-b' },
      modelValue: 'A',
    })
    expect(commandSignal?.aborted).toBe(true)
    expect(wrapper.find(`#${pendingDescription}`).text()).toBe('已取消')
    expect(wrapper.vm.undo()).toMatchObject({
      accepted: false,
      reason: 'no-history',
      value: 'A',
    })
    expect(wrapper.vm.insertMarkdownAtCursor('C')).toBe(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['AC'])

    resolveCommand?.()
    await nextTick()
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['AC'])
    expect(
      (wrapper.find('textarea').element as HTMLTextAreaElement).value,
    ).toBe('AC')
  })

  it('keeps public external transactions synchronized through v-model', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'server',
      },
    })

    expect(
      wrapper.vm.dispatchTransaction({
        changes: [{ from: 0, insert: 'client', to: 6 }],
        history: 'skip',
        origin: 'external',
        selection: { direction: 'none', start: 6, end: 6 },
      }),
    ).toMatchObject({
      accepted: true,
      value: 'client',
    })
    expect(wrapper.emitted('update:modelValue')).toEqual([['client']])
    await nextTick()
    expect(wrapper.find('textarea').element.value).toBe('client')
  })

  it('rejects public external transactions during composition', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'server',
      },
    })
    const element = wrapper.find('textarea').element as HTMLTextAreaElement

    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )

    expect(
      wrapper.vm.dispatchTransaction({
        changes: [{ from: 0, insert: 'client', to: 6 }],
        history: 'skip',
        origin: 'external',
        selection: { direction: 'none', start: 6, end: 6 },
      }),
    ).toMatchObject({
      accepted: false,
      reason: 'composition-active',
      value: 'server',
    })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('does not revive invalidated IME text after a parent hard reset', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'server-before',
      },
    })
    const element = wrapper.find('textarea').element as HTMLTextAreaElement

    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    element.value = '作成中'
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '作成中',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    )

    await wrapper.setProps({ modelValue: 'server-after' })
    expect(element.value).toBe('server-after')
    const resetTransactionCount = wrapper.emitted('transaction')?.length

    element.value = '作成中'
    element.dispatchEvent(
      new CompositionEvent('compositionend', {
        bubbles: true,
        data: '作成中',
      }),
    )
    element.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        data: '旧',
        inputType: 'insertText',
      }),
    )
    element.value = '作成中旧'
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '旧',
        inputType: 'insertText',
      }),
    )
    await nextTick()

    expect(element.value).toBe('server-after')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('transaction')).toHaveLength(
      resetTransactionCount ?? 0,
    )
  })

  it('recovers ordinary input when a hard reset receives no compositionend', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'server-before',
      },
    })
    const element = wrapper.find('textarea').element as HTMLTextAreaElement

    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    element.value = '未確定'
    await wrapper.setProps({ modelValue: 'server-after' })

    await vi.runOnlyPendingTimersAsync()
    element.value = '未確定'
    element.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '未確定',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    )
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '未確定',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    )
    await nextTick()

    expect(element.value).toBe('server-after')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    element.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '!',
        inputType: 'insertText',
      }),
    )
    element.value = 'server-after!'
    element.setSelectionRange(element.value.length, element.value.length)
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '!',
        inputType: 'insertText',
      }),
    )
    await nextTick()

    expect(wrapper.emitted('update:modelValue')).toEqual([['server-after!']])
    expect(element.value).toBe('server-after!')
  })

  it.each(['简体中文', '繁體中文', '日本語', '한국어'])(
    'commits %s composition once and freezes commands during composition',
    async (composed) => {
      const wrapper = mount(MarkdownEditor, {
        props: {
          modelValue: '',
        },
      })
      const textarea = wrapper.find('textarea')
      const element = textarea.element as HTMLTextAreaElement

      element.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      await nextTick()
      await wrapper.find('.el-markdown-editor__command').trigger('click')
      expect(wrapper.emitted('command')).toBeUndefined()

      element.value = composed
      element.setSelectionRange(composed.length, composed.length)
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: composed,
          inputType: 'insertCompositionText',
          isComposing: true,
        }),
      )
      await nextTick()
      expect(wrapper.emitted('update:modelValue')).toBeUndefined()
      expect(element.value).toBe(composed)

      await wrapper.setProps({ placeholder: 'Composition remains native' })
      expect(element.value).toBe(composed)

      element.dispatchEvent(
        new CompositionEvent('compositionend', {
          bubbles: true,
          data: composed,
        }),
      )
      await nextTick()
      expect(wrapper.emitted('update:modelValue')).toEqual([[composed]])
      expect(wrapper.emitted('history-change')?.at(-1)?.[0]).toMatchObject({
        undoDepth: 1,
      })
      expect(wrapper.emitted('transaction')?.at(-1)?.[0]).toMatchObject({
        accepted: true,
        transaction: {
          history: 'separate',
          metadata: { composition: true },
          origin: 'input',
        },
      })
    },
  )

  it('keeps native post-composition insertText commits separate from following input', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '',
      },
    })
    const element = wrapper.find('textarea').element as HTMLTextAreaElement

    const commitNativeComposition = (committed: string) => {
      element.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      element.setSelectionRange(element.value.length, element.value.length)
      element.dispatchEvent(
        new CompositionEvent('compositionend', {
          bubbles: true,
          data: '',
        }),
      )
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          data: committed,
          inputType: 'insertText',
        }),
      )
      element.value += committed
      element.setSelectionRange(element.value.length, element.value.length)
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: committed,
          inputType: 'insertText',
        }),
      )
    }

    commitNativeComposition('한')
    commitNativeComposition('글')
    element.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        inputType: 'insertLineBreak',
      }),
    )
    element.value += '\n'
    element.setSelectionRange(element.value.length, element.value.length)
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertLineBreak',
      }),
    )
    await nextTick()

    expect(wrapper.vm.undo()).toMatchObject({ value: '한글' })
    expect(wrapper.vm.undo()).toMatchObject({ value: '한' })
    expect(wrapper.vm.undo()).toMatchObject({ value: '' })
  })

  it('routes beforeinput/input paste and drop through separate dispatcher transactions', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '',
      },
    })
    const element = wrapper.find('textarea').element as HTMLTextAreaElement

    const nativeInput = async (
      value: string,
      inputType: 'insertFromDrop' | 'insertFromPaste',
    ) => {
      element.setSelectionRange(element.value.length, element.value.length)
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          data: value,
          inputType,
        }),
      )
      element.value += value
      element.setSelectionRange(element.value.length, element.value.length)
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: value,
          inputType,
        }),
      )
      await nextTick()
    }

    await nativeInput('粘贴', 'insertFromPaste')
    await nativeInput('拖放', 'insertFromDrop')

    expect(
      wrapper
        .emitted('transaction')
        ?.map(([event]) => event as MarkdownEditorTransactionEvent)
        .filter((event) => event.accepted)
        .map((event) => event.transaction.origin),
    ).toEqual(['paste', 'drop'])
    expect(wrapper.emitted('history-change')?.at(-1)?.[0]).toMatchObject({
      undoDepth: 2,
    })
    expect(wrapper.vm.undo()).toMatchObject({ value: '粘贴' })
  })

  it('maps attachment drops from the browser pointer caret through the source anchor map', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: { modelValue: 'abcd' },
    })
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offset: 2, offsetNode: textarea }),
    })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperties(drop, {
      clientX: { value: 10 },
      clientY: { value: 10 },
      dataTransfer: {
        value: {
          files: [new File(['image'], 'drop.png', { type: 'image/png' })],
          getData: () => '',
          types: ['Files'],
        },
      },
    })
    textarea.dispatchEvent(drop)
    await nextTick()

    expect(drop.defaultPrevented).toBe(true)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe(
      'ab![正在上传 drop.png…]()cd',
    )
    Reflect.deleteProperty(document, 'caretPositionFromPoint')
  })

  it('pastes mixed MIME once as plain text and ignores the follow-up input event', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '',
      },
    })
    const element = wrapper.find('textarea').element as HTMLTextAreaElement
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) =>
          type === 'text/html' ? '<b>HTML</b>' : 'plain',
        types: ['text/html', 'text/plain'],
      },
    })
    element.dispatchEvent(paste)
    await nextTick()

    element.value += 'plain'
    element.setSelectionRange(element.value.length, element.value.length)
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: 'plain',
        inputType: 'insertFromPaste',
      }),
    )
    await nextTick()

    const accepted = wrapper
      .emitted('transaction')
      ?.map(([event]) => event as MarkdownEditorTransactionEvent)
      .filter((event) => event.accepted)
    expect(accepted?.map((event) => event.value)).toEqual(['plain'])
    expect(accepted?.map((event) => event.transaction.origin)).toEqual([
      'paste',
    ])
  })

  it('rejects public mutations while loading without changing the optimistic value', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        loading: true,
        modelValue: 'draft',
      },
    })
    expect(wrapper.find('textarea').attributes('aria-busy')).toBe('true')
    expect(
      wrapper.vm.dispatchTransaction({
        changes: [{ from: 5, insert: '!', to: 5 }],
        history: 'separate',
        origin: 'programmatic',
        selection: { direction: 'none', start: 6, end: 6 },
      }),
    ).toMatchObject({
      accepted: false,
      reason: 'disabled',
      value: 'draft',
    })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await wrapper.setProps({ loading: false })
    expect(wrapper.find('textarea').attributes('aria-busy')).toBeUndefined()
  })

  it.each(['framed', 'embedded', 'minimal'] as const)(
    'keeps a single semantic editor shell when chrome is %s',
    async (chrome) => {
      const wrapper = mount(MarkdownEditor, {
        props: {
          chrome,
          modelValue: '# Contract',
        },
        global: {
          stubs: {
            ElMarkdownRenderer: {
              props: ['content'],
              template: '<div data-stub-markdown-renderer />',
            },
          },
        },
      })

      expect(wrapper.classes()).toContain(
        `el-markdown-editor--chrome-${chrome}`,
      )
      expect(wrapper.findAll('[role="region"]')).toHaveLength(1)
      expect(wrapper.find('[aria-label="Markdown 编辑器"]').exists()).toBe(true)

      if (chrome === 'minimal') {
        expect(wrapper.find('.el-markdown-editor__toolbar').exists()).toBe(
          false,
        )
        expect(wrapper.find('.el-markdown-editor__status').exists()).toBe(false)
      }

      if (chrome === 'embedded') {
        expect(wrapper.classes()).not.toContain(
          'el-markdown-editor--surface-card',
        )
      }
    },
  )

  it.each(['source', 'live', 'split', 'preview'] as const)(
    'preserves the root, accessible name, and active region across %s mode',
    async (mode) => {
      const wrapper = mount(MarkdownEditor, {
        props: {
          chrome: 'embedded',
          mode,
          modelValue: '# Contract',
        },
        global: {
          stubs: {
            ElMarkdownRenderer: {
              props: ['content'],
              template: '<div data-stub-markdown-renderer />',
            },
          },
        },
      })

      const root = wrapper.element
      expect(wrapper.classes()).toContain(`el-markdown-editor--${mode}`)
      expect(wrapper.find('[aria-label="Markdown 编辑器"]').exists()).toBe(true)

      await wrapper.setProps({ chrome: 'minimal' })
      expect(wrapper.element).toBe(root)
      expect(wrapper.find('[aria-label="Markdown 编辑器"]').exists()).toBe(true)

      const textarea = wrapper.find('textarea')
      expect(textarea.exists()).toBe(true)
      if (mode === 'preview') {
        expect(textarea.isVisible()).toBe(false)
        expect(wrapper.find('[data-stub-markdown-renderer]').exists()).toBe(
          true,
        )
      } else {
        expect(textarea.isVisible()).toBe(true)
        expect(wrapper.find('[data-stub-markdown-renderer]').exists()).toBe(
          mode === 'split',
        )
      }
    },
  )

  it('keeps one textarea owner across source/live/split/preview without rebuilding history', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        mode: 'source',
        modelValue: '# Stable',
      },
      global: {
        stubs: {
          ElMarkdownRenderer: {
            template: '<div data-stub-markdown-renderer />',
          },
        },
      },
    })
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    textarea.setSelectionRange(2, 8)
    wrapper.vm.dispatchTransaction({
      changes: [{ from: 8, insert: '!', to: 8 }],
      history: 'separate',
      origin: 'input',
      selection: { direction: 'forward', end: 9, start: 2 },
    })
    const revision = wrapper.vm.undo().revision
    wrapper.vm.redo()

    for (const mode of ['live', 'split', 'preview', 'source'] as const) {
      await wrapper.setProps({ mode })
      expect(wrapper.find('textarea').element).toBe(textarea)
      expect(
        wrapper
          .find('[data-markdown-surface-owner]')
          .attributes('data-markdown-surface-owner'),
      ).toBe('source-textarea')
    }

    expect(wrapper.vm.undo()).toMatchObject({
      accepted: true,
      value: '# Stable',
    })
    expect(revision).toBeGreaterThan(0)
    expect(wrapper.find('[data-markdown-live-decorations]').exists()).toBe(
      false,
    )
    await wrapper.setProps({ mode: 'live' })
    expect(wrapper.find('[data-stub-markdown-renderer]').exists()).toBe(false)
    expect(wrapper.find('textarea').isVisible()).toBe(true)
  })

  it('reveals live markers from the caret and hides them on Escape without editing source', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        mode: 'live',
        modelValue: 'intro ***nested*** tail',
      },
    })
    const textarea = wrapper.find('textarea')
    const element = textarea.element as HTMLTextAreaElement
    const caret = 'intro ***nested*** tail'.indexOf('nested')
    element.setSelectionRange(caret, caret)
    await textarea.trigger('select')
    expect(
      wrapper
        .find('[data-markdown-reveal-state]')
        .attributes('data-markdown-reveal-state'),
    ).toBe('caret-inside')
    const before = wrapper.emitted('update:modelValue')?.length ?? 0
    await textarea.trigger('keydown', { key: 'Escape' })
    expect(
      wrapper
        .find('[data-markdown-reveal-state]')
        .attributes('data-markdown-reveal-state'),
    ).toBe('inactive')
    expect(wrapper.emitted('update:modelValue')?.length ?? 0).toBe(before)
    expect(element.value).toBe('intro ***nested*** tail')
  })

  it('snaps live caret around atomic images and deletes them through the shared primitive', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        mode: 'live',
        modelValue: 'go ![alt](img.png) on',
      },
    })
    const textarea = wrapper.find('textarea')
    const element = textarea.element as HTMLTextAreaElement
    const image = 'go ![alt](img.png) on'.indexOf('!')
    element.setSelectionRange(image, image)
    await textarea.trigger('keydown', { key: 'ArrowRight' })
    expect(element.selectionStart).toBe('go ![alt](img.png)'.length)
    expect(
      wrapper
        .find('[data-markdown-atomic-kind]')
        .attributes('data-markdown-atomic-kind'),
    ).toBe('image')
    await textarea.trigger('keydown', { key: 'Backspace' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toBe('go  on')
  })

  it('windows live decorations and yields viewport restore to wheel', async () => {
    const modelValue = Array.from(
      { length: 40 },
      (_, index) => `# Heading ${index}\n\nparagraph ${index}\n`,
    ).join('\n')
    const wrapper = mount(MarkdownEditor, {
      props: {
        mode: 'live',
        modelValue,
      },
    })
    await nextTick()
    const decorations = wrapper.findAll(
      '[data-markdown-live-decorations] [data-node-id]',
    )
    expect(decorations.length).toBeGreaterThan(0)
    expect(decorations.length).toBeLessThanOrEqual(96)
    const textarea = wrapper.find('textarea')
    await textarea.trigger('wheel')
    expect(
      wrapper
        .find('[data-markdown-layout-action]')
        .attributes('data-markdown-layout-action'),
    ).toBe('yield')
  })

  it('keeps selection direction when switching live to source', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        mode: 'live',
        modelValue: 'keep this range',
      },
    })
    const textarea = wrapper.find('textarea')
    const element = textarea.element as HTMLTextAreaElement
    element.setSelectionRange(0, 4, 'forward')
    await textarea.trigger('select')
    const sourceTab = wrapper
      .findAll('[role="tab"]')
      .find((button) => button.text() === '源码')
    expect(sourceTab).toBeTruthy()
    await sourceTab!.trigger('click')
    await nextTick()
    expect(element.selectionStart).toBe(0)
    expect(element.selectionEnd).toBe(4)
    expect(element.selectionDirection).toBe('forward')
  })

  it('keeps the editable surface and its selection when chrome changes', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        chrome: 'framed',
        mode: 'source',
        modelValue: '# Stable document',
      },
    })
    const root = wrapper.element
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    textarea.setSelectionRange(2, 8)

    await wrapper.setProps({ chrome: 'embedded' })
    expect(wrapper.element).toBe(root)
    expect(wrapper.find('textarea').element).toBe(textarea)
    expect(textarea.selectionStart).toBe(2)
    expect(textarea.selectionEnd).toBe(8)

    await wrapper.setProps({ chrome: 'minimal' })
    expect(wrapper.element).toBe(root)
    expect(wrapper.find('textarea').element).toBe(textarea)
    expect(wrapper.find('.el-markdown-editor__toolbar').exists()).toBe(false)
    expect(wrapper.find('.el-markdown-editor__status').exists()).toBe(false)
  })

  it.each(['embedded', 'minimal'] as const)(
    'keeps focus semantics without a framed root when chrome is %s',
    (chrome) => {
      const wrapper = mount(MarkdownEditor, {
        props: { chrome, modelValue: 'focus contract' },
      })

      expect(wrapper.find('[aria-label="Markdown 编辑器"]').exists()).toBe(true)
      expect(wrapper.find('textarea').attributes('aria-label')).toBeTruthy()
      expect(wrapper.classes()).not.toContain(
        'el-markdown-editor--surface-card',
      )
    },
  )
})

describe('MarkdownEditor command contract migration', () => {
  it('does not retain the legacy apply(value, selection) command execution path', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'vue/packages/components/markdown-editor/src/markdown-editor.ts',
      ),
      'utf8',
    )

    expect(source).not.toMatch(/\bapply\s*\(\s*value\s*,\s*selection\s*\)/)
    expect(source).toMatch(/\brun\s*:/)
  })

  it('removes the write mode alias from the public component contract', () => {
    const component = readFileSync(
      resolve(
        process.cwd(),
        'vue/packages/components/markdown-editor/src/markdown-editor.vue',
      ),
      'utf8',
    )
    const model = readFileSync(
      resolve(
        process.cwd(),
        'vue/packages/components/markdown-editor/src/markdown-editor.ts',
      ),
      'utf8',
    )
    const liveContract = readFileSync(
      resolve(
        process.cwd(),
        'vue/packages/components/markdown-editor/src/markdown-editor-live-contract.ts',
      ),
      'utf8',
    )

    expect(component).not.toMatch(/mode-write|--write|is-write/)
    expect(model).not.toMatch(/['\"]write['\"]/)
    expect(liveContract).not.toMatch(/['\"]write['\"]/)
    expect(liveContract).toMatch(
      /['\"]source['\"]\s*\|\s*['\"]live['\"]\s*\|\s*['\"]split['\"]\s*\|\s*['\"]preview['\"]/,
    )
  })

  it('resolves only the six frozen live capability tokens with document identity', () => {
    expect([...markdownLiveCapabilities]).toEqual([
      'supported',
      'unsupported-platform',
      'runtime-unavailable',
      'projection-failed',
      'feature-degraded',
      'fatal',
    ])

    const identity = { epoch: 2, id: 'doc-a' }
    const supported = resolveMarkdownLiveCapability('supported', {
      documentIdentity: identity,
      revision: 4,
    })
    expect(supported.capability).toBe('supported')
    expect(supported.documentIdentity).toEqual(identity)
    expect(supported.revision).toBe(4)

    expect(() =>
      resolveMarkdownLiveCapability('write', {
        documentIdentity: identity,
        revision: 4,
      }),
    ).toThrow(/unknown markdown live capability token/i)

    expect(() =>
      resolveMarkdownLiveCapability('supported', {
        documentIdentity: { epoch: 1, id: '' },
        revision: 4,
      }),
    ).toThrow(/missing identity/i)
  })
})

describe('MarkdownEditor writing-aids integration', () => {
  it('renders focus presentation and makes outline reveal select, focus, and scroll the textarea', async () => {
    const source =
      '# Intro\n\nFirst paragraph.\n\n## Details\n\nSecond paragraph.\n'
    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: {
        editorProfile: 'prose',
        modelValue: source,
        writingAids: { focus: true, typewriter: true },
      },
    })
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    const scrollTo = vi.fn()
    Object.defineProperty(textarea, 'clientHeight', {
      configurable: true,
      value: 320,
    })
    Object.defineProperty(textarea, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })

    await nextTick()
    expect(wrapper.find('.el-markdown-editor__focus-layer').exists()).toBe(true)
    expect(wrapper.findAll('.is-dimmed').length).toBeGreaterThan(0)
    expect(wrapper.attributes('data-markdown-focus-enabled')).toBe('true')

    const model = createMarkdownOutlineModel(source, {
      epoch: 0,
      id: wrapper.attributes('data-markdown-instance'),
    })
    const target = model.items[1]!
    expect(
      (wrapper.vm as MarkdownEditorInstance).revealHeading(target.nodeId),
    ).toBe('success')
    await nextTick()
    await nextTick()

    expect(textarea.selectionStart).toBe(target.sourceRange.start)
    expect(document.activeElement).toBe(textarea)
    expect(scrollTo).toHaveBeenCalled()
    expect(wrapper.attributes('data-markdown-focus-active-block')).toBe(
      target.nodeId,
    )

    wrapper.unmount()
  })

  it('wires manual scroll and composition into the public writing-aids controller', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        editorProfile: 'prose',
        modelValue: 'line one\nline two',
        writingAids: { typewriter: true },
      },
    })
    const textarea = wrapper.find('textarea')

    await nextTick()
    await Promise.resolve()
    await textarea.trigger('scroll')
    expect(wrapper.attributes('data-markdown-writing-aids-state')).toBe(
      'user-scroll-suspended',
    )

    await textarea.trigger('compositionstart')
    expect(wrapper.attributes('data-markdown-writing-aids-state')).toBe(
      'composition-suspended',
    )
    await textarea.trigger('compositionend', { data: '' })
    expect(wrapper.attributes('data-markdown-writing-aids-state')).toBe('idle')

    await textarea.trigger('keydown', { key: 'PageDown' })
    expect(wrapper.attributes('data-markdown-writing-aids-state')).toBe(
      'user-scroll-suspended',
    )
  })

  it('fails closed without moving selection, focus, scroll, or history for missing and stale reveals', async () => {
    const source = '# Intro\n\nBody\n'
    const wrapper = mount(MarkdownEditor, {
      attachTo: document.body,
      props: {
        editorProfile: 'prose',
        modelValue: source,
        writingAids: { focus: true, typewriter: true },
      },
    })
    const textarea = wrapper.find('textarea').element as HTMLTextAreaElement
    const scrollTo = vi.fn()
    Object.defineProperty(textarea, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    textarea.setSelectionRange(source.length, source.length, 'none')
    const instance = wrapper.vm as MarkdownEditorInstance
    const historyBefore = instance.writingAidsController.state

    expect(instance.revealHeading('missing-node')).toBe('not-found')
    expect(
      instance.revealSourceRange(
        { start: 0, end: 2 },
        {
          expected: {
            documentIdentity: { id: 'other-document', epoch: 0 },
            revision: 0,
          },
        },
      ),
    ).toBe('stale')
    await nextTick()

    expect(textarea.selectionStart).toBe(source.length)
    expect(textarea.selectionEnd).toBe(source.length)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(instance.writingAidsController.state).toBe(historyBefore)
    wrapper.unmount()
  })

  it('reports a deleted stable heading identity without falling back to a same-title sibling', async () => {
    const source = '# Same\n\nBody\n\n# Same\n\nTail\n'
    const wrapper = mount(MarkdownEditor, {
      props: {
        editorProfile: 'prose',
        modelValue: source,
        writingAids: { focus: true },
      },
    })
    await nextTick()
    const identity = {
      epoch: 0,
      id: wrapper.attributes('data-markdown-instance'),
    }
    const model = createMarkdownOutlineModel(source, identity)
    const deletedId = model.items[1]!.nodeId

    await wrapper.setProps({ modelValue: '# Same\n\nBody\n\nTail\n' })
    await nextTick()
    await nextTick()

    expect(
      (wrapper.vm as MarkdownEditorInstance).revealHeading(deletedId),
    ).toBe('deleted')
    expect(
      (wrapper.vm as MarkdownEditorInstance).revealHeading(
        model.items[0]!.nodeId,
      ),
    ).toBe('success')
  })

  it('renders Focus exemptions, disables Focus in preview, and suspends Typewriter on PageDown', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        editorProfile: 'prose',
        modelValue: '# Intro\n\nFirst.\n\nSecond.\n',
        writingAids: { focus: true, typewriter: true },
      },
    })
    await nextTick()
    const dimmed = wrapper.find(
      '.el-markdown-editor__focus-layer .is-dimmed[data-node-id]',
    )
    const exemptNodeId = dimmed.attributes('data-node-id')
    expect(exemptNodeId).toBeTruthy()

    await wrapper.setProps({
      focusExemptions: { searchMatches: [exemptNodeId] },
    })
    expect(wrapper.find(`[data-node-id="${exemptNodeId}"]`).classes()).toContain(
      'is-exempt',
    )
    expect(
      wrapper.find(`[data-node-id="${exemptNodeId}"]`).classes(),
    ).not.toContain('is-dimmed')

    await wrapper.find('textarea').trigger('keydown', { key: 'PageDown' })
    expect(wrapper.attributes('data-markdown-writing-aids-state')).toBe(
      'user-scroll-suspended',
    )

    await wrapper.setProps({ mode: 'preview' })
    await nextTick()
    expect(wrapper.attributes('data-markdown-focus-enabled')).toBe('false')
    expect(wrapper.find('.el-markdown-editor__focus-layer').exists()).toBe(
      false,
    )
  })
})
