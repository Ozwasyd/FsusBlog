// @vitest-environment happy-dom

import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ElIcon, ElInput } from '@ozwasyd/element-plus';

import { CommentModerationStatus } from '@/api/authoring';
import CommentModerationToolbar from '@/components/admin/comment-moderation/CommentModerationToolbar.vue';
import { commentModerationStatusOptions, type CommentModerationFilters } from '@/composables/useCommentModerationQueue';
import { FsusUiSegmentedControl } from '@/fsusui/segmentedControl';

const wrappers: VueWrapper[] = [];
const createFilters = (status: CommentModerationStatus = CommentModerationStatus.Pending): CommentModerationFilters => ({
    status,
    keyword: 'review me',
    article: '',
    user: '',
    hitReason: '',
    blockedRegion: '',
    modelLabel: '',
    modelProvider: '',
    dateRange: null
});
const mountToolbar = (status: CommentModerationStatus = CommentModerationStatus.Pending) =>
{
    const wrapper = mount(CommentModerationToolbar, {
        attachTo: document.body,
        props: { filters: createFilters(status), loading: false },
        global: { components: { ElInput, ElIcon } }
    });
    wrappers.push(wrapper);
    return wrapper;
};

afterEach(() =>
{
    for (const wrapper of wrappers.splice(0))
    {
        wrapper.unmount();
    }
});

describe('CommentModerationToolbar with genuine FsusUI controls', () =>
{
    it.each(commentModerationStatusOptions)('emits numeric status $value through the real option', async ({ value }: { value: CommentModerationStatus }) =>
    {
        const initial = value === CommentModerationStatus.Pending
            ? CommentModerationStatus.Approved
            : CommentModerationStatus.Pending;
        const wrapper = mountToolbar(initial);
        const radios = wrapper.findAll('[role="radio"]');
        expect(radios.map((radio) => radio.text())).toEqual(commentModerationStatusOptions.map((option) => option.label));
        await radios[value]!.trigger('click');
        expect(wrapper.emitted('update:status')).toEqual([[value]]);
        await wrapper.setProps({ filters: createFilters(value) });
        expect(radios[value]!.attributes('aria-checked')).toBe('true');
    });

    it('rejects foreign public values and suppresses the already selected status', async () =>
    {
        const wrapper = mountToolbar();
        const control = wrapper.getComponent(FsusUiSegmentedControl);
        for (const value of [-1, 4, '0', '1', '', true, false, Number.NaN, CommentModerationStatus.Pending])
        {
            control.vm.$emit('update:modelValue', value);
        }
        await wrapper.get('[role="radio"]').trigger('click');
        expect(wrapper.emitted('update:status')).toBeUndefined();
    });

    it('updates genuine option and search disabled state when loading changes', async () =>
    {
        const wrapper = mountToolbar();
        const radios = wrapper.findAll<HTMLButtonElement>('[role="radio"]');
        expect(radios.every((radio) => !radio.element.disabled)).toBe(true);
        await wrapper.setProps({ loading: true });
        expect(radios.every((radio) => radio.element.disabled)).toBe(true);
        expect(radios.every((radio) => radio.attributes('tabindex') === '-1')).toBe(true);
        expect(wrapper.get<HTMLInputElement>('input').element.disabled).toBe(true);
        await radios[1]!.trigger('click');
        expect(wrapper.emitted('update:status')).toBeUndefined();
        await wrapper.setProps({ loading: false });
        expect(radios.every((radio) => !radio.element.disabled)).toBe(true);
        expect(wrapper.get<HTMLInputElement>('input').element.disabled).toBe(false);
        await radios[1]!.trigger('click');
        expect(wrapper.emitted('update:status')).toEqual([[CommentModerationStatus.Approved]]);
    });

    it('delegates named radio semantics, one tabstop and Arrow/Home/End to the public primitive', async () =>
    {
        const wrapper = mountToolbar();
        expect(wrapper.get('[role="search"]').attributes('aria-label')).toBe('评论审核筛选');
        expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('评论审核状态筛选');
        expect(wrapper.findAll('[role="radio"][tabindex="0"]')).toHaveLength(1);
        const radios = wrapper.findAll<HTMLButtonElement>('[role="radio"]');
        radios[0]!.element.focus();
        await radios[0]!.trigger('keydown', { key: 'ArrowRight' });
        expect(wrapper.emitted('update:status')?.at(-1)).toEqual([CommentModerationStatus.Approved]);
        expect(document.activeElement).toBe(radios[1]!.element);
        await wrapper.setProps({ filters: createFilters(CommentModerationStatus.Approved) });
        await radios[1]!.trigger('keydown', { key: 'End' });
        expect(wrapper.emitted('update:status')?.at(-1)).toEqual([CommentModerationStatus.Hidden]);
        expect(document.activeElement).toBe(radios[3]!.element);
        await wrapper.setProps({ filters: createFilters(CommentModerationStatus.Hidden) });
        await radios[3]!.trigger('keydown', { key: 'Home' });
        expect(wrapper.emitted('update:status')?.at(-1)).toEqual([CommentModerationStatus.Pending]);
        expect(document.activeElement).toBe(radios[0]!.element);
    });

    it('preserves keyword payload, Enter and genuine input clear search events', async () =>
    {
        const wrapper = mountToolbar();
        const input = wrapper.get('input');
        expect(input.attributes('name')).toBe('commentModerationKeyword');
        expect(input.attributes('aria-label')).toBe('搜索评论内容');
        await input.setValue('new search');
        expect(wrapper.emitted('update:keyword')?.at(-1)).toEqual(['new search']);
        await input.trigger('keyup', { key: 'Enter' });
        expect(wrapper.emitted('search')).toHaveLength(1);
        await wrapper.get('.el-input').trigger('mouseenter');
        await wrapper.get('.el-input__clear').trigger('click');
        expect(wrapper.emitted('update:keyword')?.at(-1)).toEqual(['']);
        expect(wrapper.emitted('search')).toHaveLength(2);
    });
});
