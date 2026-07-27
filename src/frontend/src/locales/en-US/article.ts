export const localeDomainIdentity = Object.freeze({ locale: 'en-US', domain: 'article' } as const)

import type { LocaleSchema } from '../keys';
import type { article as zhCNArticle } from '../zh-CN/article';

export const article = {
    actions: {
        toc: 'Contents',
        tocAria: 'Article contents',
        comments: 'Comments',
        share: 'Share',
        top: 'Top',
        copyLink: 'Copy link',
        linkCopied: 'Link copied',
        copyFailed: 'Copy failed',
        copyCode: 'Copy',
        codeCopied: 'Copied',
        viewImage: 'View image',
        viewImageNamed: 'View image: {title}',
        closeImage: 'Close image',
        previousImage: 'Previous',
        nextImage: 'Next',
        previousArticle: 'Previous post',
        nextArticle: 'Next post',
        related: 'Related',
        read: 'Read',
        readFull: 'Read: {title}',
        loadMoreComments: 'Load more comments',
        noMoreComments: 'No more comments'
    },
    metadata: {
        publishedAt: 'Published',
        updatedAt: 'Updated',
        wordCount: {
            kind: 'plural',
            forms: {
                one: '{count} word',
                other: '{count} words'
            }
        },
        readingMinuteCount: {
            kind: 'plural',
            forms: {
                one: '{count} min read',
                other: '{count} min read'
            }
        },
        longRead: 'Long read',
        longReadAria: 'Long-read notice'
    },
    comments: {
        heading: 'Reader comments',
        empty: 'No comments.',
        emptyTitle: 'No comments',
        emptyDescription: 'Log in to join the discussion.',
        loginCta: 'Log in to comment',
        safetyTitle: 'Complete comment security check',
        treeAria: 'Comment tree'
    },
    content: {
        emptyAria: 'Article body is empty',
        empty: 'This article does not have body content yet.',
        tagsAria: 'Article tags',
        rightsAria: 'Copyright and citation',
        relatedAria: 'Related articles',
        coverAlt: '{title} — cover image'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>;
