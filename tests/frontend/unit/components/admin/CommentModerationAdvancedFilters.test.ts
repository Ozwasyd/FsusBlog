// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';

import CommentModerationAdvancedFilters from '@/components/admin/comment-moderation/CommentModerationAdvancedFilters.vue';
import { CommentModerationStatus } from '@/api/authoring';
import type { CommentModerationFilters } from '@/composables/useCommentModerationQueue';
import { FsusUiButton } from '@/fsusui/button';

const DrawerStub = defineComponent({
    props: {
        modelValue: Boolean
    },
    emits: ['update:modelValue', 'opened', 'closed'],
    template: '<div v-if="modelValue" data-drawer><slot /><slot name="footer" /></div>'
});
const filters: CommentModerationFilters = {
    status: CommentModerationStatus.Pending,
    keyword: '',
    article: '42',
    user: '',
    hitReason: 'spam-repeat',
    blockedRegion: '',
    modelLabel: '',
    modelProvider: '',
    dateRange: null
};
const mountFilters = () => mount(CommentModerationAdvancedFilters, {
    attachTo: document.body,
    props: {
        filters,
        loading: false,
        hitReasonOptions: [{ value: 'spam-repeat', label: '重复刷屏' }],
        blockedRegionOptions: [],
        modelLabelOptions: [],
        modelRuntimeOptions: [],
        activeFilters: [
            { key: 'status', label: '状态：待审' },
            { key: 'article', label: '文章：42' },
            { key: 'hitReason', label: '命中：重复刷屏' }
        ]
    },
    global: {
        components: {
            ElButton: FsusUiButton
        },
        stubs: {
            ElDrawer: DrawerStub,
            ElInput: true,
            ElSelect: true,
            ElOption: true,
            ElDatePicker: true
        }
    }
});

describe('CommentModerationAdvancedFilters', () => {
    it('shows one active-count badge and restores focus after closing', async () => {
        const wrapper = mountFilters();
        const trigger = wrapper.get('.comment-advanced-trigger');
        expect(trigger.get('.comment-advanced-trigger__count').text()).toBe('2');

        await trigger.trigger('click');
        const drawer = wrapper.getComponent(DrawerStub);
        drawer.vm.$emit('opened');
        await nextTick();
        expect(document.activeElement).toBe(wrapper.get('#comment-advanced-filter-panel').element);

        drawer.vm.$emit('update:modelValue', false);
        await nextTick();
        drawer.vm.$emit('closed');
        expect(document.activeElement).toBe(trigger.element);
        wrapper.unmount();
    });

    it('removes individual filters and provides apply and clear actions', async () => {
        const wrapper = mountFilters();
        await wrapper.get('.comment-advanced-trigger').trigger('click');
        await wrapper.get('.comment-advanced-panel__active-item').trigger('click');
        expect(wrapper.emitted('remove-filter')?.[0]).toEqual(['article']);

        const buttons = wrapper.findAll('.comment-advanced-panel__footer button');
        await buttons[0]?.trigger('click');
        await buttons[1]?.trigger('click');
        expect(wrapper.emitted('clear')?.length).toBeGreaterThan(0);
        expect(wrapper.emitted('apply')?.length).toBeGreaterThan(0);
        wrapper.unmount();
    });

    it('keeps clear open and emits apply before closing the drawer', async () => {
        const wrapper = mountFilters();
        const applyOpenStates: boolean[] = [];
        await wrapper.setProps({
            onApply: () => applyOpenStates.push(wrapper.getComponent(DrawerStub).props('modelValue') === true)
        });
        await wrapper.get('.comment-advanced-trigger').trigger('click');

        const buttons = wrapper.findAll('.comment-advanced-panel__footer button');
        await buttons[0]?.trigger('click');
        expect(wrapper.getComponent(DrawerStub).props('modelValue')).toBe(true);
        await buttons[1]?.trigger('click');
        expect(applyOpenStates).toEqual([true]);
        expect(wrapper.getComponent(DrawerStub).props('modelValue')).toBe(false);
        wrapper.unmount();
    });

    it('retains valid date ranges and clears incomplete ranges', async () => {
        const wrapper = mountFilters();
        await wrapper.get('.comment-advanced-trigger').trigger('click');
        const picker = wrapper.getComponent({ name: 'ElDatePicker' });
        picker.vm.$emit('update:modelValue', ['2026-07-01', '2026-07-23']);
        picker.vm.$emit('update:modelValue', ['2026-07-01']);
        expect(wrapper.emitted('update:dateRange')).toEqual([
            [['2026-07-01', '2026-07-23']],
            [null]
        ]);
        wrapper.unmount();
    });

    it('delegates loading disablement to the native public button', async () => {
        const wrapper = mountFilters();
        await wrapper.setProps({ loading: true, activeFilters: [{ key: 'status', label: '待审' }] });
        const trigger = wrapper.get<HTMLButtonElement>('.comment-advanced-trigger');
        expect(trigger.element.disabled).toBe(true);
        expect(trigger.find('.comment-advanced-trigger__count').exists()).toBe(false);
        await trigger.trigger('click');
        expect(wrapper.getComponent(DrawerStub).props('modelValue')).toBe(false);
        wrapper.unmount();
    });
});
