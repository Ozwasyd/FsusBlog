import { mount, flushPromises } from '@vue/test-utils';
import { ElMarkdownEditor, type MarkdownEditorInstance } from '@ozwasyd/element-plus';
import { describe, expect, it, vi } from 'vitest';

import { createArticleWorkspaceNativeDocumentAuthorityConsumer } from '@/services/authoring/articleWorkspaceNativeDocumentAuthority';

describe('Main original public native document authority consumer', () =>
{
    async function mounted()
    {
        const wrapper = mount(ElMarkdownEditor, { props: {
            modelValue: 'source', mode: 'source', documentIdentity: { id: 'native-consumer', epoch: 1 }
        } });
        await flushPromises();
        const editor = wrapper.vm as MarkdownEditorInstance;
        const session = editor.getSession('session:native-consumer');
        const state = session.inspectDocumentState();
        return { wrapper, editor, session, expected: {
            documentKey: state.documentIdentity.id, documentEpoch: state.documentIdentity.epoch, revision: state.revision
        } };
    }

    it('borrows the real public ticket and cancels its original subscription without another realm', async () =>
    {
        const { wrapper, editor, session, expected } = await mounted();
        const consumer = createArticleWorkspaceNativeDocumentAuthorityConsumer();
        const revoke = vi.fn();
        try
        {
            const ticket = session.documentAuthority!.capture();
            const reservation = consumer.reserve(editor, session, expected, revoke, () => {});
            expect(reservation?.ticket).toBe(ticket);
            expect(reservation?.nativeEditor).toBe(editor);
            expect(reservation?.hasCustody()).toBe(true);
            expect(reservation?.hasCleanupCustody()).toBe(true);
            expect(reservation?.cancel()).toBe(true);
            expect(revoke).toHaveBeenCalledTimes(1);
            expect(reservation?.hasCustody()).toBe(false);
            expect(reservation?.hasCleanupCustody()).toBe(false);
            expect(consumer.inspectCleanupCustody()).toHaveLength(0);
        }
        finally
        {
            consumer.retire();
            wrapper.unmount();
        }
    });

    it('retains the actual failed handle and raw cause until genuine retirement retry succeeds', async () =>
    {
        const { wrapper, editor, session, expected } = await mounted();
        const consumer = createArticleWorkspaceNativeDocumentAuthorityConsumer();
        const cause = { tag: 'original-native-receiver-cause' };
        let fail = true;
        const reservation = consumer.reserve(editor, session, expected, () => { if (fail) { throw cause; } }, () => {});
        try
        {
            let caught: unknown;
            try { reservation?.cancel(); } catch (error) { caught = error; }
            expect(caught).toBe(cause);
            expect(reservation?.failureCause()).toBe(cause);
            expect(reservation?.hasCustody()).toBe(false);
            expect(reservation?.hasCleanupCustody()).toBe(true);
            expect(consumer.inspectCleanupCustody()[0]?.handle?.hasCustody()).toBe(true);
            fail = false;
            consumer.retire();
            expect(reservation?.hasCleanupCustody()).toBe(false);
            expect(session.documentAuthority!.capture()).toBeNull();
        }
        finally
        {
            fail = false;
            consumer.retire();
            wrapper.unmount();
        }
    });

    it('keeps the original creation error and real cleanup obligation when both paths fail', async () =>
    {
        const { wrapper, editor, session, expected } = await mounted();
        const consumer = createArticleWorkspaceNativeDocumentAuthorityConsumer();
        const creationCause = { tag: 'capture-boundary-failure' };
        const cleanupCause = { tag: 'real-unsubscribe-receiver-failure' };
        let fail = true;
        // Fault only the capture boundary; subscription/custody remain the real public producer.
        const faultySession = { ...session, documentAuthority: {
            ...session.documentAuthority!, capture: () => { throw creationCause; }
        } };
        try
        {
            let caught: unknown;
            try
            {
                consumer.reserve(editor, faultySession, expected, () => { if (fail) { throw cleanupCause; } }, () => {});
            }
            catch (cause)
            {
                caught = cause;
            }
            expect(caught).toBe(creationCause);
            const pending = consumer.inspectCleanupCustody()[0];
            expect(pending.creationCause).toBe(creationCause);
            expect(pending.cleanupCause).toBe(cleanupCause);
            expect(pending.handle?.hasCustody()).toBe(true);
            fail = false;
            consumer.retire();
            expect(pending.handle?.hasCustody()).toBe(false);
            expect(consumer.inspectCleanupCustody()).toHaveLength(0);
        }
        finally
        {
            fail = false;
            consumer.retire();
            wrapper.unmount();
        }
    });
});
