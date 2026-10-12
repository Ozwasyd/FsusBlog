import type {
    MarkdownEditorSession,
    MarkdownEditorSessionExpose,
    MarkdownEditorSessionDocumentAuthorityTicket,
    MarkdownEditorSessionDocumentAuthorityRetirementHandle
} from '@ozwasyd/element-plus';

/** Borrowed native ticket and subscription only; no application/host/resource admission. */
export interface ArticleWorkspaceNativeDocumentReservation {
    readonly nativeEditor: MarkdownEditorSessionExpose;
    readonly ticket: MarkdownEditorSessionDocumentAuthorityTicket;
    hasCustody(): boolean;
    /** False means no unlink acknowledgement; cleanup custody may still be held. */
    cancel(): boolean;
    hasCleanupCustody(): boolean;
    failureCause(): unknown;
}

interface NativeSubscription {
    handle: MarkdownEditorSessionDocumentAuthorityRetirementHandle | null;
    preparing: boolean;
    retired: boolean;
    notifying: boolean;
    canceling: boolean;
    revocationComplete: boolean;
    creationFailed: boolean;
    creationCause: unknown;
    cleanupFailed: boolean;
    cleanupCause: unknown;
}

/** Own only real Main subscription obligations, never native tickets or a second realm. */
export function createArticleWorkspaceNativeDocumentAuthorityConsumer()
{
    const subscriptions = new Set<NativeSubscription>();
    let disposed = false;
    let creating = false;
    let retiring = false;

    const cancel = (record: NativeSubscription): boolean =>
    {
        record.retired = true;
        // Original notification/unsubscribe owns this stack. Keep the actual handle
        // for a later explicit retry instead of unlinking or claiming success here.
        if (record.notifying || record.canceling || record.preparing)
        {
            return false;
        }
        if (!record.handle)
        {
            subscriptions.delete(record);
            return false;
        }
        record.canceling = true;
        try
        {
            const unlinked = record.handle.unsubscribe();
            if (!record.handle.hasCustody())
            {
                subscriptions.delete(record);
                record.cleanupFailed = false;
                record.cleanupCause = undefined;
            }
            return unlinked;
        }
        catch (cause)
        {
            record.cleanupFailed = true;
            record.cleanupCause = cause;
            throw cause;
        }
        finally
        {
            record.canceling = false;
        }
    };

    return Object.freeze({
        reserve(nativeEditor: MarkdownEditorSessionExpose, session: MarkdownEditorSession,
            expected: Readonly<{ documentKey: string; documentEpoch: number; revision: number; }>,
            revokeBeforeChange: () => void, assertOwner: () => void): ArticleWorkspaceNativeDocumentReservation | null
        {
            if (typeof revokeBeforeChange !== 'function' || typeof assertOwner !== 'function')
            {
                throw new TypeError('article-workspace-native-reservation-callback-invalid');
            }
            if (disposed || creating || retiring)
            {
                throw new Error('article-workspace-native-reservation-unavailable');
            }
            for (const previous of subscriptions)
            {
                if (previous.handle && !previous.preparing && !previous.notifying && !previous.canceling
                    && !previous.handle.hasCustody())
                {
                    // Diagnostic callers may have completed the original handle's unlink.
                    // Observe that real release; never retain a second subscription ledger.
                    subscriptions.delete(previous);
                    continue;
                }
                if (previous.retired && previous.handle?.hasCustody())
                {
                    throw new Error('article-workspace-native-cleanup-pending');
                }
            }
            creating = true;
            const record: NativeSubscription = { handle: null, preparing: true, retired: false,
                notifying: false, canceling: false, revocationComplete: false,
                creationFailed: false, creationCause: undefined, cleanupFailed: false, cleanupCause: undefined };
            subscriptions.add(record);
            try
            {
                assertOwner();
                const authority = session.documentAuthority;
                if (!authority)
                {
                    record.preparing = false;
                    cancel(record);
                    return null;
                }
                const capture = authority.capture.bind(authority);
                const hasNative = authority.hasCustody.bind(authority);
                const subscribe = authority.subscribeRetirement.bind(authority);
                if (disposed || record.retired)
                {
                    throw new Error('article-workspace-native-reservation-retired');
                }
                record.handle = subscribe(() =>
                {
                    record.retired = true;
                    record.notifying = true;
                    try
                    {
                        if (!record.revocationComplete)
                        {
                            revokeBeforeChange();
                            record.revocationComplete = true;
                        }
                    }
                    catch (cause)
                    {
                        record.cleanupFailed = true;
                        record.cleanupCause = cause;
                        throw cause;
                    }
                    finally
                    {
                        record.notifying = false;
                    }
                });
                const ticket = capture();
                if (!ticket)
                {
                    record.preparing = false;
                    cancel(record);
                    return null;
                }
                if (ticket.documentKey !== expected.documentKey || ticket.documentEpoch !== expected.documentEpoch
                    || ticket.revision !== expected.revision)
                {
                    record.preparing = false;
                    cancel(record);
                    return null;
                }
                const handle = record.handle;
                const hasRegistration = handle.hasCustody.bind(handle);
                const hasCustody = (): boolean => !disposed && !record.retired && !record.preparing
                    && !record.notifying && !record.canceling && !record.cleanupFailed
                    && hasRegistration() && hasNative(ticket);
                const reservation: ArticleWorkspaceNativeDocumentReservation = Object.freeze({
                    nativeEditor, ticket, hasCustody,
                    cancel: () => cancel(record),
                    hasCleanupCustody: hasRegistration,
                    failureCause: () => record.cleanupFailed ? record.cleanupCause : handle.failureCause()
                });
                assertOwner();
                record.preparing = false;
                // Only captured original private queries follow the final fallible owner read.
                if (!hasCustody())
                {
                    cancel(record);
                    return null;
                }
                return reservation;
            }
            catch (cause)
            {
                record.creationFailed = true;
                record.creationCause = cause;
                record.preparing = false;
                try
                {
                    cancel(record);
                }
                catch
                {
                    // The actual handle and cleanup cause remain held for retire/retry.
                }
                throw cause;
            }
            finally
            {
                creating = false;
            }
        },
        retire(): void
        {
            disposed = true;
            if (retiring)
            {
                throw new Error('article-workspace-native-retirement-active');
            }
            retiring = true;
            let failed = false;
            let firstCause: unknown;
            try
            {
                for (const record of [...subscriptions])
                {
                    try
                    {
                        cancel(record);
                        if (record.preparing || record.handle?.hasCustody())
                        {
                            throw new Error('article-workspace-native-cleanup-pending');
                        }
                    }
                    catch (cause)
                    {
                        if (!failed)
                        {
                            failed = true;
                            firstCause = cause;
                        }
                    }
                }
            }
            finally
            {
                retiring = false;
            }
            if (failed)
            {
                throw firstCause;
            }
        },
        /** Original retained obligations/causes only; not a resource completeness receipt. */
        inspectCleanupCustody: () => [...subscriptions].map(record => ({ handle: record.handle,
            preparing: record.preparing, creationFailed: record.creationFailed, creationCause: record.creationCause,
            cleanupFailed: record.cleanupFailed, cleanupCause: record.cleanupCause }))
    });
}
