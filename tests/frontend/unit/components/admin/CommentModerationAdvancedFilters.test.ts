// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import { describe, expect, it } from 'vitest';

import CommentModerationAdvancedFilters from '@/components/admin/comment-moderation/CommentModerationAdvancedFilters.vue';
import { CommentModerationStatus } from '@/api/authoring';
import type { CommentModerationFilters } from '@/composables/useCommentModerationQueue';

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
        stubs: {
            ElDrawer: DrawerStub,
            ElInput: true,
            ElSelect: true,
            ElOption: true,
            ElDatePicker: true,
            ElButton: {
                template: '<button type="button" @click="$emit(\'click\')"><slot /></button>'
            }
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
});
