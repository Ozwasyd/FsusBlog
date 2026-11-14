// @vitest-environment happy-dom

import { ElButton, ElTag } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import AuthoringWorkspacePanelRenderer from '@/components/admin/article/AuthoringWorkspacePanelRenderer.vue';
import type { AuthoringWorkspacePanelPresentationNode } from '@/components/admin/article/authoringWorkspacePanelPresentation';

const nodes = Object.freeze([
    Object.freeze({ Id: 'summary', Kind: 0, Text: '文档摘要', Value: null, CommandId: null, Tone: null }),
    Object.freeze({ Id: 'pair', Kind: 1, Text: '状态', Value: '草稿', CommandId: null, Tone: null }),
    Object.freeze({ Id: 'status', Kind: 2, Text: '需要检查', Value: null, CommandId: null, Tone: 1 }),
    Object.freeze({ Id: 'command', Kind: 3, Text: '打开检查', Value: null, CommandId: 'host.command.open', Tone: null })
] as const satisfies readonly AuthoringWorkspacePanelPresentationNode[]);

const wrappers: ReturnType<typeof mount>[] = [];

function Render(props: {
    nodes?: readonly AuthoringWorkspacePanelPresentationNode[] | null;
    commandsEnabled?: boolean;
    disabled?: boolean;
} = {})
{
    const wrapper = mount(AuthoringWorkspacePanelRenderer, {
        attachTo: document.body,
        props
    });
    wrappers.push(wrapper);
    return wrapper;
}

afterEach(() =>
{
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('AuthoringWorkspacePanelRenderer controlled presentation', () =>
{
    it('renders all four kinds in supplied order with real public controls', () =>
    {
        const wrapper = Render({ nodes });
        expect(wrapper.findAll('li').map((row) => row.text())).toEqual(['文档摘要', '状态草稿', '需要检查', '打开检查']);
        expect(wrapper.get('dt').text()).toBe('状态');
        expect(wrapper.get('dd').text()).toBe('草稿');
        expect(wrapper.findComponent(ElTag).props('type')).toBe('warning');
        expect(wrapper.findComponent(ElButton).exists()).toBe(true);
        expect(wrapper.get('button').attributes('type')).toBe('button');
        expect(wrapper.emitted()).toEqual({});
    });

    it.each([[0, 'info'], [1, 'warning'], [2, 'danger']] as const)('maps tone %s to a fixed public semantic type', (tone: 0 | 1 | 2, type: 'info' | 'warning' | 'danger') =>
    {
        const wrapper = Render({ nodes: [{ Id: 'status', Kind: 2, Text: '检查结果', Tone: tone }] });
        expect(wrapper.findComponent(ElTag).props('type')).toBe(type);
    });

    it('interpolates every text field without creating markup, styles, URLs or components', () =>
    {
        const text = '<img src=x onerror="alert(1)"><script>bad()</script> javascript:bad() color:red';
        const wrapper = Render({ nodes: [
            { Id: 'text', Kind: 0, Text: text },
            { Id: 'pair', Kind: 1, Text: text, Value: text },
            { Id: 'status', Kind: 2, Text: text, Tone: 0 },
            { Id: 'command', Kind: 3, Text: text, CommandId: 'host.command.open' }
        ] });
        expect(wrapper.findAll('li').every((row) => row.text().includes(text))).toBe(true);
        expect(wrapper.get('dt').text()).toBe(text);
        expect(wrapper.get('dd').text()).toBe(text);
        expect(wrapper.find('img, script, iframe, svg, a, [onerror], [href]').exists()).toBe(false);
        expect(wrapper.attributes('style')).toBeUndefined();
    });

    it('does not accept arbitrary attributes or component slots', () =>
    {
        const wrapper = mount(AuthoringWorkspacePanelRenderer, {
            props: { nodes },
            attrs: { style: 'position:fixed', onclick: 'bad()', 'data-extra': 'unselected' },
            slots: { default: '<img src=x>' }
        });
        wrappers.push(wrapper);
        expect(wrapper.attributes('style')).toBeUndefined();
        expect(wrapper.attributes('onclick')).toBeUndefined();
        expect(wrapper.attributes('data-extra')).toBeUndefined();
        expect(wrapper.find('img').exists()).toBe(false);
    });

    it('renders absent, null and empty selections without retaining earlier content', async () =>
    {
        const wrapper = Render();
        expect(wrapper.findAll('li')).toHaveLength(0);
        await wrapper.setProps({ nodes });
        expect(wrapper.findAll('li')).toHaveLength(4);
        await wrapper.setProps({ nodes: null });
        expect(wrapper.text()).toBe('');
        expect(wrapper.findAll('button, dl')).toHaveLength(0);
        await wrapper.setProps({ nodes: [] });
        expect(wrapper.findAll('li')).toHaveLength(0);
    });

    it('updates same-ID text and empty values directly from replacement props', async () =>
    {
        const wrapper = Render({ nodes });
        await wrapper.setProps({ nodes: [{ Id: 'pair', Kind: 1, Text: '新的字段', Value: '' }] });
        expect(wrapper.findAll('li')).toHaveLength(1);
        expect(wrapper.get('dt').text()).toBe('新的字段');
        expect(wrapper.get('dd').text()).toBe('');
        expect(wrapper.text()).not.toContain('文档摘要');
    });

    it('defaults commands to disabled and ignores native and component clicks', async () =>
    {
        const wrapper = Render({ nodes });
        expect((wrapper.get('button').element as HTMLButtonElement).disabled).toBe(true);
        await wrapper.get('button').trigger('click');
        wrapper.findComponent(ElButton).vm.$emit('click', new MouseEvent('click'));
        expect(wrapper.emitted('commandIntent')).toBeUndefined();
    });

    it('emits only the selected node and command intent when explicitly enabled', async () =>
    {
        const wrapper = Render({ nodes, commandsEnabled: true });
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('commandIntent')).toEqual([[{ nodeId: 'command', commandId: 'host.command.open' }]]);
        expect(Object.isFrozen(wrapper.emitted('commandIntent')?.[0]?.[0])).toBe(true);
        expect(wrapper.findAll('li')).toHaveLength(4);
        expect(nodes[3].CommandId).toBe('host.command.open');
    });

    it('external disabled wins over enabled and revokes previously enabled controls', async () =>
    {
        const wrapper = Render({ nodes, commandsEnabled: true, disabled: true });
        expect((wrapper.get('button').element as HTMLButtonElement).disabled).toBe(true);
        await wrapper.setProps({ disabled: false });
        expect((wrapper.get('button').element as HTMLButtonElement).disabled).toBe(false);
        await wrapper.setProps({ commandsEnabled: false });
        wrapper.findComponent(ElButton).vm.$emit('click', new MouseEvent('click'));
        expect(wrapper.emitted('commandIntent')).toBeUndefined();
    });

    it('does not emit a removed command from an old detached button', async () =>
    {
        const wrapper = Render({ nodes, commandsEnabled: true });
        const old = wrapper.get('button').element as HTMLButtonElement;
        await wrapper.setProps({ nodes: null });
        old.click();
        expect(wrapper.emitted('commandIntent')).toBeUndefined();
    });

    it('uses native focusable buttons without adding a custom keyboard handler', () =>
    {
        const wrapper = Render({ nodes, commandsEnabled: true });
        const button = wrapper.get('button').element as HTMLButtonElement;
        button.focus();
        expect(document.activeElement).toBe(button);
        expect(button.tabIndex).toBe(0);
        expect(button.getAttribute('role')).toBeNull();
    });

    it('unmounts all content and prevents later detached activation from emitting', () =>
    {
        const wrapper = Render({ nodes, commandsEnabled: true });
        const old = wrapper.get('button').element as HTMLButtonElement;
        wrapper.unmount();
        wrappers.pop();
        old.click();
        expect(document.body.contains(old)).toBe(false);
        expect(wrapper.emitted('commandIntent')).toBeUndefined();
    });
});
