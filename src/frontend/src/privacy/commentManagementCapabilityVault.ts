export const COMMENT_MANAGEMENT_CAPABILITY_PERSISTENCE_MODE = 'memory-only' as const;
export const COMMENT_MANAGEMENT_CAPABILITY_LOSS_NOTICE =
    '匿名评论管理凭据只保存在当前页面内存中；刷新或关闭页面后无法找回，也不能通过账户恢复。';

export interface CommentManagementCapabilityVault {
    get(commentId: string): string | null;
    put(commentId: string, secret: string): void;
    remove(commentId: string): void;
    clear(): void;
}

let defaultVault: CommentManagementCapabilityVault | null = null;

export function getCommentManagementCapabilityVault(): CommentManagementCapabilityVault
{
    defaultVault ??= createMemoryOnlyCommentManagementCapabilityVault();
    return defaultVault;
}

export function createMemoryOnlyCommentManagementCapabilityVault(): CommentManagementCapabilityVault
{
    const secrets = new Map<string, string>();
    return {
        get(commentId)
        {
            return secrets.get(normalizeCommentId(commentId)) ?? null;
        },
        put(commentId, secret)
        {
            const id = normalizeCommentId(commentId);
            const value = secret.trim();
            if (!id || !value)
            {
                throw new Error('comment_management_capability_invalid');
            }
            secrets.set(id, value);
        },
        remove(commentId)
        {
            secrets.delete(normalizeCommentId(commentId));
        },
        clear()
        {
            secrets.clear();
        }
    };
}

export function resetCommentManagementCapabilityVaultForTests(): void
{
    defaultVault?.clear();
    defaultVault = null;
}

function normalizeCommentId(commentId: string): string
{
    const normalized = commentId.trim();
    return /^\d+$/u.test(normalized) && normalized !== '0' ? normalized : '';
}
