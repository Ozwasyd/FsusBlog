// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope } from 'vue'
import { ElMarkdownEditor, type MarkdownEditorDispatchResult, type MarkdownEditorTransaction } from '@ozwasyd/element-plus'
import { createMarkdownAnchorMap } from '@ozwasyd/element-plus/markdown-runtime'

import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import ImageUploadOptionsPanel from '@/components/ui/ImageUploadOptionsPanel.vue'
import { getImageUploadRuntimeAdmissionError } from '@/composables/useImageUploadRuntime'
import { useImageUploadRuntime, type ImageUploadSessionBorrow, type ImageUploadSessionAccess } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow, type ImageUploadFileCompletion } from '@/composables/useImageUploadFlow'
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext'
import { ArticleAttachmentContextAdapter, type ArticleAttachmentTransactionPort } from '@/services/authoring/articleAttachmentContext'
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext'
import { decode } from '@wasm/aeds'
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'
import { encodeAedsFrame } from '@/api/binaryFrame'
import { privateRequestRuntime } from '@/services/privateRequestRuntime'
import type { ImageCompressionOptions } from '@/api/upload'

const api = vi.hoisted(() => ({
  abortUpload: vi.fn(),
  completeUpload: vi.fn(),
  getUploadPartMap: vi.fn(),
  getUploadStatus: vi.fn(),
  initUploadSession: vi.fn(),
  uploadPart: vi.fn()
}))

const compression = vi.hoisted(() => ({
  compressImageFileWithRuntime: vi.fn(),
  sha256Hex: vi.fn()
}))

vi.mock('@/api/upload', () => api)
vi.mock('@/composables/usePow', () => ({
  usePow: () => ({ calculate: vi.fn().mockResolvedValue({ nonce: 'ordinary-test-nonce', duration: 1 }) })
}))
vi.mock('@/utils/fingerprint', () => ({ getBrowserFp: () => 'ordinary-test-browser' }))
vi.mock('@/utils/imageCompression', () => compression)
vi.mock('@/utils/wasmImageCodec', () => ({
  getWasmSupportedFormats: vi.fn().mockResolvedValue(['png', 'webp'])
}))

const options: ImageCompressionOptions = {
  format: 'webp',
  quality: 82,
  scaleRatio: 1,
  maxEdge: 1920,
  preserveAlpha: true
}

const preview = {
  width: 1200,
  height: 800,
  format: 'webp' as const,
  originalBytes: 600_000,
  compressedBytes: 600_000,
  pipeline: 'wasm' as const,
  wasmCapability: 'wasm' as const
}

function fileOf(size: number, name = 'cover.png'): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png', lastModified: 1_700_000_000_000 })
}

const uploadIds = {
  old: '11111111111111111111111111111111', fresh: '22222222222222222222222222222222',
  new: '33333333333333333333333333333333', ack: '44444444444444444444444444444444',
  late: '55555555555555555555555555555555', originalLate: '66666666666666666666666666666666'
}

// Complete typed wire fixtures; safety oracles below still assert the original IO and lifecycle.
function initReply(input: { fileName?: string; name?: string; mimeType?: string; type?: string; totalBytes?: number; size?: number; targetFormat?: string },
  uploadId = uploadIds.old, uploadToken = 'token-old') {
  const totalBytes = input.totalBytes ?? input.size!
  return { uploadId, uploadToken, fileName: input.fileName ?? input.name!, mimeType: input.mimeType ?? input.type!,
    targetFormat: input.targetFormat ?? 'webp', totalBytes, chunkSize: 524_288,
    totalParts: Math.ceil(totalBytes / 524_288), expiresAt: '2099-01-01T00:00:00Z' }
}
function partReply(uploadId: string, partNumber: number, offset: number, size: number,
  uploadedBytes = offset + size, uploadedPartCount = partNumber + 1) {
  return { uploadId, partNumber, offset, size, uploadedBytes, uploadedPartCount }
}
function completeReply(uploadId: string, totalBytes: number, url = '/uploads/complete.webp', mimeType = 'image/png') {
  return { uploadId, totalBytes, url, relativeUrl: url, mimeType }
}
function statusReply(totalBytes: number, uploadedPartCount = 0, uploadedBytes = 0, nextPartHint = 0) {
  return { uploadId: uploadIds.old, status: uploadedPartCount ? 'uploading' : 'pending', totalBytes,
    chunkSize: 524_288, totalParts: Math.ceil(totalBytes / 524_288), uploadedPartCount, uploadedBytes, nextPartHint,
    expiresAt: '2099-01-01T00:00:00Z' }
}
function originalInitRequest() { return api.initUploadSession.mock.calls.at(-1)![0] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const borrowCleanup: (() => void)[] = []
afterEach(() => borrowCleanup.splice(0).forEach(dispose => dispose()))

/** Genuine original pending handle, document lease and upstream source/map dispatch. */
function attachmentHost() {
  let source = 'paragraph'
  const documentOwner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
    editorSessionId: 'session:runtime-borrow', siteScope: 'site:test', userScope: 'user:test', content: source })
  const anchors = new ArticleAnchorContextAdapter(documentOwner)
  const owner = new ArticleAttachmentContextAdapter(documentOwner, 'article-assets', 'version:1', anchors)
  const getBinding = () => ({ document: documentOwner.context,
    map: createMarkdownAnchorMap({ identity: documentOwner.documentIdentity, source }) })
  let commands: { dispatchTransaction(input: MarkdownEditorTransaction): MarkdownEditorDispatchResult }
  const port: ArticleAttachmentTransactionPort = {
    dispatch: transaction => commands.dispatchTransaction(transaction),
    commitSource: result => { source = result.value; if (documentOwner.context.sourceRevision < result.revision)
      documentOwner.updateSource(source, result.revision) },
    binding: getBinding
  }
  const wrapper = mount(ElMarkdownEditor, { props: { mode: 'source', modelValue: source,
    documentIdentity: documentOwner.documentIdentity,
    'onUpdate:modelValue': (value: string) => { source = value; documentOwner.updateSource(value) },
    onTransaction: (result: MarkdownEditorDispatchResult) => owner.consumeTransaction(result, port) } })
  commands = wrapper.vm as unknown as typeof commands
  const anchor = anchors.capture(getBinding(), { start: 0, end: 0, direction: 'none' },
    { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' })
  borrowCleanup.push(() => { owner.dispose(); documentOwner.dispose(); wrapper.unmount() })
  return { owner, documentOwner, port, anchor, getBinding, commands, source: () => source }
}

function boundAttempt(file: File) {
  const host = attachmentHost()
  const { owner, documentOwner, port, anchor, getBinding, commands } = host
  const captured = owner.capture({ source: host.source(), origin: 'pick', anchor,
    files: [{ name: file.name, mimeType: file.type, byteLength: file.size }] })
  if (captured.status !== 'created') throw new Error('capture rejected')
  const intent = owner.commitCreated(captured, port)[0]!
  const lease = documentOwner.beginTask('attachment', 'runtime-borrow')
  const binding = { owner, documentOwner, intent, lease, getBinding }
  expect(owner.readOwnedIntent(intent, getBinding())?.current).toBe(true)
  return { binding, commands, source: host.source }
}

function storedSnapshot() {
  const key = Object.keys(localStorage).find((candidate) => candidate.startsWith('fsus:image-upload-session:'))
  expect(key).toBeDefined()
  const snapshot = decodePublicAotPayload<{
    uploadId: string
    resumeKey: string
    fileName: string
    sha256: string
    uploadToken: string
  }>(localStorage.getItem(key ?? '') ?? '')
  expect(snapshot).not.toBeNull()
  return { key: key ?? '', snapshot: snapshot! }
}

async function exhaustPartRetries(runtime: ReturnType<typeof useImageUploadRuntime>, file: File): Promise<void> {
  vi.useFakeTimers()
  api.uploadPart.mockRejectedValue(new Error('part unavailable'))
  const upload = runtime.uploadFile(file, options, { wasmOnly: true })
  const rejection = expect(upload).rejects.toThrow('part unavailable')
  await vi.runAllTimersAsync()
  await rejection
  vi.useRealTimers()
}

describe('useImageUploadRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    compression.compressImageFileWithRuntime.mockImplementation(async (file: File) => ({ file, preview }))
    compression.sha256Hex.mockImplementation(async (blob: Blob) => `sha256-${blob.size}`)
    api.initUploadSession.mockImplementation(async request => initReply(request))
    api.getUploadStatus.mockImplementation(async () => statusReply(originalInitRequest().totalBytes))
    api.getUploadPartMap.mockResolvedValue({ uploadId: uploadIds.old, uploadedRanges: [] })
    api.uploadPart.mockImplementation(async (uploadId: string, _token: string, part: number, offset: number, chunk: Blob) =>
      partReply(uploadId, part, offset, chunk.size))
    api.completeUpload.mockImplementation(async uploadId => completeReply(uploadId, originalInitRequest().totalBytes, '/uploads/complete.webp', originalInitRequest().mimeType))
    api.abortUpload.mockResolvedValue({ uploadId: uploadIds.old, status: 'aborted', uploadedPartCount: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('Flow execution guard retains the original File context while a cancelled consumer is still awaited', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), gate = deferred<void>()
    const capture = vi.spyOn(host.owner, 'capture'), onSuccess = vi.fn(), blocked = vi.fn(), resumed = vi.fn()
    let original!: ImageUploadFileCompletion
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async completion => { original = completion; await gate.promise } })
    const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess })
    await flushPromises()
    expect(original.file).toBe(file)
    const context = flow.pendingContext.value
    expect(flow.canResume.value).toBe(false)
    await flow.startUpload({ files: [fileOf(64, 'replacement.png')], attachmentInput: { ...host, origin: 'pick' }, onError: blocked })
    await flow.resumeUpload({ onFileUploaded: resumed, onError: blocked })
    expect(blocked).toHaveBeenCalledTimes(2)
    expect(blocked.mock.calls.every(([, error]) => error.message === 'upload_flow_operation_pending')).toBe(true)
    expect(flow.pendingContext.value).toBe(context)
    expect(capture).toHaveBeenCalledOnce()
    flow.cancel(); flow.clearPending()
    expect(flow.pendingContext.value).toBe(context)
    expect(flow.canResume.value).toBe(false)
    await flow.startUpload({ files: [fileOf(64, 'cancel-replacement.png')], onError: blocked })
    expect(blocked).toHaveBeenCalledTimes(3)
    expect(flow.pendingContext.value?.files[0]).toBe(file)
    expect(resumed).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    gate.resolve(); await work
    expect(onSuccess).not.toHaveBeenCalled()
    expect(original.borrow.signal.aborted).toBe(true)
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow ACK handoff uses only the immutable validated original ACK URL', async () => {
    const file = fileOf(73), original = boundAttempt(file), runtime = useImageUploadRuntime()
    const ack = completeReply(uploadIds.old, 73, '/uploads/original-ack.webp')
    api.completeUpload.mockResolvedValueOnce(ack)
    let callbackBorrow!: ImageUploadSessionBorrow
    const url = await runtime.uploadFile(file, options, { attemptBinding: original.binding,
      onSessionReady: async (borrow, completionUrl) => {
        callbackBorrow = borrow
        expect(completionUrl).toBe('/uploads/original-ack.webp')
        ack.url = '/uploads/forged-after-ack.webp'
        runtime.activeSession.uploadId = uploadIds.new
        await borrow.withSession(async facts => expect(facts.uploadId).toBe(uploadIds.old))
      } })
    expect(url).toBe('/uploads/original-ack.webp')
    expect(runtime.cleanupRequired).toBe(false)
    const recovery = await runtime.abandon().catch(error => error)
    expect(recovery.details).toContain('result_url=/uploads/original-ack.webp')
    expect(recovery.details).not.toContain('forged-after-ack')
    expect(callbackBorrow.signal.aborted).toBe(true)
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow ACK handoff never writes an old late result into a replacement document owner', async () => {
    const file = fileOf(73), host = attachmentHost(), replacement = attachmentHost()
    const replacementSource = replacement.source()
    const runtime = useImageUploadRuntime(), gate = deferred<void>(), success = vi.fn(), rejected = vi.fn()
    let completion!: ImageUploadFileCompletion
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async value => { completion = value; await gate.promise } })
    const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess: success, notifyOnError: false })
    await flushPromises()
    const snapshot = storedSnapshot(), originalKeyValue = localStorage.getItem(snapshot.key)
    host.documentOwner.updateSource('replacement source')
    await flushPromises()
    expect(completion.borrow.signal.aborted).toBe(true)
    const capture = vi.spyOn(replacement.owner, 'capture')
    const other = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: replacement.documentOwner, onFileUploaded: async () => {} })
    await other.startUpload({ files: [fileOf(64, 'replacement.png')], attachmentInput: { ...replacement, origin: 'pick' }, onError: rejected })
    expect(rejected).toHaveBeenCalledOnce()
    expect(capture).not.toHaveBeenCalled()
    expect(replacement.source()).toBe(replacementSource)
    gate.resolve(); await work
    expect(success).not.toHaveBeenCalled()
    expect(runtime.cleanupRequired).toBe(true)
    expect(localStorage.getItem(snapshot.key)).toBe(originalKeyValue)
    const recovery = await runtime.abandon().catch(error => error)
    expect(recovery.details).toContain(`upload_id=${uploadIds.old}`)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow ACK handoff rejects reentrant replacement while preserving a normal fulfilled void consumer', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const capture = vi.spyOn(host.owner, 'capture'), success = vi.fn(), rejected = vi.fn()
    let flow!: ReturnType<typeof useImageUploadFlow>
    flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async completion => {
        expect(completion.file).toBe(file)
        await flow.startUpload({ files: [fileOf(64, 'reentrant.png')], attachmentInput: { ...host, origin: 'pick' }, onError: rejected })
        expect(flow.pendingContext.value?.files[0]).toBe(file)
        await expect(runtime.uploadFile(fileOf(64, 'raw-reentrant.png'), options)).rejects.toThrow('上传尝试仍在执行')
      } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess: success })
    expect(rejected).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledOnce()
    expect(success).toHaveBeenCalledWith(['/uploads/complete.webp'], { files: [file] })
    expect(runtime.cleanupRequired).toBe(false)
    expect(flow.pendingContext.value).toBeNull()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow ACK handoff retains an original session observer error before invoking the file consumer', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const failure = new Error('original-session-observer-refused'), consumer = vi.fn(), rejected = vi.fn()
    let borrow!: ImageUploadSessionBorrow
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onSessionReady: async (input, value) => {
        expect(input).toBe(file); borrow = value; throw failure
      }, onFileUploaded: consumer })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onError: rejected, notifyOnError: false })
    expect(rejected.mock.calls[0]![1]).toBe(failure)
    expect(consumer).not.toHaveBeenCalled()
    expect(borrow.signal.aborted).toBe(true)
    expect(runtime.cleanupRequired).toBe(true)
    expect(storedSnapshot().snapshot.uploadId).toBe(uploadIds.old)
    const recovery = await runtime.abandon().catch(error => error)
    expect(recovery.cause).toBe(failure)
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow ACK handoff revokes finite access without claiming to physically terminate a pending consumer', async () => {
    vi.useFakeTimers()
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), gate = deferred<void>()
    const success = vi.fn(), rejected = vi.fn()
    let borrow!: ImageUploadSessionBorrow, settled = false
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async value => { borrow = value.borrow; await gate.promise } })
    const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess: success, notifyOnError: false })
      .finally(() => { settled = true })
    await flushPromises()
    const snapshot = storedSnapshot(), context = flow.pendingContext.value
    await vi.advanceTimersByTimeAsync(30_001)
    expect(borrow.signal.aborted).toBe(true)
    expect(settled).toBe(false)
    expect(flow.canResume.value).toBe(false)
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('上传尝试仍在执行')
    await flow.startUpload({ files: [fileOf(64, 'other.png')], onError: rejected })
    expect(rejected).toHaveBeenCalledOnce()
    expect(flow.pendingContext.value).toBe(context)
    gate.resolve(); await work
    expect(settled).toBe(true)
    expect(success).not.toHaveBeenCalled()
    expect(runtime.cleanupRequired).toBe(true)
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow consumer recovery retains the original ACK snapshot error and File when the consumer fails', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const failure = new Error('original-flow-consumer-failed'), onError = vi.fn(), onSuccess = vi.fn()
    let original!: ReturnType<typeof storedSnapshot>, completion!: ImageUploadFileCompletion
    api.completeUpload.mockImplementationOnce(async id => {
      original = storedSnapshot()
      return completeReply(id, 73)
    })
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async value => {
        completion = value
        expect(value.file).toBe(file)
        expect(value.url).toBe('/uploads/complete.webp')
        await value.borrow.withSession(async facts => {
          expect(facts.uploadId).toBe(uploadIds.old)
          expect(facts.uploadToken).toBe('token-old')
          expect(facts.commitMayHaveStarted).toBe(true)
        })
        throw failure
      } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onError, onSuccess, notifyOnError: false })
    expect(onError.mock.calls[0]![1]).toBe(failure)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.canResume).toBe(false)
    expect(runtime.phase).toBe('error')
    expect(runtime.statusText).toContain('upload_completion_recovery_required')
    expect(runtime.activeSession).toEqual({ uploadId: '', resumeKey: '', fileName: '' })
    expect(completion.borrow.signal.aborted).toBe(true)
    expect(localStorage.getItem(original.key)).not.toBeNull()
    expect(storedSnapshot().snapshot).toEqual(original.snapshot)
    expect(flow.pendingContext.value?.files[0]).toBe(file)
    const context = flow.pendingContext.value
    flow.clearPending()
    expect(flow.pendingContext.value).toBe(context)
    expect(flow.canResume.value).toBe(false)
    for (let index = 0; index < 2; index++) {
      const error = await runtime.abandon().catch(error => error)
      expect(error.message).toBe('upload_completion_recovery_required')
      expect(error.cause).toBe(failure)
      expect(error.details).toContain(`upload_id=${uploadIds.old}`)
      await expect(runtime.resumeLatest()).rejects.toThrow('upload_completion_recovery_required')
      await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('upload_completion_recovery_required')
    }
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow consumer recovery refuses duplicate start resume and reupload while the original consumer is pending', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), gate = deferred<void>()
    const capture = vi.spyOn(host.owner, 'capture'), onSuccess = vi.fn(), duplicateError = vi.fn(), resumedConsumer = vi.fn()
    let consumer!: ImageUploadFileCompletion
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async value => { consumer = value; await gate.promise } })
    const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess })
    await flushPromises()
    expect(consumer.file).toBe(file)
    const context = flow.pendingContext.value
    await flow.startUpload({ files: [fileOf(64, 'replacement.png')], attachmentInput: { ...host, origin: 'pick' }, onError: duplicateError, notifyOnError: false })
    await flow.resumeUpload({ onFileUploaded: resumedConsumer, onError: duplicateError })
    expect(duplicateError).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledOnce()
    expect(flow.pendingContext.value).toBe(context)
    expect(resumedConsumer).not.toHaveBeenCalled()
    await expect(runtime.uploadFile(fileOf(64, 'direct.png'), options)).rejects.toThrow('上传尝试仍在执行')
    flow.clearPending()
    expect(flow.pendingContext.value).toBe(context)
    gate.resolve(); await work
    expect(onSuccess).toHaveBeenCalledOnce()
    expect(runtime.cleanupRequired).toBe(false)
    expect(consumer.borrow.signal.aborted).toBe(true)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it.each(['cancel-resolve', 'cancel-reject', 'intent-cancel', 'dispose', 'abandon'] as const)(
    'Flow consumer recovery keeps the original obligation after %s and rejects late completion', async action => {
      const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), gate = deferred<void>()
      const onSuccess = vi.fn(), lateFailure = new Error('original-late-consumer-failure')
      let consumer!: ImageUploadFileCompletion, original!: ReturnType<typeof storedSnapshot>
      api.completeUpload.mockImplementationOnce(async id => { original = storedSnapshot(); return completeReply(id, 73) })
      const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
        taskRegistry: host.documentOwner, onFileUploaded: async value => { consumer = value; await gate.promise } })
      const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess, notifyOnError: false })
      await flushPromises()
      expect(consumer.file).toBe(file)
      if (action.startsWith('cancel')) flow.cancel()
      else if (action === 'intent-cancel') consumer.intent.cancel()
      else if (action === 'dispose') host.documentOwner.dispose()
      else await expect(runtime.abandon()).rejects.toThrow('upload_completion_recovery_required')
      await flushPromises()
      expect(runtime.cleanupRequired).toBe(true)
      expect(api.abortUpload).not.toHaveBeenCalled()
      expect(consumer.borrow.signal.aborted).toBe(true)
      expect(storedSnapshot().snapshot).toEqual(original.snapshot)
      const context = flow.pendingContext.value
      await flow.startUpload({ files: [fileOf(64, 'other.png')], onError: vi.fn(), notifyOnError: false })
      expect(flow.pendingContext.value).toBe(context)
      if (action === 'cancel-reject') gate.reject(lateFailure)
      else gate.resolve()
      await work
      expect(onSuccess).not.toHaveBeenCalled()
      expect(runtime.cleanupRequired).toBe(true)
      expect(storedSnapshot().snapshot).toEqual(original.snapshot)
      const recovery = await runtime.abandon().catch(error => error)
      expect(recovery.message).toBe('upload_completion_recovery_required')
      if (action === 'cancel-reject') expect(recovery.cause).toBe(lateFailure)
      await expect(runtime.uploadFile(file, options)).rejects.toThrow('upload_completion_recovery_required')
      expect(api.initUploadSession).toHaveBeenCalledOnce()
      expect(api.completeUpload).toHaveBeenCalledOnce()
      expect(api.abortUpload).not.toHaveBeenCalled()
    })

  it('Flow consumer recovery keeps the ACK when a consumer settles after the original loan deadline', async () => {
    vi.useFakeTimers()
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), gate = deferred<void>()
    const onSuccess = vi.fn(), onError = vi.fn()
    let consumer!: ImageUploadFileCompletion, original!: ReturnType<typeof storedSnapshot>
    api.completeUpload.mockImplementationOnce(async id => { original = storedSnapshot(); return completeReply(id, 73) })
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async value => { consumer = value; await gate.promise } })
    const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, onSuccess, onError, notifyOnError: false })
    await flushPromises()
    expect(consumer.file).toBe(file)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(consumer.borrow.signal.aborted).toBe(true)
    gate.resolve(); await work
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(runtime.cleanupRequired).toBe(true)
    expect(storedSnapshot().snapshot).toEqual(original.snapshot)
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow consumer recovery does not persist a new token or accept mutable public state as release acknowledgement', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), failure = new Error('consumer refused')
    const writes = vi.spyOn(window.localStorage, 'setItem')
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => { throw failure } })
    try {
      await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
      expect(writes.mock.calls.filter(([key]) => key.startsWith('fsus:image-upload-session:'))).toHaveLength(1)
      runtime.cleanupRequired = false
      runtime.activeSession.uploadId = uploadIds.new
      await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('upload_completion_recovery_required')
      const error = await runtime.abandon().catch(error => error)
      expect(error.cause).toBe(failure)
      expect(error.details).toContain(`upload_id=${uploadIds.old}`)
      expect(runtime.cleanupRequired).toBe(true)
      expect(api.initUploadSession).toHaveBeenCalledOnce()
      expect(api.abortUpload).not.toHaveBeenCalled()
    } finally { writes.mockRestore() }
  })


  it('Independent Flow recovery public flag reset must not clear or replace original File context', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const failure = new Error('independent-original-consumer-refused'), capture = vi.spyOn(host.owner, 'capture')
    const rejected = vi.fn()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => { throw failure } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    const context = flow.pendingContext.value, snapshot = storedSnapshot()
    expect(runtime.cleanupRequired).toBe(true)
    expect(context?.files[0]).toBe(file)
    expect(capture).toHaveBeenCalledOnce()
    // Same writable public-state reset as the original retained author control.
    // It is not a canonical receiver or release acknowledgement.
    runtime.cleanupRequired = false
    flow.clearPending()
    expect.soft(flow.pendingContext.value === context).toBe(true)
    await flow.startUpload({ files: [fileOf(64, 'independent-replacement.png')],
      attachmentInput: { ...host, origin: 'pick' }, onError: rejected, notifyOnError: false })
    expect.soft(capture.mock.calls.length).toBe(1)
    expect.soft(flow.pendingContext.value === context).toBe(true)
    expect.soft(flow.pendingContext.value?.files[0] === file).toBe(true)
    expect(rejected).toHaveBeenCalledOnce()
    expect(rejected.mock.calls[0]![1].message).toBe('upload_completion_recovery_required')
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    const recovery = await runtime.abandon().catch(error => error)
    expect(recovery.cause).toBe(failure)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it.each([false, true])('Flow private recovery admission keeps the original context under public cleanup flag %s', async value => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const failure = new Error('original-private-obligation'), capture = vi.spyOn(host.owner, 'capture')
    const resumed = vi.fn(), rejected = vi.fn(), replacementConsumer = vi.fn()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => { throw failure } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    const context = flow.pendingContext.value, snapshot = storedSnapshot()
    runtime.cleanupRequired = value
    expect.soft(flow.canResume.value).toBe(false)
    flow.clearPending()
    expect.soft(flow.pendingContext.value === context).toBe(true)
    await flow.resumeUpload({ onError: resumed, onFileUploaded: replacementConsumer })
    expect.soft(resumed).toHaveBeenCalledOnce()
    expect.soft(resumed.mock.calls[0]?.[1]?.message).toBe('upload_completion_recovery_required')
    expect.soft(resumed.mock.calls[0]?.[1]?.cause).toBeUndefined()
    await flow.startUpload({ files: [fileOf(64, 'replacement.png')], onError: rejected, notifyOnError: false })
    expect.soft(rejected).toHaveBeenCalledOnce()
    expect.soft(rejected.mock.calls[0]?.[1]?.message).toBe('upload_completion_recovery_required')
    expect.soft(rejected.mock.calls[0]?.[1]?.cause).toBeUndefined()
    expect.soft(flow.pendingContext.value === context).toBe(true)
    expect.soft(flow.pendingContext.value?.files[0] === file).toBe(true)
    runtime.cleanupRequired = !value
    flow.clearPending()
    expect.soft(flow.canResume.value).toBe(false)
    expect.soft(flow.pendingContext.value === context).toBe(true)
    expect(replacementConsumer).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledOnce()
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    const recovery = await runtime.abandon().catch(error => error)
    expect(recovery.cause).toBe(failure)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow private recovery admission refuses fresh original anchor capture after public flag reset', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const failure = new Error('original-consumer-refused'), capture = vi.spyOn(host.owner, 'capture'), rejected = vi.fn()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => { throw failure } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    const context = flow.pendingContext.value, snapshot = storedSnapshot(), source = host.source()
    // Obtain a genuine current anchor after the first source insertion, not the old stale anchor.
    const anchors = new ArticleAnchorContextAdapter(host.documentOwner)
    const anchor = anchors.capture(host.getBinding(), { start: 0, end: 0, direction: 'none' },
      { affinity: 'after', viewportOffset: 0, percentage: 0, surface: 'source', tool: 'none' })
    expect(host.documentOwner.isCurrentContext(anchor.document)).toBe(true)
    runtime.cleanupRequired = false
    await flow.startUpload({ files: [fileOf(64, 'replacement.png')], attachmentInput: { ...host, anchor, origin: 'pick' },
      onError: rejected, notifyOnError: false })
    expect.soft(capture).toHaveBeenCalledOnce()
    expect.soft(host.source()).toBe(source)
    expect.soft(flow.pendingContext.value === context).toBe(true)
    expect.soft(flow.pendingContext.value?.files[0] === file).toBe(true)
    expect(rejected).toHaveBeenCalledOnce()
    expect(rejected.mock.calls[0]![1].message).toBe('upload_completion_recovery_required')
    expect(rejected.mock.calls[0]![1].cause).toBeUndefined()
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow private recovery admission refuses another Flow capture on the same original runtime', async () => {
    const file = fileOf(73), host = attachmentHost(), replacement = attachmentHost(), runtime = useImageUploadRuntime()
    const capture = vi.spyOn(replacement.owner, 'capture'), source = replacement.source(), rejected = vi.fn()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => { throw new Error('original-consumer-refused') } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    const context = flow.pendingContext.value, snapshot = storedSnapshot()
    runtime.cleanupRequired = false
    const other = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: replacement.documentOwner, onFileUploaded: async () => {} })
    await other.startUpload({ files: [fileOf(64, 'replacement.png')], attachmentInput: { ...replacement, origin: 'pick' },
      onError: rejected, notifyOnError: false })
    expect.soft(capture).not.toHaveBeenCalled()
    expect.soft(replacement.source()).toBe(source)
    expect.soft(other.pendingContext.value).toBeNull()
    expect(flow.pendingContext.value).toBe(context)
    expect(flow.pendingContext.value?.files[0]).toBe(file)
    expect(rejected).toHaveBeenCalledOnce()
    expect(rejected.mock.calls[0]![1].message).toBe('upload_completion_recovery_required')
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow private recovery admission stays with its original runtime when the options object is replaced', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), other = useImageUploadRuntime()
    const failure = new Error('original-runtime-obligation'), rejected = vi.fn()
    const flowOptions = { runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => { throw failure } }
    const flow = useImageUploadFlow(flowOptions)
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    const context = flow.pendingContext.value, snapshot = storedSnapshot()
    runtime.cleanupRequired = false
    flowOptions.runtime = other
    flow.clearPending()
    expect.soft(flow.pendingContext.value === context).toBe(true)
    await flow.resumeUpload({ onError: rejected })
    expect.soft(rejected).toHaveBeenCalledOnce()
    expect.soft(rejected.mock.calls[0]?.[1]?.message).toBe('upload_completion_recovery_required')
    expect.soft(rejected.mock.calls[0]?.[1]?.cause).toBeUndefined()
    expect.soft(flow.pendingContext.value?.files[0] === file).toBe(true)
    expect(other.cleanupRequired).toBe(false)
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow private recovery admission preserves normal void observers and batch success after display flag reset', async () => {
    const runtime = useImageUploadRuntime(), first = fileOf(73), host = attachmentHost(), next = attachmentHost()
    const batch = [fileOf(64, 'second.png'), fileOf(65, 'third.png')], observed: File[] = [], ready = vi.fn(), succeeded = vi.fn(), rejected = vi.fn()
    const consumer = async (completion: ImageUploadFileCompletion) => {
      await completion.borrow.withSession(async access => { expect(access.totalBytes).toBe(completion.file.size); observed.push(completion.file) })
    }
    const firstFlow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onSessionReady: async (file, borrow) => { ready(file); expect(borrow.isCurrent()).toBe(true) }, onFileUploaded: consumer })
    await firstFlow.startUpload({ files: [first], attachmentInput: { ...host, origin: 'pick' }, onSuccess: succeeded, notifyOnError: false })
    expect(firstFlow.pendingContext.value).toBeNull()
    expect(runtime.cleanupRequired).toBe(false)
    const secondFlow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: next.documentOwner, onSessionReady: async (file, borrow) => { ready(file); expect(borrow.isCurrent()).toBe(true) }, onFileUploaded: consumer })
    const capture = vi.spyOn(next.owner, 'capture')
    runtime.cleanupRequired = true
    await secondFlow.startUpload({ files: batch, attachmentInput: { ...next, origin: 'pick' }, onError: rejected, onSuccess: succeeded, notifyOnError: false })
    expect(rejected).not.toHaveBeenCalled()
    runtime.cleanupRequired = false
    expect(capture).toHaveBeenCalledOnce()
    expect(observed).toEqual([first, ...batch])
    expect(ready).toHaveBeenCalledTimes(3)
    expect(succeeded).toHaveBeenCalledTimes(2)
    expect(succeeded.mock.calls[1]![0]).toHaveLength(2)
    expect(secondFlow.pendingContext.value).toBeNull()
    expect(runtime.cleanupRequired).toBe(false)
    expect(api.initUploadSession).toHaveBeenCalledTimes(3)
    expect(api.completeUpload).toHaveBeenCalledTimes(3)
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'clone', 'proxy', 'inherited'] as const)('Flow private recovery reader fails closed for a nonoriginal %s instance before any capture', async kind => {
    const runtime = useImageUploadRuntime(), host = attachmentHost(), capture = vi.spyOn(host.owner, 'capture')
    const get = vi.fn((target: typeof runtime, key: PropertyKey, receiver: unknown) => Reflect.get(target, key, receiver))
    const candidate = kind === 'unknown' ? {} : kind === 'clone' ? { ...runtime }
      : kind === 'proxy' ? new Proxy(runtime, { get }) : Object.create(runtime)
    const facade = candidate as ReturnType<typeof useImageUploadRuntime>, rejected = vi.fn(), consumer = vi.fn()
    runtime.cleanupRequired = true
    expect(getImageUploadRuntimeAdmissionError(runtime)).toBeNull()
    runtime.cleanupRequired = false
    const error = getImageUploadRuntimeAdmissionError(facade)!
    expect(error.code).toBe('Conflict')
    expect(error.message).toBe('upload_runtime_authority_unavailable')
    expect(error.cause).toBeUndefined()
    expect(error.details).toBeUndefined()
    Object.defineProperty(error, 'message', { value: 'forged-release' })
    expect(getImageUploadRuntimeAdmissionError(facade)?.message).toBe('upload_runtime_authority_unavailable')
    const flow = useImageUploadFlow({ runtime: facade, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: consumer })
    await flow.startUpload({ files: [fileOf(73)], attachmentInput: { ...host, origin: 'pick' }, onError: rejected, notifyOnError: false })
    flow.clearPending()
    await flow.resumeUpload({ onError: rejected })
    expect(rejected).toHaveBeenCalledTimes(2)
    expect(rejected.mock.calls.every(([, value]) => value.message === 'upload_runtime_authority_unavailable')).toBe(true)
    expect(flow.pendingContext.value).toBeNull()
    expect(flow.canResume.value).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    expect(consumer).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(api.initUploadSession).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow private recovery reader returns fresh diagnostics without exposing original File token ACK or callback payload', async () => {
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime()
    const acknowledgement = completeReply(uploadIds.old, 73)
    api.completeUpload.mockResolvedValueOnce(acknowledgement)
    let originalPayload!: { file: File; uploadToken: string; acknowledgement: typeof acknowledgement }
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async completion => {
        await completion.borrow.withSession(async access => {
          originalPayload = { file: completion.file, uploadToken: access.uploadToken, acknowledgement }
          throw originalPayload
        })
      } })
    await flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    const context = flow.pendingContext.value, snapshot = storedSnapshot(), first = getImageUploadRuntimeAdmissionError(runtime)!
    expect(first.message).toBe('upload_completion_recovery_required')
    expect(first.cause).toBeUndefined()
    expect(first.details).toBeUndefined()
    expect(Object.values(first)).not.toContain(file)
    expect(Object.values(first)).not.toContain(acknowledgement)
    expect(JSON.stringify(first)).not.toContain(originalPayload.uploadToken)
    Object.defineProperty(first, 'message', { value: 'forged-recovery-release' })
    runtime.cleanupRequired = false
    flow.clearPending()
    const second = getImageUploadRuntimeAdmissionError(runtime)!
    expect(second).not.toBe(first)
    expect(second.message).toBe('upload_completion_recovery_required')
    expect(second.cause).toBeUndefined()
    expect(second.details).toBeUndefined()
    expect(flow.pendingContext.value).toBe(context)
    expect(flow.pendingContext.value?.files[0]).toBe(file)
    expect(storedSnapshot().snapshot).toEqual(snapshot.snapshot)
    const recovery = await runtime.abandon().catch(error => error)
    expect(recovery.cause).toBe(originalPayload)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('Flow private recovery reader observes the live original precomplete cancellation obligation and its actual abort ACK', async () => {
    vi.useFakeTimers()
    const file = fileOf(73), host = attachmentHost(), runtime = useImageUploadRuntime(), consumer = vi.fn()
    api.uploadPart.mockRejectedValue(new Error('part unavailable'))
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: consumer })
    const work = flow.startUpload({ files: [file], attachmentInput: { ...host, origin: 'pick' }, notifyOnError: false })
    await vi.runAllTimersAsync(); await work; vi.useRealTimers()
    const context = flow.pendingContext.value
    expect(flow.canResume.value).toBe(true)
    expect(getImageUploadRuntimeAdmissionError(runtime)).toBeNull()
    const abort = deferred<{ uploadId: string; status: string }>()
    api.abortUpload.mockReturnValueOnce(abort.promise)
    const cleanup = runtime.abandon()
    await flushPromises()
    expect(flow.canResume.value).toBe(false)
    expect(getImageUploadRuntimeAdmissionError(runtime)?.message).toContain('上传会话尚未取消')
    runtime.cleanupRequired = false
    flow.clearPending()
    expect(flow.pendingContext.value).toBe(context)
    expect(flow.pendingContext.value?.files[0]).toBe(file)
    expect(flow.canResume.value).toBe(false)
    abort.resolve({ uploadId: uploadIds.old, status: 'aborted' }); await cleanup
    expect(getImageUploadRuntimeAdmissionError(runtime)).toBeNull()
    expect(flow.canResume.value).toBe(true)
    expect(flow.pendingContext.value).toBe(context)
    expect(consumer).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(api.abortUpload).toHaveBeenCalledExactlyOnceWith(uploadIds.old, undefined, 'token-old')
  })

  it.each([
    ['reviewer-258-byte', 'é'.repeat(127) + '.png'],
    ['ascii-257-byte', 'a'.repeat(253) + '.png'],
    ['split-codepoint', 'a'.repeat(255) + 'é'],
    ['four-byte-overflow', '😀'.repeat(64) + '.png'],
    ['unpaired-surrogate', 'a\uD800.png'],
    ['embedded-nul', 'a\0.png']
  ])('refuses unrepresentable upload filename %s before init and leaves no cancellation obligation', async (_label, name) => {
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(fileOf(128, name), options, { bypassCompression: true, targetFormat: 'png' }))
      .rejects.toThrow('upload_file_name_not_representable')
    expect(api.initUploadSession).not.toHaveBeenCalled()
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(runtime.cleanupRequired).toBe(false)
    await runtime.abandon(); await runtime.abandon()
    expect(api.abortUpload).not.toHaveBeenCalled()
    await expect(runtime.uploadFile(fileOf(128, 'replacement.png'), options)).resolves.toBe('/uploads/complete.webp')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['ascii', 'a'.repeat(252) + '.png'],
    ['two-byte', 'é'.repeat(126) + '.png'],
    ['four-byte', '😀'.repeat(63) + '.png']
  ])('accepts a lossless 256-byte upload filename %s without changing its identity', async (_label, name) => {
    expect(new TextEncoder().encode(name)).toHaveLength(256)
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(fileOf(128, name), options, { bypassCompression: true, targetFormat: 'png' }))
      .resolves.toBe('/uploads/complete.webp')
    expect(originalInitRequest().fileName).toBe(name)
    expect(api.uploadPart).toHaveBeenCalledWith(uploadIds.old, 'token-old', 0, 0, expect.any(Blob), 'sha256-128')
    expect(api.completeUpload).toHaveBeenCalledWith(uploadIds.old, 'token-old', 'sha256-128')
  })

  it('checks the actual compressed filename before creating an init obligation', async () => {
    compression.compressImageFileWithRuntime.mockResolvedValueOnce({ file: fileOf(128, 'é'.repeat(127) + '.png'), preview })
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(fileOf(128, 'source.png'), options)).rejects.toThrow('upload_file_name_not_representable')
    expect(api.initUploadSession).not.toHaveBeenCalled()
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('cancels a lossless boundary filename using only the original late init ID and token', async () => {
    const file = fileOf(128, 'é'.repeat(126) + '.png')
    const init = deferred<ReturnType<typeof initReply>>()
    api.initUploadSession.mockReturnValueOnce(init.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { bypassCompression: true, targetFormat: 'png' })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    const request = originalInitRequest()
    const cancellation = runtime.abandon()
    const repeated = runtime.abandon()
    runtime.activeSession.uploadId = uploadIds.new
    expect(api.abortUpload).not.toHaveBeenCalled()
    api.abortUpload.mockResolvedValueOnce({ uploadId: uploadIds.originalLate, status: 'aborted' })
    init.resolve(initReply(request, uploadIds.originalLate, 'boundary-original-token'))
    await cancellation; await repeated; await rejected
    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.originalLate, undefined, 'boundary-original-token')
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.cleanupRequired).toBe(false)
    expect(runtime.phase).toBe('idle')
    expect(localStorage.length).toBe(0)
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledOnce()
  })

  it('rejects a zero GUID init before snapshot or part IO and cannot grant cancellation authority', async () => {
    api.initUploadSession.mockImplementationOnce(async request => initReply(request, '0'.repeat(32)))
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(fileOf(128), options)).rejects.toThrow('upload_init_response_mismatch')
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(runtime.cleanupRequired).toBe(true)
    await expect(runtime.abandon()).rejects.toThrow('upload_init_response_mismatch')
    await expect(runtime.abandon()).rejects.toThrow('upload_init_response_mismatch')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('rejects a zero GUID stored identity without status lookup or replacement init', async () => {
    const file = fileOf(128)
    await exhaustPartRetries(useImageUploadRuntime(), file)
    const stored = storedSnapshot()
    localStorage.setItem(stored.key, encodePublicAotPayload({ ...stored.snapshot, uploadId: '0'.repeat(32) }))
    const original = localStorage.getItem(stored.key)
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('upload_resume_snapshot_mismatch')
    expect(api.getUploadStatus).not.toHaveBeenCalled()
    expect(api.getUploadPartMap).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem(stored.key)).toBe(original)
    expect(runtime.cleanupRequired).toBe(true)
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('runs compression and hashing before init, uploads every required part, then completes once', async () => {
    const events: string[] = []
    const file = fileOf(600_000)
    compression.compressImageFileWithRuntime.mockImplementation(async (input: File) => {
      events.push('compress')
      return { file: input, preview }
    })
    compression.sha256Hex.mockImplementation(async (blob: Blob) => {
      events.push(blob === file ? 'hash-file' : 'hash-part')
      return `sha256-${blob.size}`
    })
    api.initUploadSession.mockImplementation(async () => {
      events.push('init')
      return initReply(file, uploadIds.fresh, 'token-fresh')
    })
    api.uploadPart.mockImplementation(async (_id: string, _token: string, part: number, offset: number, chunk: Blob) => {
      events.push(`part-${part}`)
      return partReply(_id, part, offset, chunk.size)
    })
    api.completeUpload.mockImplementation(async () => {
      events.push('complete')
      return completeReply(uploadIds.fresh, file.size, '/uploads/fresh.webp')
    })

    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { wasmOnly: true })).resolves.toBe('/uploads/fresh.webp')

    expect(events).toEqual(['compress', 'hash-file', 'init', 'hash-part', 'part-0', 'hash-part', 'part-1', 'complete'])
    expect(api.uploadPart).toHaveBeenNthCalledWith(1, uploadIds.fresh, 'token-fresh', 0, 0, expect.any(Blob), 'sha256-524288')
    expect(api.uploadPart).toHaveBeenNthCalledWith(2, uploadIds.fresh, 'token-fresh', 1, 524_288, expect.any(Blob), 'sha256-75712')
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledWith(uploadIds.fresh, 'token-fresh', 'sha256-600000')
    expect(runtime.phase).toBe('completed')
    expect(runtime.progress).toBe(100)
    expect(runtime.activeSession.uploadId).toBe('')
    expect(localStorage.length).toBe(0)
    await expect(runtime.resumeLatest()).rejects.toThrow('没有可恢复的上传任务')
  })

  it('pauses after part retry exhaustion while retaining the resumable attempt and snapshot', async () => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))

    expect(api.uploadPart).toHaveBeenCalledTimes(3)
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.phase).toBe('paused')
    expect(runtime.errorMessage).toContain('part unavailable')
    expect(runtime.canResume).toBe(true)
    expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
    expect(storedSnapshot().snapshot).toMatchObject({ uploadId: uploadIds.old, uploadToken: 'token-old' })
  })

  it('resumes the same file and options with the stored identity and uploads only missing parts', async () => {
    const file = fileOf(600_000)
    const runtime = useImageUploadRuntime()
    vi.useFakeTimers()
    api.uploadPart
      .mockResolvedValueOnce(partReply(uploadIds.old, 0, 0, 524_288))
      .mockRejectedValue(new Error('part one unavailable'))
    const firstUpload = runtime.uploadFile(file, options, { wasmOnly: true })
    const firstRejection = expect(firstUpload).rejects.toThrow('part one unavailable')
    await vi.runAllTimersAsync()
    await firstRejection
    vi.useRealTimers()

    const firstStorageKey = storedSnapshot().key
    api.uploadPart.mockReset().mockResolvedValue(partReply(uploadIds.old, 1, 524_288, 75_712))
    api.getUploadStatus.mockResolvedValue(statusReply(600_000, 1, 524_288, 1))
    api.getUploadPartMap.mockResolvedValue({ uploadId: uploadIds.old, uploadedRanges: [{ start: 0, end: 0 }] })

    await expect(runtime.resumeLatest()).resolves.toBe('/uploads/complete.webp')

    expect(compression.compressImageFileWithRuntime).toHaveBeenLastCalledWith(file, options, { wasmOnly: true })
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.getUploadStatus).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(api.getUploadPartMap).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(api.uploadPart).toHaveBeenCalledOnce()
    expect(api.uploadPart).toHaveBeenCalledWith(uploadIds.old, 'token-old', 1, 524_288, expect.any(Blob), 'sha256-75712')
    expect(api.completeUpload).toHaveBeenCalledWith(uploadIds.old, 'token-old', 'sha256-600000')
    expect(Object.keys(localStorage)).not.toContain(firstStorageKey)
  })

  it('initializes a new identity when a stored snapshot is tampered', async () => {
    // Retain this regression identity; unknown identity now preserves its real original obligation.
    const file = fileOf(128)
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, file)
    const { key, snapshot } = storedSnapshot()
    const tampered = encodePublicAotPayload({ ...snapshot, uploadId: uploadIds.new })
    localStorage.setItem(key, tampered)
    api.getUploadStatus.mockClear()
    api.uploadPart.mockClear()
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_resume_snapshot_mismatch')
    expect(api.getUploadStatus).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
    expect(localStorage.getItem(key)).toBe(tampered)
    expect(runtime.cleanupRequired).toBe(true)
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
  })

  it('initializes a new identity when stored-session status lookup fails', async () => {
    // Retain this regression identity; failed lookup cannot prove the original session is absent.
    const file = fileOf(128)
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, file)
    const { key } = storedSnapshot()
    const before = localStorage.getItem(key)
    const failure = new Error('stale session')
    api.getUploadStatus.mockRejectedValue(failure)
    api.uploadPart.mockClear()
    await expect(runtime.resumeLatest()).rejects.toBe(failure)
    expect(api.getUploadStatus).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.cleanupRequired).toBe(true)
    expect(localStorage.getItem(key)).toBe(before)
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
  })

  it('clears local state and calls abort once even when abort fails', async () => {
    // Keep this canonical regression identity. Cancelled live work is cleared,
    // while failed server cleanup must retain its separate session obligation.
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    api.abortUpload.mockRejectedValue(new Error('abort unavailable'))
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())

    await expect(runtime.abandon()).rejects.toThrow('abort unavailable')
    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(runtime.phase).toBe('error')
    expect(runtime.progress).toBe(0)
    expect(runtime.errorMessage).toBe('abort unavailable')
    expect(runtime.preview).toBeNull()
    expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.canResume).toBe(false)
    expect(storedSnapshot().snapshot.uploadId).toBe(uploadIds.old)
    await expect(runtime.uploadFile(fileOf(64, 'new.png'), options)).rejects.toThrow('上传会话尚未取消')

    part.resolve(partReply(uploadIds.old, 0, 0, 128))
    await expect(upload).rejects.toThrow('upload_attempt_superseded')
    expect(api.completeUpload).not.toHaveBeenCalled()
    await expect(runtime.resumeLatest()).rejects.toThrow('没有可恢复的上传任务')
    api.abortUpload.mockResolvedValue({ uploadId: uploadIds.old, status: 'aborted', uploadedPartCount: 0 })
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledTimes(2)
    expect(runtime.cleanupRequired).toBe(false)
    expect(runtime.phase).toBe('idle')
    expect(runtime.activeSession.uploadId).toBe('')
    expect(localStorage.length).toBe(0)
  })

  it('shares an in-flight abort and blocks replacement until server cleanup is acknowledged', async () => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))
    const abort = deferred<{ uploadId: string; status: string; uploadedPartCount: number }>()
    api.abortUpload.mockReturnValue(abort.promise)
    const first = runtime.abandon()
    const second = runtime.abandon()
    expect(first).toBe(second)
    await flushPromises()
    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
    expect(runtime.canResume).toBe(false)
    await expect(runtime.uploadFile(fileOf(64, 'new.png'), options)).rejects.toThrow('上传会话尚未取消')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    abort.resolve({ uploadId: uploadIds.old, status: 'aborted', uploadedPartCount: 0 })
    await Promise.all([first, second])
    expect(runtime.cleanupRequired).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('a late part failure cannot resurrect a cancelled recovery snapshot', async () => {
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    await runtime.abandon()
    part.reject(new Error('late transport failure'))
    await rejected
    expect(runtime.phase).toBe('idle')
    expect(localStorage.length).toBe(0)
    expect(api.completeUpload).not.toHaveBeenCalled()
  })

  it('does not call the API when abandoning without an active session', async () => {
    const runtime = useImageUploadRuntime()
    await runtime.abandon()
    await runtime.abandon()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('does not let a late part acknowledgement overwrite a new upload attempt', async () => {
    const latePart = deferred<ReturnType<typeof partReply>>()
    api.initUploadSession
      .mockImplementationOnce(async request => initReply(request))
      .mockImplementationOnce(async request => initReply(request, uploadIds.new, 'token-new'))
    api.uploadPart
      .mockReturnValueOnce(latePart.promise)
      .mockResolvedValueOnce(partReply(uploadIds.new, 0, 0, 64))
    api.completeUpload.mockResolvedValue(completeReply(uploadIds.new, 64, '/uploads/new.webp'))
    const runtime = useImageUploadRuntime()
    const oldUpload = runtime.uploadFile(fileOf(128, 'old.png'), options)
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())

    await runtime.abandon()
    await expect(runtime.uploadFile(fileOf(64, 'new.png'), options)).resolves.toBe('/uploads/new.webp')
    latePart.resolve(partReply(uploadIds.old, 0, 0, 128))
    await expect(oldUpload).rejects.toThrow('upload_attempt_superseded')

    expect(api.abortUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledWith(uploadIds.new, 'token-new', 'sha256-64')
    expect(runtime.phase).toBe('completed')
    expect(runtime.progress).toBe(100)
  })

  it('borrows actual compressed facts and retains a bound handle after public session and original lease clear', async () => {
    const file = fileOf(600_000)
    const original = boundAttempt(file)
    const compressed = new File([new Uint8Array(73)], 'actual.webp', { type: 'image/webp' })
    compression.compressImageFileWithRuntime.mockResolvedValue({ file: compressed, preview })
    compression.sha256Hex.mockImplementation(async (blob: Blob) => blob === compressed ? 'a'.repeat(64) : 'b'.repeat(64))
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: async value => {
      borrow = value
      await value.withSession(async (session, signal) => {
        expect(signal.aborted).toBe(false)
        expect(signal).not.toBe(value.signal)
        expect(session.uploadId).toBe(uploadIds.old)
        expect(session.uploadToken).toBe('token-old')
        expect(session.sha256).toBe('a'.repeat(64))
        expect(session.totalBytes).toBe(73)
        expect(session.commitMayHaveStarted).toBe(true)
        expect(api.completeUpload).toHaveBeenCalledOnce()
        expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
        expect(localStorage.length).toBe(1)
        expect(Object.keys(session)).toEqual([])
        expect(() => JSON.stringify(session)).toThrow('upload_session_borrow_not_serializable')
      })
    } })
    original.binding.lease.complete()
    expect(runtime.activeSession).toEqual({ uploadId: '', resumeKey: '', fileName: '' })
    expect(localStorage.length).toBe(0)
    expect(runtime.borrowCurrentSession()).toBe(borrow)
    await borrow.withSession(async session => {
      expect(session.commitMayHaveStarted).toBe(true)
      expect(session.totalBytes).toBe(73)
      expect(session.sha256).toBe('a'.repeat(64))
    })
    expect(api.completeUpload).toHaveBeenCalledWith(uploadIds.old, 'token-old', 'a'.repeat(64))
    borrow.release()
    expect(borrow.signal.aborted).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it.each(['clone', 'foreign'] as const)('refuses a %s pending handle before creating a session', async kind => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const intent = kind === 'clone' ? { ...original.binding.intent } : boundAttempt(file).binding.intent
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: { ...original.binding, intent } }))
      .rejects.toThrow('upload_attempt_superseded')
    expect(api.initUploadSession).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it.each(['clone', 'foreign'] as const)('refuses a %s document lease through the real original registry', async kind => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const lease = kind === 'clone' ? { taskRef: original.binding.lease.taskRef,
      signal: original.binding.lease.signal, envelope: original.binding.lease.envelope,
      isCurrent: () => true, cancel: original.binding.lease.cancel.bind(original.binding.lease),
      complete: original.binding.lease.complete.bind(original.binding.lease),
      accept: original.binding.lease.accept.bind(original.binding.lease) } : boundAttempt(file).binding.lease
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: { ...original.binding, lease } }))
      .rejects.toThrow('upload_attempt_superseded')
    expect(api.initUploadSession).not.toHaveBeenCalled()
  })

  it('refuses to mint a borrow from a localStorage-only resumed session', async () => {
    const file = fileOf(128)
    const legacy = useImageUploadRuntime()
    await exhaustPartRetries(legacy, file)
    api.uploadPart.mockReset().mockResolvedValue(partReply(uploadIds.old, 0, 0, 128))
    const original = boundAttempt(file)
    const callback = vi.fn()
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { wasmOnly: true,
      attemptBinding: original.binding, onSessionReady: callback })).rejects.toThrow('upload_session_borrow_unavailable')
    expect(callback).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
    await expect(runtime.abandon()).rejects.toThrow('upload_cleanup_authority_unavailable')
    expect(runtime.cleanupRequired).toBe(true)
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('expires a completed borrow without refreshing it from public state or storage', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    vi.useFakeTimers()
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    expect(borrow.isCurrent()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(borrow.signal.aborted).toBe(true)
    await expect(borrow.withSession(async session => session.totalBytes)).rejects.toThrow('upload_attempt_superseded')
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('waits for a cancelled original initialization and real cleanup acknowledgement before replacement', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const init = deferred<ReturnType<typeof initReply>>()
    const abort = deferred<{ uploadId: string; status: string; uploadedPartCount: number }>()
    api.initUploadSession.mockReturnValue(init.promise)
    api.abortUpload.mockReturnValue(abort.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('上传尝试仍在执行')
    original.binding.lease.cancel()
    const cleanup = runtime.abandon()
    expect(runtime.cleanupRequired).toBe(true)
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('上传会话尚未取消')
    init.resolve(initReply(file, uploadIds.late, 'late-original-token'))
    await rejected
    await vi.waitFor(() => expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.late, undefined, 'late-original-token'))
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.activeSession.uploadId).toBe(uploadIds.late)
    abort.resolve({ uploadId: uploadIds.late, status: 'aborted', uploadedPartCount: 0 })
    await cleanup
    expect(runtime.cleanupRequired).toBe(false)
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('keeps unknown initialization cleanup blocked instead of fabricating an abort acknowledgement', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const init = deferred<ReturnType<typeof initReply>>()
    api.initUploadSession.mockReturnValue(init.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding })
    const rejected = expect(upload).rejects.toThrow('initialization unknown')
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    original.binding.lease.cancel()
    const cleanup = expect(runtime.abandon()).rejects.toThrow('initialization unknown')
    init.reject(new Error('initialization unknown'))
    await Promise.all([rejected, cleanup])
    expect(runtime.cleanupRequired).toBe(true)
    await expect(runtime.abandon()).rejects.toThrow('initialization unknown')
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('上传会话尚未取消')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('retains true completion history and unknown cleanup after a cancelled completion without deleting it', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const complete = deferred<ReturnType<typeof completeReply>>()
    api.completeUpload.mockReturnValue(complete.promise)
    let borrow: ImageUploadSessionBorrow | undefined
    let unavailableMap = false
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: { ...original.binding, getBinding: () => {
      const binding = original.binding.getBinding()
      return unavailableMap ? { ...binding, map: { ...binding.map, syntax: [] } } : binding
    } }, onSessionReady: value => { borrow = value } })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.completeUpload).toHaveBeenCalledOnce())
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    unavailableMap = true
    expect(runtime.borrowCurrentSession()).toBeNull()
    original.binding.lease.cancel()
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    complete.resolve(completeReply(uploadIds.old, 128, '/uploads/late.webp'))
    await rejected
    expect(runtime.cleanupRequired).toBe(true)
    expect(localStorage.length).toBe(1)
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('uses the existing flow original lease and caller cancellation without creating a second upload', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    const begin = vi.spyOn(original.binding.documentOwner, 'beginTask')
    const onSuccess = vi.fn()
    const onError = vi.fn()
    let borrow: ImageUploadSessionBorrow | undefined
    const runtime = useImageUploadRuntime()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: original.binding.documentOwner, getAttemptBinding: () => original.binding,
      onSessionReady: (_file, value) => { borrow = value } })
    const work = flow.startUpload({ files: [file], onSuccess, onError, notifyOnSuccess: false })
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    expect(begin).toHaveBeenCalledOnce()
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    flow.cancel()
    await runtime.abandon()
    part.resolve(partReply(uploadIds.old, 0, 0, 128))
    await work
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(api.abortUpload).toHaveBeenCalledOnce()
  })

  it('grants no loan on scope disposal and waits for the original part before settling', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    const scope = effectScope()
    const runtime = scope.run(() => useImageUploadRuntime())!
    let borrow: ImageUploadSessionBorrow | undefined
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    scope.stop()
    await runtime.abandon()
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    part.resolve(partReply(uploadIds.old, 0, 0, 128))
    await rejected
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('upload_attempt_superseded')
    expect(api.completeUpload).not.toHaveBeenCalled()
  })

  it('rereads original document and intent ownership after an asynchronous borrow callback', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    const read = deferred<void>()
    const work = borrow.withSession(async session => { await read.promise; return session.totalBytes })
    const rejected = expect(work).rejects.toThrow('upload_attempt_superseded')
    original.binding.documentOwner.switchDocument({ articleId: 2, draftId: 'article:2', content: original.source(), reason: 'article-switch' })
    read.resolve()
    await rejected
    expect(borrow.isCurrent()).toBe(false)
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('does not grant a legacy attempt a new deletion action on scope disposal', async () => {
    const complete = deferred<ReturnType<typeof completeReply>>()
    api.completeUpload.mockReturnValue(complete.promise)
    const scope = effectScope()
    const runtime = scope.run(() => useImageUploadRuntime())!
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.completeUpload).toHaveBeenCalledOnce())
    scope.stop()
    complete.resolve(completeReply(uploadIds.old, 128, '/uploads/legacy-late.webp'))
    await rejected
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(1)
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('invalidates a completed original borrow when a new attempt starts', async () => {
    const file = fileOf(128)
    const original = boundAttempt(file)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    await runtime.uploadFile(fileOf(64, 'new.png'), options)
    expect(borrow.signal.aborted).toBe(true)
    await expect(borrow.withSession(async session => session.uploadToken)).rejects.toThrow('upload_attempt_superseded')
    expect(api.abortUpload).not.toHaveBeenCalled()
  })
  it('revokes returned and captured access immediately after each callback settles', async () => {
    const file = fileOf(73)
    const original = boundAttempt(file)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    let captured!: ImageUploadSessionAccess
    let callbackSignal!: AbortSignal
    const escaped = await borrow.withSession(async (facts, signal) => {
      captured = facts; callbackSignal = signal
      await Promise.resolve()
      expect(facts.totalBytes).toBe(73)
      return facts
    })
    expect(escaped).toBe(captured)
    for (const key of ['uploadId', 'uploadToken', 'sha256', 'totalBytes', 'commitMayHaveStarted'] as const)
      expect(() => escaped[key]).toThrow('upload_attempt_superseded')
    expect(callbackSignal.aborted).toBe(true)
    expect(borrow.isCurrent()).toBe(true)
    await expect(borrow.withSession(async facts => { captured = facts; throw new Error('reader failed') })).rejects.toThrow('reader failed')
    expect(() => captured.uploadToken).toThrow('upload_attempt_superseded')
    borrow.release()
  })

  it('revokes concurrent access scopes independently while awaited use remains valid', async () => {
    const file = fileOf(73)
    const original = boundAttempt(file)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    const firstGate = deferred<void>(), secondGate = deferred<void>()
    let first!: ImageUploadSessionAccess, second!: ImageUploadSessionAccess
    const firstRead = borrow.withSession(async facts => { first = facts; await firstGate.promise; return facts.totalBytes })
    const secondRead = borrow.withSession(async facts => { second = facts; await secondGate.promise; return facts.totalBytes })
    firstGate.resolve()
    expect(await firstRead).toBe(73)
    expect(() => first.sha256).toThrow('upload_attempt_superseded')
    expect(second.totalBytes).toBe(73)
    secondGate.resolve()
    expect(await secondRead).toBe(73)
    expect(() => second.sha256).toThrow('upload_attempt_superseded')
    borrow.release()
  })

  it('bounds a completed callback and aborts its access signal at the fixed loan deadline', async () => {
    vi.useFakeTimers()
    const file = fileOf(73)
    const original = boundAttempt(file)
    const gate = deferred<void>()
    let access!: ImageUploadSessionAccess, signal!: AbortSignal
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value =>
      value.withSession(async (facts, scopedSignal) => { access = facts; signal = scopedSignal; await gate.promise }) })
    const failure = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await flushPromises()
    expect(access.totalBytes).toBe(73)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(signal.aborted).toBe(true)
    expect(() => access.totalBytes).toThrow('upload_attempt_superseded')
    gate.resolve()
    await failure
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.uploadPart).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    await expect(runtime.abandon()).rejects.toThrow('upload_completion_recovery_required')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(1)
  })

  it.each(['part', 'complete'] as const)('grants no loan after raw %s failure and cannot mint one from retained state', async stage => {
    vi.useFakeTimers()
    const file = fileOf(73)
    const original = boundAttempt(file)
    let borrow: ImageUploadSessionBorrow | undefined
    if (stage === 'part') api.uploadPart.mockRejectedValue(new Error('raw part failed'))
    else api.completeUpload.mockRejectedValue(new Error('raw complete failed'))
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    const failure = expect(upload).rejects.toThrow(`raw ${stage} failed`)
    await vi.runAllTimersAsync()
    await failure
    expect(original.binding.lease.isCurrent()).toBe(true)
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(storedSnapshot().snapshot.uploadToken).toBe('token-old')
    if (stage === 'complete') {
      await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
      expect(api.abortUpload).not.toHaveBeenCalled()
    } else {
      await expect(runtime.resumeLatest()).rejects.toThrow('upload_session_borrow_unavailable')
      expect(api.initUploadSession).toHaveBeenCalledOnce()
      await runtime.abandon()
    }
  })

  it('does not remint an explicitly released loan during the active completed operation', async () => {
    const file = fileOf(73)
    const original = boundAttempt(file)
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => {
      value.release()
      expect(runtime.borrowCurrentSession()).toBeNull()
    } })
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.completeUpload).toHaveBeenCalledOnce()
  })

  it('revokes a newly acquired loan when the original completion callback fails', async () => {
    const file = fileOf(73), original = boundAttempt(file)
    const runtime = useImageUploadRuntime()
    let borrow!: ImageUploadSessionBorrow
    const callbackError = new Error('completion callback failed')
    let originalSnapshot!: string
    await expect(runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: async value => {
      borrow = value
      originalSnapshot = localStorage.getItem(storedSnapshot().key)!
      await value.withSession(async facts => { expect(facts.commitMayHaveStarted).toBe(true) })
      throw callbackError
    } })).rejects.toBe(callbackError)
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(borrow.signal.aborted).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    await expect(borrow.withSession(async facts => facts.uploadToken)).rejects.toThrow('upload_attempt_superseded')
    expect(storedSnapshot().snapshot.uploadToken).toBe('token-old')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(runtime.activeSession).toEqual({ uploadId: '', resumeKey: '', fileName: '' })
    expect(runtime.canResume).toBe(false)
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.errorMessage).toContain('completion callback failed')
    expect(runtime.statusText).toContain('upload_completion_recovery_required')
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await runtime.abandon().catch(error => error)
      expect(failure.message).toBe('upload_completion_recovery_required')
      expect(failure.cause).toBe(callbackError)
      expect(failure.details).toContain(`completion_acknowledged; generation=1; upload_id=${uploadIds.old}`)
      expect(failure.details).toContain('result_url=/uploads/complete.webp')
      expect(api.abortUpload).not.toHaveBeenCalled()
      expect(localStorage.getItem(storedSnapshot().key)).toBe(originalSnapshot)
    }
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_completion_recovery_required')
    await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('upload_completion_recovery_required')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.uploadPart).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('grants no precompletion loan during a slow chunk and expires 30 seconds from actual acquisition', async () => {
    vi.useFakeTimers()
    const file = fileOf(73)
    const original = boundAttempt(file)
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    let borrow!: ImageUploadSessionBorrow
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    await flushPromises()
    expect(api.uploadPart).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(borrow).toBeUndefined()
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.completeUpload).not.toHaveBeenCalled()
    part.resolve(partReply(uploadIds.old, 0, 0, 73))
    await upload
    await borrow.withSession(async facts => { expect(facts.commitMayHaveStarted).toBe(true) })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(borrow.isCurrent()).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(borrow.isCurrent()).toBe(false)
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('captures real per-file handles and consumes slow same-name batch files before advancing', async () => {
    vi.useFakeTimers()
    const files = [fileOf(73, 'same.png'), fileOf(73, 'same.png')]
    const host = attachmentHost()
    const capture = vi.spyOn(host.owner, 'capture'), commit = vi.spyOn(host.owner, 'commitCreated')
    const firstConsumer = deferred<void>()
    const firstPart = deferred<ReturnType<typeof partReply>>(), secondPart = deferred<ReturnType<typeof partReply>>()
    const loans: ImageUploadSessionBorrow[] = []
    const observed: File[] = []
    const runtime = useImageUploadRuntime()
    api.initUploadSession.mockImplementation(async request => initReply(request, String(api.initUploadSession.mock.calls.length).padStart(32, '0')))
    api.uploadPart.mockReturnValueOnce(firstPart.promise).mockReturnValueOnce(secondPart.promise)
    const onSuccess = vi.fn(), onError = vi.fn()
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner })
    const onFileUploaded = async ({ file, intent, borrow }: ImageUploadFileCompletion) => {
        const index = observed.length
        expect(file).toBe(files[index])
        expect(intent).toBe(commit.mock.results[0]!.value[index])
        expect(intent.snapshot.intent).toBe(capture.mock.results[0]!.value.handles[index].intent)
        expect(host.owner.readOwnedIntent(intent, host.getBinding())?.current).toBe(true)
        if (index) expect(loans[0]!.signal.aborted).toBe(true)
        observed.push(file); loans.push(borrow)
        await borrow.withSession(async facts => {
          expect(facts.commitMayHaveStarted).toBe(true)
          expect(facts.totalBytes).toBe(73)
          if (!index) await firstConsumer.promise
          expect(facts.uploadId).toBe(String(index + 1).padStart(32, '0'))
        })
      }
    const upload = flow.startUpload({ files, attachmentInput: { ...host, origin: 'pick' }, onFileUploaded, onSuccess, onError })
    await flushPromises()
    expect(api.uploadPart).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(31_001)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(observed).toHaveLength(0)
    firstPart.resolve(partReply('00000000000000000000000000000001', 0, 0, 73))
    await flushPromises()
    expect(observed).toEqual([files[0]])
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
    firstConsumer.resolve()
    await flushPromises()
    expect(api.uploadPart).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(31_001)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(observed).toHaveLength(1)
    secondPart.resolve(partReply('00000000000000000000000000000002', 0, 0, 73))
    await upload
    expect(onError).not.toHaveBeenCalled()
    expect(observed[1]).toBe(files[1])
    expect(capture).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledTimes(2)
    expect(onSuccess).toHaveBeenCalledWith(['/uploads/complete.webp', '/uploads/complete.webp'], { files })
    expect(loans.every(loan => loan.signal.aborted)).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(flow.pendingContext.value).toBeNull()
    expect(host.owner.currentTaskLeases).toHaveLength(2)
    const legacySuccess = vi.fn()
    await flow.startUpload({ files: [fileOf(73, 'legacy.png')], onSuccess: legacySuccess })
    expect(legacySuccess).toHaveBeenCalledWith(['/uploads/complete.webp'], { files: expect.any(Array) })
    expect(capture).toHaveBeenCalledOnce()
    expect(observed).toHaveLength(2)
    expect(api.completeUpload).toHaveBeenCalledTimes(3)
  })

  it('grants no loan during original compression, initialization, part or pending completion', async () => {
    vi.useFakeTimers()
    const file = fileOf(73), original = boundAttempt(file)
    const compressed = deferred<{ file: File; preview: typeof preview }>()
    const init = deferred<ReturnType<typeof initReply>>()
    const part = deferred<ReturnType<typeof partReply>>(), complete = deferred<ReturnType<typeof completeReply>>()
    compression.compressImageFileWithRuntime.mockReturnValue(compressed.promise)
    api.initUploadSession.mockReturnValue(init.promise)
    api.uploadPart.mockReturnValue(part.promise)
    api.completeUpload.mockReturnValue(complete.promise)
    const runtime = useImageUploadRuntime()
    const callback = vi.fn(async (value: ImageUploadSessionBorrow) => {
      expect(api.completeUpload).toHaveBeenCalledOnce()
      expect(original.binding.lease.isCurrent()).toBe(true)
      expect(runtime.activeSession.uploadId).toBe(uploadIds.ack)
      expect(localStorage.length).toBe(1)
      await value.withSession(async facts => { expect(facts.commitMayHaveStarted).toBe(true) })
    })
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: callback })
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(callback).not.toHaveBeenCalled()
    compressed.resolve({ file, preview })
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(callback).not.toHaveBeenCalled()
    init.resolve(initReply(file, uploadIds.ack, 'token-ack'))
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(callback).not.toHaveBeenCalled()
    part.resolve(partReply(uploadIds.ack, 0, 0, 73))
    await vi.waitFor(() => expect(api.completeUpload).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(31_001)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(callback).not.toHaveBeenCalled()
    complete.resolve(completeReply(uploadIds.ack, 73, '/uploads/ack.webp'))
    expect(await upload).toBe('/uploads/ack.webp')
    expect(callback).toHaveBeenCalledOnce()
    runtime.borrowCurrentSession()!.release()
  })

  it('cannot acquire a first loan after the original successful operation is inactive', async () => {
    const file = fileOf(73), original = boundAttempt(file)
    const runtime = useImageUploadRuntime()
    await runtime.uploadFile(file, options, { attemptBinding: original.binding })
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(runtime.activeSession.uploadId).toBe('')
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('does not refresh the acquisition deadline when a later access scope starts', async () => {
    vi.useFakeTimers()
    const file = fileOf(73), original = boundAttempt(file)
    const runtime = useImageUploadRuntime()
    let borrow!: ImageUploadSessionBorrow
    await runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => { borrow = value } })
    await vi.advanceTimersByTimeAsync(29_000)
    const gate = deferred<void>()
    let access!: ImageUploadSessionAccess, signal!: AbortSignal
    const read = borrow.withSession(async (facts, scopedSignal) => {
      access = facts; signal = scopedSignal; await gate.promise; return facts.totalBytes
    })
    const failure = expect(read).rejects.toThrow('upload_attempt_superseded')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(borrow.signal.aborted).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(() => access.totalBytes).toThrow('upload_attempt_superseded')
    expect(runtime.borrowCurrentSession()).toBeNull()
    gate.resolve()
    await failure
    expect(runtime.borrowCurrentSession()).toBeNull()
  })

  it('revokes a granted completion loan when its active original lease is cancelled', async () => {
    const file = fileOf(73), original = boundAttempt(file)
    const runtime = useImageUploadRuntime(), gate = deferred<void>()
    let borrow!: ImageUploadSessionBorrow, access!: ImageUploadSessionAccess
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: value => {
      borrow = value
      return value.withSession(async facts => { access = facts; await gate.promise; expect(facts.totalBytes).toBe(73) })
    } })
    const failure = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(borrow).toBeDefined())
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(access.commitMayHaveStarted).toBe(true)
    original.binding.lease.cancel()
    expect(borrow.signal.aborted).toBe(true)
    expect(() => access.uploadToken).toThrow('upload_attempt_superseded')
    expect(runtime.borrowCurrentSession()).toBeNull()
    gate.resolve()
    await failure
    await expect(runtime.abandon()).rejects.toThrow('upload_completion_recovery_required')
    await expect(runtime.abandon()).rejects.toThrow('upload_completion_recovery_required')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(runtime.activeSession.uploadId).toBe('')
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.canResume).toBe(false)
    expect(storedSnapshot().snapshot.uploadToken).toBe('token-old')
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_completion_recovery_required')
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.completeUpload).toHaveBeenCalledOnce()
  })

  it('releases the per-file loan and stops a batch when its completion consumer fails', async () => {
    const files = [fileOf(73), fileOf(73, 'next.png')]
    const host = attachmentHost()
    const runtime = useImageUploadRuntime()
    const onError = vi.fn(), onSuccess = vi.fn()
    let borrow!: ImageUploadSessionBorrow
    const flow = useImageUploadFlow({ runtime, getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async completion => {
        borrow = completion.borrow
        throw new Error('consumer failed')
      } })
    await flow.startUpload({ files, attachmentInput: { ...host, origin: 'pick' }, onError, onSuccess, notifyOnError: false })
    expect(onError).toHaveBeenCalledOnce()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(borrow.signal.aborted).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it.each(['callback', 'returned'] as const)('keeps ACK recovery after disposal of the %s operation without aborting', async stage => {
    const file = fileOf(73), original = boundAttempt(file), gate = deferred<void>()
    const scope = effectScope(), runtime = scope.run(() => useImageUploadRuntime())!
    let borrow!: ImageUploadSessionBorrow
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: async value => {
      borrow = value
      if (stage === 'callback') await value.withSession(async facts => {
        expect(facts.commitMayHaveStarted).toBe(true)
        await gate.promise
        expect(facts.totalBytes).toBe(73)
      })
    } })
    const rejected = stage === 'callback' ? expect(upload).rejects.toThrow('upload_attempt_superseded') : null
    if (stage === 'returned') await upload
    else await vi.waitFor(() => expect(borrow).toBeDefined())
    expect(api.completeUpload).toHaveBeenCalledOnce()
    scope.stop()
    expect(borrow.signal.aborted).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    const results = await Promise.allSettled([runtime.abandon(), runtime.abandon()])
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.message).toBe('upload_completion_recovery_required')
        expect(result.reason.details).toContain(`completion_acknowledged; generation=1; upload_id=${uploadIds.old}`)
        expect(result.reason.details).toContain('result_url=/uploads/complete.webp')
      }
    }
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(runtime.activeSession).toEqual({ uploadId: '', resumeKey: '', fileName: '' })
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.canResume).toBe(false)
    if (stage === 'callback') expect(storedSnapshot().snapshot.uploadToken).toBe('token-old')
    gate.resolve()
    if (rejected) await rejected
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_completion_recovery_required')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(api.completeUpload).toHaveBeenCalledOnce()
  })

  it.each(['intent', 'document'] as const)('retains ACK history after original %s invalidation and repeated abandon', async kind => {
    const file = fileOf(73), original = boundAttempt(file), gate = deferred<void>()
    const runtime = useImageUploadRuntime()
    let borrow!: ImageUploadSessionBorrow
    const upload = runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: async value => {
      borrow = value
      await value.withSession(async facts => { expect(facts.commitMayHaveStarted).toBe(true); await gate.promise })
    } })
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(borrow).toBeDefined())
    const snapshot = localStorage.getItem(storedSnapshot().key)
    if (kind === 'intent') original.binding.intent.cancel()
    else original.binding.documentOwner.switchDocument({ articleId: 2, draftId: 'article:2', content: original.source(), reason: 'article-switch' })
    expect(borrow.signal.aborted).toBe(true)
    gate.resolve()
    await rejected
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await runtime.abandon().catch(error => error)
      expect(failure.message).toBe('upload_completion_recovery_required')
      expect(failure.cause.message).toBe('upload_attempt_superseded')
      expect(failure.details).toContain(`completion_acknowledged; generation=1; upload_id=${uploadIds.old}`)
      expect(api.abortUpload).not.toHaveBeenCalled()
      expect(localStorage.getItem(storedSnapshot().key)).toBe(snapshot)
    }
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_completion_recovery_required')
    await expect(runtime.uploadFile(file, options)).rejects.toThrow('upload_completion_recovery_required')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(runtime.canResume).toBe(false)
  })

  it('rejects a cloned capture owner before capture or upload IO', async () => {
    const files = [fileOf(73)]
    const host = attachmentHost()
    const capture = vi.spyOn(host.owner, 'capture')
    const onError = vi.fn()
    const flow = useImageUploadFlow({ runtime: useImageUploadRuntime(), getOptions: () => options, getWasmOnly: () => false,
      taskRegistry: host.documentOwner, onFileUploaded: async () => {} })
    await flow.startUpload({ files, attachmentInput: { ...host, owner: { ...host.owner } as typeof host.owner, origin: 'pick' }, onError, notifyOnError: false })
    expect(onError).toHaveBeenCalledOnce()
    expect(capture).not.toHaveBeenCalled()
    expect(api.initUploadSession).not.toHaveBeenCalled()
  })

  it.each([
    { uploadId: 'other-generation', status: 'aborted' },
    { uploadId: uploadIds.old, status: 'uploading' },
    { uploadId: uploadIds.old, status: undefined }
  ])('retains the genuine cancellation obligation on invalid ACK $uploadId/$status', async response => {
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    const saved = localStorage.getItem(localStorage.key(0)!)
    api.abortUpload.mockResolvedValue(response)
    await expect(runtime.abandon()).rejects.toThrow('upload_abort_not_acknowledged')
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved)
    await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('上传会话尚未取消')
    api.abortUpload.mockResolvedValue({ uploadId: uploadIds.old, status: 'aborted' })
    await runtime.abandon()
    expect(api.abortUpload.mock.calls).toEqual([
      [uploadIds.old, undefined, 'token-old'], [uploadIds.old, undefined, 'token-old']
    ])
    expect(runtime.cleanupRequired).toBe(false)
    expect(localStorage.length).toBe(0)
    part.resolve(partReply(uploadIds.old, 0, 0, 128)); await rejected
  })

  it('ignores public session and copied snapshot authority while retaining the original cleanup retry', async () => {
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValue(part.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    const key = localStorage.key(0)!
    const snapshot = decodePublicAotPayload<Record<string, unknown>>(localStorage.getItem(key)!)
    runtime.activeSession.uploadId = 'copied-new-generation'
    runtime.activeSession.resumeKey = 'copied-key'
    localStorage.setItem(key, encodePublicAotPayload({ ...snapshot, uploadId: 'copied-new-generation', uploadToken: 'copied-token' }))
    api.abortUpload.mockRejectedValueOnce(new Error('genuine-cleanup-failed'))
    await expect(runtime.abandon()).rejects.toThrow('genuine-cleanup-failed')
    await runtime.abandon()
    expect(api.abortUpload.mock.calls).toEqual([
      [uploadIds.old, undefined, 'token-old'], [uploadIds.old, undefined, 'token-old']
    ])
    expect(localStorage.length).toBe(0)
    part.resolve(partReply(uploadIds.old, 0, 0, 128)); await rejected
  })

  it('retains actual original init authority across a genuine resume generation without reminting it', async () => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReset().mockReturnValue(part.promise)
    const upload = runtime.resumeLatest()
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    await runtime.abandon()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(runtime.cleanupRequired).toBe(false)
    part.resolve(partReply(uploadIds.old, 0, 0, 128)); await rejected
  })

  it('retains an original init with missing credentials instead of sending an unbound abort', async () => {
    api.initUploadSession.mockImplementation(async request => initReply(request, uploadIds.old, ''))
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(fileOf(128), options)).rejects.toThrow('上传初始化缺少恢复凭证')
    await expect(runtime.abandon()).rejects.toThrow('上传初始化状态未知')
    await expect(runtime.abandon()).rejects.toThrow('上传初始化状态未知')
    expect(runtime.cleanupRequired).toBe(true)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
  })

  it('keeps old cancellation references from acquiring a replacement generation token', async () => {
    const part = deferred<ReturnType<typeof partReply>>()
    api.uploadPart.mockReturnValueOnce(part.promise)
    const runtime = useImageUploadRuntime()
    const old = runtime.uploadFile(fileOf(128), options)
    const oldRejection = expect(old).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
    const oldCancellation = runtime.abandon()
    await oldCancellation
    api.initUploadSession.mockImplementation(async request => initReply(request, uploadIds.new, 'token-new'))
    await expect(runtime.uploadFile(fileOf(64, 'next.png'), options)).resolves.toBe('/uploads/complete.webp')
    await oldCancellation
    part.resolve(partReply(uploadIds.old, 0, 0, 128)); await oldRejection
    expect(api.abortUpload.mock.calls).toEqual([[uploadIds.old, undefined, 'token-old']])
    await expect(runtime.abandon()).rejects.toThrow('upload_completion_recovery_required')
    expect(api.abortUpload).toHaveBeenCalledOnce()
  })

  it('awaits only the original unbound init and authenticates cancellation before its ACK', async () => {
    const init = deferred<ReturnType<typeof initReply>>()
    api.initUploadSession.mockReturnValueOnce(init.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.initUploadSession).toHaveBeenCalledOnce())
    const cleanup = runtime.abandon()
    runtime.activeSession.uploadId = 'forged-upload'
    await expect(runtime.uploadFile(fileOf(64, 'other.png'), options)).rejects.toThrow('上传会话尚未取消')
    expect(api.abortUpload).not.toHaveBeenCalled()
    init.resolve(initReply(fileOf(128), uploadIds.originalLate, 'original-late-token'))
    api.abortUpload.mockResolvedValue({ uploadId: uploadIds.originalLate, status: 'aborted' })
    await cleanup; await rejected
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.originalLate, undefined, 'original-late-token')
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(runtime.phase).toBe('idle')
  })

  it('refuses abort for an unbound in-flight completion and retains its unknown obligation', async () => {
    const completion = deferred<ReturnType<typeof completeReply>>()
    api.completeUpload.mockReturnValue(completion.promise)
    const runtime = useImageUploadRuntime()
    const upload = runtime.uploadFile(fileOf(128), options)
    const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
    await vi.waitFor(() => expect(api.completeUpload).toHaveBeenCalledOnce())
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    completion.resolve(completeReply(uploadIds.old, 128, '/uploads/late.webp')); await rejected
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(runtime.cleanupRequired).toBe(true)
  })

  it.each([false, true])('retains a rejected completion with bound=%s before any cancellation or replacement', async bound => {
    const error = new Error('actual-completion-network-failure')
    api.completeUpload.mockRejectedValue(error)
    const file = fileOf(128)
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, bound ? { attemptBinding: boundAttempt(file).binding } : {})).rejects.toBe(error)
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.canResume).toBe(false)
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_commit_state_unknown')
    await expect(runtime.uploadFile(fileOf(64, 'other.png'), options)).rejects.toThrow('upload_commit_state_unknown')
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(1)
  })

  it.each(['api-error', 'network', 'same-id-aborted'] as const)(
    'uses the actual abort transport for %s and retains failure evidence until genuine ACK', async outcome => {
      const part = deferred<ReturnType<typeof partReply>>()
      api.uploadPart.mockReturnValue(part.promise)
      const runtime = useImageUploadRuntime()
      const upload = runtime.uploadFile(fileOf(128), options)
      const rejected = expect(upload).rejects.toThrow('upload_attempt_superseded')
      await vi.waitFor(() => expect(api.uploadPart).toHaveBeenCalledOnce())
      const originalKey = localStorage.key(0)!
      const originalSnapshot = localStorage.getItem(originalKey)
      const actual = await vi.importActual<typeof import('@/api/upload')>('@/api/upload')
      api.abortUpload.mockImplementation(actual.abortUpload)
      privateRequestRuntime.resetForTests()
      vi.mocked(decode).mockImplementation(buffer => {
        const bytes = new Uint8Array(buffer), view = new DataView(buffer)
        expect(view.getUint32(0, true)).toBe(AEDS_MAGIC)
        expect(view.getUint8(4)).toBe(AEDS_VERSION)
        const payloadView = bytes.subarray(AEDS_HEADER_LENGTH)
        return { ok: true, frameType: view.getUint16(8, true), payload: payloadView, payloadView, textBlob: '', error: '' }
      })
      let responseKind: string = outcome
      const intercepted = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/auth/pow-challenge')) {
          const bytes = new Uint8Array(204)
          bytes.set(new TextEncoder().encode('ordinary-salt'), 0)
          bytes.set(new TextEncoder().encode('ordinary-signature'), 76)
          return new Response(encodeAedsFrame(FrameType.PowChallenge, bytes))
        }
        expect(new URL(url).pathname).toBe(`/api/binary/upload/${uploadIds.old}`)
        expect(init?.method).toBe('DELETE')
        expect(new Headers(init?.headers).get('X-Fsus-Upload-Token')).toBe('token-old')
        if (responseKind === 'network') throw new Error('ordinary-delete-network-failure')
        const bytes = new Uint8Array(responseKind === 'api-error' ? 584 : 136)
        const put = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset)
        if (responseKind === 'api-error') {
          bytes[0] = 1; bytes[1] = 1
          new DataView(bytes.buffer).setInt32(4, 403, true)
          put(8, 'original-abort-denied'); put(264, 'ordinary-test-denial'); put(520, 'ordinary-trace')
        } else { put(0, uploadIds.old); put(64, 'aborted') }
        return new Response(encodeAedsFrame(responseKind === 'api-error' ? FrameType.ApiError : FrameType.UploadStatus, bytes),
          { status: responseKind === 'api-error' ? 403 : 200 })
      })
      vi.stubGlobal('fetch', intercepted)
      try {
        if (outcome !== 'same-id-aborted') {
          await expect(runtime.abandon()).rejects.toThrow(outcome === 'api-error' ? 'original-abort-denied' : 'ordinary-delete-network-failure')
          expect(runtime.cleanupRequired).toBe(true)
          expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
          expect(localStorage.getItem(originalKey)).toBe(originalSnapshot)
          await expect(runtime.uploadFile(fileOf(64, 'other.png'), options)).rejects.toThrow('上传会话尚未取消')
          responseKind = 'same-id-aborted'
        }
        await runtime.abandon()
        expect(runtime.cleanupRequired).toBe(false)
        expect(runtime.phase).toBe('idle')
        expect(localStorage.getItem(originalKey)).toBeNull()
        expect(intercepted.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(outcome === 'same-id-aborted' ? 1 : 2)
      } finally { vi.unstubAllGlobals(); privateRequestRuntime.resetForTests() }
      part.resolve(partReply(uploadIds.old, 0, 0, 128)); await rejected
    })

  it.each([
    ['id', { uploadId: 'not-a-guid' }], ['empty-id', { uploadId: '' }],
    ['file', { fileName: 'other.png' }], ['mime', { mimeType: 'image/jpeg' }],
    ['format', { targetFormat: 'png' }], ['bytes', { totalBytes: 129 }],
    ['chunk', { chunkSize: 65_536 }], ['parts', { totalParts: 2 }],
    ['fraction', { totalBytes: 128.5 }], ['token', { uploadToken: ' ' }]
  ])('rejects uncorrelated init %s before part IO or completion access', async (_field, mismatch) => {
    const file = fileOf(128), original = boundAttempt(file)
    const response = { ...initReply(file), ...mismatch }
    api.initUploadSession.mockResolvedValue(response)
    const callback = vi.fn()
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: callback })).rejects.toThrow()
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(runtime.cleanupRequired).toBe(true)
    await expect(runtime.abandon()).rejects.toThrow()
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['id', { uploadId: uploadIds.new }], ['status', { status: 'aborted' }],
    ['bytes', { totalBytes: 129 }], ['chunk', { chunkSize: 65_536 }], ['parts', { totalParts: 2 }],
    ['negative', { uploadedBytes: -1 }], ['overflow', { uploadedBytes: 129 }],
    ['count', { uploadedPartCount: 2 }], ['fraction', { uploadedPartCount: 0.5 }],
    ['hint', { nextPartHint: 1 }], ['state', { status: 'uploaded' }]
  ])('retains the original session on uncorrelated status %s without fresh init', async (_field, mismatch) => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))
    const { key } = storedSnapshot(), saved = localStorage.getItem(key)
    api.getUploadStatus.mockResolvedValue({ ...statusReply(128), ...mismatch })
    api.uploadPart.mockClear()
    await expect(runtime.resumeLatest()).rejects.toThrow()
    expect(api.getUploadStatus).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem(key)).toBe(saved)
    expect(runtime.cleanupRequired).toBe(true)
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
  })

  it.each([
    ['id', { uploadId: uploadIds.new, uploadedRanges: [{ start: 0, end: 0 }] }],
    ['negative', { uploadedRanges: [{ start: -1, end: 0 }] }],
    ['fraction', { uploadedRanges: [{ start: 0, end: 0.5 }] }],
    ['unbounded', { uploadedRanges: [{ start: 0, end: Infinity }] }],
    ['reversed', { uploadedRanges: [{ start: 1, end: 0 }] }],
    ['out-of-bounds', { uploadedRanges: [{ start: 0, end: 2 }] }],
    ['overlap', { uploadedRanges: [{ start: 0, end: 0 }, { start: 0, end: 0 }] }],
    ['unsorted', { uploadedRanges: [{ start: 1, end: 1 }, { start: 0, end: 0 }] }],
    ['missing', { uploadedRanges: [] }], ['wrong-count', { uploadedRanges: [{ start: 0, end: 1 }] }],
    ['wrong-bytes', { uploadedRanges: [{ start: 1, end: 1 }] }], ['absent-ranges', { uploadedRanges: undefined }]
  ])('rejects invalid part-map %s before skipping any part or minting a new session', async (_field, mismatch) => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(600_000))
    const { key } = storedSnapshot(), saved = localStorage.getItem(key)
    api.getUploadStatus.mockResolvedValue(statusReply(600_000, 1, 524_288, 1))
    api.getUploadPartMap.mockResolvedValue({ uploadId: uploadIds.old, ...mismatch })
    api.uploadPart.mockClear()
    await expect(runtime.resumeLatest()).rejects.toThrow()
    expect(api.getUploadPartMap).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
    expect(api.uploadPart).not.toHaveBeenCalled()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem(key)).toBe(saved)
    expect(runtime.cleanupRequired).toBe(true)
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
  })

  it.each([
    ['id', { uploadId: uploadIds.new }], ['index', { partNumber: 1 }], ['offset', { offset: 1 }],
    ['size', { size: 127 }], ['bytes', { uploadedBytes: 129 }], ['count', { uploadedPartCount: 2 }],
    ['fraction', { offset: 0.5 }]
  ])('rejects uncorrelated part ACK %s without publishing progress or completing', async (_field, mismatch) => {
    const file = fileOf(128), original = boundAttempt(file)
    api.uploadPart.mockResolvedValue({ ...partReply(uploadIds.old, 0, 0, 128), ...mismatch })
    const callback = vi.fn(), runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: callback }))
      .rejects.toThrow('upload_part_ack_mismatch')
    expect(api.uploadPart).toHaveBeenCalledOnce()
    expect(runtime.progress).toBe(0)
    expect(runtime.phase).toBe('paused')
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(localStorage.length).toBe(1)
    await runtime.abandon()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
  })

  it.each([
    ['id', { uploadId: uploadIds.new }], ['bytes', { totalBytes: 129 }],
    ['mime', { mimeType: 'image/jpeg' }], ['url', { url: '' }], ['relative-url', { relativeUrl: '' }]
  ])('retains unknown completion on uncorrelated complete ACK %s without a loan or abort', async (_field, mismatch) => {
    const file = fileOf(128), original = boundAttempt(file)
    api.completeUpload.mockResolvedValue({ ...completeReply(uploadIds.old, 128), ...mismatch })
    const callback = vi.fn(), runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(file, options, { attemptBinding: original.binding, onSessionReady: callback }))
      .rejects.toThrow('upload_complete_ack_mismatch')
    const { key } = storedSnapshot(), saved = localStorage.getItem(key)
    expect(runtime.cleanupRequired).toBe(true)
    expect(runtime.borrowCurrentSession()).toBeNull()
    expect(callback).not.toHaveBeenCalled()
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_commit_state_unknown')
    await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('upload_commit_state_unknown')
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(api.completeUpload).toHaveBeenCalledOnce()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(localStorage.getItem(key)).toBe(saved)
  })

  it('refuses abort when an authenticated resumed status reports completion without the original complete ACK', async () => {
    const runtime = useImageUploadRuntime()
    await exhaustPartRetries(runtime, fileOf(128))
    api.getUploadStatus.mockResolvedValue({ ...statusReply(128), status: 'completed' })
    await expect(runtime.resumeLatest()).rejects.toThrow('upload_commit_state_unknown')
    await expect(runtime.abandon()).rejects.toThrow('upload_commit_state_unknown')
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.completeUpload).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(1)
  })

  it('keeps malformed cold storage unresolved after public fields are erased and repeated abandon', async () => {
    const legacy = useImageUploadRuntime()
    await exhaustPartRetries(legacy, fileOf(128))
    const { key } = storedSnapshot()
    localStorage.setItem(key, 'unparseable-upload-evidence')
    const runtime = useImageUploadRuntime()
    await expect(runtime.uploadFile(fileOf(128), options, { wasmOnly: true })).rejects.toThrow('upload_resume_snapshot_invalid')
    runtime.activeSession.uploadId = ''
    await expect(runtime.abandon()).rejects.toThrow('upload_cleanup_authority_unavailable')
    await expect(runtime.abandon()).rejects.toThrow('upload_cleanup_authority_unavailable')
    expect(runtime.cleanupRequired).toBe(true)
    expect(api.initUploadSession).toHaveBeenCalledOnce()
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe('unparseable-upload-evidence')
  })

  it.each([['status', '404'], ['status', 'network'], ['map', '404'], ['map', 'network']] as const)(
    'retains original obligations through the actual %s transport on %s', async (stage, outcome) => {
      const runtime = useImageUploadRuntime()
      await exhaustPartRetries(runtime, fileOf(600_000))
      const { key } = storedSnapshot(), saved = localStorage.getItem(key)
      api.getUploadStatus.mockResolvedValue(statusReply(600_000, 1, 524_288, 1))
      const actual = await vi.importActual<typeof import('@/api/upload')>('@/api/upload')
      if (stage === 'status') api.getUploadStatus.mockImplementation(actual.getUploadStatus)
      else api.getUploadPartMap.mockImplementation(actual.getUploadPartMap)
      privateRequestRuntime.resetForTests()
      vi.mocked(decode).mockImplementation(buffer => {
        const bytes = new Uint8Array(buffer), view = new DataView(buffer)
        expect(view.getUint32(0, true)).toBe(AEDS_MAGIC)
        expect(view.getUint8(4)).toBe(AEDS_VERSION)
        const payloadView = bytes.subarray(AEDS_HEADER_LENGTH)
        return { ok: true, frameType: view.getUint16(8, true), payload: payloadView, payloadView, textBlob: '', error: '' }
      })
      const intercepted = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/auth/pow-challenge')) {
          const bytes = new Uint8Array(204)
          bytes.set(new TextEncoder().encode('ordinary-salt'), 0)
          bytes.set(new TextEncoder().encode('ordinary-signature'), 76)
          return new Response(encodeAedsFrame(FrameType.PowChallenge, bytes))
        }
        expect(new URL(url).pathname).toBe(`/api/binary/upload/${uploadIds.old}/status${stage === 'map' ? '/parts' : ''}`)
        expect(init?.method).toBe('GET')
        expect(new Headers(init?.headers).get('X-Fsus-Upload-Token')).toBe('token-old')
        if (outcome === 'network') throw new Error('original-lookup-network-failure')
        const bytes = new Uint8Array(584)
        bytes[0] = 1; bytes[1] = 1
        new DataView(bytes.buffer).setInt32(4, 404, true)
        bytes.set(new TextEncoder().encode('UPLOAD_SESSION_NOT_FOUND'), 8)
        bytes.set(new TextEncoder().encode('ordinary-hidden-owner-or-token'), 264)
        return new Response(encodeAedsFrame(FrameType.ApiError, bytes), { status: 404 })
      })
      vi.stubGlobal('fetch', intercepted)
      api.uploadPart.mockClear()
      try {
        await expect(runtime.resumeLatest()).rejects.toThrow(outcome === '404' ? 'UPLOAD_SESSION_NOT_FOUND' : 'original-lookup-network-failure')
        expect(runtime.cleanupRequired).toBe(true)
        expect(runtime.activeSession.uploadId).toBe(uploadIds.old)
        expect(localStorage.getItem(key)).toBe(saved)
        expect(api.initUploadSession).toHaveBeenCalledOnce()
        expect(api.uploadPart).not.toHaveBeenCalled()
        expect(api.completeUpload).not.toHaveBeenCalled()
        await expect(runtime.uploadFile(fileOf(64, 'replacement.png'), options)).rejects.toThrow('上传会话尚未取消')
        await runtime.abandon()
        expect(api.abortUpload).toHaveBeenCalledWith(uploadIds.old, undefined, 'token-old')
        expect(localStorage.getItem(key)).toBeNull()
        expect(intercepted.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1)
      } finally { vi.unstubAllGlobals(); privateRequestRuntime.resetForTests() }
    })

})

describe('ImageUploadOptionsPanel upload controls', () => {
  it('shows resume and abandon only for the corresponding runtime state and wires both actions', async () => {
    const resume = vi.fn()
    const abandon = vi.fn()
    const button = defineComponent({
      emits: ['click'],
      template: '<button type="button" @click="$emit(\'click\')"><slot /></button>'
    })
    const wrapper = mount(ImageUploadOptionsPanel, {
      props: {
        options,
        statusText: '上传已暂停，可继续',
        canResume: true,
        canAbort: true,
        onResume: resume,
        onAbandon: abandon
      },
      global: {
        stubs: {
          ElButton: button,
          ElFormItem: { template: '<label><slot /></label>' },
          ElSelect: true,
          ElOption: true,
          ElSlider: true,
          ElSwitch: true
        }
      }
    })
    await flushPromises()

    const actionButtons = wrapper.findAll('button').filter((candidate) => ['继续上传', '中止上传'].includes(candidate.text()))
    expect(actionButtons.map((candidate) => candidate.text())).toEqual(['继续上传', '中止上传'])
    await actionButtons[0].trigger('click')
    await actionButtons[1].trigger('click')
    expect(resume).toHaveBeenCalledOnce()
    expect(abandon).toHaveBeenCalledOnce()

    await wrapper.setProps({ canResume: false, canAbort: false })
    expect(wrapper.text()).not.toContain('继续上传')
    expect(wrapper.text()).not.toContain('中止上传')
  })

})
