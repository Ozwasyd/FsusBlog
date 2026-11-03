// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultAgentLeaseDetail from '@/components/admin/article/vault/VaultAgentLeaseDetail.vue';
import {
    presentVaultAgentLease,
    type VaultAgentLeaseReport,
    type VaultAgentLeaseScope
} from '@/services/articleVault/agentLeasePresentation';

const scope: VaultAgentLeaseScope = {
    siteIdentity: 'site-fixture',
    vaultIdentity: 'vault-fixture',
    deviceIdentity: 'device-fixture',
    agentInstanceIdentity: 'agent-fixture',
    userSessionIdentity: 'session-secret',
    rootSha256: 'a'.repeat(64),
    binarySha256: 'b'.repeat(64),
    agentVersion: '1.2.3',
    protocolVersion: 1
};

const report: VaultAgentLeaseReport = {
    schema: 'fsusblog.article-vault.writer-lease.v1',
    binding: scope,
    generation: 12,
    state: 'active',
    observedUnixMilliseconds: 1000,
    deadlineUnixMilliseconds: 61000,
    previousReceiptSha256: 'c'.repeat(64),
    contentSha256: 'd'.repeat(64)
};

describe('Vault agent lease read-only projection (#2134)', () => {
    it.each(Object.keys(scope) as (keyof VaultAgentLeaseScope)[])('hides all supplied details for crossed %s', (field) => {
        const expectedScope = { ...scope, [field]: field === 'protocolVersion' ? 2 : `${scope[field]}-different` };
        expect(presentVaultAgentLease(report, expectedScope)).toEqual({ availability: 'scope-mismatch', rows: [] });
    });

    it('whitelists only safe projection fields and omits session, path, token and unknown details', () => {
        const extraReport = {
            ...report,
            binding: { ...scope, userSessionIdentity: 'session-secret', rootPath: '/private-root-secret' },
            token: 'token-secret',
            source: 'private-source-secret'
        };
        const projection = presentVaultAgentLease(extraReport, scope);
        const serialized = JSON.stringify(projection);
        expect(projection.availability).toBe('reported');
        expect(serialized).not.toMatch(/session-secret|private-root-secret|token-secret|private-source-secret/u);
        expect(projection.rows.some(row => row.value === scope.rootSha256)).toBe(true);
        expect(projection.rows.some(row => row.value === report.contentSha256)).toBe(true);
        expect(projection.rows.some(row => row.value === '12')).toBe(true);
        expect(projection.rows.some(row => row.value === '61000')).toBe(true);
    });

    it('does not infer expiry from the browser clock or accept a caller verification flag as authority', () => {
        const projection = presentVaultAgentLease({ ...report, verified: true } as VaultAgentLeaseReport, scope);
        expect(projection.rows.find(row => row.label === 'Lease 报告状态')?.value).toContain('active');
        expect(projection.rows.find(row => row.label.startsWith('Receipt SHA'))?.label).toContain('尚未验证');
    });

    it('rejects unsafe digests and imprecise integer display without echoing them', () => {
        const badDigest = { ...scope, rootSha256: '/private-path-secret' };
        expect(presentVaultAgentLease({ ...report, binding: badDigest }, badDigest)).toEqual({ availability: 'unavailable', rows: [] });
        expect(presentVaultAgentLease({ ...report, generation: Number.MAX_SAFE_INTEGER + 1 }, scope)).toEqual({ availability: 'unavailable', rows: [] });
        expect(presentVaultAgentLease(null, scope).rows).toEqual([]);
        expect(presentVaultAgentLease(report, null).rows).toEqual([]);
    });

    it.each(['active', 'released', 'revoked', 'expired'] as const)('renders %s as reported facts without actionable lifecycle commands', (state) => {
        const wrapper = mount(VaultAgentLeaseDetail, { props: { report: { ...report, state }, expectedScope: scope } });
        expect(wrapper.get('dl').text()).toContain(state);
        expect(wrapper.get('dl').text()).toContain(scope.agentVersion);
        expect(wrapper.text()).toContain('尚未验证当前性、原生锁所有权、安装或签名信任与 lifecycle');
        expect(wrapper.text()).toContain('不代表 agent 正在运行或健康');
        expect(wrapper.text()).toContain('服务端文章编辑、保存、发布和恢复仍可使用');
        expect(wrapper.findAll('button, a, input')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        const titleId = wrapper.get('section').attributes('aria-labelledby');
        expect(wrapper.get(`h2[id="${titleId}"]`).text()).toBe('Agent lease 只读报告');
        wrapper.unmount();
    });

    it('renders the unavailable and crossed-scope states without report or expected identity leakage', async () => {
        const wrapper = mount(VaultAgentLeaseDetail, { props: { report: null, expectedScope: scope } });
        expect(wrapper.get('[role="status"]').text()).toContain('当前详情不可用');
        expect(wrapper.find('dl').exists()).toBe(false);
        await wrapper.setProps({ report, expectedScope: { ...scope, siteIdentity: 'other-site-secret' } });
        expect(wrapper.get('[role="status"]').text()).toContain('隐藏全部报告详情');
        expect(wrapper.text()).not.toContain(scope.siteIdentity);
        expect(wrapper.text()).not.toContain('other-site-secret');
        expect(wrapper.text()).not.toContain(scope.binarySha256);
        wrapper.unmount();
    });
});
