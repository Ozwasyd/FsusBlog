import type { AdminPrincipalSeal, useAdminStore } from '@/store/admin';

import {
    cancelRetainedArticleDocumentMembershipSeal,
    hasSealedRetainedArticleDocumentMembershipCustody,
    sealRetainedArticleDocumentMembership,
    subscribeRetainedArticleDocumentRetirement
} from './openArticleDocumentRegistry';

import type { RetainedArticleDocumentHandle, RetainedArticleDocumentMembershipSeal, RetainedNotificationSubscription } from './openArticleDocumentRegistry';
import type { MarkdownEditorNativeTargetBirth, MarkdownEditorNativeTargetLifetimeHandle,
    MarkdownEditorNativeTargetSubscription, MarkdownEditorSession, MarkdownEditorSessionExpose } from '@ozwasyd/element-plus';

export interface ArticleNativeRecreationSource {
    readonly editor: MarkdownEditorSessionExpose;
    readonly session: MarkdownEditorSession;
    readonly snapshotRef: string;
}

/** Physical staging only. Main owns the original native offer/principal and subsequent readmission. */
export interface ArticleNativeRecreationStagingLease {
    readonly scope: 'native-recreation-staging';
    readonly editor: MarkdownEditorSessionExpose;
    readonly session: MarkdownEditorSession;
    readonly documentHandle: RetainedArticleDocumentHandle;
    readonly sourceSnapshotRef: string;
    hasCustody(): boolean;
    subscribeBeforeInvalidation(receiver: () => void): RetainedNotificationSubscription;
    /** Only this loan's original subscriptions/tokens; never dispose the mounted editor. */
    cancel(): boolean;
    retryCleanup(): void;
    inspectFailure(): Readonly<{ failed: boolean; firstCause: unknown; latestCause: unknown; pendingCleanup: boolean; }>;
}

interface Receiver {
    readonly callback: () => void;
    registered: boolean;
    pendingUnsubscribe: boolean;
    running: boolean;
    notified: boolean;
    failed: boolean;
    firstCause: unknown;
    hasFirstCause: boolean;
    failureVersion: number;
}

/** Retain the original issuers before acquisitions; this controller creates no native/document owner. */
export function createArticleNativeRecreationStaging(
    admin: ReturnType<typeof useAdminStore>, documentHandle: RetainedArticleDocumentHandle,
    principalIdentityId: string, sourceSnapshotRef: string, hasWriteCustody: () => boolean)
{
    const sealAuth = admin.sealAdminPrincipalAuthority;
    const hasAuth = admin.hasAdminPrincipalAuthorityCustody;
    const cancelAuth = admin.cancelAdminPrincipalAuthority;
    let auth: AdminPrincipalSeal | null = null;
    let membership: RetainedArticleDocumentMembershipSeal | null = null;
    let documentStop: RetainedNotificationSubscription | null = null;
    let writerStop: (() => void) | null = null;
    let lifetime: MarkdownEditorNativeTargetLifetimeHandle | null = null;
    let birth: MarkdownEditorNativeTargetBirth | null = null;
    let nativeSubscription: MarkdownEditorNativeTargetSubscription | null = null;
    let editor: MarkdownEditorSessionExpose | null = null;
    let session: MarkdownEditorSession | null = null;
    let active = true;
    let preparing = true;
    let notifying = false;
    let cleaning = false;
    let acquiring = false;
    let activeReceiver: Receiver | null = null;
    let failed = false;
    let firstCause: unknown;
    let latestCause: unknown;
    const receivers = new Set<Receiver>();
    const recordFailure = (cause: unknown): void =>
    {
        if (!failed)
        {
            firstCause = cause;
        }
        failed = true;
        latestCause = cause;
    };
    const hasCustody = (): boolean => active && !preparing && !notifying && !cleaning && !failed && hasWriteCustody()
        && auth !== null && membership !== null && lifetime !== null && birth !== null && nativeSubscription !== null
        && hasAuth(auth) && hasSealedRetainedArticleDocumentMembershipCustody(membership)
        && lifetime.hasCustody(birth) && nativeSubscription.hasCustody()
        && active && !notifying && !cleaning && !failed && hasWriteCustody();
    const invalidate = (): void =>
    {
        // Withdraw before every receiver and before the original owner may perform its effect.
        active = false;
        if (notifying)
        {
            const cause = new Error('article-native-staging-invalidation-reentrant');
            recordFailure(cause);
            if (activeReceiver)
            {
                if (!activeReceiver.hasFirstCause)
                {
                    activeReceiver.hasFirstCause = true;
                    activeReceiver.firstCause = cause;
                }
                activeReceiver.failed = true;
                activeReceiver.failureVersion++;
            }
            throw cause;
        }
        notifying = true;
        let didFail = false;
        let original: unknown;
        try
        {
            for (const receiver of receivers)
            {
                if (!receiver.registered || (receiver.notified && !receiver.failed))
                {
                    continue;
                }
                receiver.running = true;
                const version = receiver.failureVersion;
                const previousReceiver = activeReceiver;
                activeReceiver = receiver;
                try
                {
                    receiver.callback();
                    if (receiver.failureVersion !== version)
                    {
                        throw receiver.firstCause;
                    }
                    receiver.failed = false;
                    receiver.notified = true;
                    if (receiver.pendingUnsubscribe)
                    {
                        receiver.registered = false;
                        receivers.delete(receiver);
                    }
                }
                catch (cause: unknown)
                {
                    if (!receiver.hasFirstCause)
                    {
                        receiver.hasFirstCause = true;
                        receiver.firstCause = cause;
                    }
                    receiver.failed = true;
                    receiver.failureVersion++;
                    recordFailure(cause);
                    if (!didFail)
                    {
                        original = cause;
                    }
                    didFail = true;
                }
                finally
                {
                    receiver.running = false;
                    activeReceiver = previousReceiver;
                }
            }
        }
        finally
        {
            notifying = false;
        }
        if (didFail)
        {
            throw original;
        }
    };
    const cleanup = (): boolean =>
    {
        active = false;
        if (notifying || cleaning || acquiring)
        {
            const cause = new Error('article-native-staging-cleanup-reentrant');
            recordFailure(cause);
            if (activeReceiver)
            {
                if (!activeReceiver.hasFirstCause)
                {
                    activeReceiver.hasFirstCause = true;
                    activeReceiver.firstCause = cause;
                }
                activeReceiver.failed = true;
                activeReceiver.failureVersion++;
            }
            throw cause;
        }
        cleaning = true;
        const failures: unknown[] = [];
        const attempt = (run: () => void): void =>
        {
            try
            {
                run();
            }
            catch (cause: unknown)
            {
                recordFailure(cause);
                failures.push(cause);
            }
        };
        try
        {
            attempt(invalidate);
            attempt(() =>
            {
                if (nativeSubscription)
                {
                    if (nativeSubscription.unsubscribe() !== true)
                    {
                        throw new Error('article-native-staging-subscription-release-not-confirmed', { cause: nativeSubscription.failureCause() });
                    }
                    nativeSubscription = null;
                }
            });
            attempt(() =>
            {
                if (writerStop)
                {
                    writerStop();
                    writerStop = null;
                }
            });
            attempt(() =>
            {
                if (documentStop)
                {
                    documentStop();
                    const stopped = documentStop.inspect();
                    if (stopped.failed && stopped.pendingUnsubscribe && !stopped.running)
                    {
                        documentStop.retry();
                    }
                    const status = documentStop.inspect();
                    if (status.failed || status.running)
                    {
                        throw status.firstFailure;
                    }
                    documentStop = null;
                }
            });
            attempt(() =>
            {
                if (auth && cancelAuth(auth) !== true)
                {
                    throw new Error('article-native-staging-auth-release-not-confirmed');
                }
                auth = null;
            });
            attempt(() =>
            {
                if (membership && cancelRetainedArticleDocumentMembershipSeal(membership) !== true)
                {
                    throw new Error('article-native-staging-membership-release-not-confirmed');
                }
                membership = null;
            });
            if (failures.length)
            {
                throw failures.length === 1 ? failures[0]
                    : new AggregateError(failures, 'article-native-staging-cleanup-incomplete', { cause: failures[0] });
            }
            return true;
        }
        finally
        {
            cleaning = false;
        }
    };
    const subscribeBeforeInvalidation = (callback: () => void): RetainedNotificationSubscription =>
    {
        if (typeof callback !== 'function' || !hasCustody())
        {
            throw new Error('article-native-staging-receiver-unavailable');
        }
        const receiver: Receiver = { callback, registered: true, pendingUnsubscribe: false,
            running: false, notified: false, failed: false, firstCause: undefined, hasFirstCause: false, failureVersion: 0 };
        const stop = (): void =>
        {
            receiver.pendingUnsubscribe = true;
            if (!receiver.running && !receiver.failed)
            {
                receiver.registered = false;
                receivers.delete(receiver);
            }
        };
        const result: RetainedNotificationSubscription = Object.assign(stop, {
            retry: (): void =>
            {
                if (receiver.failed)
                {
                    // The same original notification/custody is retried; no owner reissue.
                    invalidate();
                }
            },
            inspect: () => ({ failed: receiver.failed, pendingUnsubscribe: receiver.pendingUnsubscribe,
                running: receiver.running, firstFailure: receiver.firstCause })
        });
        if (!hasCustody())
        {
            throw new Error('article-native-staging-receiver-revoked');
        }
        receivers.add(receiver);
        return result;
    };
    return Object.freeze({ invalidate, cancel: cleanup, retryCleanup: (): void =>
    {
        cleanup();
    },
    acquire: (): void =>
    {
        acquiring = true;
        try
        {
            auth = sealAuth(principalIdentityId);
            if (!auth)
            {
                throw new Error('article-native-staging-original-principal-unavailable');
            }
            membership = sealRetainedArticleDocumentMembership(documentHandle);
            if (!membership)
            {
                throw new Error('article-native-staging-original-membership-unavailable');
            }
            documentStop = subscribeRetainedArticleDocumentRetirement(documentHandle, invalidate);
        }
        catch (cause: unknown)
        {
            recordFailure(cause);
            active = false;
            throw cause;
        }
        finally
        {
            acquiring = false;
        }
    },
    attachWriter: (subscribe: (receiver: () => void) => () => void): void =>
    {
        acquiring = true;
        try
        {
            writerStop = subscribe(invalidate);
        }
        catch (cause: unknown)
        {
            recordFailure(cause);
            active = false;
            throw cause;
        }
        finally
        {
            acquiring = false;
        }
    },
    attachTarget: (targetEditor: MarkdownEditorSessionExpose, targetSession: MarkdownEditorSession,
        handle: MarkdownEditorNativeTargetLifetimeHandle, targetBirth: MarkdownEditorNativeTargetBirth): void =>
    {
        editor = targetEditor;
        session = targetSession;
        lifetime = handle;
        birth = targetBirth;
        acquiring = true;
        try
        {
            nativeSubscription = handle.subscribeBeforeInvalidation(invalidate);
        }
        catch (cause: unknown)
        {
            recordFailure(cause);
            active = false;
            throw cause;
        }
        finally
        {
            acquiring = false;
        }
    },
    publish: (): ArticleNativeRecreationStagingLease =>
    {
        if (!editor || !session)
        {
            throw new Error('article-native-staging-actual-target-required');
        }
        const result: ArticleNativeRecreationStagingLease = Object.freeze({ scope: 'native-recreation-staging',
            editor, session, documentHandle, sourceSnapshotRef, hasCustody, subscribeBeforeInvalidation,
            cancel: cleanup, retryCleanup: (): void =>
            {
                cleanup();
            },
            inspectFailure: () => Object.freeze({ failed, firstCause, latestCause,
                pendingCleanup: nativeSubscription !== null || writerStop !== null || documentStop !== null || auth !== null || membership !== null }) });
        preparing = false;
        if (!hasCustody())
        {
            throw new Error('article-native-staging-target-custody-unavailable');
        }
        return result;
    }
    });
}
