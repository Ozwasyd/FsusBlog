import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { ArticleListItemResponse } from '@/api/article'
import { scoreContentRisk } from '@/utils/contentFilter'
import { rankSearchPage } from '@/services/searchRanking'
import { mergeSseRenderPatch } from '@/services/sseRenderScheduler'
import { SseEventType, type ArticleUpdatePayload, type SseArticleRenderPatch, type SseEventV2 } from '@/services/sseTypes'

type BenchmarkResult = {
  name: string
  iterations: number
  durationMs: number
  budgetMs: number
}

const NOW_MS = Date.parse('2026-01-01T00:00:00Z')
const results: BenchmarkResult[] = []

function benchmark(name: string, iterations: number, budgetMs: number, fn: () => void): void {
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    fn()
  }
  const durationMs = Number((performance.now() - started).toFixed(3))
  results.push({ name, iterations, durationMs, budgetMs })
  expect(durationMs).toBeLessThan(budgetMs)
}

function makeArticle(id: number): ArticleListItemResponse {
  return {
    id,
    title: `AEDS protocol ranking fixture ${id}`,
    summary: `Vue frontend search benchmark ${id}`,
    views: id * 7,
    createTime: `2025-12-${String((id % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    category: { id: 1, name: id % 2 === 0 ? 'Protocol' : 'Frontend' },
    tags: [{ id, name: id % 2 === 0 ? 'AEDS' : 'Vue' }]
  }
}

function articlePatch(action: ArticleUpdatePayload['action'], id: number): SseArticleRenderPatch {
  const payload: ArticleUpdatePayload = {
    articleId: id,
    action,
    eventTime: '2025-01-01T00:00:00Z',
    preview: action === 'Deleted' ? null : makeArticle(id)
  }
  const event: SseEventV2<ArticleUpdatePayload> = {
    id,
    type: SseEventType.ArticleChanged,
    ts: id,
    payload
  }
  return { module: 'article', kind: 'changed', event }
}

describe('frontend perf regression smoke', () => {
  it('keeps algorithm hot paths inside lightweight budgets', () => {
    const articles = Array.from({ length: 250 }, (_, index) => makeArticle(index + 1))
    const page = { items: articles, total: articles.length }
    const updated = articlePatch('Updated', 1)
    const deleted = articlePatch('Deleted', 1)

    benchmark('content-risk-500x', 500, 60, () => {
      scoreContentRisk('学习 AEDS protocol 加\u200B微\u200B信 测试')
    })
    benchmark('search-rank-250-docs-80x', 80, 320, () => {
      rankSearchPage(page, 'aeds protocol vue', 'relevance', NOW_MS)
    })
    benchmark('sse-merge-5000x', 5000, 45, () => {
      mergeSseRenderPatch(updated, deleted)
    })

    const outputDir = resolve(process.cwd(), '../../.tmp/frontend-perf')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(
      resolve(outputDir, 'frontend-perf-regression.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`
    )
  })
})
