export const article = {
    actions: {
        toc: '目录',
        tocAria: '文章目录',
        comments: '评论',
        share: '分享',
        top: '顶部',
        copyLink: '复制链接',
        linkCopied: '链接已复制',
        copyFailed: '复制失败',
        copyCode: '复制',
        codeCopied: '已复制',
        viewImage: '查看大图',
        viewImageNamed: '查看大图：{title}',
        closeImage: '关闭大图',
        previousImage: '上一张',
        nextImage: '下一张',
        previousArticle: '上一篇',
        nextArticle: '下一篇',
        related: '相关阅读',
        read: '阅读',
        readFull: '阅读全文：{title}',
        loadMoreComments: '加载更多评论',
        noMoreComments: '没有更多评论'
    },
    metadata: {
        publishedAt: '发布于',
        updatedAt: '更新于',
        words: '全文约 {count} 字',
        readingMinutes: '预计阅读 {count} 分钟',
        longRead: '长文',
        longReadAria: '长文阅读提示'
    },
    comments: {
        heading: '读者评论',
        empty: '暂无评论。',
        emptyTitle: '暂无评论',
        emptyDescription: '登录后可参与讨论。',
        loginCta: '登录以参与讨论',
        safetyTitle: '完成评论安全验证',
        treeAria: '评论树'
    },
    content: {
        emptyAria: '文章正文为空',
        empty: '这篇文章目前还没有正文内容',
        tagsAria: '文章标签',
        rightsAria: '版权与引用',
        relatedAria: '延伸阅读文章',
        coverAlt: '{title} — 题图'
    }
} as const;
