import type { useAdminArticleWrite } from '@/composables/useAdminArticleWrite';
import type { AuthoringWorkspaceMountedAuthoritySources } from '@/services/authoring/authoringWorkspaceLayoutContext';

// Derive the actual original port; this is not an SDK or Writer declaration.
type OriginalMountedWriter = ReturnType<ReturnType<typeof useAdminArticleWrite>['authoringEditorRuntime']['bindEditor']>;
type WriterRetirementPort = Pick<OriginalMountedWriter, 'subscribeMountedAuthorityRetirement'>;

function hasWriterRetirementPort(runtime: object): runtime is object & WriterRetirementPort
{
    return 'subscribeMountedAuthorityRetirement' in runtime
        && typeof runtime.subscribeMountedAuthorityRetirement === 'function';
}

interface WriterSubscription {
    readonly runtime: object & WriterRetirementPort;
    unsubscribe: (() => void) | null;
    withdrawn: boolean;
}

/** One physical Writer subscription, never an article/session index or a mounted grant. */
export function createAdminArticleWorkspaceWriterReservation()
{
    let subscription: WriterSubscription | null = null;
    let reservation: object | null = null;
    let closed = false;
    let disposing = false;
    let failed = false;
    let hasFailure = false;
    let registering = false;
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
        reservation = null;
        if (subscription)
        {
            subscription.withdrawn = true;
        }
    };
    const releaseSubscription = (): void =>
    {
        // Withdraw before invoking the original disposer, including failure retry notifications.
        withdraw();
        if (disposing || !subscription)
        {
            return;
        }
        const current = subscription;
        const release = current.unsubscribe;
        if (!release)
        {
            throw latestFailure;
        }
        disposing = true;
        try
        {
            release();
            if (subscription === current)
            {
                subscription = null;
            }
            failed = false;
        }
        catch (error: unknown)
        {
            recordFailure(error);
            throw error;
        }
        finally
        {
            disposing = false;
        }
    };
    const sources: AuthoringWorkspaceMountedAuthoritySources = Object.freeze<AuthoringWorkspaceMountedAuthoritySources>({
        reserve: (editorSessionRef, originalMountedRuntime, nativeEditor, revokeBeforeChange) =>
        {
            withdraw();
            if (closed || registering || disposing || failed)
            {
                return null;
            }
            if (subscription?.runtime !== originalMountedRuntime)
            {
                releaseSubscription();
                if (!hasWriterRetirementPort(originalMountedRuntime))
                {
                    throw new Error('article-workspace-original-writer-retirement-port-required');
                }
                // Only the real validated function is projected, without inventing Writer authority.
                const runtime = originalMountedRuntime;
                const current: WriterSubscription = { runtime, unsubscribe: null, withdrawn: false };
                subscription = current;
                registering = true;
                try
                {
                    const subscribe = runtime.subscribeMountedAuthorityRetirement.bind(runtime);
                    current.unsubscribe = subscribe(() =>
                    {
                        // Producer callback: private assignments ONLY. Never cancel/release Writer.
                        reservation = null;
                        current.withdrawn = true;
                    });
                }
                catch (error: unknown)
                {
                    recordFailure(error);
                    throw error;
                }
                finally
                {
                    registering = false;
                }
            }
            const current = subscription;
            if (!current || current.withdrawn || closed || failed)
            {
                return null;
            }
            // Subscription is installed before acquiring/publishing any Root candidate.
            reservation = { editorSessionRef, nativeEditor, revokeBeforeChange, runtime: current.runtime };
            // Original Doc pre-retirement notification is not supplied yet. This is a
            // withdrawn private attempt, NOT a published native/member/principal reservation.
            withdraw();
            return null;
        }
    });
    return Object.freeze({
        sources,
        withdraw,
        dispose: (): void =>
        {
            closed = true;
            releaseSubscription();
        },
        retryDisposal: (): void =>
        {
            closed = true;
            releaseSubscription();
        },
        readFailure: () => Object.freeze({ failed, firstFailure, latestFailure,
            retainedSubscription: subscription !== null, pendingReservation: reservation !== null }),
        limitation: 'original-document-pre-retirement-producer-unavailable' as const
    });
}
