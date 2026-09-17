import type {
    CommentAuthorView,
    CommentAuthorViewMode,
    CommentDisplayLanguage
} from '@/contracts/binaryApi';
import { AppErrorCode, createAppError } from '@/utils/appError';

export function resolveCommentAuthorView(input: {
    author?: CommentAuthorView | null;
}): CommentAuthorView
{
    const author = input.author;
    if (author?.displayName?.trim())
    {
        return {
            mode: normalizeCommentAuthorMode(author.mode),
            displayName: author.displayName.trim(),
            displayLanguage: normalizeCommentDisplayLanguage(author.displayLanguage),
            badge: normalizeNullableAuthorField(author.badge),
            scopeLabel: normalizeNullableAuthorField(author.scopeLabel)
        };
    }

    throw createAppError(AppErrorCode.ProtocolFailure, 'comment_author_contract_missing');
}

function normalizeCommentAuthorMode(mode: CommentAuthorView['mode'] | string | null | undefined): CommentAuthorViewMode
{
    const normalized = String(mode ?? '').trim().toLowerCase().replace('-', '_');
    if (normalized === 'public' || normalized === 'zk_anonymous')
    {
        return normalized;
    }
    return 'legacy_server_visible_pseudonymous';
}

function normalizeCommentDisplayLanguage(language: CommentDisplayLanguage | string | null | undefined): CommentDisplayLanguage
{
    return language === 'en' ? 'en' : 'zh-CN';
}

function normalizeNullableAuthorField(value: string | null | undefined): string | null
{
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
