import type { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import type { ArticleDocumentRetainedBinding, ArticleDocumentLifetimeSeal } from '@/services/authoring/articleDocumentContext';
import type { AuthoringWorkspaceMountedAuthoritySources } from '@/services/authoring/authoringWorkspaceLayoutContext';
import type { RetainedNotificationSubscription } from '@/services/authoring/openArticleDocumentRegistry';

type OriginalMountedWriter = ReturnType<ReturnType<typeof useAdminArticleWrite>['authoringEditorRuntime']['bindEditor']>;
export type AdminArticleWorkspaceWriterResources = OriginalMountedWriter['resources'];
type WriterAuthorityPort = Pick<OriginalMountedWriter, 'subscribeMountedAuthorityRetirement' | 'sealMountedAuthority' | 'hasMountedAuthorityCustody' | 'cancelMountedAuthority' | 'readRetainedDocumentBinding' | 'resources'>;
type WriterSeal = NonNullable<ReturnType<WriterAuthorityPort['sealMountedAuthority']>>;

function hasWriterAuthorityPort(runtime: object): runtime is object & WriterAuthorityPort
{
    return 'subscribeMountedAuthorityRetirement' in runtime && typeof runtime.subscribeMountedAuthorityRetirement === 'function'
        && 'sealMountedAuthority' in runtime && typeof runtime.sealMountedAuthority === 'function'
        && 'hasMountedAuthorityCustody' in runtime && typeof runtime.hasMountedAuthorityCustody === 'function'
        && 'cancelMountedAuthority' in runtime && typeof runtime.cancelMountedAuthority === 'function'
        && 'readRetainedDocumentBinding' in runtime && typeof runtime.readRetainedDocumentBinding === 'function'
        && 'resources' in runtime && runtime.resources !== null && typeof runtime.resources === 'object';
}

interface WriterSubscription {
    readonly runtime: object & WriterAuthorityPort;
    readonly resources: AdminArticleWorkspaceWriterResources;
    readonly seal: WriterAuthorityPort['sealMountedAuthority'];
    readonly has: WriterAuthorityPort['hasMountedAuthorityCustody'];
    readonly cancel: WriterAuthorityPort['cancelMountedAuthority'];
    readonly borrowDocument: WriterAuthorityPort['readRetainedDocumentBinding'];
    unsubscribe: (() => void) | null;
}
interface WriterResourceBinding {
    readonly writer: WriterSubscription;
    readonly editorSessionRef: string;
    readonly nativeEditor: object;
}
interface DocumentSubscription {
    readonly binding: ArticleDocumentRetainedBinding;
    readonly seal: ArticleDocumentRetainedBinding['sealLifetimeAuthority'];
    readonly has: ArticleDocumentRetainedBinding['hasLifetimeAuthorityCustody'];
    readonly cancel: ArticleDocumentRetainedBinding['cancelLifetimeAuthority'];
    stop: RetainedNotificationSubscription | null;
}
interface Reservation {
    readonly writer: WriterSubscription;
    readonly document: DocumentSubscription;
    writerSeal: WriterSeal | null;
    documentSeal: ArticleDocumentLifetimeSeal | null;
}

/** One actual physical producer join; no article/session index, document issuer or body owner. */
export function createAdminArticleWorkspaceWriterReservation()
{
    let writer: WriterSubscription | null = null;
    let writerResourceBinding: WriterResourceBinding | null = null;
    let document: DocumentSubscription | null = null;
    let reservation: Reservation | null = null;
    let obligation: Reservation | null = null;
    let attempt: object | null = null;
    let closed = false;
    let busy = false;
    let sealing = false;
    let reserving = false;
    let failed = false;
    let hasFailure = false;
    let firstFailure: unknown;
    let latestFailure: unknown;
    const recordFailure = (error: unknown): void =>
    {
        if (!hasFailure)
        {
            hasFailure = true;
            firstFailure = error;
        }
        failed = true;
        latestFailure = error;
    };
    const withdraw = (): void =>
    {
        // Also fence a seal currently inside an original producer callback.
        reservation = null;
        attempt = null;
    };
    const cancelReservation = (): void =>
    {
        withdraw();
        const current = obligation;
        if (sealing)
        {
            // A synchronous producer callback cannot discard a token still being transferred.
            return;
        }
        if (!current)
        {
            return;
        }
        const errors: unknown[] = [];
        if (current.writerSeal)
        {
            try
            {
                if (current.writer.cancel(current.writerSeal) !== true)
                {
                    throw new Error('article-workspace-writer-cancellation-not-confirmed', { cause: firstFailure });
                }
                current.writerSeal = null;
            }
            catch (error: unknown)
            {
                recordFailure(error);
                errors.push(error);
            }
        }
        if (current.documentSeal)
        {
            try
            {
                if (current.document.cancel(current.documentSeal) !== true)
                {
                    throw new Error('article-workspace-document-cancellation-not-confirmed', { cause: firstFailure });
                }
                current.documentSeal = null;
            }
            catch (error: unknown)
            {
                recordFailure(error);
                errors.push(error);
            }
        }
        if (errors.length)
        {
            throw new AggregateError(errors, 'article-workspace-reservation-cancellation-incomplete', { cause: errors[0] });
        }
        obligation = null;
    };
    const releaseSubscriptions = (retry: boolean): void =>
    {
        withdraw();
        if (busy)
        {
            return;
        }
        busy = true;
        const errors: unknown[] = [];
        try
        {
            try
            {
                cancelReservation();
            }
            catch (error: unknown)
            {
                errors.push(error);
            }
            const doc = document;
            if (doc?.stop)
            {
                try
                {
                    doc.stop();
                    const stopped = doc.stop.inspect();
                    // Healthy stop removes only this subscription; retry can retire the whole Doc owner.
                    if (retry && stopped.failed && stopped.pendingUnsubscribe && !stopped.running)
                    {
                        doc.stop.retry();
                    }
                    const status = doc.stop.inspect();
                    if (status.failed || status.running)
                    {
                        throw status.firstFailure;
                    }
                    if (document === doc)
                    {
                        document = null;
                    }
                }
                catch (error: unknown)
                {
                    recordFailure(error);
                    errors.push(error);
                }
            }
            else if (doc)
            {
                errors.push(latestFailure);
            }
            const original = writer;
            if (original?.unsubscribe)
            {
                try
                {
                    original.unsubscribe();
                    if (writer === original)
                    {
                        writer = null;
                        if (writerResourceBinding?.writer === original)
                        {
                            writerResourceBinding = null;
                        }
                    }
                }
                catch (error: unknown)
                {
                    recordFailure(error);
                    errors.push(error);
                }
            }
            else if (original)
            {
                errors.push(latestFailure);
            }
            if (errors.length)
            {
                throw new AggregateError(errors, 'article-workspace-retirement-subscriptions-incomplete', { cause: errors[0] });
            }
            failed = false;
        }
        finally
        {
            busy = false;
        }
    };
    const connectWriter = (runtime: object): void =>
    {
        if (closed || busy || sealing || failed)
        {
            throw new Error('article-workspace-reservation-connection-unavailable');
        }
        if (writer?.runtime === runtime)
        {
            return;
        }
        releaseSubscriptions(false);
        if (!hasWriterAuthorityPort(runtime))
        {
            throw new Error('article-workspace-original-writer-authority-port-required');
        }
        busy = true;
        try
        {
            const current: WriterSubscription = { runtime, resources: runtime.resources, seal: runtime.sealMountedAuthority.bind(runtime),
                has: runtime.hasMountedAuthorityCustody.bind(runtime), cancel: runtime.cancelMountedAuthority.bind(runtime),
                borrowDocument: runtime.readRetainedDocumentBinding.bind(runtime), unsubscribe: null };
            writer = current;
            current.unsubscribe = runtime.subscribeMountedAuthorityRetirement(() =>
            {
                // Synchronous Root-private assignments only; never reenter Writer cleanup.
                reservation = null;
                attempt = null;
            });
        }
        catch (error: unknown)
        {
            recordFailure(error);
            throw error;
        }
        finally
        {
            busy = false;
        }
    };
    const connectDocumentBinding = (binding: ArticleDocumentRetainedBinding): void =>
    {
        if (document?.binding === binding)
        {
            return;
        }
        if (document || closed || busy || sealing || failed)
        {
            throw new Error('article-workspace-original-document-binding-replacement-required');
        }
        busy = true;
        try
        {
            const current: DocumentSubscription = { binding, seal: binding.sealLifetimeAuthority.bind(binding),
                has: binding.hasLifetimeAuthorityCustody.bind(binding), cancel: binding.cancelLifetimeAuthority.bind(binding), stop: null };
            document = current;
            current.stop = binding.subscribeRetirement(() =>
            {
                // Original pre-retirement source, not post-event subscribeLifetime observation.
                reservation = null;
                attempt = null;
            });
        }
        catch (error: unknown)
        {
            recordFailure(error);
            throw error;
        }
        finally
        {
            busy = false;
        }
    };
    const attachDocumentBinding = (binding: ArticleDocumentRetainedBinding, runtime: object): void =>
    {
        connectWriter(runtime);
        if (document?.binding !== binding)
        {
            withdraw();
        }
        connectDocumentBinding(binding);
    };
    const hasCurrentReservation = (): boolean =>
    {
        const current = reservation;
        return current !== null && !closed && !busy && !failed && writer === current.writer && document === current.document
            && current.writerSeal !== null && current.documentSeal !== null
            && current.writer.has(current.writerSeal) && current.document.has(current.documentSeal)
            && reservation === current && !closed && !busy && !failed;
    };
    const sources = Object.freeze<AuthoringWorkspaceMountedAuthoritySources>({
        reserve: (editorSessionRef, originalMountedRuntime, nativeEditor) =>
        {
            if (closed || busy || sealing || reserving || failed)
            {
                return null;
            }
            reserving = true;
            try
            {
                withdraw();
                connectWriter(originalMountedRuntime);
                const original = writer;
                if (!original || closed || busy || failed)
                {
                    return null;
                }
                // A single genuine physical tuple, not an article/session resource registry.
                if (writerResourceBinding?.writer !== original || writerResourceBinding.editorSessionRef !== editorSessionRef
                    || writerResourceBinding.nativeEditor !== nativeEditor)
                {
                    writerResourceBinding = { writer: original, editorSessionRef, nativeEditor };
                }
                cancelReservation();
                const token = {};
                attempt = token;
                // Admission-only borrow can read scope and synchronously retire its original owner.
                const binding = original.borrowDocument();
                if (!binding || attempt !== token || writer !== original || closed || busy || failed)
                {
                    return null;
                }
                connectDocumentBinding(binding);
                const doc = document;
                if (!doc?.stop || doc.binding !== binding || attempt !== token || writer !== original || closed || busy || failed)
                {
                    return null;
                }
                const subscriptionStatus = doc.stop.inspect();
                if (subscriptionStatus.failed || subscriptionStatus.running || subscriptionStatus.pendingUnsubscribe)
                {
                    recordFailure(subscriptionStatus.firstFailure);
                    return null;
                }
                const current: Reservation = { writer: original, document: doc, writerSeal: null, documentSeal: null };
                const hasCustody = (): boolean => reservation === current && hasCurrentReservation();
                const output = Object.freeze({ nativeEditor, retainedIdentity: doc.binding.handle,
                    hasCustody, cancel: () =>
                    {
                        if (obligation === current)
                        {
                            cancelReservation();
                        }
                    } });
                if (attempt !== token || closed || failed || writer !== original || document !== doc)
                {
                    return null;
                }
                obligation = current;
                sealing = true;
                try
                {
                    current.documentSeal = doc.seal();
                    if (attempt !== token || !current.documentSeal)
                    {
                        cancelReservation();
                        return null;
                    }
                    current.writerSeal = original.seal(editorSessionRef);
                    if (attempt !== token || !current.writerSeal || !doc.has(current.documentSeal)
                        || !original.has(current.writerSeal) || closed || failed || document !== doc || writer !== original)
                    {
                        cancelReservation();
                        return null;
                    }
                    sealing = false;
                    reservation = current;
                    if (!hasCustody())
                    {
                        cancelReservation();
                        return null;
                    }
                    return output;
                }
                catch (error: unknown)
                {
                    recordFailure(error);
                    // Actual tokens stay retained for caller retry; never erase a failed cancellation.
                    withdraw();
                    throw error;
                }
                finally
                {
                    sealing = false;
                    if (reservation !== current && !failed)
                    {
                        cancelReservation();
                    }
                }
            }
            catch (error: unknown)
            {
                // Admission includes the nonpure borrow before seals; keep its exact original cause.
                recordFailure(error);
                withdraw();
                throw error;
            }
            finally
            {
                reserving = false;
                if (!reservation)
                {
                    attempt = null;
                }
            }
        }
    });
    return Object.freeze({ sources, withdraw, attachDocumentBinding, hasCurrentReservation,
        readOriginalWriterResources: (editorSessionRef: string, nativeEditor: object): AdminArticleWorkspaceWriterResources | null =>
        {
            const current = writerResourceBinding;
            if (!current || closed || busy || sealing || reserving || failed || writer !== current.writer
                || current.editorSessionRef !== editorSessionRef || current.nativeEditor !== nativeEditor)
            {
                return null;
            }
            // Forward the SAME original partial owner port; no aggregate/receipt/dispose authority.
            return current.writer.resources;
        },
        throwIfAdmissionFailed: (): void =>
        {
            // Private failure custody only: no reader, scope inspection or producer callback.
            if (hasFailure)
            {
                throw firstFailure;
            }
        },
        hasDocumentBinding: () => !!document?.stop && !closed && !failed,
        dispose: (): void =>
        {
            closed = true;
            releaseSubscriptions(false);
        },
        retryDisposal: (): void =>
        {
            closed = true;
            releaseSubscriptions(true);
        },
        readFailure: () => Object.freeze({ failed, firstFailure, latestFailure,
            retainedSubscription: writer !== null, retainedDocumentSubscription: document !== null,
            documentNotification: document?.stop?.inspect() ?? null,
            retainedCancellation: obligation !== null, pendingReservation: reservation !== null })
    });
}
