import { describe, expect, it } from 'vitest'
import type { ArticleListItemResponse } from '@/api/article'
import { normalizeModerationText, scoreContentRisk, validateCommentContent } from '@/utils/contentFilter'
import { rankSearchPage } from '@/services/searchRanking'
import { mergeNotificationStreamRenderPatch } from '@/services/notificationStreamRenderScheduler'
import { NotificationStreamEventType, type ArticleUpdatePayload, type NotificationStreamArticleRenderPatch, type NotificationStreamEventV2 } from '@/services/notificationStreamTypes'

const SAMPLE_ALPHABET = 'abcXYZ中文测试 　\u200B_%/:加微信学习'
const NOW_MS = Date.parse('2026-01-01T00:00:00Z')

function generateString(seed: number, maxLength = 48): string {
  let state = seed >>> 0
  let output = ''
  const length = 1 + (seed % maxLength)
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    output += SAMPLE_ALPHABET[state % SAMPLE_ALPHABET.length]
  }
  return output
}

function makeArticle(id: number, title: string, views = 0): ArticleListItemResponse {
  return {
    id,
    title,
    summary: `summary ${title}`,
    views,
    createTime: `2025-12-${String(Math.max(1, id)).padStart(2, '0')}T00:00:00Z`,
    category: { id: 1, name: id % 2 === 0 ? 'Protocol' : 'Frontend' },
    tags: [{ id, name: id % 2 === 0 ? 'AEDS' : 'Vue' }]
  }
}

function articlePatch(action: ArticleUpdatePayload['action'], eventId: number): NotificationStreamArticleRenderPatch {
  const payload: ArticleUpdatePayload = {
    articleId: 1,
    action,
    eventTime: `2025-01-01T00:00:${String(eventId).padStart(2, '0')}Z`,
    preview: action === 'Deleted' ? null : makeArticle(1, action)
  }
  const event: NotificationStreamEventV2<ArticleUpdatePayload> = {
    id: eventId,
    type: NotificationStreamEventType.ArticleChanged,
    ts: eventId,
    payload
  }
  return { module: 'article', kind: 'changed', event }
}

function canonicalArticlePatch(patch: NotificationStreamArticleRenderPatch): string {
  return JSON.stringify({
    kind: patch.kind,
    action: patch.event?.payload.action ?? null,
    articleId: patch.event?.payload.articleId ?? null,
    previewTitle: patch.event?.payload.preview?.title ?? null
  })
}

describe('frontend property tests', () => {
  it('keeps moderation normalization idempotent across generated Unicode samples', () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const normalized = normalizeModerationText(generateString(seed))
      expect(normalizeModerationText(normalized)).toBe(normalized)
    }
  })

  it('does not let zero-width insertion lower high-risk moderation decisions', () => {
    const direct = scoreContentRisk('加微信联系')
    const obfuscated = scoreContentRisk('加\u200B微\u200B信联系')

    expect(direct.score).toBeGreaterThanOrEqual(0.9)
    expect(obfuscated.score).toBeGreaterThanOrEqual(direct.score)
    expect(validateCommentContent('学习记录和复习计划').isValid).toBe(true)
  })

  it('keeps documented notification stream article merge sequences associative', () => {
    const legalSequences: Array<readonly ArticleUpdatePayload['action'][]> = [
      ['Created', 'Updated', 'Deleted'],
      ['Deleted', 'Restored', 'Updated'],
      ['Created', 'Deleted', 'Restored'],
      ['Updated', 'Updated', 'Deleted'],
      ['Restored', 'Updated', 'Deleted']
    ]

    for (const sequence of legalSequences) {
      const [a, b, c] = sequence.map((action, index) => articlePatch(action, index + 1))
      const left = mergeNotificationStreamRenderPatch(mergeNotificationStreamRenderPatch(a, b), c) as NotificationStreamArticleRenderPatch
      const right = mergeNotificationStreamRenderPatch(a, mergeNotificationStreamRenderPatch(b, c)) as NotificationStreamArticleRenderPatch
      expect(canonicalArticlePatch(left)).toBe(canonicalArticlePatch(right))
    }
  })

  it('keeps notification stream merge idempotent for same-action article patches', () => {
    for (const action of ['Created', 'Updated', 'Deleted', 'Restored'] as const) {
      const patch = articlePatch(action, 1)
      const merged = mergeNotificationStreamRenderPatch(patch, patch) as NotificationStreamArticleRenderPatch
      expect(canonicalArticlePatch(merged)).toBe(canonicalArticlePatch(patch))
    }
  })

  it('keeps search ranking deterministic for generated fixtures', () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      makeArticle(index + 1, `${generateString(index + 10, 12)} protocol`, index * 13)
    )

    const first = rankSearchPage({ items, total: items.length }, 'protocol vue', 'relevance', NOW_MS)
    const second = rankSearchPage({ items, total: items.length }, 'protocol vue', 'relevance', NOW_MS)

    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id))
    expect(new Set(first.items.map((item) => item.id)).size).toBe(first.items.length)
  })
})
