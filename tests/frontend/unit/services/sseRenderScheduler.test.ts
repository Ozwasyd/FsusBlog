import { describe, expect, it } from 'vitest'
import type { ArticleListItemResponse } from '@/api/article'
import { mergeSseRenderPatch } from '@/services/sseRenderScheduler'
import { SseEventType, type ArticleUpdatePayload, type SseArticleRenderPatch, type SseEventV2 } from '@/services/sseTypes'

function makeArticle(id: number, title: string): ArticleListItemResponse {
  return {
    id,
    title,
    summary: '',
    views: 0,
    createTime: '2025-01-01T00:00:00Z',
    category: { id: 1, name: 'General' },
    tags: []
  }
}

function articlePatch(
  action: ArticleUpdatePayload['action'],
  title = action,
  eventId = 1
): SseArticleRenderPatch {
  const payload: ArticleUpdatePayload = {
    articleId: 10,
    action,
    eventTime: `2025-01-01T00:00:0${eventId}Z`,
    preview: action === 'Deleted' ? null : makeArticle(10, title)
  }
  const event: SseEventV2<ArticleUpdatePayload> = {
    id: eventId,
    type: SseEventType.ArticleChanged,
    ts: eventId,
    payload
  }

  return {
    module: 'article',
    kind: 'changed',
    event
  }
}

describe('mergeSseRenderPatch', () => {
  it('merges Created + Updated into Created with the latest preview', () => {
    const merged = mergeSseRenderPatch(
      articlePatch('Created', 'draft', 1),
      articlePatch('Updated', 'latest', 2)
    ) as SseArticleRenderPatch

    expect(merged.kind).toBe('changed')
    expect(merged.event?.payload.action).toBe('Created')
    expect(merged.event?.payload.preview?.title).toBe('latest')
  })

  it('merges Updated + Deleted into Deleted', () => {
    const merged = mergeSseRenderPatch(
      articlePatch('Updated', 'before delete', 1),
      articlePatch('Deleted', 'deleted', 2)
    ) as SseArticleRenderPatch

    expect(merged.event?.payload.action).toBe('Deleted')
    expect(merged.event?.payload.preview).toBeNull()
  })

  it('merges Deleted + Restored into Restored', () => {
    const merged = mergeSseRenderPatch(
      articlePatch('Deleted', 'deleted', 1),
      articlePatch('Restored', 'restored', 2)
    ) as SseArticleRenderPatch

    expect(merged.event?.payload.action).toBe('Restored')
    expect(merged.event?.payload.preview?.title).toBe('restored')
  })

  it('lets reconnect patches dominate article coalescing', () => {
    const reconnected: SseArticleRenderPatch = {
      module: 'article',
      kind: 'reconnected',
      replayMissed: true
    }

    expect(mergeSseRenderPatch(reconnected, articlePatch('Updated'))).toBe(reconnected)
    expect(mergeSseRenderPatch(articlePatch('Updated'), reconnected)).toBe(reconnected)
  })
})
