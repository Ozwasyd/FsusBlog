// @vitest-environment happy-dom

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import ArticleMetadataPropertyList from '@/components/admin/article/ArticleMetadataPropertyList.vue';
import source from '@/components/admin/article/ArticleMetadataPropertyList.vue?raw';

const frontendRoot = path.resolve(process.cwd());
const frontendRequire = createRequire(path.join(frontendRoot, 'package.json'));
const { createServer, loadConfigFromFile } = frontendRequire('vite') as typeof import('vite');

const labels = {
    properties: 'Properties',
    compact: 'Compact',
    more: 'More',
    manage: 'Manage definitions',
    search: 'Search definitions',
    pagination: 'Property pages',
    previous: 'Previous',
    next: 'Next',
    unavailable: 'Unavailable',
    loading: 'Loading',
    stale: 'Stale',
    pageOverflow: 'Page overflow',
    empty: 'Empty',
    ready: 'Ready'
};

const props = {
    definitionIds: ['owner-defined-a', 'owner-defined-b'],
    contextKey: 'article-a:owner-revision-1',
    pageKey: 'page-1',
    showAll: false,
    query: '',
    available: true,
    loading: false,
    stale: false,
    canManage: true,
    hasPreviousPage: false,
    hasNextPage: true,
    labels
};

const wrappers: ReturnType<typeof mount>[] = [];

function render()
{
    const wrapper = mount(ArticleMetadataPropertyList, {
        attachTo: document.body,
        props,
        // The unit configuration omits production auto-import plugins. Register
        // the same public controls here; never replace them with test doubles.
        global: { components: { ElButton, ElInput } },
        slots: {
            property: ({ definitionId }: { definitionId: string }) => h('span', {
                'data-owner-definition': definitionId
            }, definitionId)
        }
    });
    wrappers.push(wrapper);
    return wrapper;
}

afterEach(() =>
{
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('ArticleMetadataPropertyList public import regression', () =>
{
    it('resolves both controls through the actual production public component resolver', async () =>
    {
        expect(source).not.toMatch(/\bfrom\s*['"]@ozwasyd\/element-plus(?:\/[^'"]*)?['"]/);
        expect(source).not.toMatch(/\bimport\s*\(\s*['"]@ozwasyd\/element-plus(?:\/[^'"]*)?['"]/);
        const production = await loadConfigFromFile(
            { command: 'serve', mode: 'test' },
            path.join(frontendRoot, 'vite.config.ts')
        );
        if (!production)
        {
            throw new Error('canonical production configuration is required');
        }
        const plugins = production.config.plugins?.flat(Infinity).filter((plugin) =>
            plugin && typeof plugin === 'object'
            && 'name' in plugin
            && ['vite:vue', 'unplugin-vue-components'].includes(plugin.name as string)
        );
        expect(plugins?.map((plugin) => plugin && typeof plugin === 'object' && 'name' in plugin
            ? plugin.name : '')).toEqual(['vite:vue', 'unplugin-vue-components']);
        const cacheDir = await mkdtemp(path.join(tmpdir(), 'property-list-public-import-'));
        const server = await createServer({
            ...production.config,
            configFile: false,
            root: frontendRoot,
            plugins,
            cacheDir,
            logLevel: 'silent',
            server: { middlewareMode: true, watch: null },
            optimizeDeps: { noDiscovery: true, include: [] }
        });
        try
        {
            const transformed = await server.transformRequest(
                '/src/components/admin/article/ArticleMetadataPropertyList.vue'
            );
            expect(transformed?.code).toMatch(/import\s*\{\s*ElButton\s+as\s+__unplugin_components_\d+\s*\}/);
            expect(transformed?.code).toMatch(/import\s*\{\s*ElInput\s+as\s+__unplugin_components_\d+\s*\}/);
            expect(transformed?.code).not.toMatch(/_resolveComponent\(["']El(?:Button|Input)["']\)/);
        }
        finally
        {
            await server.close();
            await rm(cacheDir, { recursive: true, force: true });
        }
    });

    it('keeps real public controls and owner-driven search, management, list additions and removals', async () =>
    {
        const wrapper = render();
        const button = (text: string) => wrapper.findAllComponents(ElButton)
            .find((control) => control.text() === text)!;
        expect(wrapper.findAllComponents(ElButton)).toHaveLength(4);
        expect(wrapper.findAll('button')).toHaveLength(4);
        await button(labels.more).trigger('click');
        expect(wrapper.emitted('update:showAll')).toEqual([[true]]);
        expect(wrapper.props('showAll')).toBe(false);
        await wrapper.setProps({ showAll: true });
        expect(wrapper.getComponent(ElInput).props('modelValue')).toBe('');
        await wrapper.get('input[aria-label="Search definitions"]').setValue('owner query');
        expect(wrapper.emitted('update:query')).toEqual([['owner query']]);
        expect(wrapper.props('query')).toBe('');
        await button(labels.manage).trigger('click');
        expect(wrapper.emitted('manage')).toEqual([[]]);
        await wrapper.setProps({ definitionIds: ['owner-defined-a', 'owner-defined-b', 'owner-defined-c'] });
        expect(wrapper.findAll('[data-owner-definition]').map((field) => field.text()))
            .toEqual(['owner-defined-a', 'owner-defined-b', 'owner-defined-c']);
        await wrapper.setProps({ definitionIds: ['owner-defined-c', 'owner-defined-a'] });
        expect(wrapper.findAll('[data-owner-definition]').map((field) => field.text()))
            .toEqual(['owner-defined-c', 'owner-defined-a']);
        expect(wrapper.props('contextKey')).toBe(props.contextKey);
        expect(wrapper.emitted('page')).toBeUndefined();
    });

    it('preserves requested-page focus and permission/currentness gating with the real controls', async () =>
    {
        const wrapper = render();
        const next = wrapper.findAllComponents(ElButton).find((control) => control.text() === labels.next)!;
        await next.trigger('click');
        expect(wrapper.emitted('page')).toEqual([['next']]);
        await wrapper.setProps({ pageKey: 'page-2' });
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('[role="status"]').element);
        await wrapper.setProps({ showAll: true, stale: true });
        expect(wrapper.findAll('[data-owner-definition]')).toHaveLength(0);
        expect(wrapper.get('[role="status"]').text()).toBe(labels.stale);
        expect(wrapper.findAllComponents(ElButton).every((control) => control.props('disabled'))).toBe(true);
        expect(wrapper.getComponent(ElInput).props('disabled')).toBe(true);
        await next.trigger('click');
        expect(wrapper.emitted('page')).toEqual([['next']]);
        await wrapper.setProps({ stale: false, canManage: false });
        expect(wrapper.findAllComponents(ElButton).some((control) => control.text() === labels.manage)).toBe(false);
        await wrapper.setProps({ available: false });
        expect(wrapper.findComponent(ElButton).exists()).toBe(false);
        expect(wrapper.findComponent(ElInput).exists()).toBe(false);
        expect(wrapper.get('[role="status"]').text()).toBe(labels.unavailable);
    });
});
