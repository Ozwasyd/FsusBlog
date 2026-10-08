// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import type { ArticleTemplateTransport, ArticleTemplateVersion } from '@/api/articleTemplates';
import ArticleTemplateManager from '@/components/admin/article/templates/ArticleTemplateManager.vue';
import ArticleTemplatePreview from '@/components/admin/article/templates/ArticleTemplatePreview.vue';

const version: ArticleTemplateVersion = {
    templateId: 'template-id', versionId: 'immutable-version-id', versionNumber: 1, versionDigest: 'a'.repeat(64),
    definitionRevision: 2, scopeRevision: 3, name: 'Tutorial', description: null, scope: 'personal', status: 'active', canManage: true,
    source: '<script>alert(1)</script>\r\n{{title}}', variables: ['title'], provenanceCount: 0,
    defaults: { titlePlaceholder: null, summaryPlaceholder: null, categoryId: null, tagIds: [], assetIds: [],
        propertyDefaults: [], rightsProfile: null, responsibilityProfile: null, prepublishProfile: null }
};
const labels = { heading: 'Manage templates', create: 'Create definition', rename: 'Rename', newVersion: 'New version',
    retire: 'Retire', delete: 'Delete', name: 'Name', description: 'Description', source: 'Source', operation: 'Operation',
    confirm: 'Confirm', cancel: 'Cancel', affected: 'Affected articles', pending: 'Pending', done: 'Saved', reason: (code: string) => code };
const stubs = {
    FsusDialog: defineComponent({ template: '<section><slot /><slot name="footer" /></section>' }),
    ElButton: defineComponent({ props: ['disabled', 'nativeType'], template: '<button :disabled="disabled"><slot /></button>' }),
    ElInput: defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" />' }),
    ElSelect: defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], template: '<div><slot /></div>' }),
    ElOption: defineComponent({ props: ['value', 'label'], template: '<span>{{ label }}</span>' })
};

function manager(selected: ArticleTemplateVersion | null = version, canManage = true)
{
    const transport: ArticleTemplateTransport = {
        listVersions: vi.fn().mockResolvedValue({ items: [], nextVersionNumber: null }), list: vi.fn(), getVersion: vi.fn(), plan: vi.fn(),
        manage: vi.fn().mockResolvedValue({ receiptId: 'receipt-id', contentDigest: 'a'.repeat(64) }) };
    const wrapper = mount(ArticleTemplateManager, { props: { visible: true, transport, version: selected,
        scope: 'personal', scopeRevision: 3, canManage, labels }, global: { stubs } });
    const submit = () => wrapper.findAll('button').at(-1)!.trigger('click');
    return { wrapper, transport, submit };
}

describe('template composition boundaries', () =>
{
    it('renders skeleton bytes as text without HTML execution', () =>
    {
        const wrapper = mount(ArticleTemplatePreview, { props: { version, labels: { version: 'Version', source: 'Source',
            variables: 'Variables', defaults: 'Defaults', defaultLabel: key => key, defaultValue: (_key, value) => String(value ?? 'none') } } });
        expect(wrapper.find('script').exists()).toBe(false);
        expect(wrapper.find('pre').element.textContent).toBe(version.source);
        expect(wrapper.text()).toContain('Version 1');
    });

    it('creates a new immutable version using observed CAS and fresh identity', async () =>
    {
        const { wrapper, transport, submit } = manager();
        await submit();
        await flushPromises();
        const command = vi.mocked(transport.manage).mock.calls[0]![0];
        expect(command).toMatchObject({ kind: 'new-version', templateId: version.templateId, expectedScopeRevision: 3,
            expectedDefinitionRevision: 2, expectedCurrentVersionNumber: 1, defaults: version.defaults });
        if (command.kind !== 'new-version') throw new Error('wrong command');
        expect(command.versionId).not.toBe(version.versionId);
        expect(wrapper.emitted('changed')).toEqual([['receipt-id']]);
    });

    it.each(['rename', 'retire', 'delete'] as const)('submits explicit %s management without article writes', async kind =>
    {
        const { wrapper, transport, submit } = manager();
        wrapper.findComponent(stubs.ElSelect).vm.$emit('update:modelValue', kind);
        await flushPromises();
        await submit();
        await flushPromises();
        expect(transport.manage).toHaveBeenCalledWith(expect.objectContaining({ kind, templateId: version.templateId,
            expectedDefinitionRevision: 2, expectedScopeRevision: 3 }));
        expect(transport.plan).not.toHaveBeenCalled();
    });

    it('has zero management writes after cancel or permission denial', async () =>
    {
        const { wrapper, transport, submit } = manager(version, false);
        await submit();
        await wrapper.find('button').trigger('click');
        expect(wrapper.emitted('close')).toHaveLength(1);
        expect(transport.manage).not.toHaveBeenCalled();
    });

    it('retains the exact command for network retry and exposes CAS failure', async () =>
    {
        const { wrapper, transport, submit } = manager();
        vi.mocked(transport.manage).mockRejectedValueOnce({ code: 'network_error' }).mockRejectedValueOnce({ code: 'article_template_cas_stale' });
        await submit();
        await flushPromises();
        await submit();
        await flushPromises();
        expect(vi.mocked(transport.manage).mock.calls[0]![0]).toBe(vi.mocked(transport.manage).mock.calls[1]![0]);
        expect(wrapper.find('[role="alert"]').text()).toBe('article_template_cas_stale');
        expect(wrapper.emitted('changed')).toBeUndefined();
    });

    it('creates a definition only after explicit input and excludes history defaults', async () =>
    {
        const { wrapper, transport, submit } = manager(null);
        wrapper.findAllComponents(stubs.ElInput)[0]!.vm.$emit('update:modelValue', 'Explicit template');
        await flushPromises();
        await submit();
        await flushPromises();
        expect(transport.manage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create', name: 'Explicit template',
            expectedScopeRevision: 3, scope: 'personal', defaults: expect.objectContaining({ propertyDefaults: [], rightsProfile: null }) }));
    });
});
