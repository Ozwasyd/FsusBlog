// @vitest-environment happy-dom

import { ElButton } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import VaultUnlinkReview from '@/components/admin/article/vault/VaultUnlinkReview.vue';
import type { VaultAgentLeaseScope } from '@/services/articleVault/agentLeasePresentation';
import type { VaultAgentLifecycleReport } from '@/services/articleVault/agentLifecyclePresentation';

const scope: VaultAgentLeaseScope = {
    siteIdentity: 'site-fixture', vaultIdentity: 'vault-fixture', deviceIdentity: 'device-fixture',
    agentInstanceIdentity: 'agent-fixture', userSessionIdentity: 'session-secret',
    rootSha256: 'a'.repeat(64), binarySha256: 'b'.repeat(64), agentVersion: '1.2.3', protocolVersion: 1
};

// Display fixture only, not native or verified shutdown evidence.
const report: VaultAgentLifecycleReport = {
    schema: 'fsusblog.article-vault.agent-lifecycle.v1', binding: scope, platform: 'linux',
    previousState: 'unlinking', newState: 'retained-control-state', sequence: 5, observedUnixMilliseconds: 2000,
    rescanRequired: true, leaseGeneration: null, leaseReceiptSha256: null, ipcReceiptSha256: null,
    retainedBinarySha256: null, candidateBinarySha256: null, recovery: null,
    producerReceiptSha256: 'c'.repeat(64), reasonCode: 'rescan_required',
    previousReceiptSha256: 'd'.repeat(64), contentSha256: 'e'.repeat(64)
};

describe('Vault unlink review boundary (#2130)', () => {
    it('keeps unlink retention separate from unavailable local-copy deletion with real disabled controls', async () => {
        const wrapper = mount(VaultUnlinkReview);
        expect(wrapper.text()).toContain('本次本地 agent 所持有的授权、writer lease 与 IPC 通道');
        expect(wrapper.text()).toContain('不会删除本地 Markdown、服务端文章、缓存或其他运行的文件');
        expect(wrapper.text()).toContain('本地控制和审计记录也会保留');
        expect(wrapper.text()).toContain('与断开连接分开的危险操作');
        expect(wrapper.text()).toContain('原生条件删除与同步基线提交目前不可用');
        expect(wrapper.text()).toContain('服务端文章编辑、保存、发布和恢复仍可使用');
        const buttons = wrapper.findAll('button');
        expect(wrapper.findAllComponents(ElButton)).toHaveLength(2);
        expect(buttons.map(button => button.text())).toEqual(['断开连接（不可用）', '删除本地副本（不可用）']);
        for (const button of buttons)
        {
            expect(button.element.disabled).toBe(true);
            await button.trigger('click');
            const description = button.attributes('aria-describedby');
            expect(wrapper.get(`[id="${description}"]`).text()).toMatch(/无法|不可用/u);
        }
        expect(wrapper.emitted()).toEqual({});
        expect(wrapper.find('dl').exists()).toBe(false);
        wrapper.unmount();
    });

    it.each(Object.keys(scope) as (keyof VaultAgentLeaseScope)[])('rejects crossed %s without showing report details or enabling unlink/delete', (field) => {
        const expectedScope = { ...scope, [field]: field === 'protocolVersion' ? 2 : `${scope[field]}-crossed` };
        const wrapper = mount(VaultUnlinkReview, { props: { lifecycleReport: report, expectedScope } });
        expect(wrapper.get('[role="status"]').text()).toContain('已隐藏全部范围与回执详情');
        expect(wrapper.find('dl').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(scope.siteIdentity);
        expect(wrapper.text()).not.toContain(scope.rootSha256);
        expect(wrapper.text()).not.toContain(report.contentSha256);
        expect(wrapper.text()).not.toContain(scope.userSessionIdentity);
        expect(wrapper.findAll('button').every(button => button.element.disabled)).toBe(true);
        wrapper.unmount();
    });

    it.each(['stopping', 'stopped', 'unlinking', 'removed', 'retained-control-state', 'crashed'] as const)(
        'shows exact reported %s with producer/digest refs but no terminal success', async (newState) => {
            const wrapper = mount(VaultUnlinkReview, { props: { lifecycleReport: { ...report, newState }, expectedScope: scope } });
            expect(wrapper.findAll('dl')).toHaveLength(2);
            expect(wrapper.get('dl[aria-label="未验证的解绑报告绑定范围"]').text()).toContain(scope.rootSha256);
            const receipt = wrapper.get('dl[aria-label="未验证的解绑 lifecycle 回执详情"]');
            expect(receipt.text()).toContain(newState);
            expect(receipt.text()).toContain(report.producerReceiptSha256);
            expect(receipt.text()).toContain(report.contentSha256);
            expect(wrapper.text()).toContain('回执链与当前性尚未验证');
            expect(wrapper.text()).toContain('不证明本页面已经完成解绑或撤销');
            for (const button of wrapper.findAll('button'))
            {
                expect(button.element.disabled).toBe(true);
                await button.trigger('click');
            }
            expect(wrapper.emitted()).toEqual({});
            wrapper.unmount();
        }
    );

    it('suppresses unsafe or absent reports without claiming success from browser persistence after reload', async () => {
        const write = vi.spyOn(Storage.prototype, 'setItem');
        const read = vi.spyOn(Storage.prototype, 'getItem');
        try
        {
            const wrapper = mount(VaultUnlinkReview, { props: { lifecycleReport: report, expectedScope: scope } });
            await wrapper.setProps({ lifecycleReport: { ...report, producerReceiptSha256: '/private-path-secret' } });
            expect(wrapper.find('dl').exists()).toBe(false);
            expect(wrapper.text()).not.toContain('/private-path-secret');
            expect(wrapper.get('[role="status"]').text()).toContain('不能确认解绑或撤销结果');
            await wrapper.setProps({ lifecycleReport: null });
            expect(wrapper.find('dl').exists()).toBe(false);
            wrapper.unmount();
            const reloaded = mount(VaultUnlinkReview);
            expect(reloaded.find('dl').exists()).toBe(false);
            expect(reloaded.findAll('button').every(button => button.element.disabled)).toBe(true);
            expect(write).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
            reloaded.unmount();
        }
        finally
        {
            vi.restoreAllMocks();
        }
    });

    it('omits session, path, token and private source even from an otherwise displayable report', () => {
        const payload = {
            ...report,
            binding: { ...scope, rootPath: '/private-path-secret' },
            token: 'token-secret', source: 'private-source-secret'
        };
        const wrapper = mount(VaultUnlinkReview, { props: { lifecycleReport: payload, expectedScope: scope } });
        expect(wrapper.findAll('dl')).toHaveLength(2);
        expect(wrapper.html()).not.toMatch(/session-secret|private-path-secret|token-secret|private-source-secret/u);
        for (const section of wrapper.findAll('section'))
        {
            const titleId = section.attributes('aria-labelledby');
            expect(wrapper.find(`[id="${titleId}"]`).exists()).toBe(true);
        }
        expect(wrapper.emitted()).toEqual({});
        wrapper.unmount();
    });
});
