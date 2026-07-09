import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

const extractConstBlock = (source: string, name: string): string => {
  const start = source.indexOf(`const ${name} =`)
  expect(start, `missing const ${name}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n\n', start)
  expect(end, `missing const block end ${name}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('frontend Map/Set and first-array simplification contracts', () => {
  it('rebuilds comment stream indexes with Map and Set constructors', () => {
    const commentStream = readRepoFile('src/frontend/src/composables/useArticleCommentStream.ts')
    const updateReplySet = extractConstBlock(commentStream, 'updateReplySet')
    const rebuildThreadIndexes = extractConstBlock(commentStream, 'rebuildThreadIndexes')

    expect(updateReplySet).toContain('new Set(replies.map((item) => String(item.id)))')
    expect(updateReplySet).not.toContain('for (const item of replies)')
    expect(rebuildThreadIndexes).toContain('new Map(items.map((item, index)')
    expect(rebuildThreadIndexes).toContain('[String(item.rootId), index]')
    expect(rebuildThreadIndexes).not.toContain('for (let index')
  })

  it('selects the first home seed array through a helper instead of nested ternaries', () => {
    const homeView = readRepoFile('src/frontend/src/composables/useHomeView.ts')

    expect(homeView).toContain('const firstArrayOf = <T>(...candidates: (T[] | null | undefined)[]): T[] =>')
    expect(homeView).toContain('const initialFeaturedArticles = firstArrayOf(')
    expect(homeView).toContain('const initialHotArticles = firstArrayOf(')
    expect(homeView).not.toContain('Array.isArray(initialHydrationPayload?.featuredArticles)\n    ?')
    expect(homeView).not.toContain('Array.isArray(initialHydrationPayload?.hotArticles)\n    ?')
  })

  it('does not keep dead duplicate-id state in the user comments cursor page', () => {
    const userCommentsPage = readRepoFile('src/frontend/src/composables/useUserCommentsPage.ts')

    expect(userCommentsPage).not.toContain('existingIds')
    expect(userCommentsPage).not.toContain('uniqueNew')
    expect(userCommentsPage).toContain('response.data.map(createUserCommentViewContract)')
  })
})
