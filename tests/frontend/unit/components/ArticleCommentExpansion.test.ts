// @vitest-environment happy-dom

import { ElMarkdownRenderer } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ArticleCommentsVirtualList from '@/components/article/ArticleCommentsVirtualList.vue';
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream';
import { FsusUiButton } from '@/fsusui/button';
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter';

const makeThreads = (count: number): CommentTreeViewNode[] => Array.from({ length: count }, (_, index) =>
{
    const id = String(index + 1);
    return {
        id,
        content: `Comment ${id}`,
        createTime: '2026-06-01T03:00:00.000Z',
        author: { mode: 'public', displayName: 'Reader', displayLanguage: 'en', badge: null, scopeLabel: null },
        replyToAuthor: null,
        parentId: null,
        rootId: id,
        replyToCommentId: null,
        depth: 0,
        isDeleted: false,
        isEdited: false,
        childCount: 0,
        hasMoreChildren: false,
        children: [],
        childrenExpanded: false
    };
});

const mountList = (count: number, initialRenderLimit?: number) => mount(ArticleCommentsVirtualList, {
    global: { components: { ElMarkdownRenderer } },
    props: {
        threads: makeThreads(count),
        isAdmin: false,
        isLoggedIn: false,
        ownedCommentIds: new Set<string>(),
        loadingReplies: {},
        ...(initialRenderLimit === undefined ? {} : { initialRenderLimit })
    }
});

describe('article root comment expansion', () =>
{
    it('uses the real public link button with an explicit non-submit type', async () =>
    {
        const limit = COMMENT_CONTENT_CONSTRAINT.rootRenderLimit;
        const wrapper = mountList(limit + 1);
        try
        {
            const action = wrapper.get('.fsus-comments-list__more').getComponent(FsusUiButton);
            expect(action.props('link')).toBe(true);
            expect(action.get('button').attributes('type')).toBe('button');
            expect(action.text()).toBe('显示更多评论（1）');
            expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(limit);

            await action.get('button').trigger('click');

            expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(limit + 1);
            expect(wrapper.find('.fsus-comments-list__more').exists()).toBe(false);
            expect(wrapper.emitted('reply')).toBeUndefined();
            expect(wrapper.emitted('loadMoreReplies')).toBeUndefined();
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it('respects the caller initial limit and expands in bounded batches in source order', async () =>
    {
        const limit = COMMENT_CONTENT_CONSTRAINT.rootRenderLimit;
        const count = limit * 2 + 3;
        const wrapper = mountList(count, 1);
        try
        {
            expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(1);
            expect(wrapper.get('.fsus-comments-list__more').text()).toBe(`显示更多评论（${count - 1}）`);

            await wrapper.get('.fsus-comments-list__more button').trigger('click');

            expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(limit + 1);
            expect(wrapper.get('.fsus-comments-list__more').text()).toBe(`显示更多评论（${limit + 2}）`);

            await wrapper.get('.fsus-comments-list__more button').trigger('click');

            expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(limit * 2 + 1);
            expect(wrapper.get('.fsus-comments-list__more').text()).toBe('显示更多评论（2）');

            await wrapper.get('.fsus-comments-list__more button').trigger('click');

            expect(wrapper.findAll('.fsus-comment-tree-node').map(node => node.attributes('id')))
                .toEqual(Array.from({ length: count }, (_, index) => `comment-${index + 1}`));
            expect(wrapper.find('.fsus-comments-list__more').exists()).toBe(false);
        }
        finally
        {
            wrapper.unmount();
        }
    });

    it.each([0, 1, COMMENT_CONTENT_CONSTRAINT.rootRenderLimit])('omits the control for %i fully visible roots', (count: number) =>
    {
        const wrapper = mountList(count);
        try
        {
            expect(wrapper.findAll('.fsus-comment-tree-node')).toHaveLength(count);
            expect(wrapper.find('.fsus-comments-list__more').exists()).toBe(false);
            expect(wrapper.attributes('aria-label')).toBe('评论树');
        }
        finally
        {
            wrapper.unmount();
        }
    });
});
