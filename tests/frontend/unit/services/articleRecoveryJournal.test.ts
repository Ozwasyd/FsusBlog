import { IDBFactory, IDBObjectStore, IDBVersionChangeEvent } from 'fake-indexeddb'
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
  type ArticleRecoveryJournalCheckpointSource,
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


function checkpointSource(): ArticleRecoveryJournalCheckpointSource
{
    return {
        ...baseInput,
        owner: {},
        mountedEditor: {},
        siteScope: 'primary',
        draftKey: 'draft-key-1813',
        registryRevision: 4,
        associationRevision: 2,
        editorSessionRef: 'session-2295',
        documentId: 'document-2295',
        draftId: 'draft-2295',
        documentEpoch: 3,
        editorRevision: 11,
        sourceRevision: '9001',
        draftRevision: '7'
    };
}

describe('original journal checkpoint custody source regressions', () =>
{
    it('issues frozen custody only after original persistence and restores through the original integrity reader', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            expect(token).not.toBeNull();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            const stored = await rawGetAll(indexedDB);
            expect(stored).toHaveLength(1);
            expect(Object.isFrozen(token)).toBe(true);
            expect(Object.keys(token)).toHaveLength(0);
            expect(binding.validate(token)).toBe(true);
            const info = binding.inspect(token);
            expect(info).not.toBeInstanceOf(Promise);
            expect(Object.isFrozen(info)).toBe(true);
            expect(info).toMatchObject({ documentId: source.documentId, documentEpoch: 3, editorRevision: 11 });
            expect(Object.hasOwn(info!, 'content')).toBe(false);
            const restored = await binding.restore(token);
            expect(restored?.content).toBe(source.content);
            expect(Object.isFrozen(restored)).toBe(true);
        }
        finally
        {
            binding.release();
        }
    });

    it('rejects copied and foreign-binding or foreign-journal tokens without revoking legitimate custody', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const foreignBinding = journal.bindCheckpointSource(() => source);
        const foreignJournal = new ArticleRecoveryJournal({ indexedDB }).bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            expect(binding.validate({ ...token })).toBe(false);
            expect(foreignBinding.inspect(token)).toBeNull();
            expect(await foreignJournal.restore(token)).toBeNull();
            expect(binding.validate(token)).toBe(true);
        }
        finally
        {
            binding.release();
            foreignBinding.release();
            foreignJournal.release();
        }
    });

    it.each([
        ['documentEpoch', 4],
        ['editorRevision', 12],
        ['editorSessionRef', 'replacement-session'],
        ['documentId', 'replacement-document'],
        ['draftId', 'replacement-draft'],
        ['draftKey', 'replacement-key'],
        ['siteScope', 'other-site'],
        ['identityId', 'other-principal'],
        ['articleId', 43],
        ['tabId', 'other-recovery-tab'],
        ['sourceRevision', '9002'],
        ['draftRevision', '8'],
        ['baseRevisionId', '9002'],
        ['serverRevision', 8],
        ['clientRevision', 'client-1813-next'],
        ['registryRevision', 5],
        ['associationRevision', 3],
        ['owner', {}],
        ['mountedEditor', {}]
    ])('refuses stale %s and does not resurrect custody after facts return', async (key, replacement) =>
    {
        const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() });
        const original = checkpointSource();
        let source = original;
        const binding = journal.bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            source = { ...original, [key]: replacement };
            expect(binding.inspect(token)).toBeNull();
            source = original;
            expect(binding.validate(token)).toBe(false);
            expect(await binding.restore(token)).toBeNull();
        }
        finally
        {
            binding.release();
        }
    });

    it('refuses stale asynchronous completion and owner release during the source reread', async () =>
    {
        const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() });
        const source = checkpointSource();
        let reads = 0;
        const binding = journal.bindCheckpointSource(() => ++reads === 1 ? source : { ...source, documentEpoch: 4 });
        expect(await binding.prepare()).toBeNull();
        binding.release();
        const active = journal.bindCheckpointSource(() => source);
        const token = await active.prepare();
        if (!token)
        {
            throw new Error('checkpoint_not_issued');
        }
        active.release();
        expect(active.validate(token)).toBe(false);
        expect(await active.prepare()).toBeNull();
    });

    it('does not accept custody invalidated reentrantly by the actual reader', async () =>
    {
        const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() });
        const source = checkpointSource();
        let invalidateOnRead = false;
        const binding = journal.bindCheckpointSource(() =>
        {
            if (invalidateOnRead)
            {
                binding.invalidate();
            }
            return source;
        });
        const token = await binding.prepare();
        if (!token)
        {
            throw new Error('checkpoint_not_issued');
        }
        invalidateOnRead = true;
        expect(binding.validate(token)).toBe(false);
        binding.release();
    });

    it('refuses unavailable storage, failed persistence and cancellation without issuing a token', async () =>
    {
        const source = checkpointSource();
        const unavailable = new ArticleRecoveryJournal({ indexedDB: null }).bindCheckpointSource(() => source);
        expect(await unavailable.prepare()).toBeNull();
        unavailable.release();
        const indexedDB = new IDBFactory();
        const binding = new ArticleRecoveryJournal({ indexedDB }).bindCheckpointSource(() => source);
        const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() =>
        {
            throw new DOMException('quota', 'QuotaExceededError');
        });
        try
        {
            expect(await binding.prepare()).toBeNull();
        }
        finally
        {
            failure.mockRestore();
        }
        const cancelled = new AbortController();
        const pending = binding.prepare(cancelled.signal);
        cancelled.abort();
        expect(await pending).toBeNull();
        expect(await binding.prepare(cancelled.signal)).toBeNull();
        expect(await rawGetAll(indexedDB)).toHaveLength(0);
        binding.release();
    });

    it('refuses cancellation after persistence without claiming rollback of the original recovery row', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const controller = new AbortController();
        let reads = 0;
        const binding = journal.bindCheckpointSource(() =>
        {
            if (++reads === 2)
            {
                controller.abort();
            }
            return source;
        });
        expect(await binding.prepare(controller.signal)).toBeNull();
        expect((await journal.list(source.identityId, source.articleId)).records).toHaveLength(1);
        binding.release();
    });

    it.each(['write', 'confirm', 'discard', 'clearScope', 'clearArticle'] as const)(
        'revokes custody through original %s semantics', async (operation) =>
        {
            const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() });
            const source = checkpointSource();
            const binding = journal.bindCheckpointSource(() => source);
            try
            {
                const token = await binding.prepare();
                const record = (await journal.list(source.identityId, source.articleId)).records[0];
                if (!token || !record)
                {
                    throw new Error('checkpoint_not_issued');
                }
                if (operation === 'write')
                {
                    await journal.write(source);
                }
                else if (operation === 'confirm')
                {
                    await journal.confirm(record);
                }
                else if (operation === 'discard')
                {
                    await journal.discard(record.id);
                }
                else if (operation === 'clearScope')
                {
                    await journal.clearScope(source.identityId, source.articleId);
                }
                else
                {
                    await journal.clearArticle(source.articleId!);
                }
                expect(binding.validate(token)).toBe(false);
            }
            finally
            {
                binding.release();
            }
        }
    );

    it('rejects expired custody and preserves original integrity cleanup after raw payload tampering', async () =>
    {
        let now = 1_780_000_000_000;
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB, now: () => now });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const expired = await binding.prepare();
        if (!expired)
        {
            throw new Error('checkpoint_not_issued');
        }
        now += ARTICLE_RECOVERY_JOURNAL_TTL_MS;
        expect(binding.validate(expired)).toBe(false);
        const token = await binding.prepare();
        if (!token)
        {
            throw new Error('checkpoint_not_issued');
        }
        const raw = (await rawGetAll(indexedDB))[0] as Record<string, unknown>;
        raw.payload = new Uint8Array((raw.payload as Uint8Array).byteLength).fill(65);
        await rawPut(indexedDB, raw);
        expect(await binding.restore(token)).toBeNull();
        expect(binding.validate(token)).toBe(false);
        expect(await rawGetAll(indexedDB)).toHaveLength(0);
        binding.release();
    });

    it('revokes on database deletion/versionchange and closes the original custody connection', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const token = await binding.prepare();
        if (!token)
        {
            throw new Error('checkpoint_not_issued');
        }
        await new Promise<void>((resolve, reject) =>
        {
            const request = indexedDB.deleteDatabase(ARTICLE_RECOVERY_JOURNAL_DATABASE);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        expect(binding.validate(token)).toBe(false);
        expect(await binding.restore(token)).toBeNull();
        binding.release();
    });

    it('rejects a foreign overwrite when the original reader observes it', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const token = await binding.prepare();
        if (!token)
        {
            throw new Error('checkpoint_not_issued');
        }
        await new ArticleRecoveryJournal({ indexedDB }).write({ ...source, content: 'foreign content' });
        expect(await binding.restore(token)).toBeNull();
        expect(binding.validate(token)).toBe(false);
        binding.release();
    });

    it('does not mint custody from a lossy UTF-8 round trip', async () =>
    {
        const source = { ...checkpointSource(), content: 'unpaired surrogate: \uD800' };
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        expect(await binding.prepare()).toBeNull();
        binding.release();
    });

    it('revokes when an earlier original write settles after preparation', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
        let releaseFirstDigest: (() => void) | undefined;
        const firstDigestGate = new Promise<void>(resolve =>
        {
            releaseFirstDigest = resolve;
        });
        let calls = 0;
        const hold = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) =>
        {
            if (++calls === 1)
            {
                await firstDigestGate;
            }
            return digest(algorithm, data);
        });
        try
        {
            const earlierWrite = journal.write({ ...source, clientRevision: 'earlier-client-revision', content: 'earlier write' });
            const token = await binding.prepare();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            releaseFirstDigest?.();
            await earlierWrite;
            expect(binding.validate(token)).toBe(false);
        }
        finally
        {
            releaseFirstDigest?.();
            hold.mockRestore();
            binding.release();
        }
    });

    it('bounds binding custody and refuses a concurrent prepare without queuing another body', async () =>
    {
        const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() });
        const source = checkpointSource();
        const bindings = Array.from({ length: 32 }, () => journal.bindCheckpointSource(() => source));
        try
        {
            expect(() => journal.bindCheckpointSource(() => source)).toThrow('article_recovery_checkpoint_binding_capacity');
            const pending = bindings[0]!.prepare();
            expect(await bindings[1]!.prepare()).toBeNull();
            expect(await pending).not.toBeNull();
        }
        finally
        {
            bindings.forEach(binding => binding.release());
        }
    });
});


function holdNextRecoveryHash(content: string)
{
    const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let resumeRead: () => void = () => {};
    let notifyHeld: () => void = () => {};
    const held = new Promise<void>(resolve =>
    {
        notifyHeld = resolve;
    });
    const resumed = new Promise<void>(resolve =>
    {
        resumeRead = resolve;
    });
    let blocked = false;
    const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) =>
    {
        if (!blocked && new TextDecoder().decode(data) === `${ARTICLE_RECOVERY_JOURNAL_SCHEMA}:source:${content}`)
        {
            blocked = true;
            notifyHeld();
            await resumed;
        }
        return digest(algorithm, data);
    });
    return {
        held,
        resume: resumeRead,
        release: () =>
        {
            resumeRead();
            spy.mockRestore();
        }
    };
}

describe('original journal asynchronous custody replacement source controls', () =>
{
    it.each(['restore', 'list'] as const)('preserves B after a delayed A %s settles', async (kind) =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        let source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const tokenA = await binding.prepare();
        if (!tokenA)
        {
            throw new Error('checkpoint_A_not_issued');
        }
        const heldRead = holdNextRecoveryHash(source.content);
        try
        {
            const pendingA = kind === 'restore' ? binding.restore(tokenA) : journal.list(source.identityId, source.articleId);
            await heldRead.held;
            source = { ...source, clientRevision: 'client-2295-B', editorRevision: 12, content: 'B persisted body' };
            const tokenB = await binding.prepare();
            if (!tokenB)
            {
                throw new Error('checkpoint_B_not_issued');
            }
            heldRead.resume();
            const resultA = await pendingA;
            if (kind === 'restore')
            {
                expect(resultA).toBeNull();
            }
            expect(binding.validate(tokenB)).toBe(true);
            expect((await binding.restore(tokenB))?.content).toBe(source.content);
        }
        finally
        {
            heldRead.release();
            binding.release();
        }
    });

    it('does not delete or revoke valid B using delayed A invalid-record cleanup', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        let source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const tokenA = await binding.prepare();
        if (!tokenA)
        {
            throw new Error('checkpoint_A_not_issued');
        }
        const rawA = (await rawGetAll(indexedDB))[0] as Record<string, unknown>;
        rawA.sourceHash = '0'.repeat(64);
        await rawPut(indexedDB, rawA);
        const heldRead = holdNextRecoveryHash(source.content);
        try
        {
            const pendingA = journal.list(source.identityId, source.articleId);
            await heldRead.held;
            source = { ...source, clientRevision: 'client-2295-B', editorRevision: 12, content: 'valid replacement B' };
            const tokenB = await binding.prepare();
            if (!tokenB)
            {
                throw new Error('checkpoint_B_not_issued');
            }
            heldRead.resume();
            const oldRead = await pendingA;
            expect(oldRead.removedInvalidRecords).toBe(0);
            expect(binding.validate(tokenB)).toBe(true);
            expect((await binding.restore(tokenB))?.content).toBe(source.content);
        }
        finally
        {
            heldRead.release();
            binding.release();
        }
    });

    it('ignores queued callbacks belonging to a retired checkpoint connection', async () =>
    {
        const indexedDB = new IDBFactory();
        const databases: IDBDatabase[] = [];
        const originalOpen = indexedDB.open.bind(indexedDB);
        const opened = vi.spyOn(indexedDB, 'open').mockImplementation((...args) =>
        {
            const request = originalOpen(...args);
            request.addEventListener('success', () => databases.push(request.result));
            return request;
        });
        const journal = new ArticleRecoveryJournal({ indexedDB });
        let source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        try
        {
            expect(await binding.prepare()).not.toBeNull();
            const retired = databases[0]!;
            const oldVersionChange = retired.onversionchange;
            const oldClose = retired.onclose;
            source = { ...source, clientRevision: 'client-2295-B', editorRevision: 12, content: 'new connection B' };
            const tokenB = await binding.prepare();
            if (!tokenB)
            {
                throw new Error('checkpoint_B_not_issued');
            }
            oldVersionChange?.call(retired, new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2 }));
            oldClose?.call(retired, new Event('close'));
            expect(binding.validate(tokenB)).toBe(true);
        }
        finally
        {
            opened.mockRestore();
            binding.release();
        }
    });
});


describe('original journal stable reference and native digest source controls', () =>
{
    it('issues an owner locator for the completed token and resolves it only in the same binding', async () =>
    {
        const source = checkpointSource();
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        const foreign = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            const foreignToken = await foreign.prepare();
            if (!token || !foreignToken)
            {
                throw new Error('checkpoint_not_issued');
            }
            const info = binding.inspect(token)!;
            const foreignInfo = foreign.inspect(foreignToken)!;
            expect(info.checkpointRef).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u);
            expect(info.checkpointRef).not.toBe(foreignInfo.checkpointRef);
            expect(binding.inspectReference(info.checkpointRef)).toBe(info);
            expect(binding.validateReference(info.checkpointRef, source.content)).toBe(true);
            expect(binding.validateContent(token, source.content)).toBe(true);
            expect((await binding.restoreReference(info.checkpointRef))?.content).toBe(source.content);
            expect(foreign.inspectReference(info.checkpointRef)).toBeNull();
            expect(await foreign.restoreReference(info.checkpointRef)).toBeNull();
            expect(binding.inspectReference(foreignInfo.checkpointRef)).toBeNull();
            expect(binding.validateReference(`${info.checkpointRef}:forged`, source.content)).toBe(false);
            expect(binding.validate({ ...token })).toBe(false);
            expect(binding.validate(token)).toBe(true);
        }
        finally
        {
            binding.release();
            foreign.release();
        }
    });

    it('rejects native digest input differing from the completed body and retires its locator', async () =>
    {
        const source = checkpointSource();
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            const ref = binding.inspect(token)!.checkpointRef;
            expect(binding.validateReference(ref, `${source.content} unsaved native input`)).toBe(false);
            expect(binding.inspectReference(ref)).toBeNull();
            expect(binding.validate(token)).toBe(false);
        }
        finally
        {
            binding.release();
        }
    });

    it('detects changed actual Writer content even when its revision fields were incorrectly unchanged', async () =>
    {
        const original = checkpointSource();
        let source = original;
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            const ref = binding.inspect(token)!.checkpointRef;
            source = { ...original, content: 'changed actual body at unchanged numeric revision' };
            expect(binding.inspectReference(ref)).toBeNull();
            source = original;
            expect(binding.validateReference(ref, source.content)).toBe(false);
        }
        finally
        {
            binding.release();
        }
    });

    it('does not treat equal UTF-8 replacement bytes as equal actual native source text', async () =>
    {
        const source = { ...checkpointSource(), content: '\uFFFD' };
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        try
        {
            const token = await binding.prepare();
            if (!token)
            {
                throw new Error('checkpoint_not_issued');
            }
            expect(binding.validateContent(token, '\uD800')).toBe(false);
            expect(binding.validate(token)).toBe(false);
        }
        finally
        {
            binding.release();
        }
    });

    it('does not reuse a retired locator even if the UUID provider repeats a value', async () =>
    {
        const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
        const source = checkpointSource();
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        try
        {
            const tokenA = await binding.prepare();
            if (!tokenA)
            {
                throw new Error('checkpoint_A_not_issued');
            }
            const refA = binding.inspect(tokenA)!.checkpointRef;
            const tokenB = await binding.prepare();
            if (!tokenB)
            {
                throw new Error('checkpoint_B_not_issued');
            }
            const refB = binding.inspect(tokenB)!.checkpointRef;
            expect(refB).not.toBe(refA);
            expect(binding.inspectReference(refA)).toBeNull();
            expect(binding.validateReference(refA, source.content)).toBe(false);
            expect(await binding.restoreReference(refA)).toBeNull();
            expect(binding.validateReference(refB, source.content)).toBe(true);
            binding.invalidate();
            expect(binding.inspectReference(refB)).toBeNull();
        }
        finally
        {
            uuid.mockRestore();
            binding.release();
        }
    });

    it('issues no locator when cryptographic locator issuance fails after real persistence', async () =>
    {
        const journal = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() =>
        {
            throw new Error('random_uuid_unavailable');
        });
        try
        {
            expect(await binding.prepare()).toBeNull();
            expect((await journal.list(source.identityId, source.articleId)).records).toHaveLength(1);
        }
        finally
        {
            uuid.mockRestore();
            binding.release();
        }
    });

    it('refuses a locator after its actual owner reader is released', async () =>
    {
        const source = checkpointSource();
        const binding = new ArticleRecoveryJournal({ indexedDB: new IDBFactory() }).bindCheckpointSource(() => source);
        const token = await binding.prepare();
        if (!token)
        {
            throw new Error('checkpoint_not_issued');
        }
        const ref = binding.inspect(token)!.checkpointRef;
        binding.release();
        expect(binding.validateReference(ref, source.content)).toBe(false);
        expect(await binding.restoreReference(ref)).toBeNull();
    });
});


describe('original cleanup fences incomplete checkpoint issuance source control', () =>
{
    it('refuses B after actual cleanup deletes its row while its completed-read result is held', async () =>
    {
        const indexedDB = new IDBFactory();
        const journal = new ArticleRecoveryJournal({ indexedDB });
        const source = checkpointSource();
        const binding = journal.bindCheckpointSource(() => source);
        const originalList = journal.list.bind(journal);
        let releaseRead: () => void = () => {};
        let notifyRead: () => void = () => {};
        const held = new Promise<void>(resolve =>
        {
            notifyRead = resolve;
        });
        const released = new Promise<void>(resolve =>
        {
            releaseRead = resolve;
        });
        const delayed = vi.spyOn(journal, 'list').mockImplementationOnce(async (...args) =>
        {
            const actualRead = await originalList(...args);
            notifyRead();
            await released;
            return actualRead;
        });
        try
        {
            const pendingB = binding.prepare();
            await held;
            const raw = (await rawGetAll(indexedDB))[0] as Record<string, unknown>;
            raw.sourceHash = '0'.repeat(64);
            await rawPut(indexedDB, raw);
            const cleanup = await originalList(source.identityId, source.articleId);
            expect(cleanup.removedInvalidRecords).toBe(1);
            releaseRead();
            expect(await pendingB).toBeNull();
            expect(await rawGetAll(indexedDB)).toHaveLength(0);
        }
        finally
        {
            releaseRead();
            delayed.mockRestore();
            binding.release();
        }
    });
});
