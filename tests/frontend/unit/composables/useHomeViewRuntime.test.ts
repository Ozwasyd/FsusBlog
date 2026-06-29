import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(__dirname, '../../../..')
const sourcePath = resolve(repoRoot, 'src/frontend/src/composables/useHomeView.ts')

function readSource(): string {
  return readFileSync(sourcePath, 'utf8')
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`const ${name} =`)
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0)
  const braceStart = source.indexOf('{', start)
  expect(braceStart, `missing function body ${name}`).toBeGreaterThan(start)
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') {
      depth++
    } else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  throw new Error(`unterminated function ${name}`)
}

describe('useHomeView runtime coalescing contract', () => {
  it('coalesces article batch fallback refresh through a single debounce timer', () => {
    const source = readSource()
    const handleArticleBatch = extractFunction(source, 'handleArticleBatch')

    expect(source).toContain('HOME_ARTICLE_BATCH_REFRESH_DELAY_MS')
    expect(source).toContain('let articleRefreshTimer')
    expect(source).toContain('const scheduleArticleBatchRefresh =')
    expect(handleArticleBatch).toContain('scheduleArticleBatchRefresh({')
    expect(handleArticleBatch).not.toContain('dispatchListUpdate()')
    expect(handleArticleBatch).not.toContain('dispatchFeaturedUpdate()')
  })

  it('keeps home secondary refresh behind one coalesced entrypoint', () => {
    const source = readSource()
    const loadHomeSecondaryArticles = extractFunction(source, 'loadHomeSecondaryArticles')
    const scheduleHomeSecondaryRefresh = extractFunction(source, 'scheduleHomeSecondaryRefresh')

    expect(source).toContain('HOME_SECONDARY_REFRESH_DELAY_MS')
    expect(loadHomeSecondaryArticles).toContain('getFeaturedArticles')
    expect(loadHomeSecondaryArticles).toContain('getHotArticles')
    expect(scheduleHomeSecondaryRefresh).toContain('secondaryRefreshTimer')
    expect(source).not.toContain('dispatchFeaturedUpdate')
  })

  it('does not force full list refresh for non-first-page article patches', () => {
    const source = readSource()
    const applyArticlePatch = extractFunction(source, 'applyArticlePatch')

    expect(applyArticlePatch).toContain('currentPage.value !== 1')
    expect(applyArticlePatch).toContain('homeRuntimeMetrics.stalePageMarks++')
  })

  it('does not schedule secondary article refresh for local Updated patches', () => {
    const source = readSource()
    const handleArticleBatch = extractFunction(source, 'handleArticleBatch')

    expect(handleArticleBatch).toContain("action === 'Created' || action === 'Deleted' || action === 'Restored'")
    expect(handleArticleBatch).not.toContain("|| action === 'Updated'")
    expect(handleArticleBatch).not.toContain("action === 'Updated' ||")
  })
})
