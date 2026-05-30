import type { SseArticleRenderPatch, SseCommentRenderPatch, SseInboxRenderPatch, SseRenderPatch } from '@/services/sseTypes'

type ModuleKey = SseRenderPatch['module']

type ModulePatchMap = {
  article: SseArticleRenderPatch
  comment: SseCommentRenderPatch
  inbox: SseInboxRenderPatch
}

type SchedulerStats = Readonly<{
  batchSize: number
  durationMs: number
}>

type SchedulerOptions = Readonly<{
  maxHz?: number
  onFlush: <TModule extends ModuleKey>(module: TModule, patches: ModulePatchMap[TModule][], stats: SchedulerStats) => void
}>

type PendingBucket<TPatch extends SseRenderPatch> = {
  pending: Map<string, TPatch>
  lastCommittedAt: number
  rafId: number | null
  timerId: ReturnType<typeof setTimeout> | null
}

const DEFAULT_MAX_HZ = 10

function createBucket<TPatch extends SseRenderPatch>(): PendingBucket<TPatch> {
  return {
    pending: new Map<string, TPatch>(),
    lastCommittedAt: 0,
    rafId: null,
    timerId: null
  }
}

function resolvePatchKey(patch: SseRenderPatch): string {
  if (patch.module === 'article') {
    if (patch.kind === 'reconnected') {
      return 'article:reconnected'
    }

    const payload = patch.event?.payload
    return `article:${payload?.articleId ?? 0}:${payload?.action ?? 'unknown'}`
  }

  if (patch.module === 'comment') {
    const payload = patch.event.payload
    if ('comment' in payload) {
      return `comment:add:${payload.comment.id}`
    }

    return `comment:remove:${payload.commentId}`
  }

  if (patch.kind === 'reconnected') {
    return 'inbox:reconnected'
  }

  if (patch.kind === 'message-received' && patch.payload && typeof patch.payload === 'object' && 'id' in patch.payload) {
    return `inbox:message:${String(patch.payload.id)}`
  }

  if (patch.kind === 'message-revoked' && patch.payload && typeof patch.payload === 'object' && 'messageId' in patch.payload) {
    return `inbox:message-revoked:${String(patch.payload.messageId)}`
  }

  if (patch.kind === 'global-notice' && patch.payload && typeof patch.payload === 'object' && 'id' in patch.payload) {
    return `inbox:global:${String(patch.payload.id)}`
  }

  return `inbox:${patch.kind}`
}

export function createSseRenderScheduler(options: SchedulerOptions) {
  const frameWindowMs = 1000 / Math.max(1, options.maxHz ?? DEFAULT_MAX_HZ)

  const buckets: {
    article: PendingBucket<SseArticleRenderPatch>
    comment: PendingBucket<SseCommentRenderPatch>
    inbox: PendingBucket<SseInboxRenderPatch>
  } = {
    article: createBucket<SseArticleRenderPatch>(),
    comment: createBucket<SseCommentRenderPatch>(),
    inbox: createBucket<SseInboxRenderPatch>()
  }

  const flush = <TModule extends ModuleKey>(module: TModule): void => {
    const bucket = buckets[module] as PendingBucket<ModulePatchMap[TModule]>
    bucket.rafId = null

    const now = performance.now()
    const remaining = frameWindowMs - (now - bucket.lastCommittedAt)
    if (remaining > 0) {
      if (bucket.timerId !== null) {
        clearTimeout(bucket.timerId)
      }

      bucket.timerId = setTimeout(() => {
        bucket.timerId = null
        schedule(module)
      }, remaining)
      return
    }

    const patches = Array.from(bucket.pending.values())
    bucket.pending.clear()
    if (patches.length === 0) {
      return
    }

    bucket.lastCommittedAt = performance.now()
    const renderStarted = performance.now()
    options.onFlush(module, patches, {
      batchSize: patches.length,
      durationMs: performance.now() - renderStarted
    })
  }

  const schedule = <TModule extends ModuleKey>(module: TModule): void => {
    const bucket = buckets[module]
    if (bucket.rafId !== null) {
      return
    }

    bucket.rafId = window.requestAnimationFrame(() => flush(module))
  }

  return {
    schedule(patch: SseRenderPatch): void {
      const bucket = buckets[patch.module]
      bucket.pending.set(resolvePatchKey(patch), patch as never)
      schedule(patch.module)
    },
    cancel(): void {
      for (const bucket of Object.values(buckets)) {
        if (bucket.rafId !== null) {
          cancelAnimationFrame(bucket.rafId)
          bucket.rafId = null
        }

        if (bucket.timerId !== null) {
          clearTimeout(bucket.timerId)
          bucket.timerId = null
        }

        bucket.pending.clear()
      }
    }
  }
}