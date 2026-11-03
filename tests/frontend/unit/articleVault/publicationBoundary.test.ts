// @vitest-environment happy-dom
import { ElButton } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import VaultPublicationBoundary from '@/components/admin/article/vault/VaultPublicationBoundary.vue';
import type { VaultServerExecutionDocument } from '@/services/articleVault/executionProgress';

const expected = { siteIdentity: 'site-fixture', vaultIdentity: 'vault-fixture', planReference: 'plan-fixture', planSha256: 'a'.repeat(64) };
const result: VaultServerExecutionDocument = {
    ...expected, resultReference: 'result-fixture', outcome: 'completed', reasonCode: null,
    completedAtUnixMs: 1234, contentSha256: 'b'.repeat(64), groups: [{ groupIdentity: 'group-fixture', committed: true, reasonCode: null,
        operations: [{ operationIdentity: 'operation-fixture', portableArticleIdentity: 'article-fixture', outcome: 'executed',
            beforeRevision: 1, afterRevision: 2, reasonCode: null, contentSha256: 'c'.repeat(64) }] }]
};

describe('unavailable Vault publication composition (#2135)', () => {
    it.each([true, false])('ordinary prepublish canPublish=%s never enables Vault publish or dispatches a command', async (canPublish) => {
        const wrapper = mount(VaultPublicationBoundary, { props: { expected, serverResult: result, prepublish: { canPublish,
            issues: [{ severity: 'warning', code: 'dependency_unverified', message: 'private-source-secret' }] } } });
        expect(wrapper.findComponent(ElButton).exists()).toBe(true);
        const action = wrapper.get<HTMLButtonElement>('button');
        expect(action.element.disabled).toBe(true);
        expect(wrapper.text()).toContain('该结果未绑定 Vault 范围或正式当前 revision');
        expect(wrapper.text()).toContain('历史 accepted revision 不等于当前可发布 revision');
        expect(wrapper.text()).toContain('普通服务端写作入口仍由原 publication authority 管理');
        expect(wrapper.text()).toContain('warning: dependency_unverified');
        expect(wrapper.text()).not.toContain('private-source-secret');
        expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
        await action.trigger('click');
        expect(wrapper.emitted()).toEqual({});
        expect(wrapper.get(`#${action.attributes('aria-describedby')}`).text()).toContain('当前 Vault 发布动作不可用');
        wrapper.unmount();
    });

    it('missing prepublish/result never defaults to current clean or permission', () => {
        const wrapper = mount(VaultPublicationBoundary, { props: { expected, serverResult: null, prepublish: null } });
        expect(wrapper.text()).toContain('尚无普通发布前检查结果');
        expect(wrapper.text()).toContain('指定操作的回执尚不可用');
        expect(wrapper.text()).toContain('离线本身不证明可以或不可以发布');
        expect(wrapper.get<HTMLButtonElement>('button').element.disabled).toBe(true);
        wrapper.unmount();
    });

    it('crossed Vault result is refused and cannot expose another result/history or enable publication', () => {
        const wrapper = mount(VaultPublicationBoundary, { props: { expected, prepublish: { canPublish: true, issues: [] },
            serverResult: { ...result, vaultIdentity: 'another-vault', resultReference: 'other-private-result' } } });
        expect(wrapper.text()).toContain('回执与当前站点、Vault 或计划引用不匹配');
        expect(wrapper.text()).not.toContain('other-private-result');
        expect(wrapper.text()).not.toContain('revision 1 → 2');
        expect(wrapper.get<HTMLButtonElement>('button').element.disabled).toBe(true);
        wrapper.unmount();
    });

    it('does not echo unsafe check codes or private free-form messages', () => {
        const wrapper = mount(VaultPublicationBoundary, { props: { expected, serverResult: null, prepublish: { canPublish: false,
            issues: [{ severity: 'error', code: '/private-root-secret', message: 'private-body-secret' }] } } });
        expect(wrapper.text()).toContain('未识别的检查代码');
        expect(wrapper.text()).not.toMatch(/private-root-secret|private-body-secret/u);
        wrapper.unmount();
    });
});
