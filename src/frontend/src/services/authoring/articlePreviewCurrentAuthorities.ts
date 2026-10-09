import { getArticleResponsibilityHistory, type ArticleResponsibilityVersionResponse } from '@/api/authoring';
import { getSiteConfig } from '@/api/system';
import type { ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

import type { ArticleDocumentContextAdapter } from './articleDocumentContext';
import type { ArticlePreviewSourceInput } from './articlePreviewSourceAdmission';

/** The host lends its existing source/context; revisionId is its currentRevisionId, never a history selection. */
export interface ArticlePreviewCurrentHostInput extends Omit<ArticlePreviewSourceInput, 'responsibility' | 'siteAuthor'> {
    readonly revisionId: string | null;
}

export interface ArticlePreviewCurrentAuthoritiesOptions {
    readonly documentContext: Pick<ArticleDocumentContextAdapter, 'isCurrentContext' | 'subscribeContext'>;
    readonly readHost: () => ArticlePreviewCurrentHostInput;
    /** undefined permits a saved-revision read; null means explicitly missing and forbids fallback. */
    readonly readEditingResponsibility: () => ArticleDraftResponsibilitySource | null | undefined;
    /** Actual host siteConfig.author, or undefined before it is loaded. No default or confirmation is inferred. */
    readonly readCurrentSiteAuthor: () => string | undefined;
}

export interface ArticlePreviewCurrentAuthoritiesState {
    readonly status: 'unavailable' | 'pending' | 'ready' | 'failed' | 'canceled' | 'stale';
    readonly responsibilitySource: 'editing' | 'revision-history' | 'missing';
    readonly reasons: readonly string[];
    /** Existing history reads are saved-revision facts, not the unpublished current-authoring transport. */
    readonly currentResponsibilityTransport: 'unavailable';
}

export interface ArticlePreviewCurrentAuthorities {
    readonly state: ArticlePreviewCurrentAuthoritiesState;
    /** Refresh for each preview generation with that request's signal before attaching source admission. */
    refresh(signal: AbortSignal): Promise<ArticlePreviewCurrentAuthoritiesState>;
    read(): ArticlePreviewSourceInput;
    readResponsibility(): ArticleDraftResponsibilitySource | null;
    readSiteAuthor(): string;
    cancel(): void;
    dispose(): void;
}

interface AuthorityRead {
    readonly contextDigest: string;
    readonly revisionId: string | null;
    readonly responsibility: ArticleDraftResponsibilitySource | null;
    readonly siteAuthor: string;
    readonly hostSiteAuthor: string | undefined;
    readonly signal: AbortSignal;
    readonly historyRead: boolean;
}

function savedResponsibility(
    history: ArticleResponsibilityVersionResponse[],
    host: ArticlePreviewCurrentHostInput
): ArticleDraftResponsibilitySource | null
{
    // The original service returns descending versions for precisely this article/revision.
    // Reject foreign/ambiguous data rather than searching it for a convenient matching row.
    if (!Array.isArray(history) || history.some((row, index) => row.articleId !== host.context.articleId
        || row.articleRevisionId !== host.revisionId || !Number.isSafeInteger(row.responsibilityVersion)
        || row.responsibilityVersion < 1
        || (index > 0 && history[index - 1].responsibilityVersion <= row.responsibilityVersion)))
    {
        throw new Error('preview-responsibility-history-mismatch');
    }
    const row = history[0];
    if (!row)
    {
        return null;
    }
    // Retain only the admission's existing fields; no release, proof or write coordinates are produced.
    return Object.freeze({ inheritSiteAuthor: row.inheritSiteAuthor,
        authors: Object.freeze(row.authors.map(person => Object.freeze({ name: person.name,
            profileUrl: person.profileUrl }))) as typeof row.authors,
        reviewer: row.reviewer ? Object.freeze({ name: row.reviewer.name, profileUrl: row.reviewer.profileUrl }) : null,
        sources: Object.freeze(row.sources.map(source => Object.freeze({ ...source }))) as typeof row.sources,
        updateSummary: row.updateSummary, updateReason: row.updateReason, effectiveAt: row.effectiveAt,
        conclusionImpact: row.conclusionImpact, responsiblePersonConfirmed: row.responsiblePersonConfirmed });
}

/**
 * Read composition only. It borrows the canonical owner and existing binary APIs; it creates no document,
 * responsibility writer or backend authority. Unsaved host fields stay live for admission's accept-time read.
 */
export function createArticlePreviewCurrentAuthorities(
    options: ArticlePreviewCurrentAuthoritiesOptions
): ArticlePreviewCurrentAuthorities
{
    let disposed = false;
    let generation = 0;
    let active: AbortController | null = null;
    let loaded: AuthorityRead | null = null;
    let status: ArticlePreviewCurrentAuthoritiesState['status'] = 'unavailable';
    let failure: string | null = 'preview-authorities-not-read';

    const cancel = (): void =>
    {
        ++generation;
        active?.abort('preview-authorities-canceled');
        active = null;
        loaded = null;
        status = 'canceled';
        failure = 'preview-authorities-canceled';
    };
    const stop = options.documentContext.subscribeContext(() =>
    {
        cancel();
        status = 'stale';
        failure = 'preview-authorities-context-changed';
    });
    const currentHost = (): ArticlePreviewCurrentHostInput =>
    {
        if (disposed)
        {
            throw new Error('preview-authorities-disposed');
        }
        const host = options.readHost();
        if (!options.documentContext.isCurrentContext(host.context))
        {
            throw new Error('preview-authorities-context-changed');
        }
        return host;
    };
    const currentRead = (): AuthorityRead =>
    {
        const host = currentHost();
        if (!loaded || loaded.signal.aborted || loaded.contextDigest !== host.context.contextDigest
            || loaded.revisionId !== host.revisionId)
        {
            throw new Error('preview-authorities-not-current');
        }
        return loaded;
    };
    const readResponsibility = (): ArticleDraftResponsibilitySource | null =>
    {
        const read = currentRead();
        const editing = options.readEditingResponsibility();
        return editing === undefined ? read.responsibility : editing;
    };
    const readSiteAuthor = (): string =>
    {
        const read = currentRead();
        const hostAuthor = options.readCurrentSiteAuthor();
        // A later host config edit invalidates admission without replacing the host's configuration.
        // An unchanged host cache cannot override the fresh canonical API observation.
        if (hostAuthor !== read.hostSiteAuthor)
        {
            if (hostAuthor === undefined)
            {
                throw new Error('preview-site-author-unavailable');
            }
            return hostAuthor;
        }
        return read.siteAuthor;
    };
    const state = (): ArticlePreviewCurrentAuthoritiesState =>
    {
        let currentStatus = status;
        let responsibilitySource: ArticlePreviewCurrentAuthoritiesState['responsibilitySource'] = 'missing';
        const reasons: string[] = failure ? [failure] : [];
        if (loaded)
        {
            try
            {
                const editing = options.readEditingResponsibility();
                const responsibility = readResponsibility();
                responsibilitySource = editing !== undefined ? 'editing' : responsibility ? 'revision-history' : 'missing';
                if (editing === undefined && !loaded.historyRead)
                {
                    currentStatus = 'unavailable';
                    if (!reasons.includes('current-authoring-responsibility-transport-unavailable'))
                    {
                        reasons.push('current-authoring-responsibility-transport-unavailable');
                    }
                }
                if (!responsibility)
                {
                    reasons.push('responsibility-missing');
                }
                else if (responsibility.responsiblePersonConfirmed !== true)
                {
                    reasons.push('responsibility-person-unconfirmed');
                }
                if (!readSiteAuthor().trim())
                {
                    reasons.push('site-author-missing');
                }
            }
            catch
            {
                currentStatus = 'stale';
                reasons.push('preview-authorities-not-current');
            }
        }
        return Object.freeze({ status: currentStatus, responsibilitySource,
            reasons: Object.freeze(reasons), currentResponsibilityTransport: 'unavailable' });
    };
    const inputIdentity = (host: ArticlePreviewCurrentHostInput): string =>
    {
        const editing = options.readEditingResponsibility();
        return digest({ contextDigest: host.context.contextDigest, revisionId: host.revisionId,
            authoringInputDigest: host.authoringInputDigest ?? null, responsibility: editing ?? null,
            hasEditingInput: editing !== undefined, siteAuthor: options.readCurrentSiteAuthor() ?? null });
    };
    const superseded = (): ArticlePreviewCurrentAuthoritiesState => Object.freeze({ status: 'canceled',
        responsibilitySource: 'missing', reasons: Object.freeze(['preview-authorities-superseded']),
        currentResponsibilityTransport: 'unavailable' });

    return {
        get state()
        {
            return state();
        },
        async refresh(signal)
        {
            cancel();
            const sequence = generation;
            const controller = new AbortController();
            active = controller;
            const requestSignal = AbortSignal.any([signal, controller.signal]);
            status = 'pending';
            failure = null;
            let onAbort: (() => void) | undefined;
            try
            {
                const host = currentHost();
                const identity = inputIdentity(host);
                requestSignal.throwIfAborted();
                const editing = options.readEditingResponsibility();
                const canReadHistory = editing === undefined && host.context.articleId !== null
                    && host.revisionId !== null && /^[1-9]\d*$/u.test(host.revisionId);
                const work = Promise.all([
                    getSiteConfig({ signal: requestSignal }),
                    canReadHistory ? getArticleResponsibilityHistory(host.context.articleId, host.revisionId,
                        { signal: requestSignal }) : Promise.resolve(null)
                ]);
                const response = await Promise.race([work, new Promise<never>((_, reject) =>
                {
                    onAbort = () => reject(new DOMException('Preview authority read canceled', 'AbortError'));
                    requestSignal.addEventListener('abort', onAbort, { once: true });
                    if (requestSignal.aborted)
                    {
                        onAbort();
                    }
                })]);
                requestSignal.throwIfAborted();
                if (sequence !== generation)
                {
                    return superseded();
                }
                if (inputIdentity(currentHost()) !== identity)
                {
                    status = 'stale';
                    failure = 'preview-authorities-input-changed';
                    controller.abort(failure);
                    return state();
                }
                const [site, history] = response;
                if (typeof site?.author !== 'string')
                {
                    throw new Error('preview-site-author-unavailable');
                }
                loaded = Object.freeze({ contextDigest: host.context.contextDigest, revisionId: host.revisionId,
                    responsibility: history === null ? null : savedResponsibility(history, host),
                    siteAuthor: site.author, hostSiteAuthor: options.readCurrentSiteAuthor(),
                    signal: requestSignal, historyRead: canReadHistory });
                status = canReadHistory || editing !== undefined ? 'ready' : 'unavailable';
                failure = status === 'unavailable' ? 'current-authoring-responsibility-transport-unavailable' : null;
                return state();
            }
            catch
            {
                if (sequence === generation)
                {
                    loaded = null;
                    status = requestSignal.aborted ? 'canceled' : 'failed';
                    failure = requestSignal.aborted ? 'preview-authorities-canceled' : 'preview-authorities-read-failed';
                    controller.abort(failure);
                }
                return sequence === generation ? state() : superseded();
            }
            finally
            {
                if (onAbort)
                {
                    requestSignal.removeEventListener('abort', onAbort);
                }
                if (active === controller)
                {
                    active = null;
                }
            }
        },
        read: () =>
        {
            const { context, source, attachmentLifecycleHistory, authoringInputDigest } = currentHost();
            return { context, source, attachmentLifecycleHistory, authoringInputDigest,
                responsibility: readResponsibility(), siteAuthor: readSiteAuthor() };
        },
        readResponsibility,
        readSiteAuthor,
        cancel,
        dispose: () =>
        {
            if (!disposed)
            {
                cancel();
                disposed = true;
                stop();
            }
        }
    };
}
