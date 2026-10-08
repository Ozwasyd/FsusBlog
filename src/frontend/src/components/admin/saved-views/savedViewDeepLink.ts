export type SavedViewDeepLink =
    | { status: 'none'; }
    | { status: 'invalid'; reason: string; }
    | { status: 'resolve'; viewId: string; schemaVersion: number; };

const viewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isViewId(value: string): boolean
{
    return viewIdPattern.test(value) && value !== '00000000-0000-0000-0000-000000000000';
}

/** The route owner supplies the path. Links contain no names, AST or private values. */
export function buildSavedViewDeepLink(path: string, viewId: string, schemaVersion: number): string
{
    if (!/^\/(?!\/)[^?#]*$/u.test(path) || /[\\\p{Cc}]/u.test(path) || !isViewId(viewId)
        || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
    {
        throw new Error('saved_view_deep_link_invalid');
    }
    const parameters = new URLSearchParams({ view: viewId, viewSchema: String(schemaVersion) });
    return `${path}?${parameters}`;
}

/** Resolve identity through the server; a link never proves ownership or execution. */
export function readSavedViewDeepLink(parameters: URLSearchParams): SavedViewDeepLink
{
    if (!parameters.has('view'))
    {
        return { status: 'none' };
    }
    const viewId = parameters.get('view')!;
    const version = parameters.get('viewSchema');
    if ([...parameters.keys()].some(key => key !== 'view' && key !== 'viewSchema')
        || parameters.getAll('view').length !== 1
        || parameters.getAll('viewSchema').length !== 1
        || !isViewId(viewId) || !version || !/^[1-9][0-9]{0,8}$/u.test(version))
    {
        return { status: 'invalid', reason: '视图链接无效，请重新选择视图。' };
    }
    return { status: 'resolve', viewId, schemaVersion: Number(version) };
}
