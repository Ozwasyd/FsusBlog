/** Presentation only: the host admits labels and identities and owns each opaque action.
 * Null or undefined actions remain unavailable. These types are not a transport DTO.
 */
export interface InternalLinkPickerArticle {
    id: string;
    revision: string;
    title: string;
    statusText: string | null;
    updatedText: string | null;
    unavailableText: string | null;
    selectAction: unknown;
    headingsAction: unknown;
}

/** Heading IDs and revisions are supplied by the owner, never derived from labels. */
export interface InternalLinkPickerHeading {
    id: string;
    revision: string;
    title: string;
    unavailableText: string | null;
    selectAction: unknown;
}

export type InternalLinkPickerState = 'loading' | 'ready' | 'error' | 'cancelled';

export interface InternalLinkPickerSearchResult {
    requestKey: string;
    state: InternalLinkPickerState;
    articles: readonly InternalLinkPickerArticle[];
    /** Only caller-admitted, safe display copy; raw transport errors do not belong here. */
    message: string | null;
}

export interface InternalLinkPickerHeadingResult {
    requestKey: string;
    articleId: string;
    articleRevision: string;
    state: InternalLinkPickerState;
    headings: readonly InternalLinkPickerHeading[];
    message: string | null;
}

export interface InternalLinkPickerProps {
    modelValue: boolean;
    /** Change this when the host's command/selection context is replaced. */
    sessionKey: string;
    searchResult: InternalLinkPickerSearchResult | null;
    headingResult: InternalLinkPickerHeadingResult | null;
    /** Exact owner-provided current-selection diagnostic; null alone means no diagnostic. */
    selectionUnavailableText: string | null;
}

export interface InternalLinkPickerSearchRequest {
    sessionKey: string;
    requestKey: string;
    query: string;
}

export interface InternalLinkPickerHeadingRequest {
    sessionKey: string;
    requestKey: string;
    articleId: string;
    articleRevision: string;
    action: unknown;
}

export interface InternalLinkPickerSelection {
    sessionKey: string;
    searchRequestKey: string;
    headingRequestKey: string | null;
    articleId: string;
    articleRevision: string;
    headingId: string | null;
    headingRevision: string | null;
    action: unknown;
}

export interface InternalLinkPickerCancellation {
    sessionKey: string;
    scope: 'picker' | 'search' | 'headings';
    reason: 'dismiss' | 'replace-search' | 'back' | 'invalidated' | 'context-changed';
    searchRequestKey: string | null;
    headingRequestKey: string | null;
}

export interface InternalLinkPickerEmits {
    'update:modelValue': [value: boolean];
    'request-search': [request: InternalLinkPickerSearchRequest];
    'request-headings': [request: InternalLinkPickerHeadingRequest];
    select: [selection: InternalLinkPickerSelection];
    cancel: [cancellation: InternalLinkPickerCancellation];
    /** Notification only; the public dialog owns DOM focus return, the host owns editor focus. */
    closed: [];
}
