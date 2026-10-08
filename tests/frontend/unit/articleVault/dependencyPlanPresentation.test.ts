// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultDependencyPlanReview from '@/components/admin/article/vault/VaultDependencyPlanReview.vue';
import VaultPlanReview from '@/components/admin/article/vault/VaultPlanReview.vue';
import { presentVaultDependencyPlan, type VaultDependencyPlanReviewDocument } from '@/services/articleVault/dependencyPlanPresentation';
import { presentVaultPlan, type VaultPlanReviewDocument } from '@/services/articleVault/planReview';

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
    it('refuses the unchanged same-scope unknown-order counterexample without projecting undefined', () => {
        const malformedPlan = { ...plan, operationOrder: ['unknown-op'] };
        const malformedExtension = { ...extension, operationOrder: ['unknown-op'] };
        const before = JSON.stringify({ malformedPlan, malformedExtension });
        expect(presentVaultPlan(malformedPlan).orderAvailable).toBe(false);
        expect(presentVaultDependencyPlan(malformedExtension, malformedPlan)).toBeNull();
        expect(JSON.stringify({ malformedPlan, malformedExtension })).toBe(before);
    });
    it.each(['unknown', 'duplicate-order', 'missing-order', 'duplicate-plan-item', 'duplicate-extension-item'])('keeps %s membership closed with matching plan/extension order', (kind) => {
        const first = plan.groups[0].items[0];
        const second = { ...first, operationIdentity: 'op-two' };
        const dependency = extension.items[0];
        const operationOrder = kind === 'unknown' ? ['op-one', 'unknown-op']
            : kind === 'duplicate-order' ? ['op-one', 'op-one']
                : kind === 'missing-order' ? ['op-one'] : ['op-one', 'op-two'];
        const malformedPlan = { ...plan, operationOrder, groups: [{ ...plan.groups[0],
            items: [first, kind === 'duplicate-plan-item' ? first : second] }] };
        const malformedExtension = { ...extension, operationOrder,
            items: [dependency, kind === 'duplicate-extension-item' ? dependency : { ...dependency, operationIdentity: 'op-two' }] };
        expect(presentVaultDependencyPlan(malformedExtension, malformedPlan)).toBeNull();
    });
    it('projects every valid member exactly once in the unchanged canonical order', () => {
        const second = { ...plan.groups[0].items[0], operationIdentity: 'op-two' };
        const operationOrder = ['op-two', 'op-one'];
        const orderedPlan = { ...plan, operationOrder, groups: [{ ...plan.groups[0], items: [...plan.groups[0].items, second] }] };
        const orderedExtension = { ...extension, operationOrder,
            items: [...extension.items, { ...extension.items[0], operationIdentity: 'op-two' }] };
        const before = JSON.stringify({ orderedPlan, orderedExtension });
        const view = presentVaultDependencyPlan(orderedExtension, orderedPlan)!;
        expect(view.items.map(item => item.operationIdentity)).toEqual(operationOrder);
        expect(view.items.every(item => item !== undefined)).toBe(true);
        expect(view.items[0]).toBe(orderedExtension.items[1]);
        expect(view.items[1]).toBe(orderedExtension.items[0]);
        expect(JSON.stringify({ orderedPlan, orderedExtension })).toBe(before);
        expect(view).not.toHaveProperty('canExecute');
    });
    it.each(['dependency', 'plan'] as const)('renders the original unknown-order counterexample through %s as unavailable without crashing', (component) => {
        const malformedPlan = { ...plan, operationOrder: ['unknown-op'] };
        const malformedExtension = { ...extension, operationOrder: ['unknown-op'] };
        const wrapper = component === 'dependency'
            ? mount(VaultDependencyPlanReview, { props: { plan: malformedPlan, extension: malformedExtension } })
            : mount(VaultPlanReview, { props: { plan: malformedPlan, dependencyPlan: malformedExtension } });
        expect(wrapper.get('[aria-label="Vault 计划依赖范围"] [role="alert"]').text()).toContain('不匹配');
        expect(wrapper.get('[aria-label="Vault 计划依赖范围"] [role="status"]').text()).toContain('不能据此执行同步或发布');
        expect(wrapper.find('[aria-label="按同步操作顺序审查依赖"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('exact-node-key');
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
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
