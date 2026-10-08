// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultDependencyPlanReview from '@/components/admin/article/vault/VaultDependencyPlanReview.vue';
import { presentVaultDependencyPlan, type VaultDependencyPlanReviewDocument } from '@/services/articleVault/dependencyPlanPresentation';
import type { VaultPlanReviewDocument } from '@/services/articleVault/planReview';

const digest = 'a'.repeat(64);
const coordinate = { serverRevision: 3, contentSha256: digest, metadataManifestSha256: digest,
    dependencySha256: digest, permissionSha256: digest, lifecycle: 'draft' };
const binding = { siteIdentity: 'site-one', vaultIdentity: 'vault-one', portableArticleIdentity: 'article-one' };
const plan: VaultPlanReviewDocument = {
    ...binding, deviceIdentity: 'device-one', direction: 'pull', createdAtUnixMs: 1, expiresAtUnixMs: 2,
    status: 'ready', cancelPolicy: 'before-execution-only', contentSha256: digest, rootManifestSha256: digest,
    operationOrder: ['op-one'], conflicts: [],
    groups: [{ groupIdentity: 'group-one', allOrNothing: true, portableArticleIdentities: ['article-one'], dependencies: [],
        items: [{ operationIdentity: 'op-one', sequence: 1, groupIdentity: 'group-one', portableArticleIdentity: 'article-one',
            serverArticleIdentity: 'server-one', decision: 'pull-update', base: coordinate, local: coordinate, server: coordinate,
            preconditions: { articleManifestSha256: digest, serverObservationSha256: digest, expectedServerRevision: 3,
                expectedPermissionSha256: digest, expectedLifecycle: 'draft' }, dependsOnOperationIdentities: [] }] }]
};
const extension: VaultDependencyPlanReviewDocument = {
    siteIdentity: 'site-one', vaultIdentity: 'vault-one', syncPlanSha256: digest, contentSha256: digest,
    operationOrder: ['op-one'], items: [{ operationIdentity: 'op-one', groupIdentity: 'group-one',
        portableArticleIdentity: 'article-one', dependencyOrder: ['exact-node-key'],
        manifest: { binding, sourceSide: 'Server', graphSha256: digest, relationSha256: digest, contentSha256: digest,
            nodes: [{ kind: 'asset', binding, admission: { permission: 'Allowed', requiredRights: 'Read, Materialize',
                grantedRights: 'Read, Materialize', permissionSha256: digest, rightsSha256: digest, authoritySha256: digest } }],
            edges: [{ prerequisiteKey: 'exact-node-key', dependentKey: 'exact-other-key', kind: 'FrozenRequires' }] } }]
};

describe('canonical dependency extension read-only scope', () => {
    it('preserves codec enum spelling and exact refs without admitting execution', () => {
        const review = presentVaultDependencyPlan(extension, plan);
        expect(review?.items[0]?.manifest.sourceSide).toBe('Server');
        expect(review?.items[0]?.manifest.edges[0]?.kind).toBe('FrozenRequires');
        expect(review?.items[0]?.dependencyOrder).toEqual(['exact-node-key']);
        expect(review).not.toHaveProperty('canExecute');
        expect(review).not.toHaveProperty('canPublish');
    });
    it.each(['siteIdentity', 'vaultIdentity', 'syncPlanSha256'] as const)('refuses crossed %s', (field) => {
        expect(presentVaultDependencyPlan({ ...extension, [field]: 'other' }, plan)).toBeNull();
    });
    it('refuses missing, duplicate or reordered membership', () => {
        expect(presentVaultDependencyPlan({ ...extension, items: [] }, plan)).toBeNull();
        expect(presentVaultDependencyPlan({ ...extension, items: [...extension.items, ...extension.items] }, plan)).toBeNull();
        expect(presentVaultDependencyPlan({ ...extension, operationOrder: ['other'] }, plan)).toBeNull();
    });
    it('refuses crossed node article identity instead of reusing another article permissions', () => {
        const item = extension.items[0]!;
        const node = item.manifest.nodes[0]!;
        expect(presentVaultDependencyPlan({ ...extension, items: [{ ...item,
            manifest: { ...item.manifest, nodes: [{ ...node, binding: { ...binding, portableArticleIdentity: 'another-article' } }] } }] }, plan)).toBeNull();
    });
    it('renders exact scope with no sync/publication action and hides mismatched graph details', async () => {
        const wrapper = mount(VaultDependencyPlanReview, { props: { extension, plan } });
        expect(wrapper.text()).toContain('Read, Materialize');
        expect(wrapper.text()).toContain('FrozenRequires');
        expect(wrapper.find('[role="status"]').text()).toContain('不能据此执行同步或发布');
        expect(wrapper.findAll('button')).toHaveLength(0);
        await wrapper.setProps({ extension: { ...extension, vaultIdentity: 'other' } });
        expect(wrapper.find('[role="alert"]').text()).toContain('不匹配');
        expect(wrapper.text()).not.toContain('exact-node-key');
        wrapper.unmount();
    });
});
