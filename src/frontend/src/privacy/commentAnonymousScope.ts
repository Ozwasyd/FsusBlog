export const anonymousCommentScopePolicy = {
  version: 1,
  topLevelUsesPerCredential: 1,
  threadReplyUsesPerCredential: 3
} as const

export type AnonymousCommentScope = {
  articleId: number
  kind: 'top' | 'thread'
  rootId: string | null
}

export function createAnonymousTopLevelScope(articleId: number): string {
  assertPositiveInteger(articleId, 'articleId')
  return `comment:v1:article:${articleId}:top`
}

export function createAnonymousThreadScope(articleId: number, rootId: string): string {
  assertPositiveInteger(articleId, 'articleId')
  if (!/^[1-9]\d*$/.test(rootId)) {
    throw new Error('anonymous_comment_root_id_invalid')
  }
  return `comment:v1:article:${articleId}:thread:${rootId}`
}

export function parseAnonymousCommentScope(scope: string): AnonymousCommentScope | null {
  const match = /^comment:v1:article:([1-9]\d*):(top|thread(?::([1-9]\d*))?)$/.exec(scope)
  if (!match) {
    return null
  }

  const articleId = Number(match[1])
  if (!Number.isSafeInteger(articleId) || articleId <= 0) {
    return null
  }

  if (match[2] === 'top') {
    return { articleId, kind: 'top', rootId: null }
  }

  return match[3]
    ? { articleId, kind: 'thread', rootId: match[3] }
    : null
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`anonymous_comment_${name}_invalid`)
  }
}
