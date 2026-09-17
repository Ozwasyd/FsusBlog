import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import {
  ARTICLE_RECOVERY_JOURNAL_DATABASE,
  ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES,
  ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES,
  ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES,
  ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC,
  ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE,
  ARTICLE_RECOVERY_JOURNAL_SCHEMA,
  ARTICLE_RECOVERY_JOURNAL_STORE,
  ARTICLE_RECOVERY_JOURNAL_TTL_HOURS,
  ARTICLE_RECOVERY_JOURNAL_TTL_MS,
  ArticleRecoveryCoordinator,
  ArticleRecoveryFlushOwner,
  ArticleRecoveryJournal,
  assessArticleRecoveryDivergence,
  bindArticleRecoveryLifecycleFlush,
  createArticleRecoveryOperationRunner,
  summarizeArticleRecoveryComparison,
  type ArticleRecoveryJournalWriteInput,
  type ArticleRecoveryJournalRecord
} from '@/services/articleRecoveryJournal'

const baseInput = {
  identityId: 'admin-principal-1813',
  articleId: 42,
  tabId: 'tab-1813-primary',
  baseRevisionId: '9001',
  serverRevision: 7,
  clientRevision: 'client-1813-one',
  content: '第一行\n崩溃前未同步正文🙂'
} as const

async function rawPut(indexedDB: IDBFactory, value: unknown): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ARTICLE_RECOVERY_JOURNAL_DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ARTICLE_RECOVERY_JOURNAL_STORE)) {
        request.result.createObjectStore(ARTICLE_RECOVERY_JOURNAL_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readwrite')
    transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

async function rawGetAll(indexedDB: IDBFactory): Promise<unknown[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ARTICLE_RECOVERY_JOURNAL_DATABASE, 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readonly')
    const request = transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE).getAll()
    request.onsuccess = () => resolve(request.result as unknown[])
    request.onerror = () => reject(request.error)
  })
  database.close()
  return records
}

describe('article recovery journal', () => {
  it('persists CJK, emoji, and 100k characters as deterministic versioned plaintext UTF-8 bytes', async () => {
    const indexedDB = new IDBFactory()
    const now = 1_780_000_000_000
    const journal = new ArticleRecoveryJournal({ indexedDB, now: () => now })
    const content = '恢复🙂'.repeat(25_000)
    const expectedPayload = new TextEncoder().encode(content)

    const written = await journal.write({ ...baseInput, content })
    const firstRaw = (await rawGetAll(indexedDB))[0] as Record<string, unknown>
    await journal.write({ ...baseInput, content })
    const secondRaw = (await rawGetAll(indexedDB))[0] as Record<string, unknown>
    const listed = await journal.list(baseInput.identityId, baseInput.articleId)

    expect(content.length).toBe(100_000)
    expect(ARTICLE_RECOVERY_JOURNAL_TTL_HOURS).toBe(168)
    expect(ARTICLE_RECOVERY_JOURNAL_TTL_MS).toBe(168 * 60 * 60 * 1000)
    expect(ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE).toContain('未加密')
    expect(ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE).toContain('最长 7 天')
    expect(written.status).toBe('stored')
    expect(Object.hasOwn(firstRaw, 'content')).toBe(false)
    expect(firstRaw.payloadCodec).toBe(ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC)
    expect(firstRaw.payloadCodec).toBe('utf8-v1')
    expect(firstRaw.payload).toBeInstanceOf(Uint8Array)
    expect(firstRaw.payload).toEqual(expectedPayload)
    expect(firstRaw.storedBytes).toBe((firstRaw.payload as Uint8Array).byteLength)
    expect(firstRaw.storedBytes).toBe(firstRaw.contentBytes)
    expect(secondRaw.payload).toEqual(firstRaw.payload)
    expect(JSON.stringify(firstRaw)).not.toContain(content)
    expect(JSON.stringify(firstRaw)).not.toContain('恢复')
    expect(JSON.stringify(firstRaw)).not.toContain('🙂')
    expect(listed.status).toBe('ready')
    expect(listed.records).toHaveLength(1)
    expect(listed.records[0]).toMatchObject({
      schema: ARTICLE_RECOVERY_JOURNAL_SCHEMA,
      articleKey: 'edit:42',
      articleId: 42,
      tabId: baseInput.tabId,
      baseRevisionId: baseInput.baseRevisionId,
      serverRevision: baseInput.serverRevision,
      clientRevision: baseInput.clientRevision,
      content,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ARTICLE_RECOVERY_JOURNAL_TTL_MS
    })
    expect(listed.records[0]?.identityHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(listed.records[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(listed.records[0])).not.toContain(baseInput.identityId)
  })

  it('keeps request-in-flight content and conditionally clears only the server-confirmed revision/hash', async () => {
    const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() })
    const first = await journal.write(baseInput)
    expect((await journal.list(baseInput.identityId, 42)).records).toHaveLength(1)

    const newer = await journal.write({
      ...baseInput,
      clientRevision: 'client-1813-two',
      content: `${baseInput.content}\nnewer input before the first response`
    })
    expect(first.record).not.toBeNull()
    expect(newer.record).not.toBeNull()

    expect(await journal.confirm({
      id: first.record!.id,
      clientRevision: first.record!.clientRevision,
      sourceHash: first.record!.sourceHash
    })).toBe(false)
    expect((await journal.list(baseInput.identityId, 42)).records[0]?.clientRevision)
      .toBe('client-1813-two')

    expect(await journal.confirm({
      id: newer.record!.id,
      clientRevision: newer.record!.clientRevision,
      sourceHash: newer.record!.sourceHash
    })).toBe(true)
    expect((await journal.list(baseInput.identityId, 42)).records).toEqual([])
  })

  it('retains an offline/request-failed record until reconnect confirms the same coordinates', async () => {
    const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() })
    const written = await journal.write(baseInput)
    expect(written.record).not.toBeNull()

    await Promise.reject(new TypeError('network_unavailable')).catch(() => undefined)
    expect((await journal.list(baseInput.identityId, 42)).records).toEqual([
      expect.objectContaining({
        clientRevision: baseInput.clientRevision,
        sourceHash: written.record!.sourceHash,
        content: baseInput.content
      })
    ])

    expect(await journal.confirm({
      id: written.record!.id,
      clientRevision: written.record!.clientRevision,
      sourceHash: written.record!.sourceHash
    })).toBe(true)
    expect((await journal.list(baseInput.identityId, 42)).records).toEqual([])
  })

  it('keeps one/two/many tab owners separate and refuses silent last-write-wins past the cap', async () => {
    const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() })
    for (let index = 0; index < ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES; index += 1) {
      const result = await journal.write({
        ...baseInput,
        tabId: `tab-1813-${String(index).padStart(3, '0')}`,
        clientRevision: `client-1813-${String(index).padStart(3, '0')}`,
        content: `标签页 ${index} 的独立正文`
      })
      expect(result.status).toBe('stored')
    }
    const listed = await journal.list(baseInput.identityId, 42)
    expect(listed.records).toHaveLength(ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES)
    expect(new Set(listed.records.map(record => record.tabId)).size)
      .toBe(ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES)

    expect((await journal.write({
      ...baseInput,
      tabId: 'tab-1813-over-cap',
      clientRevision: 'client-1813-over-cap',
      content: '不得覆盖任一已有标签页'
    })).status).toBe('capacity-exceeded')
  })

  it('isolates create/edit and identity scopes, then supports discard, publish, and delete cleanup', async () => {
    const indexedDB = new IDBFactory()
    const journal = new ArticleRecoveryJournal({ indexedDB })
    await journal.write(baseInput)
    await journal.write({
      ...baseInput,
      articleId: null,
      tabId: 'tab-1813-create',
      clientRevision: 'client-1813-create'
    })
    await journal.write({
      ...baseInput,
      identityId: 'second-admin-principal',
      tabId: 'tab-1813-second-admin',
      clientRevision: 'client-1813-second-admin'
    })
      const expired = await journal.write({
      ...baseInput,
      tabId: 'tab-1813-expired-cleanup',
      clientRevision: 'client-1813-expired-cleanup'
    })
    const expiredRaw = (await rawGetAll(indexedDB))
      .find(record => (record as { id?: unknown }).id === expired.record?.id)
    await rawPut(indexedDB, {
      ...(expiredRaw as Record<string, unknown>),
      schema: 'fsusblog.article-recovery-journal.v0',
      expiresAt: 1
    })

    expect(await journal.clearScope(baseInput.identityId, 42)).toBe(2)
    expect((await journal.list(baseInput.identityId, 42)).records).toEqual([])
    expect((await journal.list(baseInput.identityId, null)).records).toHaveLength(1)
    expect((await journal.list('second-admin-principal', 42)).records).toHaveLength(1)
    expect(await journal.clearArticle(42)).toBe(1)
    expect((await journal.list('second-admin-principal', 42)).records).toEqual([])
  })

  it('purges old/unsupported schemas and corrupt hash, length, payload, or stored budgets', async () => {
    const indexedDB = new IDBFactory()
    const now = 1_780_000_000_000
    const journal = new ArticleRecoveryJournal({ indexedDB, now: () => now })
    const valid = await journal.write(baseInput)
    expect(valid.record).not.toBeNull()
    const raw = (await rawGetAll(indexedDB))[0] as Record<string, unknown>
    const withTab = (tabId: string): Record<string, unknown> => ({
      ...raw,
      id: `${String(raw.identityHash)}:${String(raw.articleKey)}:${tabId}`,
      tabId,
      payload: Uint8Array.from(raw.payload as Uint8Array)
    })

    await rawPut(indexedDB, {
      ...withTab('tab-1813-old-schema'),
      schema: 'fsusblog.article-recovery-journal.v1',
      payloadCodec: 'gzip-v1',
      content: baseInput.content
    })
    await rawPut(indexedDB, {
      ...withTab('tab-1813-expired'),
      expiresAt: now - 1
    })
    await rawPut(indexedDB, {
      ...withTab('tab-1813-future'),
      expiresAt: now + ARTICLE_RECOVERY_JOURNAL_TTL_MS + 1
    })
    await rawPut(indexedDB, {
      ...raw,
      sourceHash: '0'.repeat(64)
    })
    await rawPut(indexedDB, {
      ...withTab('tab-1813-length'),
      contentBytes: (raw.contentBytes as number) + 1
    })
    const corruptPayload = Uint8Array.from(raw.payload as Uint8Array)
    corruptPayload[Math.floor(corruptPayload.byteLength / 2)] ^= 0xff
    await rawPut(indexedDB, {
      ...withTab('tab-1813-payload'),
      payload: corruptPayload
    })
    await rawPut(indexedDB, {
      ...withTab('tab-1813-unsupported'),
      payloadCodec: 'unsupported-v9'
    })
    await rawPut(indexedDB, {
      ...withTab('tab-1813-stored-oversize'),
      payload: new Uint8Array(ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES + 1),
      storedBytes: ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES + 1
    })

    const listed = await journal.list(baseInput.identityId, 42)
    expect(listed.records).toEqual([])
    expect(listed.removedInvalidRecords).toBe(8)
  })

  it('degrades without localStorage fallback on private mode, quota, and logical oversize', async () => {
    const unavailable = new ArticleRecoveryJournal({ indexedDB: null })
    expect((await unavailable.write(baseInput)).status).toBe('unavailable')
    expect((await unavailable.list(baseInput.identityId, 42)).status).toBe('unavailable')
    await expect(unavailable.clearScope(baseInput.identityId, 42)).resolves.toBe(0)

    const quotaFactory = {
      open: vi.fn(() => {
        throw new DOMException('quota', 'QuotaExceededError')
      })
    } as unknown as IDBFactory
    expect((await new ArticleRecoveryJournal({ indexedDB: quotaFactory }).write(baseInput)).status)
      .toBe('quota-exceeded')

    const oversized = '界'.repeat(Math.ceil(ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES / 3) + 1)
    expect((await new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).write({
      ...baseInput,
      content: oversized
    })).status).toBe('oversize')

    const compressionStream = globalThis.CompressionStream
    const decompressionStream = globalThis.DecompressionStream
    vi.stubGlobal('CompressionStream', undefined)
    vi.stubGlobal('DecompressionStream', undefined)
    try {
      const indexedDB = new IDBFactory()
      const journal = new ArticleRecoveryJournal({ indexedDB })
      expect((await journal.write(baseInput)).status).toBe('stored')
      const listed = await journal.list(baseInput.identityId, 42)
      expect(listed.status).toBe('ready')
      expect(listed.records[0]?.content).toBe(baseInput.content)
      expect(Object.hasOwn((await rawGetAll(indexedDB))[0] as object, 'content')).toBe(false)
    } finally {
      vi.stubGlobal('CompressionStream', compressionStream)
      vi.stubGlobal('DecompressionStream', decompressionStream)
    }
  })

  it('keeps 167h59m recoverable and deletes at the exact 168h boundary without sliding on read', async () => {
    const indexedDB = new IDBFactory()
    let now = 1_780_000_000_000
    const journal = new ArticleRecoveryJournal({ indexedDB, now: () => now })
    const written = await journal.write(baseInput)
    expect(written.record?.expiresAt).toBe(now + ARTICLE_RECOVERY_JOURNAL_TTL_MS)
    const createdAt = written.record!.createdAt
    const originalExpiresAt = written.record!.expiresAt

    now = createdAt + ARTICLE_RECOVERY_JOURNAL_TTL_MS - 60_000
    const almostExpired = await journal.list(baseInput.identityId, 42)
    expect(almostExpired.records).toHaveLength(1)
    expect(almostExpired.records[0]?.content).toBe(baseInput.content)
    expect(almostExpired.removedInvalidRecords).toBe(0)
    expect(((await rawGetAll(indexedDB))[0] as { expiresAt: number }).expiresAt)
      .toBe(originalExpiresAt)

    now = createdAt + ARTICLE_RECOVERY_JOURNAL_TTL_MS
    const atBoundary = await journal.list(baseInput.identityId, 42)
    expect(atBoundary.records).toEqual([])
    expect(atBoundary.removedInvalidRecords).toBe(1)
    expect(await rawGetAll(indexedDB)).toEqual([])

    const rewritten = await journal.write({
      ...baseInput,
      clientRevision: 'client-1813-after-boundary'
    })
    now = rewritten.record!.updatedAt + ARTICLE_RECOVERY_JOURNAL_TTL_MS + 1
    const afterBoundary = await journal.list(baseInput.identityId, 42)
    expect(afterBoundary.records).toEqual([])
    expect(afterBoundary.removedInvalidRecords).toBe(1)
  })

  it('anchors expiresAt to the last unconfirmed mutation and does not revive expired records', async () => {
    const indexedDB = new IDBFactory()
    let now = 1_780_000_000_000
    const journal = new ArticleRecoveryJournal({ indexedDB, now: () => now })
    const first = await journal.write(baseInput)
    now += 3_600_000
    const mutated = await journal.write({
      ...baseInput,
      clientRevision: 'client-1813-mutated',
      content: `${baseInput.content}\nlater mutation`
    })
    expect(first.record?.createdAt).toBe(mutated.record?.createdAt)
    expect(mutated.record?.updatedAt).toBe(now)
    expect(mutated.record?.expiresAt).toBe(now + ARTICLE_RECOVERY_JOURNAL_TTL_MS)

    const expiredRaw = (await rawGetAll(indexedDB))[0] as Record<string, unknown>
    await rawPut(indexedDB, {
      ...expiredRaw,
      expiresAt: now - 1
    })
    expect((await journal.list(baseInput.identityId, 42)).records).toEqual([])
    expect(await rawGetAll(indexedDB)).toEqual([])
  })

  it('classifies newer server/current coordinates before an explicit recovery choice', async () => {
    const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() })
    const record = (await journal.write(baseInput)).record as ArticleRecoveryJournalRecord

    expect(assessArticleRecoveryDivergence(record, {
      currentRevisionId: '9001',
      serverRevision: 7
    })).toBe('none')
    expect(assessArticleRecoveryDivergence(record, {
      currentRevisionId: '9001',
      serverRevision: 8
    })).toBe('newer-server-draft')
    expect(assessArticleRecoveryDivergence(record, {
      currentRevisionId: '9002',
      serverRevision: 7
    })).toBe('newer-current-revision')
  })
})

class MockLifecycleDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

class MockLifecycleWindow extends EventTarget {
  private intervalCallback: (() => void) | null = null

  setInterval(callback: TimerHandler): number {
    this.intervalCallback = callback as () => void
    return 1813
  }

  clearInterval(timer: number): void {
    if (timer === 1813) {
      this.intervalCallback = null
    }
  }

  fireInterval(): void {
    this.intervalCallback?.()
  }
}

describe('article recovery lifecycle flush owner', () => {
  it('coalesces rapid 100k stages to one in-flight and one latest pending write', async () => {
    const releases: Array<() => void> = []
    const writer = vi.fn((input: ArticleRecoveryJournalWriteInput) => new Promise<{
      status: 'stored'
      record: null
    }>((resolve) => {
      releases.push(() => resolve({ status: 'stored', record: null }))
    }))
    const owner = new ArticleRecoveryFlushOwner(writer)
    const initial = { ...baseInput, content: '初'.repeat(100_000) }
    owner.stage(initial)
    const first = owner.flush()
    const queued: Array<Promise<unknown>> = []
    let latestContent = initial.content
    for (let index = 1; index <= 64; index += 1) {
      latestContent = `${'终'.repeat(99_990)}-${index.toString().padStart(8, '0')}`
      owner.stage({
        ...baseInput,
        clientRevision: `client-1813-rapid-${index.toString().padStart(3, '0')}`,
        content: latestContent
      })
      queued.push(owner.flush())
    }

    expect(writer).toHaveBeenCalledOnce()
    await expect(Promise.all(queued.slice(0, -1)))
      .resolves.toEqual(Array.from({ length: 63 }, () => null))

    releases.shift()?.()
    await first
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(2))
    expect(writer.mock.calls[1]?.[0].content).toBe(latestContent)
    releases.shift()?.()
    await expect(queued.at(-1)).resolves.toEqual({ status: 'stored', record: null })
    await owner.drain()
    expect(writer).toHaveBeenCalledTimes(2)
  })

  it('routes input, visibility, pagehide, beforeunload, and periodic flush through one idempotent owner', async () => {
    const writer = vi.fn(async () => ({
      status: 'stored' as const,
      record: null
    }))
    const owner = new ArticleRecoveryFlushOwner(writer)
    const lifecycleDocument = new MockLifecycleDocument()
    const lifecycleWindow = new MockLifecycleWindow()
    const flush = vi.fn(() => owner.flush())
    const dispose = bindArticleRecoveryLifecycleFlush(flush, {
      document: lifecycleDocument as unknown as Document,
      window: lifecycleWindow as unknown as Window
    }, 2_000)

    owner.stage(baseInput)
    await owner.flush()
    lifecycleDocument.visibilityState = 'hidden'
    lifecycleDocument.dispatchEvent(new Event('visibilitychange'))
    lifecycleWindow.dispatchEvent(new Event('pagehide'))
    lifecycleWindow.dispatchEvent(new Event('beforeunload'))
    lifecycleWindow.fireInterval()
    await owner.drain()

    expect(flush).toHaveBeenCalledTimes(4)
    expect(writer).toHaveBeenCalledOnce()
    expect(owner.pendingClientRevision()).toBe(baseInput.clientRevision)

    dispose()
    lifecycleDocument.dispatchEvent(new Event('visibilitychange'))
    lifecycleWindow.dispatchEvent(new Event('pagehide'))
    lifecycleWindow.dispatchEvent(new Event('beforeunload'))
    lifecycleWindow.fireInterval()
    expect(flush).toHaveBeenCalledTimes(4)
  })

  it('retries a failed flush and still lets server autosave proceed when storage is unavailable', async () => {
    const writer = vi.fn()
      .mockResolvedValueOnce({ status: 'unavailable', record: null })
      .mockResolvedValueOnce({ status: 'stored', record: null })
    const serverAutosave = vi.fn()
    const owner = new ArticleRecoveryFlushOwner(writer)
    owner.stage(baseInput)

    serverAutosave(await owner.flush())
    expect(serverAutosave).toHaveBeenCalledWith({ status: 'unavailable', record: null })
    expect(await owner.flush()).toEqual({ status: 'stored', record: null })
    expect(writer).toHaveBeenCalledTimes(2)
  })

  it('retains newer coordinates when an older server confirmation arrives', async () => {
    const firstRecord = {
      id: 'record-first',
      clientRevision: baseInput.clientRevision,
      sourceHash: 'a'.repeat(64)
    }
    const secondInput = {
      ...baseInput,
      clientRevision: 'client-1813-newer',
      content: '较新的未确认正文'
    }
    const owner = new ArticleRecoveryFlushOwner(vi.fn()
      .mockResolvedValueOnce({ status: 'stored', record: firstRecord })
      .mockResolvedValueOnce({
        status: 'stored',
        record: {
          ...firstRecord,
          id: 'record-second',
          clientRevision: secondInput.clientRevision,
          sourceHash: 'b'.repeat(64)
        }
      }))

    owner.stage(baseInput)
    await owner.flush()
    owner.stage(secondInput)
    owner.markConfirmed(firstRecord)

    expect(owner.pendingClientRevision()).toBe(secondInput.clientRevision)
    await owner.flush()
    expect(owner.pendingClientRevision()).toBe(secondInput.clientRevision)
  })
})

describe('article recovery decision helpers', () => {
  it('compares without mutating the selected or authoritative content', () => {
    const record = {
      content: '未同步正文 🧭'
    } as ArticleRecoveryJournalRecord
    const source = {
      label: '初始化时的服务端草稿正文',
      content: '权威服务端正文'
    }
    const before = structuredClone({ record, source })

    const summary = summarizeArticleRecoveryComparison(record, [source])

    expect(summary).toContain('未同步正文')
    expect(summary).toContain('初始化时的服务端草稿正文')
    expect(summary).toContain('内容不同')
    expect({ record, source }).toEqual(before)
  })

  it('serializes compare/recover/discard and preserves an inline failure state', async () => {
    const states: Array<{ kind: string | null, error: string }> = []
    const run = createArticleRecoveryOperationRunner(state => states.push(state))
    let finishFirst: (() => void) | null = null
    const first = run('compare', '比较失败', () => new Promise<void>((resolve) => {
      finishFirst = resolve
    }))
    const duplicate = await run('recover', '恢复失败', async () => {})
    expect(duplicate).toBe(false)
    finishFirst?.()
    await first

    expect(await run('discard', '丢弃失败', async () => {
      throw new Error('private detail')
    })).toBe(false)
    expect(states).toEqual([
      { kind: 'compare', error: '' },
      { kind: null, error: '' },
      { kind: 'discard', error: '' },
      { kind: null, error: '丢弃失败' }
    ])
    expect(JSON.stringify(states)).not.toContain('private detail')
  })
})

class MockBroadcastChannel {
  static readonly instances: MockBroadcastChannel[] = []
  readonly messages: unknown[] = []
  private listener: ((event: MessageEvent) => void) | null = null

  constructor(readonly name: string) {
    MockBroadcastChannel.instances.push(this)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener
  }

  removeEventListener(): void {
    this.listener = null
  }

  postMessage(message: unknown): void {
    this.messages.push(message)
    for (const instance of MockBroadcastChannel.instances) {
      if (instance !== this && instance.name === this.name) {
        instance.listener?.({ data: message } as MessageEvent)
      }
    }
  }

  close(): void {
    this.listener = null
  }
}

describe('article recovery tab coordination', () => {
  it('publishes body-free article ownership changes and ignores the sending tab', () => {
    MockBroadcastChannel.instances.length = 0
    const first = new ArticleRecoveryCoordinator({
      tabId: 'tab-1813-first',
      BroadcastChannel: MockBroadcastChannel as unknown as typeof BroadcastChannel
    })
    const second = new ArticleRecoveryCoordinator({
      tabId: 'tab-1813-second',
      BroadcastChannel: MockBroadcastChannel as unknown as typeof BroadcastChannel
    })
    const firstSubscriber = vi.fn()
    const secondSubscriber = vi.fn()
    first.subscribe(firstSubscriber)
    second.subscribe(secondSubscriber)

    first.notify('changed', 42)

    expect(firstSubscriber).not.toHaveBeenCalled()
    expect(secondSubscriber).toHaveBeenCalledWith(expect.objectContaining({
      type: 'changed',
      articleKey: 'edit:42',
      tabId: 'tab-1813-first'
    }))
    const serialized = JSON.stringify(MockBroadcastChannel.instances[0]?.messages)
    expect(serialized).not.toContain(baseInput.content)
    expect(serialized).not.toContain(baseInput.identityId)
    expect(serialized).not.toContain(baseInput.clientRevision)
    first.dispose()
    second.dispose()
  })
})
