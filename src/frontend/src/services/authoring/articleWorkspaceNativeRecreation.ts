
import type { ArticleNativeRecreationSource, ArticleNativeRecreationStagingLease } from './articleNativeRecreationStaging';
import type { ArticleWorkspaceMountedAuthority, ArticleWorkspaceNativeHandoverReservation } from './fsusUiEditorSessionFactory';
import type { OpenArticleDocumentEntry, RetainedNotificationSubscription } from './openArticleDocumentRegistry';
import type { MarkdownEditorNativeHandoverProof, MarkdownEditorSessionSnapshot } from '@ozwasyd/element-plus';

/** Supplied only by the original installed Frame; no mount discovery or alternative issuer. */
export interface ArticleWorkspaceNativeRecreationRootPort
{
    reserveTarget(entry: Readonly<OpenArticleDocumentEntry>, source: ArticleNativeRecreationSource): Promise<ArticleNativeRecreationStagingLease>;
    readmitTarget(entry: Readonly<OpenArticleDocumentEntry>, target: ArticleNativeRecreationSource,
        cancellation: AbortSignal): Promise<ArticleWorkspaceMountedAuthority>;
    retryCleanup(): void;
}

/** Native memory and actual same-target Root admission only, never full-host readiness. */
export interface ArticleWorkspaceNativeRecreationObservation
{
    readonly native: MarkdownEditorNativeHandoverProof;
    readonly mounted: ArticleWorkspaceMountedAuthority;
    readonly fullRefsRestored: false;
    readonly resourcesValidated: false;
}

/** One original operation holder; no document/body/history or session index. */
export function createArticleWorkspaceNativeRecreationDriver(
    root: ArticleWorkspaceNativeRecreationRootPort,
    prepareSource: (entry: OpenArticleDocumentEntry, snapshot: MarkdownEditorSessionSnapshot, draftStateRef: string,
        cancellation: AbortSignal) => ArticleWorkspaceNativeHandoverReservation,
    hasInstallation: () => boolean,
    inspectSourceCleanup: () => Readonly<{ pending: boolean; failed: boolean; firstCause: unknown; latestCause: unknown; }>)
{
    interface Attempt {
        readonly operation: AbortController;
        active: boolean;
        running: boolean;
        cleaning: boolean;
        withdrawing: boolean;
        releasingStage: boolean;
        source: ArticleWorkspaceNativeHandoverReservation | null;
        stage: ArticleNativeRecreationStagingLease | null;
        target: ArticleNativeRecreationSource | null;
        stop: RetainedNotificationSubscription | null;
        failed: boolean;
        firstCause: unknown;
        latestCause: unknown;
    }
    let attempt: Attempt | null = null;
    let terminalFailure: Readonly<{ failed: boolean; firstCause: unknown; latestCause: unknown; }> | null = null;
    const failure = (own: Attempt, cause: unknown): void =>
    {
        if (!own.failed)
        {
            own.firstCause = cause;
        }
        own.failed = true;
        own.latestCause = cause;
    };
    const withdraw = (own: Attempt, cancelStaging = true): void =>
    {
        own.active = false;
        if (own.withdrawing)
        {
            return; // The same holder remains pending; never acknowledge reentrant cleanup.
        }
        own.withdrawing = true;
        let didFail = false;
        let first: unknown;
        const run = (work: () => void): void =>
        {
            try
            {
                work();
            }
            catch (cause)
            {
                if (!didFail)
                {
                    first = cause;
                }
                didFail = true;
                failure(own, cause);
            }
        };
        try
        {
            // This same signal is in the original principal guard and actual Write operation.
            run(() => own.operation.abort());
            run(() =>
            {
                if (own.source && own.source.cancel() !== true)
                {
                    throw new Error('article-workspace-native-source-withdrawal-pending');
                }
            });
            run(() =>
            {
                if (!cancelStaging)
                {
                    return; // Original staging is already inside its invalidation notification.
                }
                const releasingStage = own.releasingStage;
                own.releasingStage = true;
                try
                {
                    if (own.stage)
                    {
                        if (own.stage.cancel() !== true)
                        {
                            throw new Error('article-workspace-native-staging-withdrawal-pending');
                        }
                    }
                    else
                    {
                        // Original Frame aborts its actual in-flight physical preparation.
                        root.retryCleanup();
                    }
                }
                finally
                {
                    own.releasingStage = releasingStage;
                }
            });
            if (didFail)
            {
                throw first;
            }
        }
        finally
        {
            own.withdrawing = false;
        }
    };
    const cleanup = (own: Attempt): boolean =>
    {
        own.active = false;
        if (own.running || own.cleaning || own.withdrawing)
        {
            withdraw(own);
            return false;
        }
        own.cleaning = true;
        let didFail = false;
        let first: unknown;
        const run = (work: () => void): void =>
        {
            try
            {
                work();
            }
            catch (cause)
            {
                if (!didFail)
                {
                    first = cause;
                }
                didFail = true;
                failure(own, cause);
            }
        };
        try
        {
            run(() =>
            {
                const target = own.target?.session;
                if (target?.inspectNativeHandoverCleanup().pending)
                {
                    if (!target.retryNativeHandoverCleanup() || target.inspectNativeHandoverCleanup().pending)
                    {
                        throw new Error('article-workspace-native-receiving-cleanup-pending');
                    }
                }
            });
            run(() =>
            {
                own.stop?.();
                own.stop = null;
            });
            run(() =>
            {
                own.releasingStage = true;
                try
                {
                    if (own.stage && own.stage.cancel() !== true)
                    {
                        throw new Error('article-workspace-native-staging-cleanup-pending');
                    }
                    if (!own.stage)
                    {
                        root.retryCleanup();
                    }
                    own.stage = null;
                }
                finally
                {
                    own.releasingStage = false;
                }
            });
            run(() =>
            {
                if (own.source && own.source.cancel() !== true)
                {
                    throw new Error('article-workspace-native-source-cleanup-pending');
                }
                own.source = null;
            });
            run(() =>
            {
                // A throwing source acquisition may retain its original factory holder.
                // Observe that real debt; never borrow/cancel an unidentified source attempt.
                const source = inspectSourceCleanup();
                if (source.pending)
                {
                    if (source.failed)
                    {
                        throw source.firstCause;
                    }
                    throw new Error('article-workspace-native-source-cleanup-unconfirmed');
                }
            });
            if (didFail)
            {
                throw first;
            }
            own.target = null;
            if (attempt === own)
            {
                if (own.failed)
                {
                    terminalFailure = Object.freeze({ failed: true, firstCause: own.firstCause, latestCause: own.latestCause });
                }
                attempt = null;
            }
            return true;
        }
        finally
        {
            own.cleaning = false;
        }
    };
    return Object.freeze({
        async recreate(entry: OpenArticleDocumentEntry, snapshot: MarkdownEditorSessionSnapshot,
            draftStateRef: string): Promise<ArticleWorkspaceNativeRecreationObservation>
        {
            if (attempt || !hasInstallation())
            {
                throw new Error('article-workspace-native-recreation-owner-unavailable');
            }
            const own: Attempt = { operation: new AbortController(), active: true, running: true, cleaning: false,
                withdrawing: false, releasingStage: false,
                source: null, stage: null, target: null, stop: null, failed: false, firstCause: undefined, latestCause: undefined };
            attempt = own;
            const current = (): boolean => own.active && !own.operation.signal.aborted && attempt === own && hasInstallation();
            const verify = (): void =>
            {
                if (!current() || !own.source?.hasCustody())
                {
                    throw new Error('article-workspace-native-recreation-custody-revoked');
                }
            };
            try
            {
                own.source = prepareSource(entry, snapshot, draftStateRef, own.operation.signal);
                const source = own.source;
                verify();
                own.stage = await root.reserveTarget(entry, { editor: source.sourceEditor,
                    session: source.sourceSession, snapshotRef: source.nativeHandover.snapshotRef });
                const stage = own.stage;
                verify();
                if (!stage.hasCustody() || stage.documentHandle !== source.handle
                    || stage.sourceSnapshotRef !== source.nativeHandover.snapshotRef)
                {
                    throw new Error('article-workspace-native-staging-source-mismatch');
                }
                own.target = { editor: stage.editor, session: stage.session, snapshotRef: stage.sourceSnapshotRef };
                const target = own.target;
                own.stop = stage.subscribeBeforeInvalidation(() =>
                {
                    if (!own.releasingStage)
                    {
                        // Withdraw the original principal before native transfer can continue.
                        withdraw(own, false);
                    }
                });
                verify();
                if (!stage.hasCustody() || target.editor.getSession(entry.editorSessionRef) !== target.session)
                {
                    throw new Error('article-workspace-native-target-replaced');
                }
                const native = await target.session.adoptNativeHandover(source.nativeHandover, {
                    documentIdentity: source.nativeHandover.documentIdentity,
                    revision: source.nativeHandover.revision, principal: source.principal });
                verify();
                if (target.session.inspectNativeHandoverCleanup().pending || !stage.hasCustody()
                    || native.status !== 'native-recreated' || native.editorSessionRef !== entry.editorSessionRef
                    || native.snapshotRef !== source.nativeHandover.snapshotRef
                    || target.editor.getSession(entry.editorSessionRef) !== target.session)
                {
                    throw new Error('article-workspace-native-target-admission-incomplete');
                }
                own.releasingStage = true;
                try
                {
                    if (stage.cancel() !== true)
                    {
                        throw new Error('article-workspace-native-staging-release-incomplete');
                    }
                    own.stage = null;
                    own.stop?.();
                    own.stop = null;
                }
                finally
                {
                    own.releasingStage = false;
                }
                verify();
                const mounted = await root.readmitTarget(entry, target, own.operation.signal);
                verify();
                if (mounted.nativeEditor !== target.editor || mounted.editorSessionRef !== entry.editorSessionRef
                    || !mounted.hasCustody() || target.editor.getSession(entry.editorSessionRef) !== target.session)
                {
                    throw new Error('article-workspace-native-root-readmission-target-mismatch');
                }
                verify();
                own.running = false;
                if (!cleanup(own))
                {
                    throw new Error('article-workspace-native-recreation-cleanup-pending');
                }
                own.operation.signal.throwIfAborted();
                return Object.freeze({ native, mounted, fullRefsRestored: false as const, resourcesValidated: false as const });
            }
            catch (cause)
            {
                failure(own, cause);
                own.running = false;
                try
                {
                    withdraw(own);
                }
                catch
                {
                    // Immediate withdrawal debt cannot skip eventual attempt-all cleanup.
                }
                try
                {
                    cleanup(own);
                }
                catch
                { /* Original holders and latest raw cleanup cause remain available for retry. */ }
                if (attempt !== own && own.failed)
                {
                    terminalFailure = Object.freeze({ failed: true, firstCause: own.firstCause, latestCause: own.latestCause });
                }
                throw cause;
            }
        },
        retryCleanup(): boolean
        {
            const own = attempt;
            if (!own)
            {
                return true;
            }
            if (!own.running && !own.cleaning)
            {
                withdraw(own);
            }
            return cleanup(own);
        },
        inspect: () => Object.freeze({ pending: attempt !== null, running: attempt?.running ?? false,
            failed: attempt?.failed ?? terminalFailure?.failed ?? false,
            firstCause: attempt ? attempt.firstCause : terminalFailure?.firstCause,
            latestCause: attempt ? attempt.latestCause : terminalFailure?.latestCause })
    });
}
