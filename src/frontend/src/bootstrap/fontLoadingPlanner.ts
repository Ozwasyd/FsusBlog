export const FONT_LOADING_PLAN_SCHEMA = 'fsusblog.font.loading-plan.v1';
export const FONT_LOADING_EVIDENCE_SCHEMA = 'fsusblog.font.loading-evidence.v1';
export const FONT_PRELOAD_BUDGET = 4;

export type BundledFontFaceId =
  | 'google-sans:400'
  | 'google-sans:500'
  | 'google-sans:700'
  | 'noto-sans-sc:400'
  | 'noto-sans-sc:500'
  | 'noto-sans-sc:700'
  | 'noto-sans-tc:400'
  | 'noto-sans-tc:500'
  | 'noto-sans-tc:700'
  | 'noto-sans-jp:400'
  | 'noto-sans-jp:500'
  | 'noto-sans-jp:700'
  | 'jetbrains-mono:400'
  | 'jetbrains-mono:500'
  | 'jetbrains-mono:700';

export type BundledFontLoadTrigger = 'critical' | 'idle' | 'route' | 'locale' | 'content';

export type BundledFontLoadingPlan = Readonly<{
    schema: typeof FONT_LOADING_PLAN_SCHEMA;
    critical: readonly BundledFontFaceId[];
    deferred: readonly BundledFontFaceId[];
    preload: readonly BundledFontFaceId[];
    route: Readonly<Record<'shell' | 'article' | 'admin', readonly BundledFontFaceId[]>>;
    locale: Readonly<Record<'zh-CN' | 'zh-TW' | 'ja-JP', readonly BundledFontFaceId[]>>;
    fallback: readonly string[];
}>;

export type BundledFontLoadingContext = Readonly<{
    pathname?: string;
    locale?: string;
    hasCode?: boolean;
    hasEmoji?: boolean;
    trigger?: Exclude<BundledFontLoadTrigger, 'critical'>;
}>;

export type BundledFontLoadResult = Readonly<{
    faceId: BundledFontFaceId;
    status: 'loaded' | 'failed' | 'deduplicated';
}>;

export type BundledFontLoadingEvidence = Readonly<{
    schema: typeof FONT_LOADING_EVIDENCE_SCHEMA;
    status: 'ok' | 'fallback';
    trigger: BundledFontLoadTrigger;
    requested: readonly BundledFontFaceId[];
    loaded: readonly BundledFontFaceId[];
    failed: readonly BundledFontFaceId[];
    deduplicated: readonly BundledFontFaceId[];
    preloadCount: number;
    preloadBudget: number;
    fallbackPreserved: true;
}>;

type FontStyleLoader = () => Promise<unknown>;
export type BundledFontStyleLoad = (faceId: BundledFontFaceId) => Promise<unknown>;

const CRITICAL_FACES: readonly BundledFontFaceId[] = [
    'google-sans:400',
    'google-sans:500',
    'google-sans:700',
    'noto-sans-sc:400',
    'noto-sans-sc:500'
];

const DEFERRED_FACES: readonly BundledFontFaceId[] = [
    'noto-sans-sc:700',
    'noto-sans-tc:400',
    'noto-sans-tc:500',
    'noto-sans-tc:700',
    'noto-sans-jp:400',
    'noto-sans-jp:500',
    'noto-sans-jp:700',
    'jetbrains-mono:400',
    'jetbrains-mono:500',
    'jetbrains-mono:700'
];

const CODE_FACES: readonly BundledFontFaceId[] = [
    'jetbrains-mono:400',
    'jetbrains-mono:500',
    'jetbrains-mono:700'
];

const LOCALE_FACES = {
    'zh-CN': ['noto-sans-sc:700'],
    'zh-TW': ['noto-sans-tc:400', 'noto-sans-tc:500', 'noto-sans-tc:700'],
    'ja-JP': ['noto-sans-jp:400', 'noto-sans-jp:500', 'noto-sans-jp:700']
} as const satisfies BundledFontLoadingPlan['locale'];

const ROUTE_FACES = {
    shell: ['noto-sans-sc:700'],
    article: ['noto-sans-sc:700'],
    admin: CODE_FACES
} as const satisfies BundledFontLoadingPlan['route'];

export const BUNDLED_FONT_LOADING_PLAN: BundledFontLoadingPlan = Object.freeze({
    schema: FONT_LOADING_PLAN_SCHEMA,
    critical: CRITICAL_FACES,
    deferred: DEFERRED_FACES,
    preload: [
        'google-sans:400',
        'google-sans:500',
        'noto-sans-sc:400',
        'noto-sans-sc:500'
    ],
    route: ROUTE_FACES,
    locale: LOCALE_FACES,
    fallback: ['system-ui', 'ui-sans-serif', 'sans-serif', 'ui-monospace', 'monospace']
});

const fontStyleLoaders: Readonly<Record<BundledFontFaceId, FontStyleLoader | null>> = {
    'google-sans:400': null,
    'google-sans:500': null,
    'google-sans:700': null,
    'noto-sans-sc:400': null,
    'noto-sans-sc:500': null,
    'noto-sans-sc:700': () => import('@fontsource/noto-sans-sc/700.css'),
    'noto-sans-tc:400': () => import('@fontsource/noto-sans-tc/400.css'),
    'noto-sans-tc:500': () => import('@fontsource/noto-sans-tc/500.css'),
    'noto-sans-tc:700': () => import('@fontsource/noto-sans-tc/700.css'),
    'noto-sans-jp:400': () => import('@fontsource/noto-sans-jp/400.css'),
    'noto-sans-jp:500': () => import('@fontsource/noto-sans-jp/500.css'),
    'noto-sans-jp:700': () => import('@fontsource/noto-sans-jp/700.css'),
    'jetbrains-mono:400': () => import('@fontsource/jetbrains-mono/400.css'),
    'jetbrains-mono:500': () => import('@fontsource/jetbrains-mono/500.css'),
    'jetbrains-mono:700': () => import('@fontsource/jetbrains-mono/700.css')
};

const loadedFaces = new Set<BundledFontFaceId>();
const pendingFaces = new Map<BundledFontFaceId, Promise<BundledFontLoadResult>>();

export function validateFontPreloadBudget(
    plan: BundledFontLoadingPlan,
    budget = FONT_PRELOAD_BUDGET
): void
{
    if (!Number.isInteger(budget) || budget < 0 || plan.preload.length > budget)
    {
        throw new Error(`font_preload_budget_exceeded:${plan.preload.length}:${budget}`);
    }
    if (new Set(plan.preload).size !== plan.preload.length)
    {
        throw new Error('font_preload_duplicate');
    }
    if (plan.preload.some((faceId) => !plan.critical.includes(faceId)))
    {
        throw new Error('font_preload_not_critical');
    }
}

export function selectBundledDeferredFonts(
    context: BundledFontLoadingContext
): readonly BundledFontFaceId[]
{
    const trigger = context.trigger ?? 'idle';
    if (trigger === 'idle')
    {
        return DEFERRED_FACES;
    }

    if (trigger === 'content')
    {
        return context.hasCode ? CODE_FACES : [];
    }

    if (trigger === 'locale')
    {
        return resolveLocaleFaces(context.locale);
    }

    return ROUTE_FACES[resolveRoute(context.pathname)];
}

export function recordCriticalFontPlan(
    plan: BundledFontLoadingPlan = BUNDLED_FONT_LOADING_PLAN
): BundledFontLoadingEvidence
{
    validateFontPreloadBudget(plan);
    for (const faceId of plan.critical)
    {
        loadedFaces.add(faceId);
    }
    return emitEvidence('critical', plan.critical.map((faceId) => ({ faceId, status: 'loaded' })), plan);
}

export async function loadBundledFonts(
    context: BundledFontLoadingContext,
    plan: BundledFontLoadingPlan = BUNDLED_FONT_LOADING_PLAN,
    loadStyle: BundledFontStyleLoad = loadBundledFontStyle
): Promise<BundledFontLoadingEvidence>
{
    validateFontPreloadBudget(plan);
    const trigger = context.trigger ?? 'idle';
    const requested = selectBundledDeferredFonts(context);
    const results = await Promise.all(requested.map((faceId) => loadFace(faceId, loadStyle)));
    return emitEvidence(trigger, results, plan);
}

export function resetBundledFontLoadingStateForTests(): void
{
    loadedFaces.clear();
    pendingFaces.clear();
}

async function loadFace(
    faceId: BundledFontFaceId,
    loadStyle: BundledFontStyleLoad
): Promise<BundledFontLoadResult>
{
    if (loadedFaces.has(faceId))
    {
        return { faceId, status: 'deduplicated' };
    }

    const pending = pendingFaces.get(faceId);
    if (pending)
    {
        await pending;
        return { faceId, status: loadedFaces.has(faceId) ? 'deduplicated' : 'failed' };
    }

    const load = loadStyle(faceId)
        .then((): BundledFontLoadResult =>
        {
            loadedFaces.add(faceId);
            return { faceId, status: 'loaded' };
        })
        .catch((): BundledFontLoadResult => ({ faceId, status: 'failed' }))
        .finally(() => pendingFaces.delete(faceId));
    pendingFaces.set(faceId, load);
    return load;
}

function loadBundledFontStyle(faceId: BundledFontFaceId): Promise<unknown>
{
    const loader = fontStyleLoaders[faceId];
    return loader ? loader() : Promise.reject(new Error('font_style_loader_unavailable'));
}

function emitEvidence(
    trigger: BundledFontLoadTrigger,
    results: readonly BundledFontLoadResult[],
    plan: BundledFontLoadingPlan
): BundledFontLoadingEvidence
{
    const evidence: BundledFontLoadingEvidence = Object.freeze({
        schema: FONT_LOADING_EVIDENCE_SCHEMA,
        status: results.some((result) => result.status === 'failed') ? 'fallback' : 'ok',
        trigger,
        requested: results.map((result) => result.faceId),
        loaded: results.filter((result) => result.status === 'loaded').map((result) => result.faceId),
        failed: results.filter((result) => result.status === 'failed').map((result) => result.faceId),
        deduplicated: results.filter((result) => result.status === 'deduplicated').map((result) => result.faceId),
        preloadCount: plan.preload.length,
        preloadBudget: FONT_PRELOAD_BUDGET,
        fallbackPreserved: true
    });

    if (typeof window !== 'undefined')
    {
        window.dispatchEvent(new window.CustomEvent('fsus:font-loading-evidence', { detail: evidence }));
    }
    return evidence;
}

function resolveRoute(pathname = '/'): keyof BundledFontLoadingPlan['route']
{
    if (pathname.startsWith('/user/manage') || pathname.startsWith('/admin'))
    {
        return 'admin';
    }
    if (pathname.startsWith('/article') || pathname.startsWith('/post'))
    {
        return 'article';
    }
    return 'shell';
}

function resolveLocaleFaces(locale = 'und'): readonly BundledFontFaceId[]
{
    if (/^ja(?:-|$)/iu.test(locale))
    {
        return LOCALE_FACES['ja-JP'];
    }
    if (/^zh-(?:TW|HK|MO)(?:-|$)/iu.test(locale))
    {
        return LOCALE_FACES['zh-TW'];
    }
    if (/^zh(?:-|$)/iu.test(locale))
    {
        return LOCALE_FACES['zh-CN'];
    }
    return [];
}
