import type { VaultStoredOperationIdentity, VaultStoredRecoverySnapshot, VaultStoredResolutionProposal } from '@/services/articleVault/storedRecoveryPresentation';

import { FrameType } from '@wasm/protocol/frame';

import { requestAuthoringBinary } from './authoring';

import type { ApiRequestConfig } from './requestConfig';

/** Exact canonical identity; these wire fields confer no local IPC or execution authority. */
export type VaultRecoveryHistoryRequest = Readonly<{
    schema: 'fsusblog.article-vault.recovery-history-request.v1';
    articleId: number;
    resolutionOperationIdentity: string;
    proposalSha256: string;
    operation: VaultStoredOperationIdentity & Readonly<{
        requestSha256: string;
        idempotencySha256: string;
        deadlineUnixMs: number;
    }>;
    sequence: number;
    checkpointSha256: string;
}>;

export type VaultRecoveryHistoryResponse = Readonly<{
    proposal: VaultStoredResolutionProposal;
    snapshot: VaultStoredRecoverySnapshot;
    permissionSnapshotSha256: string;
    isHistorical: true;
    canExecute: false;
    canCommitBase: false;
}>;

/** Uses the existing authenticated private AEDS/session runtime, including logout/site-switch cancellation. */
export function readVaultRecoveryHistory(request: VaultRecoveryHistoryRequest, config?: ApiRequestConfig): Promise<VaultRecoveryHistoryResponse>
{
    return requestAuthoringBinary<VaultRecoveryHistoryResponse>('/vault/recovery/history',
        FrameType.ArticleVaultRecoveryHistoryResponse, config, {
            method: 'POST',
            requestFrame: FrameType.ArticleVaultRecoveryHistoryRequest,
            request
        });
}
