// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ArticleLibraryRail from '@/components/admin/article/ArticleLibraryRail.vue';
import { ArticlePublishStatus } from '@/contracts/binaryApi';

import type { ArticleLibraryPresentation } from '@/components/admin/article/articleLibraryPresentation';

const mounted: Array<{ unmount(): void; }> = [];
const actions = ['previous', 'next', 'reveal-current'] as const;
const nonReadyStates = ['loading', 'error', 'unavailable', 'unconnected'] as const;

// A bounded display fixture only: no query response, cache, permission or API is mocked/admitted.
function displayPage(): Extract<ArticleLibraryPresentation, { state: 'ready'; }>
{
    return {
        state: 'ready',
        group: 'recent',
        entries: [{ id: 71, title: 'Current page article', status: ArticlePublishStatus.Draft }],
        hasPrevious: true,
        hasNext: true
    };
}

beforeEach(() =>
{
    const originalMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    {
        const media = originalMatchMedia(query);
        Object.defineProperty(media, 'matches', { value: false });
        return media;
    });
});

afterEach(() =>
{
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

async function openRail(withDisplayPage = true)
{
    const wrapper = mount(ArticleLibraryRail, {
        props: {
            presentation: withDisplayPage ? displayPage() : undefined,
            currentArticleId: withDisplayPage ? 72 : null
        },
        attachTo: document.body
    });
    mounted.push(wrapper);
    await wrapper.get('button[aria-label="文章库"]').trigger('click');
    await nextTick();
    return wrapper;
}

describe('ArticleLibraryRail focus regressions (#1853)', () =>
{
    it('closes from the desktop collapse button on Escape and restores the trigger', async () =>
    {
        const wrapper = await openRail(false);
        expect(document.activeElement).toBe(wrapper.get('[data-library-group="recent"]').element);
        const collapse = wrapper.get<HTMLButtonElement>('aside[aria-label="文章库"] > button');
        collapse.element.focus();
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        collapse.element.dispatchEvent(event);
        await nextTick();
        await nextTick();

        expect(event.defaultPrevented).toBe(true);
        expect(wrapper.find('aside[aria-label="文章库"]').exists()).toBe(false);
        const trigger = wrapper.get<HTMLButtonElement>('button[aria-label="文章库"]');
        expect(trigger.attributes('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger.element);
    });

    describe.each(actions)('%s action', (action) =>
    {
        it.each(nonReadyStates)('hands focus to the active group when input becomes %s', async (state) =>
        {
            const wrapper = await openRail();
            const control = wrapper.get<HTMLButtonElement>(`[data-library-action="${action}"]`);
            control.element.focus();
            await control.trigger('click');
            await wrapper.setProps({ presentation: { state, group: 'recent' } });
            await nextTick();

            expect(wrapper.find(`[data-library-action="${action}"]`).exists()).toBe(false);
            expect(wrapper.findAll('[data-article-id]')).toHaveLength(0);
            const fallback = wrapper.get<HTMLButtonElement>('[data-library-group="recent"]');
            expect(document.activeElement).toBe(fallback.element);
            expect(document.activeElement?.isConnected).toBe(true);
            expect(wrapper.get('[role="status"]').text()).not.toBe('');

            await wrapper.setProps({ presentation: displayPage() });
            await nextTick();
            const restored = wrapper.get<HTMLButtonElement>(`[data-library-action="${action}"]`);
            expect(document.activeElement).toBe(restored.element);
        });

        it('hands focus to a surviving row when the ready input removes or disables the action', async () =>
        {
            const wrapper = await openRail();
            wrapper.get<HTMLButtonElement>(`[data-library-action="${action}"]`).element.focus();
            await wrapper.setProps({ presentation: { state: 'loading', group: 'recent' } });
            await nextTick();
            await wrapper.setProps({
                presentation: { ...displayPage(), hasPrevious: false, hasNext: false },
                currentArticleId: 71
            });
            await nextTick();

            const row = wrapper.get<HTMLButtonElement>('[data-article-id="71"]');
            expect(document.activeElement).toBe(row.element);
            expect(row.attributes('aria-current')).toBe('page');
        });

        it('keeps a new user focus choice when the ready page returns', async () =>
        {
            const wrapper = await openRail();
            wrapper.get<HTMLButtonElement>(`[data-library-action="${action}"]`).element.focus();
            await wrapper.setProps({ presentation: { state: 'loading', group: 'recent' } });
            await nextTick();
            const chosen = wrapper.get<HTMLButtonElement>('[data-library-group="draft"]');
            chosen.element.focus();
            await wrapper.setProps({ presentation: displayPage() });
            await nextTick();

            expect(document.activeElement).toBe(chosen.element);
        });

        it('does not restore an old action after the host changes group and loading input together', async () =>
        {
            const wrapper = await openRail();
            wrapper.get<HTMLButtonElement>(`[data-library-action="${action}"]`).element.focus();
            await wrapper.setProps({
                activeGroup: 'draft',
                presentation: { state: 'loading', group: 'draft' }
            });
            await nextTick();
            const fallback = wrapper.get<HTMLButtonElement>('[data-library-group="draft"]');
            expect(document.activeElement).toBe(fallback.element);

            await wrapper.setProps({ presentation: { ...displayPage(), group: 'draft' } });
            await nextTick();
            expect(document.activeElement).toBe(fallback.element);
            expect(document.activeElement).not.toBe(wrapper.get(`[data-library-action="${action}"]`).element);
        });

        it('clears an existing pending action when the host changes group', async () =>
        {
            const wrapper = await openRail();
            wrapper.get<HTMLButtonElement>(`[data-library-action="${action}"]`).element.focus();
            await wrapper.setProps({ presentation: { state: 'loading', group: 'recent' } });
            await nextTick();
            const anchor = wrapper.get<HTMLButtonElement>('[data-library-group="recent"]');
            expect(document.activeElement).toBe(anchor.element);

            await wrapper.setProps({
                activeGroup: 'draft',
                presentation: { state: 'loading', group: 'draft' }
            });
            await nextTick();
            await wrapper.setProps({ presentation: { ...displayPage(), group: 'draft' } });
            await nextTick();
            expect(document.activeElement).toBe(anchor.element);

            await wrapper.setProps({ activeGroup: 'recent', presentation: displayPage() });
            await nextTick();
            expect(document.activeElement).toBe(anchor.element);
            expect(document.activeElement).not.toBe(wrapper.get(`[data-library-action="${action}"]`).element);
        });
    });

    it('does not move external editor focus when the page becomes unavailable', async () =>
    {
        const wrapper = await openRail();
        const external = document.createElement('button');
        document.body.append(external);
        external.focus();
        await wrapper.setProps({ presentation: { state: 'unavailable', group: 'recent' } });
        await nextTick();

        expect(document.activeElement).toBe(external);
        expect(wrapper.findAll('[data-article-id]')).toHaveLength(0);
    });

    it('does not restore a pending action after the Rail has closed', async () =>
    {
        const wrapper = await openRail();
        wrapper.get<HTMLButtonElement>('[data-library-action="next"]').element.focus();
        await wrapper.setProps({ presentation: { state: 'loading', group: 'recent' } });
        await nextTick();
        await wrapper.get('[data-library-group="recent"]').trigger('keydown', { key: 'Escape' });
        await nextTick();
        const external = document.createElement('button');
        document.body.append(external);
        external.focus();
        await wrapper.setProps({ presentation: displayPage() });
        await nextTick();

        expect(wrapper.find('aside[aria-label="文章库"]').exists()).toBe(false);
        expect(document.activeElement).toBe(external);
    });
});
