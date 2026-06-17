import type { PublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import { createPublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import { TimeUtils } from '@/utils/time'

export interface CommentTimeContract {
  readonly isoTime: string
  readonly relativeTimeText: string
  readonly fullLocalTimeText: string
}

interface CommentArticleLinkContract {
  readonly id: number
  readonly title: string
  readonly route: PublicArticleDetailNavigationTarget['route']
  readonly ariaLabel: string
}

export interface CommentThreadItemContract {
  readonly id: string
  readonly content: string
  readonly time: CommentTimeContract
  readonly userName?: string
  readonly canDelete: boolean
  readonly article?: CommentArticleLinkContract
}

export interface CommentComposerUiContract {
  readonly placeholder: string
  readonly submitText: string
  readonly submitBusyText: string
  readonly disabled: boolean
  readonly guestPromptPrefix: string
  readonly guestPromptLoginText: string
  readonly guestPromptSuffix: string
  readonly guestLoginRoute: {
    readonly path: string
    readonly query: {
      readonly redirect: string
    }
  }
}

export const commentDetailTokens = {
  articleList: {
    itemRoot: 'group border-b border-[var(--fsusblog-panel-border)] pb-8 last:border-0',
    headerRoot: 'flex items-center justify-between gap-3 mb-3',
    headerMeta: 'flex items-center gap-3',
    authorName: 'text-sm font-bold text-[var(--fsusblog-text-primary)] truncate',
    timeText: 'text-[10px] tabular-nums text-[var(--fsusblog-text-muted)] shrink-0 tabular-nums',
    content: 'text-sm text-[var(--fsusblog-text-tertiary)] leading-relaxed whitespace-pre-wrap break-words',
  },
  composer: {
    loggedInShell: 'mb-12',
    submitWrap: 'mt-3 flex justify-end',
    guestShell: 'mb-12 py-8 bg-[var(--fsusblog-panel-bg)]/50 flex items-center justify-center border border-[var(--fsusblog-panel-border)]',
    guestText: 'text-xs sm:text-sm font-medium tracking-normal normal-case text-[var(--fsusblog-text-muted)]',
    guestLink: 'text-[var(--fsusblog-text-primary)] hover:text-[var(--fsusblog-color-primary)] underline underline-offset-4 font-bold',
  }
} as const

export function createArticleCommentViewContract(comment: {
  id: string
  content: string
  createTime: string
  userName: string
}, canDelete: boolean): CommentThreadItemContract {
  return {
    id: String(comment.id),
    content: comment.content,
    userName: comment.userName,
    canDelete,
    time: {
      isoTime: comment.createTime,
      relativeTimeText: TimeUtils.toRelative(comment.createTime),
      fullLocalTimeText: TimeUtils.toFullLocalString(comment.createTime)
    }
  }
}

export function createUserCommentViewContract(comment: {
  id: string
  content: string
  createTime: string
  articleId: number
  articleTitle: string
}): CommentThreadItemContract {
  const articleTarget = createPublicArticleDetailNavigationTarget(comment.articleId)
  return {
    id: String(comment.id),
    content: comment.content,
    canDelete: true,
    time: {
      isoTime: comment.createTime,
      relativeTimeText: TimeUtils.toRelative(comment.createTime),
      fullLocalTimeText: TimeUtils.toFullLocalString(comment.createTime)
    },
    article: {
      id: comment.articleId,
      title: comment.articleTitle,
      route: articleTarget.route,
      ariaLabel: `查看文章《${comment.articleTitle}》`
    }
  }
}

export function createCommentComposerUiContract(redirectPath: string, state: {
  isBanned: boolean
  isPowCalculating: boolean
  isSubmitting: boolean
  hasContent: boolean
  authorMode?: 'anonymous' | 'public' | 'zk_anonymous'
  publicSendConfirmed?: boolean
  anonymousCommentsEnabled?: boolean
  publicCommentsEnabled?: boolean
  zkAnonymousEnabled?: boolean
}): CommentComposerUiContract {
  const authorMode = state.authorMode ?? 'anonymous'
  const publicBlocked = authorMode === 'public' && (!state.publicCommentsEnabled || !state.publicSendConfirmed)
  const anonymousBlocked = authorMode === 'anonymous' && state.anonymousCommentsEnabled === false
  const zkBlocked = authorMode === 'zk_anonymous' && state.zkAnonymousEnabled !== true
  const disabled = state.isBanned || state.isPowCalculating || state.isSubmitting || !state.hasContent || publicBlocked || anonymousBlocked || zkBlocked

  return {
    placeholder: state.isBanned ? '您已被封禁，仅限阅读。' : '在此写出你的评论 (Ctrl + Enter 发送)',
    submitText: '发送',
    submitBusyText: state.isBanned ? '账号已封禁' : state.isPowCalculating ? '安全校验...' : state.isSubmitting ? '发送中...' : '发送',
    disabled,
    guestPromptPrefix: '请',
    guestPromptLoginText: '登录',
    guestPromptSuffix: '后发表评论',
    guestLoginRoute: {
      path: '/login',
      query: {
        redirect: redirectPath
      }
    }
  }
}
