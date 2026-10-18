import type { ArticleAnchorCaptureOptions } from './articleAnchorContext';
import type { ArticleEditorSurface } from './articleEditorSurface';
import type { MarkdownEditorSourceNavigationView, MarkdownEditorSourceNavigationViewOptions } from '@ozwasyd/element-plus';

/** Product metadata accompanies the exact native observation; neither grants admission. */
export interface AuthoringWorkspaceNavigationView
{
    readonly source: MarkdownEditorSourceNavigationView;
    readonly capture: ArticleAnchorCaptureOptions;
}

export interface AuthoringWorkspaceNavigationViewPort
{
    readSourceNavigationView(options: MarkdownEditorSourceNavigationViewOptions): AuthoringWorkspaceNavigationView | null;
    isCurrentSourceNavigationView(view: AuthoringWorkspaceNavigationView): boolean;
}

export interface AuthoringNativeNavigationViewPort
{
    readSourceNavigationView(options: MarkdownEditorSourceNavigationViewOptions): MarkdownEditorSourceNavigationView | null;
    isCurrentSourceNavigationView(view: MarkdownEditorSourceNavigationView): boolean;
}

/** Custody belongs to this original wrapper lifetime, including its actual surface/tool state. */
export function createAuthoringWorkspaceNavigationViewOwner(read: () => Readonly<{
    native: AuthoringNativeNavigationViewPort;
    surface: ArticleEditorSurface;
    compare: boolean;
    generation: number;
}> | null): AuthoringWorkspaceNavigationViewPort
{
    const issued = new WeakMap<AuthoringWorkspaceNavigationView, NonNullable<ReturnType<typeof read>>>();
    function current(view: AuthoringWorkspaceNavigationView): boolean
    {
        const owner = issued.get(view);
        if (!owner)
        {
            return false;
        }
        const before = read();
        if (before?.native !== owner.native || before.surface !== owner.surface || before.compare !== owner.compare || before.generation !== owner.generation
            || !owner.native.isCurrentSourceNavigationView(view.source))
        {
            return false;
        }
        const after = read();
        return !!after && after.native === owner.native && after.surface === owner.surface && after.compare === owner.compare && after.generation === owner.generation;
    }
    return Object.freeze({
        readSourceNavigationView: (options: MarkdownEditorSourceNavigationViewOptions): AuthoringWorkspaceNavigationView | null =>
        {
            const owner = read();
            if (!owner)
            {
                return null;
            }
            const source = owner.native.readSourceNavigationView(options);
            if (!source)
            {
                return null;
            }
            const view = Object.freeze({ source, capture: Object.freeze({ affinity: source.affinity,
                viewportOffset: source.viewportOffset, percentage: source.percentage, surface: owner.surface,
                tool: owner.compare ? 'source-compare' as const : 'none' as const }) });
            issued.set(view, owner);
            return current(view) ? view : null;
        },
        isCurrentSourceNavigationView: current
    });
}
