export type SavedViewDeepLink =
    | { status: 'none'; }
    | { status: 'invalid'; reason: string; }
    | { status: 'resolve'; viewId: string; schemaVersion: number; };

const viewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// The existing link grammar has nine decimal digits; schema support stays server-owned.
const maximumDeepLinkSchemaVersion = 999_999_999;

function isViewId(value: string): boolean
{
    return value.length === 36 && viewIdPattern.test(value)
        && value !== '00000000-0000-0000-0000-000000000000';
}

function isSchemaVersion(value: number): boolean
{
    return Number.isSafeInteger(value) && value >= 1 && value <= maximumDeepLinkSchemaVersion;
}

/** The route owner supplies the path. Links contain no names, AST or private values. */
export function buildSavedViewDeepLink(path: string, viewId: string, schemaVersion: number): string
{
    if (!/^\/(?!\/)[^?#]*$/u.test(path) || /[\\\p{Cc}]/u.test(path) || !isViewId(viewId)
        || !isSchemaVersion(schemaVersion))
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
    const schemaVersion = version === null ? Number.NaN : Number(version);
    if ([...parameters.keys()].some(key => key !== 'view' && key !== 'viewSchema')
        || parameters.getAll('view').length !== 1
        || parameters.getAll('viewSchema').length !== 1
        || !isViewId(viewId) || !isSchemaVersion(schemaVersion) || String(schemaVersion) !== version)
    {
        return { status: 'invalid', reason: '视图链接无效，请重新选择视图。' };
    }
    return { status: 'resolve', viewId, schemaVersion };
}
