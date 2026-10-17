// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import ArticleCommentTreeNode from '@/components/article/ArticleCommentTreeNode.vue';
import type { CommentTreeViewNode } from '@/composables/useArticleCommentStream';
import { FsusUiButton } from '@/fsusui/button';
import { resetCommentManagementCapabilityVaultForTests } from '@/privacy/commentManagementCapabilityVault';

const makeNode = (overrides: Partial<CommentTreeViewNode> = {}): CommentTreeViewNode => ({
    id: '7',
    rootId: '7',
    parentId: null,
    replyToCommentId: null,
    depth: 0,
    content: '评论正文'.repeat(100),
    createTime: '2026-06-01T03:00:00.000Z',
    author: { mode: 'public', displayName: 'Reader', displayLanguage: 'zh-CN', badge: null, scopeLabel: null },
    replyToAuthor: null,
    isDeleted: false,
    isEdited: false,
    childCount: 2,
    hasMoreChildren: true,
    children: [],
    childrenExpanded: true,
    ...overrides
});

const mounted: ReturnType<typeof mount>[] = [];

function mountNode(node = makeNode(), owned = true, isAdmin = false)
{
    const wrapper = mount(ArticleCommentTreeNode, {
        attachTo: document.body,
        props: {
            node,
            depth: node.depth,
            isLoggedIn: true,
            isAdmin,
            ownedCommentIds: new Set(owned ? [node.id] : []),
            loadingReplies: {}
        },
        global: {
            stubs: {
                CommentMarkdownRenderer: {
                    props: ['content'],
                    template: '<div>{{ content }}</div>'
                }
            }
        }
    });
    mounted.push(wrapper);
    return wrapper;
}

afterEach(() =>
{
    for (const wrapper of mounted.splice(0))
    {
        wrapper.unmount();
    }
    resetCommentManagementCapabilityVaultForTests();
});

describe('comment tree public FsusUI controls', () =>
{
    it('uses six real public Buttons with native semantics and the product danger marker', () =>
    {
        const wrapper = mountNode();
        const buttons = wrapper.findAllComponents(FsusUiButton);
        expect(buttons).toHaveLength(6);
        for (const button of buttons)
        {
            expect(button.element.tagName).toBe('BUTTON');
            expect(button.attributes('type')).toBe('button');
            expect(button.props('link')).toBe(true);
            expect(button.props('inlineAction')).toBe(true);
        }
        const deletion = buttons[4];
        expect(deletion.classes()).toContain('is-danger');
        expect(deletion.props('type')).toBe('danger');
        expect(deletion.attributes('aria-label')).toBe('删除评论');
    });

    it('preserves reply, edit and delete payloads exactly once per real Button activation', async () =>
    {
        const node = makeNode({ rootId: '3', parentId: '4', depth: 2 });
        const wrapper = mountNode(node);
        const buttons = wrapper.findAllComponents(FsusUiButton);
        await buttons[0].trigger('click');
        await buttons[3].trigger('click');
        await buttons[4].trigger('click');
        expect(wrapper.emitted('reply')).toEqual([[{
            id: node.id, rootId: node.rootId, author: node.author, depth: node.depth
        }]]);
        expect(wrapper.emitted('edit')).toEqual([[{ id: node.id, content: node.content }]]);
        expect(wrapper.emitted('delete')).toEqual([[{
            id: node.id, rootId: node.rootId, parentId: node.parentId, content: node.content
        }]]);
        expect(buttons[4].attributes('aria-label')).toBe('删除回复');
    });

    it('keeps body folding, branch ARIA, native article focus and lazy-load ownership', async () =>
    {
        const wrapper = mountNode();
        const bodyFold = wrapper.findAllComponents(FsusUiButton)[1];
        const branch = wrapper.get('[aria-controls="comment-children-7"]');
        const article = wrapper.get('article');
        expect(bodyFold.text()).toBe('展开正文');
        await bodyFold.trigger('click');
        expect(bodyFold.text()).toBe('收起正文');
        await branch.trigger('click');
        expect(branch.attributes('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(article.element);
        expect(wrapper.find('[role="group"]').exists()).toBe(false);
        await branch.trigger('click');
        expect(branch.attributes('aria-expanded')).toBe('true');
        expect(wrapper.get('[role="group"]').attributes('id')).toBe('comment-children-7');
        expect(wrapper.emitted('loadMore')).toEqual([['7']]);
    });

    it('delegates loading disablement to the real Button without emitting load-more', async () =>
    {
        const wrapper = mountNode();
        await wrapper.setProps({ loadingReplies: { '7': true } });
        const loadMore = wrapper.get('.fsus-comment-tree-node__load-more');
        expect(loadMore.text()).toBe('加载中…');
        expect((loadMore.element as HTMLButtonElement).disabled).toBe(true);
        await loadMore.trigger('click');
        expect(wrapper.emitted('loadMore')).toBeUndefined();
        await wrapper.setProps({ loadingReplies: {} });
        await loadMore.trigger('click');
        expect(wrapper.emitted('loadMore')).toEqual([['7']]);
    });

    it('preserves ownership and admin permission predicates without adding an edit action', () =>
    {
        const unowned = mountNode(makeNode(), false);
        expect(unowned.find('.is-danger').exists()).toBe(false);
        expect(unowned.findAllComponents(FsusUiButton).some(button => button.text() === '编辑')).toBe(false);
        const admin = mountNode(makeNode({ isDeleted: true }), false, true);
        expect(admin.get('.is-danger').attributes('aria-label')).toBe('删除评论');
        expect(admin.findAllComponents(FsusUiButton).some(button => button.text() === '编辑')).toBe(false);
    });
});
