// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import VaultStoredConflictReview from '@/components/article-vault/VaultStoredConflictReview.vue';
import { presentStoredConflictReview } from '@/components/article-vault/storedConflictReviewPresentation';
import type {
    VaultReviewDisplayContext, VaultStoredReviewReference, VaultStoredReviewResponse
} from '@/components/article-vault/storedConflictReviewPresentation';
import schema from '../../../../src/shared/Contracts/ArticleVault/article-vault-conflict-evidence.schema.json';

/** Explicit synthetic component data; backend tests execute canonical readers separately. */
export function storedReviewFixture() {
    const context: VaultReviewDisplayContext = { actorIdentity: 'actor-7', sessionEpoch: 'session-epoch-1',
        siteIdentity: 'site-one', vaultIdentity: 'vault-one', deviceIdentity: 'device-one',
        serverArticleIdentity: '101', portableArticleIdentity: 'article-one' };
    const coordinate = { present: true, deleted: false, serverRevision: 4, lifecycle: 'draft',
        source: { sha256: 'a'.repeat(64) }, metadataManifestSha256: 'b'.repeat(64), dependencySha256: 'c'.repeat(64),
        permissionSha256: 'd'.repeat(64), contentSha256: 'e'.repeat(64) };
    const binding = { siteIdentity: context.siteIdentity, vaultIdentity: context.vaultIdentity,
        deviceIdentity: context.deviceIdentity, serverArticleIdentity: context.serverArticleIdentity,
        portableArticleIdentity: context.portableArticleIdentity, planCandidateIdentity: 'original-plan',
        planSha256: '2'.repeat(64), groupIdentity: 'group-one', operationIdentity: 'item-one',
        coordinates: { base: coordinate, local: coordinate, server: coordinate } };
    const operation = { schema: 'fsusblog.article-vault.operation-identity.v1', schemaVersion: 1,
        siteIdentity: context.siteIdentity, vaultIdentity: context.vaultIdentity, deviceIdentity: context.deviceIdentity,
        agentIdentity: 'agent-one', planReference: binding.planCandidateIdentity, planSha256: binding.planSha256,
        requestSha256: '3'.repeat(64), idempotencySha256: '4'.repeat(64), deadlineUnixMs: 1000,
        operationIdentity: 'operation-one', contentSha256: '5'.repeat(64) };
    const reference: VaultStoredReviewReference = { resolutionOperationIdentity: 'resolution-one', proposalSha256: '1'.repeat(64),
        checkpoint: { operation, sequence: 2, contentSha256: '6'.repeat(64) } };
    const response: VaultStoredReviewResponse = { requestIdentity: 'read-one', context, requested: reference, snapshot: {
        proposal: { schema: 'fsusblog.article-vault.resolution-plan.v1', schemaVersion: 1,
            resolutionOperationIdentity: reference.resolutionOperationIdentity, state: 'prepared',
            contentSha256: reference.proposalSha256, evidenceSha256: '7'.repeat(64), gitFactsSha256: '8'.repeat(64), binding,
            groups: [{ groupIdentity: 'group-one', allOrNothing: true, portableArticleIdentities: ['article-one'], dependencies: [] }],
            decisions: [{ type: 'metadata-disjoint', action: 'prepare-metadata-candidate', provenance: 'automatic',
                resultCandidateSha256: '9'.repeat(64) }], expectedOutput: { expectedServerRevision: 4,
                sourceSha256: coordinate.source.sha256, metadataManifestSha256: coordinate.metadataManifestSha256,
                dependencySha256: coordinate.dependencySha256 }, expiresAtUnixMs: 1000 },
        currentEvidence: { schema: schema.properties.schema.const, schemaVersion: 1, registrySha256: 'a'.repeat(64),
            contentSha256: '7'.repeat(64), binding, items: [{ type: 'metadata-disjoint', disposition: 'automatic',
                allowedActions: ['prepare-metadata-candidate', 'cancel-operation'], observation: { metadata: {
                    changes: [{ field: 'title', entityIdentity: null }] } } }] },
        currentValidation: { isValid: true, reasonCode: null },
        executionAdmission: { isValid: false, reasonCode: 'article_vault_resolution_canonical_execution_admission_missing' },
        permissionSnapshotSha256: 'b'.repeat(64), checkpoint: {
            resolutionPlanSha256: reference.proposalSha256, operation, checkpoints: [{
                schema: 'fsusblog.article-vault.operation-checkpoint.v1', schemaVersion: 1,
                operationIdentity: operation.operationIdentity, identitySha256: operation.contentSha256,
                sequence: 2, state: 'recovery-required', serverCommit: 'accepted',
                serverResult: { reference: 'server-result', contentSha256: 'c'.repeat(64) }, materializationReceipt: null,
                cancellationRequested: false, reasonCode: 'native_write_missing', contentSha256: reference.checkpoint!.contentSha256
            }], missingCapabilities: ['native_conditional_write_and_readback', 'atomic_verified_manifest_base_receipt_commit'] }
    } };
    return { context, reference, response };
}

const mounted: ReturnType<typeof mount>[] = [];
function render() {
    const fixture = storedReviewFixture();
    const wrapper = mount(VaultStoredConflictReview, { props: { ...fixture, requestIdentity: 'read-one',
        schema, loading: false, readFailureReason: null }, attachTo: document.body });
    mounted.push(wrapper);
    return { wrapper, ...fixture };
}
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('stored conflict review consumer', () => {
    it('composes the actual leaves and distinguishes persisted operation checkpoints from recovery journals', () => {
        const { wrapper } = render();
        expect(wrapper.find('[data-vault-conflict-list]').exists()).toBe(true);
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(true);
        expect(wrapper.text()).toContain('指定 operation 检查点');
        expect(wrapper.text()).toContain('不是 recovery journal');
        expect(wrapper.text()).toContain('article_vault_resolution_canonical_execution_admission_missing');
        expect(wrapper.text()).toContain('服务端接受不代表当前已同步');
        expect(wrapper.text()).not.toContain('private-source');
    });

    it.each(['actorIdentity', 'sessionEpoch', 'siteIdentity', 'vaultIdentity', 'deviceIdentity',
        'serverArticleIdentity', 'portableArticleIdentity'] as const)('hides earlier authorized data after current %s changes', async field => {
        const { wrapper, context } = render();
        await wrapper.setProps({ context: { ...context, [field]: 'changed' } });
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(false);
        expect(wrapper.text()).toContain('响应不属于当前用户');
        expect(wrapper.text()).not.toContain('server-result');
    });

    it('rejects stale replies even when the exact proposal and checkpoint reference remain the same', async () => {
        const { wrapper } = render();
        await wrapper.setProps({ requestIdentity: 'read-two' });
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(false);
        await wrapper.setProps({ response: { ...wrapper.props('response')!, requestIdentity: 'read-two' } });
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(true);
    });

    it.each(['proposal', 'tip', 'operation', 'scope', 'history-kind'])('rejects crossed %s references without selecting latest', variant => {
        const { context, reference, response } = storedReviewFixture();
        const checkpoint = response.snapshot.checkpoint!;
        const changed: VaultStoredReviewResponse = { ...response, snapshot: { ...response.snapshot,
            proposal: variant === 'proposal' ? { ...response.snapshot.proposal, contentSha256: 'f'.repeat(64) } : response.snapshot.proposal,
            checkpoint: { ...checkpoint,
                operation: variant === 'operation' ? { ...checkpoint.operation, requestSha256: 'f'.repeat(64) }
                    : variant === 'scope' ? { ...checkpoint.operation, siteIdentity: 'another-site' } : checkpoint.operation,
                checkpoints: [{ ...checkpoint.checkpoints[0], sequence: variant === 'tip' ? 3 : 2,
                    schema: variant === 'history-kind' ? 'fsusblog.article-vault.recovery-journal.v1' : checkpoint.checkpoints[0].schema }]
            }
        } };
        expect(presentStoredConflictReview(changed, reference, context, 'read-one')).toBeNull();
    });

    it('keeps stale canonical proposals reviewable without showing current conflict actions or success', async () => {
        const { wrapper, response } = render();
        await wrapper.setProps({ response: { ...response, snapshot: { ...response.snapshot,
            currentEvidence: null, currentValidation: { isValid: false, reasonCode: 'article_vault_plan_expired' } } } });
        expect(wrapper.find('[data-vault-conflict-list]').exists()).toBe(false);
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(true);
        expect(wrapper.text()).toContain('article_vault_plan_expired');
        expect(wrapper.findAll('dd').filter(node => node.text() === '通过')).toHaveLength(0);
    });

    it('hides old results during loading or permission refusal and emits only exact read/return/action intents', async () => {
        const { wrapper, context, reference, response } = render();
        const before = JSON.stringify(response);
        const read = wrapper.findAll('button').find(button => button.text() === '读取指定提案与检查点')!;
        await read.trigger('click');
        expect(wrapper.emitted('request-read')).toEqual([[context, reference, 'read-one']]);
        await wrapper.findAll('button').find(button => button.text() === '返回当前工作区')!.trigger('click');
        expect(wrapper.emitted('request-return')).toEqual([[context, reference, 'read-one']]);
        await wrapper.findAll('button').find(button => button.text() === '请求元数据候选')!.trigger('click');
        expect(wrapper.emitted('request-action')?.[0]?.[0]).toMatchObject({ evidenceSha256: '7'.repeat(64), action: 'prepare-metadata-candidate' });
        expect(wrapper.emitted('request-action')?.[0]?.[1]).toBe('read-one');
        expect(JSON.stringify(response)).toBe(before);
        for (const text of ['取消解决操作', '恢复本地状态']) {
            const button = wrapper.findAll('button').find(node => node.text() === text)!;
            expect(button.attributes('disabled')).toBeDefined();
            expect(button.attributes('aria-describedby')).toBeTruthy();
        }
        await wrapper.setProps({ loading: true });
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(false);
        await wrapper.setProps({ loading: false, readFailureReason: 'article_vault_conflict_review_permission_denied' });
        expect(wrapper.find('[data-vault-resolution-status]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('server-result');
    });

    it('forwards current request identity with unchanged read return and action values', async () => {
        const { wrapper, context, reference, response } = render();
        const before = JSON.stringify(response);
        await wrapper.findAll('button').find(button => button.text() === '读取指定提案与检查点')!.trigger('click');
        await wrapper.findAll('button').find(button => button.text() === '返回当前工作区')!.trigger('click');
        await wrapper.findAll('button').find(button => button.text() === '请求元数据候选')!.trigger('click');
        expect(wrapper.emitted('request-read')).toEqual([[context, reference, 'read-one']]);
        expect(wrapper.emitted('request-return')).toEqual([[context, reference, 'read-one']]);
        expect(wrapper.emitted('request-action')).toEqual([[{
            evidenceSha256: '7'.repeat(64), operationIdentity: 'item-one', portableArticleIdentity: 'article-one',
            type: 'metadata-disjoint', action: 'prepare-metadata-candidate'
        }, 'read-one']]);
        expect(JSON.stringify(response)).toBe(before);
    });

    it('forwards the existing request identity after a same-reference refresh', async () => {
        const { wrapper, context, reference, response } = render();
        await wrapper.findAll('button').find(button => button.text() === '读取指定提案与检查点')!.trigger('click');
        await wrapper.setProps({ requestIdentity: 'read-two' });
        await wrapper.findAll('button').find(button => button.text() === '读取指定提案与检查点')!.trigger('click');
        await wrapper.findAll('button').find(button => button.text() === '返回当前工作区')!.trigger('click');
        expect(wrapper.emitted('request-read')).toEqual([[context, reference, 'read-one'], [context, reference, 'read-two']]);
        expect(wrapper.emitted('request-return')).toEqual([[context, reference, 'read-two']]);
        await wrapper.setProps({ response: { ...response, requestIdentity: 'read-two' } });
        await wrapper.findAll('button').find(button => button.text() === '请求元数据候选')!.trigger('click');
        expect(wrapper.emitted('request-action')).toEqual([[{
            evidenceSha256: '7'.repeat(64), operationIdentity: 'item-one', portableArticleIdentity: 'article-one',
            type: 'metadata-disjoint', action: 'prepare-metadata-candidate'
        }, 'read-two']]);
    });

    it('uses real local fragment targets for comparison/review navigation without inventing routes', () => {
        const { wrapper } = render();
        const links = wrapper.findAll('nav a');
        expect(links.map(link => link.text())).toEqual(['查看逐项冲突', '查看提案与检查点']);
        for (const link of links) {
            const id = link.attributes('href').slice(1);
            const target = document.getElementById(id);
            expect(target).toBeTruthy();
            expect(target!.getAttribute('tabindex')).toBe('-1');
        }
    });

    it('rejects implicit checkpoint selection and evidence for another original plan or group', () => {
        const { context, reference, response } = storedReviewFixture();
        expect(presentStoredConflictReview(response, { ...reference, checkpoint: null }, context, 'read-one')).toBeNull();
        for (const field of ['planSha256', 'planCandidateIdentity', 'groupIdentity'] as const) {
            const changed = { ...response, snapshot: { ...response.snapshot, currentEvidence: {
                ...response.snapshot.currentEvidence!, binding: { ...response.snapshot.currentEvidence!.binding, [field]: 'another' }
            } } };
            expect(presentStoredConflictReview(changed, reference, context, 'read-one')).toBeNull();
        }
    });

    it('does not forward injected unknown actions or private extra fields from a child event', async () => {
        const { wrapper, response } = render();
        wrapper.findComponent({ name: 'VaultConflictList' }).vm.$emit('request-action', {
            evidenceSha256: '7'.repeat(64), operationIdentity: 'item-one', portableArticleIdentity: 'article-one',
            type: 'metadata-disjoint', action: 'accept-all-local', privateSource: 'private-source'
        });
        expect(wrapper.emitted('request-action')).toBeUndefined();
        await wrapper.setProps({ response: { ...response, snapshot: { ...response.snapshot,
            privateSource: 'private-source', token: 'private-token', proposal: { ...response.snapshot.proposal,
                privateMetadata: 'private-metadata' } } } as VaultStoredReviewResponse });
        for (const secret of ['private-source', 'private-token', 'private-metadata']) expect(wrapper.html()).not.toContain(secret);
    });
});
