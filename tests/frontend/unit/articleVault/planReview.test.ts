// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultPlanReview from '@/components/admin/article/vault/VaultPlanReview.vue';
import VaultExecutionProgress from '@/components/admin/article/vault/VaultExecutionProgress.vue';

import { filterVaultPlanItems, presentVaultPlan, type VaultPlanReviewDocument, type VaultPlanReviewItem } from '@/services/articleVault/planReview';
import { presentVaultServerExecution, type VaultServerExecutionDocument } from '@/services/articleVault/executionProgress';

import schema from '../../../../src/shared/Contracts/ArticleVault/article-vault-sync-plan.schema.json';

const digest = 'a'.repeat(64);
const coordinate = {
    serverRevision: 12,
    contentSha256: digest,
    metadataManifestSha256: digest,
    dependencySha256: digest,
    permissionSha256: digest,
    lifecycle: 'draft'
};
function item(operationIdentity: string, decision: VaultPlanReviewItem['decision'] = 'pull-update'): VaultPlanReviewItem {
    return {
        operationIdentity,
        sequence: 0,
        groupIdentity: 'group-one',
        portableArticleIdentity: `article-${operationIdentity}`,
        serverArticleIdentity: 'server-one',
        decision,
        base: coordinate,
        local: coordinate,
        server: coordinate,
        preconditions: {
            articleManifestSha256: digest,
            serverObservationSha256: digest,
            expectedServerRevision: 12,
            expectedPermissionSha256: digest,
            expectedLifecycle: 'draft'
        },
        dependsOnOperationIdentities: []
    };
}
function plan(items: VaultPlanReviewItem[]): VaultPlanReviewDocument {
    return {
        siteIdentity: 'site-one', vaultIdentity: 'vault-one', deviceIdentity: 'device-one',
        direction: 'sync', createdAtUnixMs: 1, expiresAtUnixMs: 1000,
        status: 'ready', cancelPolicy: 'before-execution-only',
        contentSha256: digest, rootManifestSha256: digest,
        operationOrder: items.map((entry) => entry.operationIdentity).reverse(),
        groups: [{ groupIdentity: 'group-one', allOrNothing: true,
            portableArticleIdentities: items.map((entry) => entry.portableArticleIdentity),
            dependencies: [], items }],
        conflicts: [{ groupIdentity: 'group-one', portableArticleIdentity: 'article-one', reasonCode: 'missing_base' }]
    };
}

describe('read-only canonical plan presentation (no machine acceptance)', () => {
    it('preserves canonical operation order for a large plan and filters exact identities without mutation', () => {
        const document = plan(Array.from({ length: 1000 }, (_, index) => item(`op-${index}`)));
        const before = JSON.stringify(document);
        const review = presentVaultPlan(document);
        expect(review.articleCount).toBe(1000);
        expect(review.items[0]?.operationIdentity).toBe('op-999');
        expect(filterVaultPlanItems(review.items, 'ARTICLE-op-999').map((entry) => entry.operationIdentity)).toEqual(['op-999']);
        expect(JSON.stringify(document)).toBe(before);
        expect(review).not.toHaveProperty('canExecute');
        expect(review).not.toHaveProperty('clean');
    });

    it.each(['duplicate', 'missing', 'unknown'])('rejects %s operation order without silently showing a partial plan', (kind) => {
        const document = plan([item('op-one'), item('op-two')]);
        const operationOrder = kind === 'duplicate' ? ['op-one', 'op-one']
            : kind === 'missing' ? ['op-one'] : ['op-one', 'unknown'];
        const review = presentVaultPlan({ ...document, operationOrder });
        expect(review.orderAvailable).toBe(false);
        expect(review.items).toEqual([]);
    });

    it('rejects duplicate operation identities even if order length matches', () => {
        expect(presentVaultPlan(plan([item('op-one'), item('op-one')])).orderAvailable).toBe(false);
    });

    it('uses the decision roster of the shared schema and preserves exact conflict reasons', () => {
        const decisions = schema.$defs.item.properties.decision.enum as VaultPlanReviewItem['decision'][];
        const document = plan(decisions.map((decision, index) => item(`op-${index}`, decision)));
        const review = presentVaultPlan(document);
        expect(review.counts.map((entry) => entry.decision)).toEqual(decisions);
        expect(review.counts.every((entry) => entry.count === 1)).toBe(true);
        expect(review.conflictCount).toBe(1);
        expect(document.conflicts[0]?.reasonCode).toBe('missing_base');
    });
});

const expected = { siteIdentity: 'site-one', vaultIdentity: 'vault-one', planReference: 'plan-one', planSha256: digest };
const result: VaultServerExecutionDocument = {
    ...expected, resultReference: 'result-one', outcome: 'completed', reasonCode: null,
    completedAtUnixMs: 100, contentSha256: digest,
    groups: [{ groupIdentity: 'group-one', committed: true, reasonCode: null,
        operations: [{ operationIdentity: 'op-one', portableArticleIdentity: 'article-one', outcome: 'executed',
            beforeRevision: 12, afterRevision: 13, reasonCode: null, contentSha256: digest }] }]
};

describe('server receipt display scope (no local completion authority)', () => {
    it.each(['siteIdentity', 'vaultIdentity', 'planReference', 'planSha256'] as const)('refuses crossed %s', (field) => {
        expect(presentVaultServerExecution({ ...result, [field]: 'another' }, expected)).toBeNull();
    });
    it('displays server counts without declaring local/base/other-device completion', () => {
        const view = presentVaultServerExecution(result, expected);
        expect(view).toEqual({ operationCount: 1, committedGroupCount: 1, failedOperationCount: 0 });
        expect(view).not.toHaveProperty('clean');
        expect(view).not.toHaveProperty('synced');
    });
});


describe('plan and server receipt composition (unqualified presentation)', () => {
    it('keeps missing and ready plans unavailable for execution', async () => {
        const wrapper = mount(VaultPlanReview, { props: { plan: null } });
        expect(wrapper.find('[role="status"]').text()).toContain('尚不可用');
        expect(wrapper.text()).toContain('状态未知');
        await wrapper.setProps({ plan: plan([item('op-one')]) });
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        expect(wrapper.text()).toContain('尚未验证是否仍然有效');
        expect(wrapper.text()).toContain('missing_base');
        expect(wrapper.find('input').attributes('aria-label')).toBe('筛选 article 或 operation identity');
        wrapper.unmount();
    });

    it('does not disclose crossed-scope operation data', () => {
        const wrapper = mount(VaultExecutionProgress, {
            props: { result: { ...result, vaultIdentity: 'other-vault', resultReference: 'other-private-result' }, expected }
        });
        expect(wrapper.find('[role="alert"]').text()).toContain('不匹配');
        expect(wrapper.text()).not.toContain('other-private-result');
        expect(wrapper.findAll('li')).toHaveLength(0);
        wrapper.unmount();
    });

    it('server completed receipt leaves materialization/base unknown and exposes no continuation command', () => {
        const wrapper = mount(VaultExecutionProgress, { props: { result, expected } });
        expect(wrapper.find('[role="status"]').text()).toContain('同步状态未知');
        expect(wrapper.text()).toContain('已提交的服务端 revision/history 保留');
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });
});
