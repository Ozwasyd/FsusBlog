// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import PublicArchivePageContent from '@/components/public/pages/PublicArchivePageContent.vue';
import PublicFilterPageContent from '@/components/public/pages/PublicFilterPageContent.vue';
import {
    createLocaleTextContext,
    ENABLED_LOCALES,
    LOCALE_TEXT_CONTEXT_KEY,
    prepareLocaleDomains,
    resetLocaleRuntimeForTests
} from '@/locales';

describe('public page request-scoped copy', () =>
{
    afterEach(() => resetLocaleRuntimeForTests());

    for (const { code } of ENABLED_LOCALES)
    {
        it(`renders filter controls and loading/error states from ${code}`, async () =>
        {
            const scoped = createLocaleTextContext(await prepareLocaleDomains(code, ['public']));
            const wrapper = mount(PublicFilterPageContent, {
                props: {
                    view: {
                        filterType: 'search',
                        header: { labelText: 'Header', currentName: 'Query', description: null, loadingMeta: false },
                        loading: { loadingArticles: true, isPowCalculating: false, skeletonCount: 3, indicatorText: 'Loading' },
                        empty: { hasError: false, isInvalidTarget: false, title: 'Empty', description: '', actionText: 'Home', actionRoute: { name: 'Home' } },
                        articles: [],
                        pagination: { currentPage: 1, totalPages: 2, pageIndicatorText: '1 / 2', canGoPrev: false, canGoNext: true }
                    },
                    invalidTarget: false,
                    isLoadingState: true,
                    showSearchSort: true
                },
                global: {
                    provide: { [LOCALE_TEXT_CONTEXT_KEY as symbol]: scoped },
                    stubs: {
                        FilterHeader: true,
                        FilterArticleLoadingState: true,
                        PublicContentState: true,
                        PublicArticleList: true,
                        ElRadioGroup: { template: '<div><slot /></div>' },
                        ElRadioButton: true,
                        ElIcon: true
                    }
                }
            });
            try
            {
                expect(wrapper.text()).toContain(scoped.translate('public.filter.scope'));
                expect(wrapper.text()).toContain(scoped.translate('public.filter.sort'));
                expect(wrapper.text()).toContain(scoped.translate('public.filter.result', {
                    state: scoped.translate('public.filter.searching')
                }));
                expect(wrapper.find('[aria-label]').attributes('aria-label')).toBe(scoped.translate('public.filter.sortAria'));
                expect(wrapper.find('aside a').text()).toBe(scoped.translate('public.filter.backHome'));
                await wrapper.setProps({ isLoadingState: false, invalidTarget: true });
                expect(wrapper.text()).toContain(scoped.translate('public.filter.result', {
                    state: scoped.translate('public.filter.unavailable')
                }));
                await wrapper.setProps({
                    invalidTarget: false,
                    view: {
                        ...wrapper.props('view'),
                        articles: [{
                            card: { kind: 'article-list-card', index: 0 },
                            id: 1,
                            href: '/article/1',
                            title: 'Authored title',
                            summary: 'Authored summary',
                            meta: { isoTime: '2026-10-08', displayTime: '2026-10-08', fullTime: '2026-10-08', categoryName: 'Category' },
                            tags: []
                        }]
                    }
                });
                const pagination = wrapper.findComponent({ name: 'PublicArticleList' }).props('pagination');
                expect(pagination.previous.label).toBe(scoped.translate('public.filter.previous'));
                expect(pagination.next.label).toBe(scoped.translate('public.filter.next'));
            }
            finally
            {
                wrapper.unmount();
            }
        });

        it(`renders archive title, navigation and empty description from ${code}`, async () =>
        {
            const scoped = createLocaleTextContext(await prepareLocaleDomains(code, ['public']));
            const wrapper = mount(PublicArchivePageContent, {
                props: {
                    view: {
                        total: 0,
                        yearGroups: [{ year: '2026', months: [] }, { year: '2025', months: [] }],
                        emptyState: { title: 'Empty' }
                    }
                },
                global: {
                    provide: { [LOCALE_TEXT_CONTEXT_KEY as symbol]: scoped },
                    stubs: {
                        PublicReadingPageFrame: { template: '<section><slot /></section>' },
                        PublicContentState: true,
                        ElSkeleton: true,
                        ElSkeletonItem: true
                    }
                }
            });
            try
            {
                expect(wrapper.find('h1').text()).toBe(scoped.translate('public.archive.title'));
                expect(wrapper.find('nav').attributes('aria-label')).toBe(scoped.translate('public.archive.yearNavigation'));
                await wrapper.setProps({ view: { total: 0, yearGroups: [], emptyState: { title: 'Empty' } } });
                expect(wrapper.findComponent({ name: 'PublicContentState' }).attributes('description'))
                    .toBe(scoped.translate('public.archive.emptyDescription'));
            }
            finally
            {
                wrapper.unmount();
            }
        });
    }
});
