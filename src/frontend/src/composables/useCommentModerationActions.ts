import { computed, ref } from 'vue';

import {
    CommentModerationStatus,
    blockAnonymousNullifier,
    claimCommentModeration,
    moderateComment,
    moderateCommentsBulk,
    releaseCommentModerationClaim,
    revokeAnonymousCredential,
    type CommentModerationClaimResponse
} from '@/api/authoring';
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof';
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback';
import { commentModerationStatusLabel, type CommentModerationViewItem } from '@/composables/useCommentModerationQueue';
import { promptText, toast } from '@/fsusui/feedback';
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime';
import { AppErrorCode, isAppError } from '@/utils/appError';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';


function isBanEligibleStatus(status: CommentModerationStatus): boolean
{
    return status === CommentModerationStatus.Rejected || status === CommentModerationStatus.Hidden;
}

function normalizeModerationReason(status: CommentModerationStatus, reason: string): string
{
    const trimmed = reason.trim();
    return trimmed.length > 0 ? trimmed : commentModerationStatusLabel(status);
}

function cleanGovernanceValue(value: string | number | null | undefined): string | null
{
    if (value === null || value === undefined)
    {
        return null;
    }
    const text = String(value).trim();
    return text.length > 0 ? text : null;
}

function moderationErrorMessage(error: unknown, fallback: string): string
{
    if (!isAppError(error))
    {
        if (error instanceof Error)
        {
            if (error.message === 'MFA_CHALLENGE_CANCELLED')
            {
                return '已取消管理员二次验证';
            }
            if (error.message === 'MFA_CHALLENGE_REQUIRED' || error.message === 'MFA_PROOF_REQUIRED')
            {
                return '管理员验证已过期，请重新完成二次验证';
            }
        }
        return fallback;
    }

    const message = error.message || fallback;
    if (message.includes('MFA_PROOF_REQUIRED') || message.includes('MFA_CHALLENGE_REQUIRED') || error.status === 428)
    {
        return '管理员验证已过期，请重新完成二次验证';
    }
    if (error.code === AppErrorCode.Forbidden || error.status === 403)
    {
        return '当前账号无权限执行该审核操作';
    }
    if (error.code === AppErrorCode.Conflict || error.status === 409)
    {
        return '该评论已被其他管理员处理，请刷新队列';
    }
    if (error.code === AppErrorCode.NotFound || error.status === 404)
    {
        return '评论不存在或已删除，队列需要刷新';
    }
    if (error.code === AppErrorCode.RateLimited || error.status === 429)
    {
        return '审核操作过于频繁，请稍后再试';
    }
    if (error.code === AppErrorCode.Unauthorized || error.status === 401)
    {
        return '登录状态已失效，请重新登录';
    }
    return message;
}

function anonymousGovernanceErrorMessage(error: unknown, fallback: string): string
{
    if (!isAppError(error))
    {
        if (error instanceof Error)
        {
            if (error.message === 'MFA_CHALLENGE_CANCELLED')
            {
                return '已取消管理员二次验证';
            }
            if (error.message === 'MFA_CHALLENGE_REQUIRED' || error.message === 'MFA_PROOF_REQUIRED')
            {
                return '管理员验证已过期，请重新完成二次验证';
            }
            if (error.message === 'ANONYMOUS_GOVERNANCE_NOT_APPLIED')
            {
                return '匿名治理动作未被应用，请刷新队列后重试';
            }
        }
        return fallback;
    }

    const message = error.message || fallback;
    if (message.includes('MFA_PROOF_REQUIRED') || message.includes('MFA_CHALLENGE_REQUIRED') || error.status === 428)
    {
        return '管理员验证已过期，请重新完成二次验证';
    }
    if (error.code === AppErrorCode.Forbidden || error.status === 403)
    {
        return '当前账号无权限执行匿名治理操作';
    }
    if (error.code === AppErrorCode.Conflict || error.status === 409)
    {
        return '匿名治理对象状态已变化，请刷新队列';
    }
    if (error.code === AppErrorCode.NotFound || error.status === 404)
    {
        return '匿名治理对象不存在或已失效，请刷新队列';
    }
    if (error.code === AppErrorCode.RateLimited || error.status === 429)
    {
        return '匿名治理操作过于频繁，请稍后再试';
    }
    if (error.code === AppErrorCode.Unauthorized || error.status === 401)
    {
        return '登录状态已失效，请重新登录';
    }
    return message;
}

type ActiveDecisionClaim = Readonly<{
    item: CommentModerationViewItem;
    claim: CommentModerationClaimResponse;
}>;

export function useCommentModerationActions(resolveQueueItems: () => readonly CommentModerationViewItem[] = () => [])
{
    const selectedIds = ref<string[]>([]);
    const actionReason = ref('');
    const banUsers = ref(false);
    const processingId = ref<string | null>(null);
    const processingBulk = ref(false);
    const isProcessing = computed(() => processingBulk.value || processingId.value !== null);
    const taskFeedback = useAdminTaskFeedback();

    const acquireDecisionClaim = async (item: CommentModerationViewItem): Promise<ActiveDecisionClaim> =>
    {
        const claim = await claimCommentModeration(item.id, {
            leaseSeconds: 120,
            processSlaSeconds: 1800,
            escalationStatus: 'none'
        });
        if (!claim.applied || !claim.commentRowVersion || !claim.claimToken || !claim.claimGeneration || !claim.claimRowVersion)
        {
            throw new Error('comment_moderation_claim_invalid_response');
        }
        return { item, claim };
    };

    const releaseDecisionClaim = async ({ item, claim }: ActiveDecisionClaim): Promise<void> =>
    {
        if (!claim.claimToken || !claim.claimGeneration || !claim.claimRowVersion)
        {
            return;
        };
        try
        {
            await releaseCommentModerationClaim(item.id, {
                claimToken: claim.claimToken,
                claimGeneration: claim.claimGeneration,
                claimRowVersion: claim.claimRowVersion
            });
        }
        catch
        {
            // The lease is bounded and may already have expired or been completed.
        }
    };

    const toggleSelection = (id: string, checked: boolean): void =>
    {
        selectedIds.value = checked
            ? [...new Set([...selectedIds.value, id])]
            : selectedIds.value.filter((selectedId) => selectedId !== id);
    };

    const clearSelection = (): void =>
    {
        selectedIds.value = [];
    };

    const pruneSelection = (availableIds: readonly string[]): void =>
    {
        const available = new Set(availableIds);
        selectedIds.value = selectedIds.value.filter((id) => available.has(id));
    };

    const applySingle = async (
        comment: CommentModerationViewItem,
        status: CommentModerationStatus,
        afterSuccess?: () => Promise<void> | void
    ): Promise<boolean> =>
    {
        processingId.value = comment.id;
        let activeClaim: ActiveDecisionClaim | null = null;
        const targetStatus = commentModerationStatusLabel(status);
        taskFeedback.begin('正在审核评论', `#${comment.id} -> ${targetStatus}`, comment.id);
        try
        {
            const mfaProofToken = await ensureAdminSensitiveProof();
            activeClaim = await acquireDecisionClaim(comment);
            await moderateComment(comment.id, {
                status,
                reason: normalizeModerationReason(status, actionReason.value),
                banUser: banUsers.value && isBanEligibleStatus(status),
                expectedStatus: comment.status,
                commentRowVersion: activeClaim.claim.commentRowVersion!,
                claimToken: activeClaim.claim.claimToken!,
                claimGeneration: activeClaim.claim.claimGeneration!,
                claimRowVersion: activeClaim.claim.claimRowVersion!
            }, {
                mfaProofToken
            });
            taskFeedback.succeed('评论审核状态已更新', `#${comment.id} -> ${targetStatus}`, comment.id);
            toast.success('评论审核状态已更新');
            await afterSuccess?.();
            return true;
        }
        catch (error: unknown)
        {
            if (activeClaim)
            {
                await releaseDecisionClaim(activeClaim);
            };
            const message = moderationErrorMessage(error, '评论审核操作失败');
            taskFeedback.fail('评论审核操作失败', message, message, comment.id);
            showErrorToast(message, '评论审核操作失败');
            return false;
        }
        finally
        {
            processingId.value = null;
        }
    };

    const applyBulk = async (
        status: CommentModerationStatus,
        afterSuccess?: () => Promise<void> | void
    ): Promise<boolean> =>
    {
        if (selectedIds.value.length === 0)
        {
            showWarningToast('请先选择评论');
            return false;
        }

        processingBulk.value = true;
        let bulkClaims: ActiveDecisionClaim[] = [];
        const selectedCount = selectedIds.value.length;
        const targetStatus = commentModerationStatusLabel(status);
        taskFeedback.begin('正在批量审核评论', `${selectedCount} 条 -> ${targetStatus}`, 'moderation-bulk');
        try
        {
            const mfaProofToken = await ensureAdminSensitiveProof();
            const itemsById = new Map(resolveQueueItems().map((item) => [item.id, item] as const));
            try
            {
                for (const id of selectedIds.value)
                {
                    const item = itemsById.get(id);
                    if (!item)
                    {
                        throw new Error('comment_moderation_selection_stale');
                    };
                    bulkClaims.push(await acquireDecisionClaim(item));
                }
            }
            catch (error)
            {
                await Promise.all(bulkClaims.map(releaseDecisionClaim));
                bulkClaims = [];
                throw error;
            }
            const result = await moderateCommentsBulk({
                commentIds: selectedIds.value,
                status,
                reason: normalizeModerationReason(status, actionReason.value),
                banUsers: banUsers.value && isBanEligibleStatus(status),
                preconditions: bulkClaims.map(({ item, claim }) => ({
                    commentId: item.id,
                    expectedStatus: item.status,
                    commentRowVersion: claim.commentRowVersion!,
                    claimToken: claim.claimToken!,
                    claimGeneration: claim.claimGeneration!,
                    claimRowVersion: claim.claimRowVersion!
                }))
            }, {
                mfaProofToken
            });
            if ((result.conflicts?.length ?? 0) > 0)
            {
                await Promise.all(bulkClaims.map(releaseDecisionClaim));
                bulkClaims = [];
                throw new Error('comment_moderation_conflict');
            }
            bulkClaims = [];
            if (result.updated === selectedCount)
            {
                taskFeedback.succeed('批量审核完成', `已处理 ${result.updated} 条评论`, 'moderation-bulk');
            }
            else
            {
                taskFeedback.partial('批量审核部分完成', `已处理 ${result.updated}/${selectedCount} 条评论`, 'moderation-bulk');
            }
            toast.success(`已处理 ${result.updated} 条评论`);
            selectedIds.value = [];
            await afterSuccess?.();
            return true;
        }
        catch (error: unknown)
        {
            if (bulkClaims.length > 0)
            {
                await Promise.all(bulkClaims.map(releaseDecisionClaim));
            };
            const message = moderationErrorMessage(error, '批量审核操作失败');
            taskFeedback.fail('批量审核操作失败', message, message, 'moderation-bulk');
            showErrorToast(message, '批量审核操作失败');
            return false;
        }
        finally
        {
            processingBulk.value = false;
        }
    };

    const requestGovernanceReason = async (
        title: string,
        confirmButtonText: string,
        inputPlaceholder: string
    ): Promise<string | null> =>
    {
        const reason = await promptText('输入处理原因', title, {
            confirmButtonText,
            cancelButtonText: '取消',
            inputPlaceholder,
            inputValidator: (value: string) => value.trim().length > 0 || '请输入处理原因'
        });
        return cleanGovernanceValue(reason);
    };

    const applyBlockAnonymousNullifier = async (
        item: CommentModerationViewItem,
        afterSuccess?: () => Promise<void> | void
    ): Promise<boolean> =>
    {
        if (!item.canBlockAnonymousNullifier)
        {
            showWarningToast('当前管理员没有封禁匿名 Nullifier 的权限');
            return false;
        }

        const nullifierHash = cleanGovernanceValue(item.nullifierHash);
        const scope = cleanGovernanceValue(item.anonymousScope);
        if (!nullifierHash || !scope)
        {
            showWarningToast('当前匿名主体缺少可封禁的 Nullifier 信息');
            return false;
        }

        const reason = await requestGovernanceReason('封禁匿名 Nullifier', '封禁', '说明封禁原因');
        if (!reason)
        {
            return false;
        }

        processingId.value = item.id;
        taskFeedback.begin('正在封禁匿名 Nullifier', `${item.actorDisplayName} / ${scope}`, item.id);
        try
        {
            const mfaProofToken = await ensureAdminSensitiveProof();
            const result = await blockAnonymousNullifier({
                nullifierHash,
                scope,
                reason
            }, {
                mfaProofToken
            });
            if (!result.applied)
            {
                throw new Error('ANONYMOUS_GOVERNANCE_NOT_APPLIED');
            }

            taskFeedback.succeed('匿名 Nullifier 已封禁', `${item.actorDisplayName} / ${scope}`, item.id);
            toast.success('匿名 Nullifier 已封禁');
            await afterSuccess?.();
            return true;
        }
        catch (error: unknown)
        {
            const message = anonymousGovernanceErrorMessage(error, '匿名 Nullifier 封禁失败');
            taskFeedback.fail('匿名 Nullifier 封禁失败', message, message, item.id);
            showErrorToast(message, '匿名 Nullifier 封禁失败');
            return false;
        }
        finally
        {
            processingId.value = null;
        }
    };

    const applyRevokeAnonymousCredential = async (
        item: CommentModerationViewItem,
        afterSuccess?: () => Promise<void> | void
    ): Promise<boolean> =>
    {
        if (!item.canRevokeAnonymousCredential)
        {
            showWarningToast('当前管理员没有撤销匿名凭证的权限');
            return false;
        }

        const credentialId = cleanGovernanceValue(item.anonymousCredentialId);
        if (!credentialId)
        {
            showWarningToast('当前匿名主体缺少可撤销的匿名凭证信息');
            return false;
        }

        const reason = await requestGovernanceReason('撤销匿名凭证', '撤销', '说明撤销原因');
        if (!reason)
        {
            return false;
        }

        processingId.value = item.id;
        taskFeedback.begin('正在撤销匿名凭证', `${item.actorDisplayName} / ${credentialId}`, item.id);
        try
        {
            const mfaProofToken = await ensureAdminSensitiveProof();
            const result = await revokeAnonymousCredential(credentialId, {
                reason
            }, {
                mfaProofToken
            });
            if (!result.applied)
            {
                throw new Error('ANONYMOUS_GOVERNANCE_NOT_APPLIED');
            }

            await clearPrivateBrowserState('credential-revoked');
            taskFeedback.succeed('匿名凭证已撤销', `${item.actorDisplayName} / ${credentialId}`, item.id);
            toast.success('匿名凭证已撤销');
            await afterSuccess?.();
            return true;
        }
        catch (error: unknown)
        {
            const message = anonymousGovernanceErrorMessage(error, '匿名凭证撤销失败');
            taskFeedback.fail('匿名凭证撤销失败', message, message, item.id);
            showErrorToast(message, '匿名凭证撤销失败');
            return false;
        }
        finally
        {
            processingId.value = null;
        }
    };

    return {
        selectedIds,
        actionReason,
        banUsers,
        processingId,
        processingBulk,
        isProcessing,
        taskFeedback,
        toggleSelection,
        clearSelection,
        pruneSelection,
        ensureAdminSensitiveProof,
        applySingle,
        applyBulk,
        applyBlockAnonymousNullifier,
        applyRevokeAnonymousCredential
    };
}
