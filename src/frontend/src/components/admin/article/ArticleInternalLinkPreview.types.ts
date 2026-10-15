/** Caller-owned opaque request token. Use a fresh object for every request/retry.
 * Pass the same object on its presentation; targetKey is never a slug or URL.
 * The host owns admission, AbortController, transport, selection and focus return.
 */
export interface ArticleInternalLinkPreviewRequest
{
    readonly targetKey: string;
    readonly signal: AbortSignal;
}

/** Plain, already-admitted display data only. Null means the fact is unavailable.
 * openInNewTab must be the host's authoritative canonical action, preserving its
 * editor context. This component neither resolves routes nor grants admission.
 */
export interface ArticleInternalLinkPreviewContent
{
    readonly title: string | null;
    readonly excerpt: string | null;
    readonly statusText: string | null;
    readonly sectionText: string | null;
    readonly openInNewTab: (() => void) | null;
}

export type ArticleInternalLinkPreviewPresentation = Readonly<{
    request: ArticleInternalLinkPreviewRequest;
}> & (
    | Readonly<{ state: 'ready'; content: ArticleInternalLinkPreviewContent; }>
    | Readonly<{ state: 'loading' | 'error' | 'empty' | 'aborted' | 'stale'; }>
);
