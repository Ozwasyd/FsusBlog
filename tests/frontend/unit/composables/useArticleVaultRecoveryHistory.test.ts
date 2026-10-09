import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type EffectScope } from 'vue';

import { readVaultRecoveryHistory, type VaultRecoveryHistoryResponse } from '@/api/articleVault';
import { useArticleVaultRecoveryHistory, type VaultRecoveryHistoryHostScope } from '@/composables/useArticleVaultRecoveryHistory';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';

vi.mock('@/api/articleVault', () => ({ readVaultRecoveryHistory: vi.fn() }));
const readMock = vi.mocked(readVaultRecoveryHistory);
const scopes: EffectScope[] = [];
const digest = 'a'.repeat(64);

function fixture()
{
    const operation = {
        schema: 'fsusblog.article-vault.operation-identity.v1' as const, schemaVersion: 1 as const,
        siteIdentity: 'site-a', vaultIdentity: 'vault-a', deviceIdentity: 'device-a', agentIdentity: 'agent-a',
        planReference: 'plan-a', planSha256: digest, operationIdentity: 'operation-a', contentSha256: digest,
        requestSha256: digest, idempotencySha256: digest, deadlineUnixMs: 1700000000000
    };
    const scope: VaultRecoveryHistoryHostScope = {
        actorIdentity: 'admin-1', sessionEpoch: 'session-generation-1', expected: {
            siteIdentity: 'site-a', vaultIdentity: 'vault-a', deviceIdentity: 'device-a', agentIdentity: 'agent-a',
            portableArticleIdentity: 'portable-a', serverArticleIdentity: '17',
            planReference: 'plan-a', planSha256: digest, groupIdentity: 'group-a', itemOperationIdentity: 'item-a',
            operationIdentity: 'operation-a', operationSha256: digest, resolutionOperationIdentity: 'resolution-a',
            resolutionPlanSha256: digest, exactSequence: 3, exactCheckpointSha256: digest
        }, request: {
            schema: 'fsusblog.article-vault.recovery-history-request.v1', articleId: 17,
            resolutionOperationIdentity: 'resolution-a', proposalSha256: digest,
            operation, sequence: 3, checkpointSha256: digest
        }
    };
    const response: VaultRecoveryHistoryResponse = {
        proposal: {
            schema: 'fsusblog.article-vault.resolution-plan.v1', schemaVersion: 1, resolutionOperationIdentity: 'resolution-a',
            state: 'prepared', binding: { siteIdentity: 'site-a', vaultIdentity: 'vault-a', deviceIdentity: 'device-a',
                portableArticleIdentity: 'portable-a', serverArticleIdentity: '17', planCandidateIdentity: 'plan-a',
                planSha256: digest, groupIdentity: 'group-a', operationIdentity: 'item-a' },
            evidenceSha256: digest, gitFactsSha256: digest, rootManifestSha256: digest, contentSha256: digest
        }, snapshot: {
            resolutionPlanSha256: digest, operation, serverResult: null, missingCapabilities: [], checkpoints: [{
                schema: 'fsusblog.article-vault.operation-checkpoint.v1', schemaVersion: 1, operationIdentity: 'operation-a',
                identitySha256: digest, sequence: 3, state: 'blocked', serverCommit: 'not-started',
                serverResult: null, materializationReceipt: null, reasonCode: null, contentSha256: digest
            }]
        }, permissionSnapshotSha256: digest, isHistorical: true, canExecute: false, canCommitBase: false
    };
    const current = ref<VaultRecoveryHistoryHostScope | null>(scope);
    const owner = effectScope(); scopes.push(owner);
    const host = owner.run(() => useArticleVaultRecoveryHistory(current));
    if (!host) throw new Error('host_scope_required');
    return { current, owner, host, response, scope };
}
function deferred<T>()
{
    let resolve!: (value: T) => void;
    let reject!: (value: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
afterEach(() => { for (const scope of scopes.splice(0)) scope.stop(); privateSurfaceRuntime.resetForTests(); privateRequestRuntime.resetForTests(); vi.resetAllMocks(); });

describe('Vault authenticated historical read host', () => {
    it('calls the sole private API with owned exact references and exposes only compatible historical display', async () => {
        const f = fixture(); readMock.mockResolvedValue(f.response);
        await f.host.read();
        expect(readMock).toHaveBeenCalledTimes(1);
        expect(readMock.mock.calls[0]?.[0]).toEqual(f.scope.request);
        expect(readMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
        expect(f.host.display.value?.proposalState).toBe('prepared');
        expect(f.host.response.value?.canExecute).toBe(false);
        expect(f.host.response.value?.canCommitBase).toBe(false);
        expect(f.host.requestIdentity.value).not.toBe('');
        expect(f.host.loading.value).toBe(false);
    });

    it.each(['actor', 'session', 'site', 'vault', 'device', 'server-document', 'portable-document', 'plan', 'checkpoint'])
    ('hides old results and aborts pending reads synchronously on %s change', async field => {
        const f = fixture(); readMock.mockResolvedValueOnce(f.response); await f.host.read();
        const next = deferred<VaultRecoveryHistoryResponse>(); readMock.mockReturnValueOnce(next.promise);
        const pending = f.host.read(); const signal = readMock.mock.calls[1]?.[1]?.signal;
        if (!f.current.value) throw new Error('scope_required');
        switch (field) {
            case 'actor': f.current.value = { ...f.current.value, actorIdentity: 'admin-2' }; break;
            case 'session': f.current.value = { ...f.current.value, sessionEpoch: 'session-2' }; break;
            case 'site': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, siteIdentity: 'site-b' } }; break;
            case 'vault': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, vaultIdentity: 'vault-b' } }; break;
            case 'device': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, deviceIdentity: 'device-b' } }; break;
            case 'server-document': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, serverArticleIdentity: '18' } }; break;
            case 'portable-document': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, portableArticleIdentity: 'portable-b' } }; break;
            case 'plan': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, planSha256: 'b'.repeat(64) } }; break;
            case 'checkpoint': f.current.value = { ...f.current.value, expected: { ...f.current.value.expected, exactSequence: 4 } }; break;
        }
        expect(signal?.aborted).toBe(true);
        expect(f.host.response.value).toBeNull(); expect(f.host.display.value).toBeNull();
        expect(f.host.requestIdentity.value).toBe(''); expect(f.host.loading.value).toBe(false);
        next.resolve(f.response); await pending;
        expect(f.host.response.value).toBeNull();
    });

    it('refuses missing context and mismatched request before any transport call', async () => {
        const f = fixture(); f.current.value = null; await f.host.read();
        expect(f.host.readFailureReason.value).toBe('article_vault_history_scope_unavailable');
        f.current.value = { ...f.scope, request: { ...f.scope.request, articleId: 18 } };
        await f.host.read(); expect(readMock).not.toHaveBeenCalled();
    });

    it.each(['logout', 'admin-logout', 'account-switch', 'session-expired'] as const)
    ('uses the original private surface %s transition to hide and abort even before host context updates', async reason => {
        const f = fixture(); readMock.mockResolvedValueOnce(f.response); await f.host.read();
        const old = deferred<VaultRecoveryHistoryResponse>(); readMock.mockReturnValueOnce(old.promise);
        const pending = f.host.read(); const signal = readMock.mock.calls[1]?.[1]?.signal;
        const cleanup = deferred<void>();
        const transition = privateSurfaceRuntime.invalidate(reason, () => cleanup.promise);
        expect(signal?.aborted).toBe(true); expect(f.host.response.value).toBeNull();
        expect(f.host.display.value).toBeNull(); expect(f.host.requestIdentity.value).toBe('');
        await f.host.read(); expect(readMock).toHaveBeenCalledTimes(2);
        cleanup.resolve(); await transition;
        old.resolve(f.response); await pending;
        await f.host.read(); expect(readMock).toHaveBeenCalledTimes(2);
        f.current.value = { ...f.scope, sessionEpoch: privateSurfaceRuntime.authGeneration.value };
        readMock.mockResolvedValueOnce(f.response); await f.host.read();
        expect(readMock).toHaveBeenCalledTimes(3); expect(f.host.display.value).not.toBeNull();
    });

    it.each(['proposal', 'checkpoint', 'permission', 'canExecute', 'historical'])
    ('refuses incompatible %s response without promoting history to current review', async field => {
        const f = fixture(); let value = structuredClone(f.response);
        switch (field) {
            case 'proposal': value = { ...value, proposal: { ...value.proposal, resolutionOperationIdentity: 'other' } }; break;
            case 'checkpoint': value = { ...value, snapshot: { ...value.snapshot, checkpoints: [] } }; break;
            case 'permission': value = { ...value, permissionSnapshotSha256: 'missing' }; break;
            case 'canExecute': Object.assign(value, { canExecute: true }); break;
            case 'historical': Object.assign(value, { isHistorical: false }); break;
        }
        readMock.mockResolvedValue(value); await f.host.read();
        expect(f.host.response.value).toBeNull(); expect(f.host.display.value).toBeNull();
        expect(f.host.readFailureReason.value).toBe('article_vault_history_response_mismatch');
    });

    it('suppresses an old completion after a repeated read even when transport ignores its aborted signal', async () => {
        const f = fixture(); const old = deferred<VaultRecoveryHistoryResponse>();
        readMock.mockReturnValueOnce(old.promise); const pending = f.host.read();
        const firstIdentity = f.host.requestIdentity.value;
        readMock.mockResolvedValueOnce(f.response); await f.host.read();
        expect(f.host.requestIdentity.value).not.toBe(firstIdentity);
        expect(readMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        old.resolve({ ...f.response, permissionSnapshotSha256: 'b'.repeat(64) }); await pending;
        expect(f.host.response.value?.permissionSnapshotSha256).toBe(digest);
    });

    it('propagates closed read failure and permits retry without exposing server exception context', async () => {
        const f = fixture(); readMock.mockRejectedValueOnce(new Error('private-session-source-detail'));
        await f.host.read(); expect(f.host.readFailureReason.value).toBe('article_vault_history_read_failed');
        expect(f.host.response.value).toBeNull();
        readMock.mockResolvedValueOnce(f.response); await f.host.read();
        expect(f.host.readFailureReason.value).toBeNull(); expect(f.host.display.value).not.toBeNull();
    });

    it('clears before returning focus and refuses stale return intents after context changes', async () => {
        const f = fixture(); readMock.mockResolvedValue(f.response); await f.host.read();
        const identity = f.host.requestIdentity.value;
        const focus = vi.fn(() => expect(f.host.response.value).toBeNull());
        expect(f.host.returnToWorkspace(identity, focus)).toBe(true); expect(focus).toHaveBeenCalledOnce();
        expect(f.host.returnToWorkspace(identity, focus)).toBe(false);
        await f.host.read(); const obsolete = f.host.requestIdentity.value;
        if (!f.current.value) throw new Error('scope_required'); f.current.value = { ...f.current.value, actorIdentity: 'admin-2' };
        expect(f.host.returnToWorkspace(obsolete, focus)).toBe(false); expect(focus).toHaveBeenCalledOnce();
    });

    it('disposing the component scope aborts and suppresses outstanding completion with repeat-safe cleanup', async () => {
        const f = fixture(); const old = deferred<VaultRecoveryHistoryResponse>();
        readMock.mockReturnValueOnce(old.promise); const pending = f.host.read();
        const signal = readMock.mock.calls[0]?.[1]?.signal; f.owner.stop(); f.host.dispose();
        expect(signal?.aborted).toBe(true); old.resolve(f.response); await pending;
        expect(f.host.response.value).toBeNull(); await f.host.read(); expect(readMock).toHaveBeenCalledOnce();
    });
});
