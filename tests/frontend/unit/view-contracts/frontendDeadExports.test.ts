import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoPath = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))

const readFrontendSources = (dir: string): string => {
  let combined = ''
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`
    const stat = statSync(path)
    if (stat.isDirectory()) {
      combined += readFrontendSources(path)
    } else if (/\.(ts|vue)$/.test(entry)) {
      combined += `\n// ${path}\n${readFileSync(path, 'utf8')}`
    }
  }
  return combined
}

describe('frontend dead export cleanup contract', () => {
  it('does not expose retired store actions or risk control option clients', () => {
    const source = readFrontendSources(repoPath('src/frontend/src'))
    const retiredTokens = [
      'setUserInfo',
      'isMobileSearchOpen',
      'setMobileSearchVisible',
      'updateRiskControlOptions',
      'rollbackRiskControlOptions',
      'RiskControlPolicyUpdateRequest',
      'captchaV1Enabled',
      'poSpaceV1Enabled'
    ]

    expect(retiredTokens.filter((token) => source.includes(token))).toEqual([])
  })

  it('does not expose the retired legacy comment creation API', () => {
    const source = readFrontendSources(repoPath('src/frontend/src'))
    const commentApi = readFileSync(repoPath('src/frontend/src/api/comment.ts'), 'utf8')
    const retiredPatterns = [
      ['createComment', /\bcreateComment\b/u],
      ['CommentDto', /\bCommentDto\b/u],
      ['PowRequest', /\bPowRequest\b/u]
    ] as const

    expect(retiredPatterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name)).toEqual([])
    expect(commentApi).toContain('export interface CommentCreateV2Dto')
    expect(commentApi).toContain('export const createCommentV2')
    expect(commentApi).toContain('export const createPublicComment')
  })
})
