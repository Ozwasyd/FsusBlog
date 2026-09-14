import type { CommentAuthorView } from '@/api/comment';
import type { PublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets';
import { createPublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets';
import { TimeUtils } from '@/utils/time';

export interface CommentTimeContract {
    readonly isoTime: string;
    readonly relativeTimeText: string;
    readonly fullLocalTimeText: string;
}

export type UserCommentModerationTone = 'success' | 'warning' | 'danger' | 'info';

export interface UserCommentModerationContract {
    readonly status: number;
    readonly statusLabel: string;
    readonly visibilityState: string;
    readonly reasonCode: string;
    readonly reasonText: string;
    readonly tone: UserCommentModerationTone;
    readonly publiclyVisible: boolean;
}

interface CommentArticleLinkContract {
    readonly id: number;
    readonly title: string;
    readonly route: PublicArticleDetailNavigationTarget['route'];
    readonly ariaLabel: string;
}

export interface CommentThreadItemContract {
    readonly id: string;
    readonly content: string;
    readonly time: CommentTimeContract;
    readonly author: CommentAuthorView;
    readonly canDelete: boolean;
    readonly article?: CommentArticleLinkContract;
    readonly moderation?: UserCommentModerationContract;
}

export interface CommentComposerUiContract {
    readonly placeholder: string;
    readonly submitText: string;
    readonly submitBusyText: string;
    readonly disabled: boolean;
    readonly guestText: string;
    readonly guestActionText: string;
    readonly guestLoginRoute: {
        readonly path: string;
        readonly query: {
            readonly redirect: string;
        };
    };
}

export const commentDetailTokens = {
    articleList: {
        itemRoot: 'fsus-comment',
        headerRoot: 'fsus-comment__header',
        headerMeta: 'fsus-comment__identity',
        authorName: 'fsus-comment__author',
        timeText: 'fsus-comment__time',
        content: 'fsus-comment__content fsus-markdown-body',
        footer: 'fsus-comment__footer',
        action: 'fsus-comment__action'
    },
    composer: {
        loggedInShell: 'mb-6',
        submitWrap: 'mt-2 flex justify-end',
        guestShell: 'fsus-comment-login',
        guestText: 'fsus-comment-login__text',
        guestLink: 'fsus-comment-login__btn'
    }
} as const;

export function createArticleCommentViewContract(comment: {
    id: string;
    content: string;
    createTime: string;
    author: CommentAuthorView;
}, canDelete: boolean): CommentThreadItemContract
{
    return {
        id: String(comment.id),
        content: comment.content,
        author: comment.author,
        canDelete,
        time: {
            isoTime: comment.createTime,
            relativeTimeText: TimeUtils.toRelative(comment.createTime),
            fullLocalTimeText: TimeUtils.toFullLocalString(comment.createTime)
        }
    };
}

export function createUserCommentViewContract(comment: {
    id: string;
    content: string;
    createTime: string;
    articleId: number;
    articleTitle: string;
    author: CommentAuthorView;
    moderationStatus: number;
    moderationStatusLabel: string;
    visibilityState: string;
    visibilityReasonCode: string;
    isPubliclyVisible: boolean;
}): CommentThreadItemContract
{
    const articleTarget = createPublicArticleDetailNavigationTarget(comment.articleId);
    return {
        id: String(comment.id),
        content: comment.content,
        author: comment.author,
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
        },
        moderation: createUserCommentModerationContract(comment)
    };
}

function createUserCommentModerationContract(comment: {
    moderationStatus: number;
    moderationStatusLabel: string;
    visibilityState: string;
    visibilityReasonCode: string;
    isPubliclyVisible: boolean;
}): UserCommentModerationContract
{
    const reasonCode = comment.visibilityReasonCode || 'pending_review';
    return {
        status: comment.moderationStatus,
        statusLabel: comment.moderationStatusLabel || fallbackStatusLabel(reasonCode),
        visibilityState: comment.visibilityState || fallbackVisibilityState(reasonCode),
        reasonCode,
        reasonText: reasonText(reasonCode),
        tone: reasonTone(reasonCode),
        publiclyVisible: comment.isPubliclyVisible
    };
}

function fallbackStatusLabel(reasonCode: string): string
{
    switch (reasonCode)
    {
        case 'approved_public':
        case 'geo_limited':
            return '已公开';
        case 'hidden_by_moderation':
            return '已隐藏';
        case 'rejected_by_moderation':
            return '未通过审核';
        case 'deleted_by_user_or_admin':
            return '已删除';
        default:
            return '待审核，仅自己可见';
    }
}

function fallbackVisibilityState(reasonCode: string): string
{
    switch (reasonCode)
    {
        case 'approved_public':
            return 'public';
        case 'geo_limited':
            return 'limited';
        case 'hidden_by_moderation':
            return 'hidden';
        case 'rejected_by_moderation':
            return 'rejected';
        case 'deleted_by_user_or_admin':
            return 'deleted';
        default:
            return 'pending';
    }
}

function reasonText(reasonCode: string): string
{
    switch (reasonCode)
    {
        case 'approved_public':
            return '其他读者可以看到这条评论。';
        case 'geo_limited':
            return '部分地区不可见。';
        case 'hidden_by_moderation':
            return '此评论当前不会公开显示。';
        case 'rejected_by_moderation':
            return '此评论未通过审核，不会公开显示。';
        case 'deleted_by_user_or_admin':
            return '评论已删除，不再公开显示。';
        default:
            return '等待审核通过后才会公开显示。';
    }
}

function reasonTone(reasonCode: string): UserCommentModerationTone
{
    switch (reasonCode)
    {
        case 'approved_public':
            return 'success';
        case 'pending_review':
        case 'geo_limited':
            return 'warning';
        case 'hidden_by_moderation':
        case 'rejected_by_moderation':
            return 'danger';
        default:
            return 'info';
    }
}

export function createCommentComposerUiContract(redirectPath: string, state: {
    isBanned: boolean;
    isPowCalculating: boolean;
    isSubmitting: boolean;
    hasContent: boolean;
    authorMode?: 'public' | 'zk_anonymous';
    publicSendConfirmed?: boolean;
    anonymousCommentsEnabled?: boolean;
    publicCommentsEnabled?: boolean;
    zkAnonymousEnabled?: boolean;
}): CommentComposerUiContract
{
    const authorMode = state.authorMode ?? 'zk_anonymous';
    const publicBlocked = authorMode === 'public' && (!state.publicCommentsEnabled || !state.publicSendConfirmed);
    const zkBlocked = authorMode === 'zk_anonymous' && state.zkAnonymousEnabled !== true;
    const disabled = state.isBanned || state.isPowCalculating || state.isSubmitting || !state.hasContent || publicBlocked || zkBlocked;

    return {
        placeholder: state.isBanned ? '您已被封禁，仅限阅读。' : '在此写出你的评论 (Ctrl + Enter 发送)',
        submitText: '发送',
        submitBusyText: state.isBanned ? '账号已封禁' : state.isPowCalculating ? '安全校验...' : state.isSubmitting ? '发送中...' : '发送',
        disabled,
        guestText: '登录后可发表评论与回复。',
        guestActionText: '登录',
        guestLoginRoute: {
            path: '/login',
            query: {
                redirect: redirectPath
            }
        }
    };
}
