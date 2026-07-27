export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'article' } as const)

import type { LocaleSchema } from '../keys';
import type { article as zhCNArticle } from '../zh-CN/article';

export const article = {
    actions: {
        toc: '목차',
        tocAria: '기사 목차',
        comments: '댓글',
        share: '공유',
        top: '맨 위',
        copyLink: '링크 복사',
        linkCopied: '링크가 복사되었습니다',
        copyFailed: '복사 실패',
        copyCode: '복사',
        codeCopied: '복사됨',
        viewImage: '이미지 보기',
        viewImageNamed: '이미지 보기: {title}',
        closeImage: '이미지 닫기',
        previousImage: '이전',
        nextImage: '다음',
        previousArticle: '이전 글',
        nextArticle: '다음 글',
        related: '관련',
        read: '읽기',
        readFull: '전체 읽기: {title}',
        loadMoreComments: '댓글 더 보기',
        noMoreComments: '더 이상 댓글 없음'
    },
    metadata: {
        publishedAt: '발행',
        updatedAt: '업데이트',
        wordCount: {
            kind: 'plural',
            forms: {
                other: '전체 {count}단어'
            }
        },
        readingMinuteCount: {
            kind: 'plural',
            forms: {
                other: '예상 {count}분 읽기'
            }
        },
        longRead: '긴 글',
        longReadAria: '긴 글 안내'
    },
    comments: {
        heading: '독자 댓글',
        empty: '댓글이 없습니다.',
        emptyTitle: '댓글 없음',
        emptyDescription: '토론에 참여하려면 로그인하세요.',
        loginCta: '댓글을 달려면 로그인',
        safetyTitle: '댓글 보안 검증을 완료해 주세요',
        treeAria: '댓글 트리'
    },
    content: {
        emptyAria: '기사 본문이 비어 있습니다',
        empty: '이 글에는 아직 본문이 없습니다.',
        tagsAria: '글 태그',
        rightsAria: '저작권 및 인용',
        relatedAria: '관련 글',
        coverAlt: '{title} — 표지 이미지'
    }
} as const satisfies LocaleSchema<typeof zhCNArticle>;
