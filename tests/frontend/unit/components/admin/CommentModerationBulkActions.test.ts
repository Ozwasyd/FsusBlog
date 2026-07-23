// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { describe, expect, it } from 'vitest';

import { CommentModerationStatus } from '@/api/authoring';
import CommentModerationBulkActions from '@/components/admin/comment-moderation/CommentModerationBulkActions.vue';

const DialogStub = defineComponent({
    props: { modelValue: Boolean },
    emits: ['update:modelValue'],
    template: '<div v-if="modelValue" data-preview><slot /><slot name="footer" /></div>'
});
const ButtonStub = defineComponent({
    emits: ['click'],
    template: '<button type="button" @click="$emit(\'click\')"><slot /></button>'
});
const mountActions = () => mount(CommentModerationBulkActions, {
    props: {
        selectedCount: 10,
        reason: '',
        banUsers: false,
        loading: false
    },
    global: {
        stubs: {
            FsusDialog: DialogStub,
            ElButton: ButtonStub,
            ElInput: true,
            ElCheckbox: true,
            ElIcon: true
        }
    }
});

describe('CommentModerationBulkActions', () => {
    it('keeps reason fields out of the sticky bar until an action is chosen', async () => {
        const wrapper = mountActions();
        expect(wrapper.find('[data-preview]').exists()).toBe(false);
        expect(wrapper.find('.comment-moderation-bulk-actions__preview-fields').exists()).toBe(false);
        expect(wrapper.get('.comment-moderation-bulk-actions__count').text()).toBe('已选择 10 条');

        await wrapper.findAll('.comment-moderation-bulk-actions__commands button')[0]?.trigger('click');
        expect(wrapper.find('[data-preview]').exists()).toBe(true);
        expect(wrapper.find('.comment-moderation-bulk-actions__preview-fields').exists()).toBe(true);
    });

    it('emits the selected moderation status only after preview confirmation', async () => {
        const wrapper = mountActions();
        await wrapper.findAll('.comment-moderation-bulk-actions__commands button')[0]?.trigger('click');
        expect(wrapper.emitted('apply')).toBeUndefined();
        await wrapper.findAll('[data-preview] button').at(-1)?.trigger('click');
        expect(wrapper.emitted('apply')?.at(-1)).toEqual([CommentModerationStatus.Approved]);
    });
});
