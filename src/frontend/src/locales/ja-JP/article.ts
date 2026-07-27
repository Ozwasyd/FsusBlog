export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'article' } as const)

import type { LocaleSchema } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: '目次',
        tocAria: '記事目次',
        comments: 'コメント',
        share: '共有',
        top: 'トップ',
        copyLink: 'リンクをコピー',
        linkCopied: 'リンクをコピーしました',
        copyFailed: 'コピーに失敗しました',
        copyCode: 'コピー',
        codeCopied: 'コピーしました',
        viewImage: '画像を拡大',
        viewImageNamed: '画像を拡大：{title}',
        closeImage: '画像を閉じる',
        previousImage: '前へ',
        nextImage: '次へ',
        previousArticle: '前の記事',
        nextArticle: '次の記事',
        related: '関連記事',
        read: '読む',
        readFull: '全文を読む：{title}',
        loadMoreComments: 'さらにコメントを読み込む',
        noMoreComments: 'これ以上のコメントはありません'
    },
    metadata: {
        publishedAt: '公開日',
        updatedAt: '更新日',
        wordCount: {
            kind: 'plural',
            forms: {
                other: '約 {count} 字'
            }
        },
        readingMinuteCount: {
            kind: 'plural',
            forms: {
                other: '読了目安 {count} 分'
            }
        },
        longRead: '長文',
        longReadAria: '長文記事のお知らせ'
    },
    comments: {
        heading: '読者コメント',
        empty: 'まだコメントはありません。',
        emptyTitle: 'コメントなし',
        emptyDescription: 'ログインするとディスカッションに参加できます。',
        loginCta: 'ログインしてコメントする',
        safetyTitle: 'コメントセキュリティ検証を完了してください',
        treeAria: 'コメントツリー'
    },
    content: {
        emptyAria: '記事本文が空です',
        empty: 'この記事にはまだ本文がありません',
        tagsAria: '記事タグ',
        rightsAria: '著作権と引用',
        relatedAria: '関連記事',
        coverAlt: '{title} — カバー画像'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>
