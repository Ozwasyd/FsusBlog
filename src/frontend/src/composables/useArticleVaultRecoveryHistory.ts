import { computed, onScopeDispose, readonly, shallowRef, toRaw, toValue, watch, type MaybeRefOrGetter } from 'vue';

import { readVaultRecoveryHistory, type VaultRecoveryHistoryRequest, type VaultRecoveryHistoryResponse } from '@/api/articleVault';
import { presentVaultStoredRecovery, type VaultStoredRecoveryDisplayScope } from '@/services/articleVault/storedRecoveryPresentation';
import { privateSurfaceRuntime } from '@/services/privateSurfaceRuntime';

/** Host-supplied authenticated display context and exact canonical references; never an authority grant. */
export interface VaultRecoveryHistoryHostScope {
    readonly actorIdentity: string;
    readonly sessionEpoch: string;
    readonly expected: VaultStoredRecoveryDisplayScope;
    readonly request: VaultRecoveryHistoryRequest;
}

/** Uses the existing authenticated AEDS read. It cannot produce a current conflict-review snapshot. */
export function useArticleVaultRecoveryHistory(scope: MaybeRefOrGetter<VaultRecoveryHistoryHostScope | null>)
{
    const response = shallowRef<VaultRecoveryHistoryResponse | null>(null);
    const loading = shallowRef(false);
    const readFailureReason = shallowRef<string | null>(null);
    const requestIdentity = shallowRef('');
    const heldScope = shallowRef<VaultRecoveryHistoryHostScope | null>(null);
    let pending: AbortController | null = null;
    let disposed = false;
    let generation = 0;

    function clear(): void
    {
        generation += 1;
        pending?.abort();
        pending = null;
        response.value = null;
        loading.value = false;
        readFailureReason.value = null;
        requestIdentity.value = '';
    }

    const stop = watch(() => toValue(scope), value =>
    {
        // Clear synchronously, before the next render or an old transport continuation can publish.
        clear();
        heldScope.value = privateSurfaceRuntime.isClearing.value ? null : copyScope(value);
    }, { deep: true, immediate: true, flush: 'sync' });

    const stopPrivateSurface = watch([privateSurfaceRuntime.authGeneration, privateSurfaceRuntime.isClearing], () =>
    {
        // The original logout/account-switch owner invalidates already displayed data as well as pending reads.
        // A later host scope update must select a fresh authenticated context before another read.
        clear();
        heldScope.value = null;
    }, { flush: 'sync' });

    const display = computed(() => response.value && heldScope.value
        ? presentVaultStoredRecovery(response.value.proposal, response.value.snapshot, heldScope.value.expected) : null);

    async function read(): Promise<void>
    {
        if (disposed)
        {
            return;
        }
        clear();
        const current = heldScope.value;
        if (!current || !requestMatchesScope(current))
        {
            readFailureReason.value = 'article_vault_history_scope_unavailable';
            return;
        }
        const selected = structuredClone(current);
        const controller = new AbortController();
        const selectedGeneration = generation;
        pending = controller;
        requestIdentity.value = crypto.randomUUID();
        loading.value = true;
        try
        {
            const result = await readVaultRecoveryHistory(selected.request, { signal: controller.signal });
            if (disposed || controller.signal.aborted || generation !== selectedGeneration || pending !== controller)
            {
                return;
            }
            if (result.isHistorical !== true || result.canExecute !== false || result.canCommitBase !== false
                || !/^[a-f0-9]{64}$/u.test(result.permissionSnapshotSha256)
                || !presentVaultStoredRecovery(result.proposal, result.snapshot, selected.expected))
            {
                readFailureReason.value = 'article_vault_history_response_mismatch';
                return;
            }
            response.value = result;
        }
        catch
        {
            if (!disposed && !controller.signal.aborted && generation === selectedGeneration && pending === controller)
            {
                // Exception messages may contain private server/source details. Never expose or log them.
                readFailureReason.value = 'article_vault_history_read_failed';
            }
        }
        finally
        {
            if (pending === controller)
            {
                pending = null;
                loading.value = false;
            }
        }
    }

    function dispose(): void
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        stop();
        stopPrivateSurface();
        clear();
        heldScope.value = null;
    }

    function returnToWorkspace(expectedRequestIdentity: string, restoreFocus: () => void): boolean
    {
        if (disposed || !expectedRequestIdentity || requestIdentity.value !== expectedRequestIdentity)
        {
            return false;
        }
        clear();
        restoreFocus();
        return true;
    }
    onScopeDispose(dispose);
    return { response: readonly(response), display, loading: readonly(loading),
        readFailureReason: readonly(readFailureReason), requestIdentity: readonly(requestIdentity), read, dispose, returnToWorkspace };
}

function copyScope(scope: VaultRecoveryHistoryHostScope | null): VaultRecoveryHistoryHostScope | null
{
    if (!scope)
    {
        return null;
    }
    try
    {
        // Props/store scopes may be reactive proxies. Hold only the original value fields before awaiting.
        return structuredClone({ actorIdentity: scope.actorIdentity, sessionEpoch: scope.sessionEpoch,
            expected: toRaw(scope.expected), request: { ...toRaw(scope.request), operation: toRaw(scope.request.operation) } });
    }
    catch
    {
        return null;
    }
}

function requestMatchesScope(scope: VaultRecoveryHistoryHostScope): boolean
{
    const { request, expected } = scope;
    const operation = request?.operation;
    if (!request || !expected || !operation)
    {
        return false;
    }
    return typeof scope.actorIdentity === 'string' && scope.actorIdentity.length > 0
        && typeof scope.sessionEpoch === 'string' && scope.sessionEpoch.length > 0
        && request.schema === 'fsusblog.article-vault.recovery-history-request.v1'
        && Number.isSafeInteger(request.articleId) && request.articleId > 0
        && String(request.articleId) === expected.serverArticleIdentity
        && request.resolutionOperationIdentity === expected.resolutionOperationIdentity
        && request.proposalSha256 === expected.resolutionPlanSha256
        && request.sequence === expected.exactSequence && request.checkpointSha256 === expected.exactCheckpointSha256
        && operation.siteIdentity === expected.siteIdentity && operation.vaultIdentity === expected.vaultIdentity
        && operation.deviceIdentity === expected.deviceIdentity && operation.agentIdentity === expected.agentIdentity
        && operation.planReference === expected.planReference && operation.planSha256 === expected.planSha256
        && operation.operationIdentity === expected.operationIdentity && operation.contentSha256 === expected.operationSha256;
}
