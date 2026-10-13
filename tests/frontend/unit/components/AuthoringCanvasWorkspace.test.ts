// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AuthoringCanvasWorkspace from '@/components/admin/canvas/AuthoringCanvasWorkspace.vue';
import { authoringCanvasStorage, createCanvasTestSession, settleCanvasTestOperations } from '../../fixtures/authoringCanvasTransportFixture';
import { createMemoryHistory, createRouter } from 'vue-router';
import { translate } from '@/locales';
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/canvas/:id?', name: 'ManageAuthoringCanvasDocument', component: { template: '<div />' } }] });

describe('AuthoringCanvasWorkspace Component (#2489)', () => {
    beforeEach(() => {
        authoringCanvasStorage.clear();
    });

    it('renders the workspace with toolbar, viewport, and actions', async () => {
        const wrapper = mount(AuthoringCanvasWorkspace, {
            props: {
                session: createCanvasTestSession(),
                newCanvasTitle: 'Test Canvas'
            },
            global: { plugins: [router] }
        });

        await flushPromises();

        expect(wrapper.find('.canvas-toolbar').exists()).toBe(true);
        expect(wrapper.find('.canvas-viewport').exists()).toBe(true);

        // Add a note
        const addNoteBtn = wrapper.find(`button[title="${translate('admin.canvas.note')}"]`);
        expect(addNoteBtn.exists()).toBe(true);
        await addNoteBtn.trigger('click');
        await settleCanvasTestOperations();
        await flushPromises();

        // Check that a note node card appears
        expect(wrapper.findAll('.node-plain-text-note').length).toBe(1);
    });

    it('toggles between interactive canvas view and structured outline view', async () => {
        const wrapper = mount(AuthoringCanvasWorkspace, {
            props: {
                session: createCanvasTestSession(),
                newCanvasTitle: 'Test Canvas'
            },
            global: { plugins: [router] }
        });

        await flushPromises();

        const toggleBtn = wrapper.find('.mode-toggle');
        expect(toggleBtn.exists()).toBe(true);

        // Click to switch to outline
        await toggleBtn.trigger('click');
        await flushPromises();
        expect(wrapper.find('.outline-container').exists()).toBe(true);
    });
});
