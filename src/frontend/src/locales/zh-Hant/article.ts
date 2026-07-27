export const localeDomainIdentity = Object.freeze({ locale: 'zh-Hant', domain: 'article' } as const)

import type { LocaleSchema } from '../keys'
import type { article as zhCNArticle } from '../zh-CN/article'

export const article = {
    actions: {
        toc: '目錄',
        tocAria: '文章目錄',
        comments: '評論',
        share: '分享',
        top: '頂部',
        copyLink: '複製連結',
        linkCopied: '連結已複製',
        copyFailed: '複製失敗',
        copyCode: '複製',
        codeCopied: '已複製',
        viewImage: '檢視大圖',
        viewImageNamed: '檢視大圖：{title}',
        closeImage: '關閉大圖',
        previousImage: '上一張',
        nextImage: '下一張',
        previousArticle: '上一篇',
        nextArticle: '下一篇',
        related: '相關閱讀',
        read: '閱讀',
        readFull: '閱讀全文：{title}',
        loadMoreComments: '載入更多評論',
        noMoreComments: '沒有更多評論'
    },
    metadata: {
        publishedAt: '發佈於',
        updatedAt: '更新於',
        wordCount: {
            kind: 'plural',
            forms: {
                other: '全文約 {count} 字'
            }
        },
        readingMinuteCount: {
            kind: 'plural',
            forms: {
                other: '預計閱讀 {count} 分鐘'
            }
        },
        longRead: '長文',
        longReadAria: '長文閱讀提示'
    },
    comments: {
        heading: '讀者評論',
        empty: '暫無評論。',
        emptyTitle: '暫無評論',
        emptyDescription: '登入後可參與討論。',
        loginCta: '登入以參與討論',
        safetyTitle: '完成評論安全驗證',
        treeAria: '評論樹'
    },
    content: {
        emptyAria: '文章正文為空',
        empty: '這篇文章目前還沒有正文內容',
        tagsAria: '文章標籤',
        rightsAria: '版權與引用',
        relatedAria: '延伸閱讀文章',
        coverAlt: '{title} — 題圖'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>
