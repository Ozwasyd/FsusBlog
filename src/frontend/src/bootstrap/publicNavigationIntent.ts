import { isPublicSeoPath } from '@/bootstrap/publicShellPrimitives';

export type PublicNavigationIntentSource = 'link' | 'pagination' | 'search' | 'auth' | 'action';

export type PublicAtomicNavigationIntent = Readonly<{
    kind: 'atomic-public-route';
    href: string;
    fullPath: string;
    source: PublicNavigationIntentSource;
}>;

export type PublicNativeNavigationIntent = Readonly<{
    kind: 'native';
    reason:
    | 'modified-click'
    | 'external'
    | 'download'
    | 'empty'
    | 'api-route'
    | 'same-page-hash'
    | 'non-aot-route';
}>;

export type PublicCommentsIslandIntent = Readonly<{
    kind: 'comments-island';
}>;

export type PublicNavigationIntent =
  | PublicAtomicNavigationIntent
  | PublicNativeNavigationIntent
  | PublicCommentsIslandIntent;

export type PublicNavigationIntentInput = Readonly<{
    action?: string | null;
    anchor?: HTMLAnchorElement | null;
    currentHref?: string;
    event?: MouseEvent | null;
    href?: string | null;
    source?: PublicNavigationIntentSource;
}>;

function resolveBrowserHref(): string
{
    return typeof window === 'undefined' ? 'http://127.0.0.1/' : window.location.href;
}

function isModifiedMouseEvent(event?: MouseEvent | null): boolean
{
    return Boolean(
        event?.defaultPrevented ||
    event && event.button !== 0 ||
    event?.metaKey ||
    event?.ctrlKey ||
    event?.shiftKey ||
    event?.altKey
    );
}

function resolveHref(input: PublicNavigationIntentInput): string
{
    return input.href || input.anchor?.href || '';
}

export function classifyPublicNavigationIntent(input: PublicNavigationIntentInput): PublicNavigationIntent
{
    if (input.action === 'activate-comments')
    {
        return { kind: 'comments-island' };
    }

    if (isModifiedMouseEvent(input.event))
    {
        return { kind: 'native', reason: 'modified-click' };
    }

    if (input.anchor?.hasAttribute('download'))
    {
        return { kind: 'native', reason: 'download' };
    }

    if (input.anchor?.target && input.anchor.target !== '_self')
    {
        return { kind: 'native', reason: 'external' };
    }

    const rawHref = resolveHref(input);
    if (!rawHref || rawHref.startsWith('#'))
    {
        return { kind: 'native', reason: 'empty' };
    }

    const current = new URL(input.currentHref ?? resolveBrowserHref());
    const target = new URL(rawHref, current.origin);
    if (target.origin !== current.origin)
    {
        return { kind: 'native', reason: 'external' };
    }

    if (target.pathname.startsWith('/api/'))
    {
        return { kind: 'native', reason: 'api-route' };
    }

    if (
        target.hash &&
    target.pathname === current.pathname &&
    target.search === current.search
    )
    {
        return { kind: 'native', reason: 'same-page-hash' };
    }

    if (!isPublicSeoPath(target.pathname))
    {
        return { kind: 'native', reason: 'non-aot-route' };
    }

    return {
        kind: 'atomic-public-route',
        href: target.toString(),
        fullPath: `${target.pathname}${target.search}${target.hash}`,
        source: input.source ?? 'link'
    };
}
