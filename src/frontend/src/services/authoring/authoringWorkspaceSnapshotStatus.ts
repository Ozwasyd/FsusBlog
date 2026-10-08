import { AuthoringWorkspaceSnapshotError, freezeWorkspaceSnapshot, workspaceSnapshotDigest, type AuthoringWorkspaceSnapshotApi } from '@/api/authoringWorkspaceSnapshot';

import { requirePreparedWorkspaceSnapshotRestorePlan, type AuthoringWorkspaceSnapshotRestorePlan } from './authoringWorkspaceSnapshotRestore';

import type { AuthoringWorkspaceSnapshotSync } from './authoringWorkspaceSnapshotSync';
export interface AuthoringWorkspaceSnapshotStatusModel {
    state: 'loading' | 'current' | 'cached-placeholder' | 'offline-unsynced' | 'partial' | 'failed' | 'defaulted' | 'conflict' | 'future-schema';
    message: string | null;
    role: 'status';
    live: 'polite';
    canInspectReasons: boolean;
    reasonCounts: Record<string, number>;
    canReset: boolean;
    contentDigest: string;
}
/// Product projection only; success is quiet and cached/offline/conflict never claims to be saved.
export function authoringWorkspaceSnapshotStatusModel(sync: AuthoringWorkspaceSnapshotSync, plan: AuthoringWorkspaceSnapshotRestorePlan | null = null): AuthoringWorkspaceSnapshotStatusModel
{
    const state = sync.getState();
    let status: AuthoringWorkspaceSnapshotStatusModel['state'] = state.status === 'blocked' ? 'failed' : state.status;
    let message: string | null = null;
    const reasonCounts: Record<string, number> = {};
    if (state.status === 'loading')
    {
        message = '正在恢复工作区布局。';
    }
    if (state.status === 'cached-placeholder')
    {
        message = '正在显示缓存布局，尚未验证服务端状态。';
    }
    if (state.status === 'offline-unsynced')
    {
        message = '离线：当前布局仅保留在本次会话，尚未同步。';
    }
    if (state.status === 'conflict')
    {
        message = '服务端布局已变化。请采用服务端布局后继续。';
    }
    if (state.status === 'failed' || state.status === 'blocked')
    {
        message = '工作区布局暂不可恢复，文章和草稿仍保留。';
    }
    if (state.reason === 'future_schema')
    {
        status = 'future-schema';
        message = '工作区布局版本暂不支持，文章和草稿仍保留。';
    }
    if (!state.online && !state.dirty && status !== 'cached-placeholder')
    {
        message = '离线：已打开的文章可继续使用，布局尚未向服务端验证。';
    }
    if (plan)
    {
        try
        {
            requirePreparedWorkspaceSnapshotRestorePlan(plan);
        }
        catch
        {
            // Old summaries lose their authority with the observation; the current status still renders.
            plan = null;
        }
    }
    if (plan && state.online && state.status === 'current' && plan.serverRevision === state.serverRevision
        && plan.scopeDigest === state.scopeDigest && plan.sourceDigest === state.sourceDigest && plan.summary.skipped + plan.summary.blocked > 0)
    {
        status = 'partial';
        message = `布局包含 ${plan.summary.restored} 个可恢复标签，跳过或阻止 ${plan.summary.skipped + plan.summary.blocked} 个引用。`;
        Object.assign(reasonCounts, plan.summary.reasons);
    }
    const unsigned = { state: status, message, role: 'status' as const, live: 'polite' as const,
        canInspectReasons: Object.keys(reasonCounts).length > 0, reasonCounts,
        canReset: state.online && !state.dirty && !state.resetting && (state.status === 'current' || state.status === 'defaulted') && state.serverRevision !== null };
    return freezeWorkspaceSnapshot({ ...unsigned, contentDigest: workspaceSnapshotDigest(unsigned) });
}
export class AuthoringWorkspaceSnapshotResetController
{
    private confirmation: {
        revision: number;
        digest: string;
    } | null = null;
    public constructor(private readonly api: AuthoringWorkspaceSnapshotApi, private readonly sync: AuthoringWorkspaceSnapshotSync)
    { }
    public request(): {
        prompt: string;
        returnFocus: 'workspace';
    }
    {
        const state = this.sync.getState();
        if (!authoringWorkspaceSnapshotStatusModel(this.sync).canReset || state.serverRevision === null)
        {
            throw new AuthoringWorkspaceSnapshotError('reset_requires_current_server');
        }
        this.confirmation = { revision: state.serverRevision, digest: this.api.resetConfirmation(state.serverRevision) };
        return { prompt: '仅重置当前账号和站点的工作区布局。文章、草稿、版本、附件和恢复记录均保留。', returnFocus: 'workspace' };
    }
    public cancel(): void
    {
        this.confirmation = null;
    }
    public async confirm(): Promise<void>
    {
        const confirmation = this.confirmation;
        this.confirmation = null;
        if (!confirmation)
        {
            throw new AuthoringWorkspaceSnapshotError('reset_confirmation_required');
        }
        await this.sync.reset(true, confirmation.revision, confirmation.digest);
    }
}
