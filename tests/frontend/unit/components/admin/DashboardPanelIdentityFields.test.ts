import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const deprecatedIdentityFields = /\b(?:userName|userId)\b/

describe('admin dashboard panel identity fields', () => {
  it('keeps DashboardCommentModerationPanel on anonymous-safe actor display metadata', () => {
    const source = readRepoFile('src/frontend/src/components/admin/DashboardCommentModerationPanel.vue')

    expect(source).toContain('comment.actorDisplayName')
    expect(source).not.toMatch(deprecatedIdentityFields)
  })

  it('keeps DashboardRecentComments on anonymous-safe author display metadata', () => {
    const source = readRepoFile('src/frontend/src/components/admin/DashboardRecentComments.vue')

    expect(source).toContain('comment.authorDisplayName')
    expect(source).not.toMatch(deprecatedIdentityFields)
  })

  it('keeps DashboardAuthorAnalyticsPanel on aggregate analytics only', () => {
    const source = readRepoFile('src/frontend/src/components/admin/DashboardAuthorAnalyticsPanel.vue')

    expect(source).toContain('props.view.authorAnalytics')
    expect(source).not.toMatch(deprecatedIdentityFields)
  })
})
