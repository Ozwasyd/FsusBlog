// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultStatusUnavailable from '@/components/admin/article/vault/VaultStatusUnavailable.vue';

 describe('missing canonical Vault capability disclosure', () => {
    it('keeps the status compact and unknown with no fake commands or successful connection state', async () => {
        const wrapper = mount(VaultStatusUnavailable);
        expect(wrapper.find('details').attributes('open')).toBeUndefined();
        expect(wrapper.find('summary').text()).toBe('Vault：状态未知');
        expect(wrapper.find('[role="status"]').text()).toContain('当前无法取得已验证');
        expect(wrapper.text()).toContain('服务端文章编辑、保存、发布和恢复仍可使用');
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });
});

it('shows supplied canonical lease reports only inside the same unavailable status owner and suppresses crossed session data', async () => {
    const scope = {
        siteIdentity: 'site-fixture', vaultIdentity: 'vault-fixture', deviceIdentity: 'device-fixture',
        agentInstanceIdentity: 'agent-fixture', userSessionIdentity: 'session-secret',
        rootSha256: 'a'.repeat(64), binarySha256: 'b'.repeat(64), agentVersion: '1.2.3', protocolVersion: 1
    };
    const leaseReport = {
        schema: 'fsusblog.article-vault.writer-lease.v1' as const, binding: scope, generation: 12,
        state: 'active' as const, observedUnixMilliseconds: 1000, deadlineUnixMilliseconds: 61000,
        previousReceiptSha256: null, contentSha256: 'c'.repeat(64)
    };
    const wrapper = mount(VaultStatusUnavailable, { props: { leaseReport, leaseScope: scope } });
    expect(wrapper.find('summary').text()).toBe('Vault：状态未知');
    expect(wrapper.text()).toContain('不代表 agent 正在运行或健康');
    expect(wrapper.text()).toContain(scope.binarySha256);
    expect(wrapper.text()).not.toContain(scope.userSessionIdentity);
    expect(wrapper.findAll('button')).toHaveLength(0);
    await wrapper.setProps({ leaseScope: { ...scope, userSessionIdentity: 'new-session-secret' } });
    expect(wrapper.text()).toContain('已隐藏全部报告详情');
    expect(wrapper.text()).not.toContain(scope.binarySha256);
    expect(wrapper.text()).not.toContain('new-session-secret');
    expect(wrapper.find('summary').text()).toBe('Vault：状态未知');
    expect(wrapper.emitted()).toEqual({});
    wrapper.unmount();
});
