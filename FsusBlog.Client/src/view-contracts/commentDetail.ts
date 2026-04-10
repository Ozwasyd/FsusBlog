import { TimeUtils } from '@/utils/time'

export interface CommentTimeContract {
  readonly isoTime: string
  readonly relativeTimeText: string
  readonly fullLocalTimeText: string
}

export interface CommentArticleLinkContract {
  readonly id: number
  readonly title: string
  readonly route: {
    readonly name: 'ArticleDetail'
    readonly params: {
      readonly id: number
    }
  }
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
  readonly disabledClass: string
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
    itemRoot: 'group border-b border-zinc-100 pb-8 last:border-0',
    headerRoot: 'flex items-center justify-between gap-3 mb-3',
    headerMeta: 'flex items-center gap-3',
    authorName: 'text-sm font-bold text-zinc-950 truncate',
    deleteButton: 'text-[9px] font-bold text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-all uppercase tracking-widest outline-none',
    timeText: 'text-[10px] font-mono text-zinc-400 shrink-0 tabular-nums',
    content: 'text-sm text-zinc-600 leading-relaxed whitespace-pre-wrap break-words',
  },
  userList: {
    root: 'space-y-10 sm:space-y-12',
    itemRoot: 'group relative pt-8 border-t border-zinc-100 first:border-t-0 sm:first:border-t',
    headerRoot: 'flex flex-col sm:flex-row justify-between items-start gap-3 sm:gap-6 mb-5 sm:mb-6',
    headerMeta: 'space-y-1.5 grow pr-0 sm:pr-8',
    articleLabel: 'text-[9px] font-bold text-zinc-400 uppercase tracking-[0.2em]',
    articleLink: 'block text-sm font-bold text-zinc-950 hover:text-zinc-500 transition-colors tracking-wide leading-snug break-words outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 rounded-sm',
    timeText: 'text-[10px] font-mono font-bold text-zinc-300 uppercase tracking-widest shrink-0 pt-0.5 tabular-nums',
    content: 'text-zinc-600 text-sm leading-relaxed whitespace-pre-wrap mb-6 break-words overflow-hidden',
    deleteWrap: 'flex justify-end',
    deleteButton: 'text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-300 hover:text-zinc-950 transition-colors duration-300 py-3 -mr-3 px-3 active:scale-95 outline-none focus-visible:text-zinc-950',
    pageRoot: 'pt-12 border-t border-zinc-950 flex justify-center',
    loadMoreButton: 'w-full sm:w-auto px-10 py-4 sm:py-3 border border-zinc-950 text-[10px] font-black tracking-[0.3em] uppercase transition-all duration-300 active:bg-zinc-950 active:text-white sm:hover:bg-zinc-950 sm:hover:text-white disabled:opacity-30 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950',
    loadMoreLoading: 'animate-pulse',
    endHint: 'text-[9px] font-bold tracking-[0.3em] text-zinc-300 uppercase',
  },
  composer: {
    loggedInShell: 'mb-12',
    textarea: 'w-full bg-transparent border border-zinc-100 focus:border-zinc-950 rounded-none p-4 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors resize-none appearance-none',
    textareaDisabled: 'opacity-50 cursor-not-allowed',
    submitWrap: 'mt-3 flex justify-end',
    submitButton: 'w-full sm:w-auto text-xs font-bold tracking-[0.2em] uppercase px-8 py-3 bg-zinc-950 text-white hover:opacity-80 disabled:opacity-30 transition-all',
    guestShell: 'mb-12 py-8 bg-white flex items-center justify-center border border-zinc-100',
    guestText: 'text-xs sm:text-sm font-medium tracking-widest uppercase text-zinc-400',
    guestLink: 'text-zinc-950 underline underline-offset-4 font-bold',
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
      route: {
        name: 'ArticleDetail',
        params: {
          id: comment.articleId
        }
      },
      ariaLabel: `查看文章《${comment.articleTitle}》`
    }
  }
}

export function createCommentComposerUiContract(redirectPath: string, state: {
  isBanned: boolean
  isPowCalculating: boolean
  isSubmitting: boolean
  hasContent: boolean
}): CommentComposerUiContract {
  const disabled = state.isBanned || state.isPowCalculating || state.isSubmitting || !state.hasContent

  return {
    placeholder: state.isBanned ? '您已被封禁，仅限阅读。' : '在此写出你的评论 (Ctrl + Enter 发送)',
    submitText: '发送',
    submitBusyText: state.isBanned ? '账号已封禁' : state.isPowCalculating ? '安全校验...' : state.isSubmitting ? '发送中...' : '发送',
    disabled,
    disabledClass: state.isBanned ? commentDetailTokens.composer.textareaDisabled : '',
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
