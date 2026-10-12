import {
    calculateOpenArticleDocumentDigest,
    cancelRetainedArticleDocumentMembershipSeal,
    hasSealedRetainedArticleDocumentMembershipCustody,
    inspectRetainedArticleDocumentHandle,
    retainedArticleDocumentHandleBelongsTo,
    sealRetainedArticleDocumentMembership
} from './openArticleDocumentRegistry';

import type { OpenArticleDocumentEntry, OpenArticleDocumentRegistry, RetainedArticleDocumentHandle,
    RetainedArticleDocumentMembershipSeal } from './openArticleDocumentRegistry';
import type { AdminPrincipalSeal, useAdminStore } from '../../store/admin';
import type { MarkdownEditorNativeHandoverPrincipal } from '@ozwasyd/element-plus';

/** Original local Auth and canonical Registry custody only; no native/remote/target receipt. */
export interface ArticleWorkspaceNativeHandoverContinuity {
    readonly principal: MarkdownEditorNativeHandoverPrincipal;
    readonly handle: RetainedArticleDocumentHandle;
    readonly scope: 'observed-local-auth-and-registry-membership';
    /** Admission only, once; caller retains this owner before any original acquisition. */
    acquire(): void;
    hasCustody(): boolean;
    cancel(): boolean;
    inspectFailure(): Readonly<{ failed: boolean; firstCause: unknown; latestCause: unknown; }>;
}

/** Uses the actual application store and original Registry issuers, never copied tokens. */
export function createArticleWorkspaceNativeHandoverContinuity(
    admin: ReturnType<typeof useAdminStore>, registry: OpenArticleDocumentRegistry,
    handle: RetainedArticleDocumentHandle, entry: OpenArticleDocumentEntry,
    principalIdentityId: string, hasInstallation: () => boolean
): ArticleWorkspaceNativeHandoverContinuity
{
    const sealAuth = admin.sealAdminPrincipalAuthority;
    const hasAuth = admin.hasAdminPrincipalAuthorityCustody;
    const cancelAuth = admin.cancelAdminPrincipalAuthority;
    const expectedDigest = calculateOpenArticleDocumentDigest(entry);
    let auth: AdminPrincipalSeal | null = null;
    let membership: RetainedArticleDocumentMembershipSeal | null = null;
    let active = true;
    let acquisitionStarted = false;
    let cancelling = false;
    let failed = false;
    let firstCause: unknown;
    let latestCause: unknown;
    const recordFailure = (cause: unknown): void =>
    {
        if (!failed)
        {
            firstCause = cause;
        }
        failed = true;
        latestCause = cause;
    };
    // Original private queries only: no clock/admin snapshot/Doc inspection/reacquisition.
    const hasCustody = (): boolean => active && !cancelling && hasInstallation()
        && auth !== null && membership !== null && hasAuth(auth)
        && hasSealedRetainedArticleDocumentMembershipCustody(membership)
        && hasAuth(auth) && hasInstallation() && active && !cancelling;
    const cancel = (): boolean =>
    {
        active = false;
        if (cancelling)
        {
            return false;
        }
        cancelling = true;
        let didFail = false;
        let original: unknown;
        const attempt = (run: () => void): void =>
        {
            try
            {
                run();
            }
            catch (cause)
            {
                if (!didFail)
                {
                    original = cause;
                }
                didFail = true;
                recordFailure(cause);
            }
        };
        try
        {
            attempt(() =>
            {
                if (auth && cancelAuth(auth) !== true)
                {
                    throw new Error('native-handover-auth-cancellation-not-confirmed');
                }
                auth = null;
            });
            attempt(() =>
            {
                if (membership && cancelRetainedArticleDocumentMembershipSeal(membership) !== true)
                {
                    throw new Error('native-handover-membership-cancellation-not-confirmed');
                }
                membership = null;
            });
            if (didFail)
            {
                throw original;
            }
            return auth === null && membership === null;
        }
        finally
        {
            cancelling = false;
        }
    };
    // Allocate both the borrower and its guard before original issuer callbacks.
    const result: ArticleWorkspaceNativeHandoverContinuity = Object.freeze({
        principal: Object.freeze({ hasCustody }), handle, scope: 'observed-local-auth-and-registry-membership',
        hasCustody, cancel, acquire,
        inspectFailure: () => Object.freeze({ failed, firstCause, latestCause })
    });
    function acquire(): void
    {
        if (acquisitionStarted || !active || cancelling)
        {
            throw new Error('native-handover-continuity-acquisition-consumed');
        }
        acquisitionStarted = true;
        try
        {
            if (!hasInstallation() || !retainedArticleDocumentHandleBelongsTo(handle, registry))
            {
                throw new Error('native-handover-original-registry-owner-mismatch');
            }
            const observation = inspectRetainedArticleDocumentHandle(handle);
            const current = observation.entry;
            if (observation.state !== 'live' || observation.notificationFailed
            || current?.editorSessionRef !== entry.editorSessionRef || current.tabId !== entry.tabId
            || current.identity.articleId !== entry.identity.articleId || current.identity.draftId !== entry.identity.draftId
            || current.identity.documentId !== entry.identity.documentId
            || current.documentContext.documentEpoch !== entry.documentContext.documentEpoch
            || current.documentContext.sourceRevision !== entry.documentContext.sourceRevision
            || current.documentContext.draftRevision !== entry.documentContext.draftRevision
            || current.lifecycleRevision !== entry.lifecycleRevision || current.contentDigest !== entry.contentDigest)
            {
                throw new Error('native-handover-original-document-context-mismatch');
            }
            auth = sealAuth(principalIdentityId);
            if (!auth)
            {
                throw new Error('native-handover-original-auth-authority-unavailable');
            }
            membership = sealRetainedArticleDocumentMembership(handle);
            const final = inspectRetainedArticleDocumentHandle(handle);
            if (!membership || final.state !== 'live' || final.notificationFailed || !final.entry
            || calculateOpenArticleDocumentDigest(final.entry) !== expectedDigest || !hasCustody())
            {
                throw new Error('native-handover-original-membership-unavailable');
            }
            return;
        }
        catch (cause)
        {
            recordFailure(cause);
            try
            {
                cancel();
            }
            catch
            { /* Original token holders and both causes remain in this owner. */ }
            throw cause;
        }
    }
    return result;
}
