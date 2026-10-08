// @vitest-environment happy-dom

import { ElButton, ElCheckbox } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import VaultConnectionPrivacyReview from '@/components/admin/article/vault/VaultConnectionPrivacyReview.vue';

const scope = {
    siteIdentity: 'site-review-fixture',
    vaultIdentity: 'vault-review-fixture',
    selectedRootPath: '/chosen/review-fixture'
};

afterEach(() => { vi.restoreAllMocks(); });

describe('Vault connection privacy review (#2130)', () => {
    it('discloses actual disk/privacy effects and starts with explicit unchecked acknowledgement', async () => {
        const wrapper = mount(VaultConnectionPrivacyReview, { props: scope });
        const checkbox = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
        const buttons = wrapper.findAll('button');

        expect(wrapper.findComponent(ElCheckbox).exists()).toBe(true);
        expect(wrapper.findAllComponents(ElButton)).toHaveLength(2);
        expect(checkbox.element.checked).toBe(false);
        expect(buttons[1].element.disabled).toBe(true);
        expect(wrapper.text()).toContain('私有文章、草稿正文和 assets 会写入所选目录');
        expect(wrapper.text()).toContain('不会自动加密');
        expect(wrapper.text()).toContain('第三方编辑器');
        expect(wrapper.text()).toContain('备份服务可能读取');
        expect(wrapper.text()).toContain('不会连接 Vault 或写入文件');
        expect(wrapper.text()).toContain('服务端文章编辑、保存、发布和恢复');
        expect(wrapper.emitted()).toEqual({});

        await checkbox.setValue(true);
        await buttons[1].trigger('click');
        expect(wrapper.emitted('reviewInitialPlan')).toEqual([[]]);
        expect(wrapper.emitted('connected')).toBeUndefined();
        expect(wrapper.emitted('delete')).toBeUndefined();
        wrapper.unmount();
    });

    it.each(['siteIdentity', 'vaultIdentity', 'selectedRootPath'] as const)(
        'clears acknowledgement when %s changes and blocks incomplete scope',
        async (field) => {
            const wrapper = mount(VaultConnectionPrivacyReview, { props: scope });
            await wrapper.get('input[type="checkbox"]').setValue(true);
            await wrapper.setProps({ [field]: `${scope[field]}-changed` });

            expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(false);
            expect(wrapper.findAll('button')[1].element.disabled).toBe(true);
            await wrapper.get('input[type="checkbox"]').setValue(true);
            await wrapper.setProps({ [field]: null });
            expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.disabled).toBe(true);
            expect(wrapper.get('[role="status"]').text()).toContain('当前不能继续审核');
            expect(wrapper.emitted('reviewInitialPlan')).toBeUndefined();
            wrapper.unmount();
        }
    );

    it.each([null, '', '   '])('never chooses a default root when the supplied root is %s', async (selectedRootPath) => {
        const wrapper = mount(VaultConnectionPrivacyReview, { props: { ...scope, selectedRootPath } });
        expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.disabled).toBe(true);
        expect(wrapper.findAll('button')[1].element.disabled).toBe(true);
        await wrapper.findAll('button')[1].trigger('click');
        expect(wrapper.emitted('reviewInitialPlan')).toBeUndefined();
        expect(wrapper.get('dl').text()).not.toMatch(/Documents|\/home\//u);
        wrapper.unmount();
    });

    it('cancels without leaking reviewed scope or retaining acknowledgement after remount', async () => {
        const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
        const consoleLog = vi.spyOn(console, 'log');
        const wrapper = mount(VaultConnectionPrivacyReview, { props: scope });

        for (const value of Object.values(scope)) expect(wrapper.get('dl').text()).toContain(value);
        await wrapper.get('input[type="checkbox"]').setValue(true);
        await wrapper.findAll('button')[0].trigger('click');
        expect(wrapper.emitted('cancel')).toEqual([[]]);
        expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(false);
        expect(storageWrite).not.toHaveBeenCalled();
        expect(consoleLog).not.toHaveBeenCalled();
        wrapper.unmount();

        const restored = mount(VaultConnectionPrivacyReview, { props: scope });
        expect(restored.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(false);
        expect(restored.emitted()).toEqual({});
        restored.unmount();
    });

    it('provides a named section, labelled acknowledgement and readable disclosure association', () => {
        const wrapper = mount(VaultConnectionPrivacyReview, { props: scope });
        const section = wrapper.get('section');
        expect(wrapper.get(`h2[id="${section.attributes('aria-labelledby')}"]`).text()).toContain('隐私与范围');
        const checkbox = wrapper.get('input[type="checkbox"]');
        expect(wrapper.get('label').text()).toContain('我已阅读并理解');
        const disclosureId = section.attributes('aria-describedby');
        expect(wrapper.get(`[id="${disclosureId}"]`).text()).toContain('不会自动加密');
        expect(checkbox.attributes('tabindex')).not.toBe('-1');
        wrapper.unmount();
    });
});
