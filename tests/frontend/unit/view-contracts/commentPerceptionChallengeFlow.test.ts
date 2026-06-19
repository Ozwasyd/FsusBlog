import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepoFile = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('comment perception v2 challenge flow wiring', () => {
  it('connects comment.create challenge issue, host rendering, verified resume, and proof forwarding', () => {
    const view = readRepoFile('src/views/ArticleDetail.vue')
    const composable = readRepoFile('src/composables/useArticleDetailView.ts')

    expect(view).toContain('FsusSecurityChallenge')
    expect(view).toContain('commentChallengeVisible')
    expect(view).toContain('@verified="handleCommentChallengeVerified"')
    expect(view).toContain('@cancel="handleCommentChallengeCancel"')

    expect(composable).toContain("const COMMENT_CREATE_CHALLENGE_ACTION = 'comment.create'")
    expect(composable).toContain('ensureCommentCreateChallengeProof')
    expect(composable).toContain('commentChallengeClient.issue(context)')
    expect(composable).toContain('commentChallengePreload.value = result')
    expect(composable).toContain('proofToken: challengeProof?.proofToken ?? null')
    expect(composable).toContain('commentMutationSubmitted = true')
  })

  it('keeps auth login and recovery-key verify behind explicit fallback gates', () => {
    const challengeClient = readRepoFile('src/security/challenge-client.ts')

    expect(challengeClient).toContain("'auth.login': 'fallback'")
    expect(challengeClient).toContain("'recovery-key.verify': 'fallback'")
  })
})
