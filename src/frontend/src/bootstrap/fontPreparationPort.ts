import type { SupportedLocale } from '@/locales/localeCatalog';
import {
    LOCALE_FONT_CATALOG_DIGEST,
    LOCALE_FONT_WEIGHTS,
    getLocaleFontDescriptor,
    type LocaleFontScript,
    type LocaleFontWeight
} from '@/locales/localeFontCatalog';

export const FONT_PREPARATION_RECEIPT_SCHEMA =
    'fsusblog.locale-font-preparation-receipt.v1' as const;

export type LocaleFontPreparationReceipt = Readonly<{
    schema: typeof FONT_PREPARATION_RECEIPT_SCHEMA;
    locale: SupportedLocale;
    script: LocaleFontScript;
    family: string;
    faceIds: readonly string[];
    weights: readonly LocaleFontWeight[];
    representativeText: string;
    catalogDigest: typeof LOCALE_FONT_CATALOG_DIGEST;
    generation: number;
}>;

export type FontFaceSetPort = Readonly<{
    load: (font: string, text?: string) => Promise<readonly unknown[]>;
    check: (font: string, text?: string) => boolean;
}>;

export type FontPreparationDependencies = Readonly<{
    fontFaceSet: () => FontFaceSetPort | undefined;
    loadScriptStyle: (script: LocaleFontScript) => Promise<unknown>;
}>;

export type FontPreparationPort = Readonly<{
    prepareLocaleFonts: (
        locale: SupportedLocale,
        weights: readonly LocaleFontWeight[],
        signal?: AbortSignal
    ) => Promise<LocaleFontPreparationReceipt>;
    peekPreparedLocaleFonts: (
        locale: SupportedLocale
    ) => LocaleFontPreparationReceipt | undefined;
}>;

const styleLoaders = {
    Hans: () => import('@/assets/fonts/hans.css'),
    Hant: () => import('@/assets/fonts/hant.css'),
    Jpan: () => import('@/assets/fonts/jpan.css'),
    Kore: () => import('@/assets/fonts/kore.css'),
    Latn: () => import('@/assets/fonts/latn.css'),
    Cyrl: () => import('@/assets/fonts/cyrl.css')
} satisfies Readonly<Record<LocaleFontScript, () => Promise<unknown>>>;

const defaultDependencies: FontPreparationDependencies = Object.freeze({
    fontFaceSet: () => (
        typeof document === 'undefined'
            ? undefined
            : document.fonts as unknown as FontFaceSetPort
    ),
    loadScriptStyle: (script) => styleLoaders[script]()
});

function abortError(): DOMException
{
    return new DOMException('Font preparation aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void
{
    if (signal?.aborted)
    {
        throw abortError();
    }
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>
{
    if (!signal)
    {
        return promise;
    }
    if (signal.aborted)
    {
        return Promise.reject(abortError());
    }

    return new Promise<T>((resolve, reject) =>
    {
        const abort = (): void =>
        {
            signal.removeEventListener('abort', abort);
            reject(abortError());
        };
        signal.addEventListener('abort', abort, { once: true });
        promise.then(
            (value) =>
            {
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            (error: unknown) =>
            {
                signal.removeEventListener('abort', abort);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        );
    });
}

function normalizeWeights(weights: readonly LocaleFontWeight[]): readonly LocaleFontWeight[]
{
    const supported = new Set<number>(LOCALE_FONT_WEIGHTS);
    if (weights.length === 0 || weights.some((weight) => !supported.has(weight)))
    {
        throw new Error(`font_preparation_weights_invalid:${weights.join(',')}`);
    }
    const normalized = [...new Set(weights)].sort((left, right) => left - right);
    return Object.freeze(normalized);
}

export function createFontPreparationPort(
    dependencies: FontPreparationDependencies = defaultDependencies
): FontPreparationPort
{
    const preparedFaces = new Set<string>();
    const pendingFaces = new Map<string, Promise<void>>();
    const preparedScripts = new Set<LocaleFontScript>();
    const pendingScripts = new Map<LocaleFontScript, Promise<void>>();
    const receipts = new Map<SupportedLocale, LocaleFontPreparationReceipt>();
    let receiptGeneration = 0;

    const prepareScript = async (
        script: LocaleFontScript,
        signal?: AbortSignal
    ): Promise<void> =>
    {
        if (preparedScripts.has(script))
        {
            return;
        }

        let pending = pendingScripts.get(script);
        if (!pending)
        {
            pending = dependencies.loadScriptStyle(script)
                .then(() =>
                {
                    preparedScripts.add(script);
                })
                .finally(() =>
                {
                    pendingScripts.delete(script);
                });
            pendingScripts.set(script, pending);
        }
        await awaitWithAbort(pending, signal);
    };

    const prepareFace = async (
        locale: SupportedLocale,
        family: string,
        faceId: string,
        weight: LocaleFontWeight,
        representativeText: string,
        signal?: AbortSignal
    ): Promise<void> =>
    {
        if (preparedFaces.has(faceId))
        {
            return;
        }

        let pending = pendingFaces.get(faceId);
        if (!pending)
        {
            pending = (async () =>
            {
                const fontFaceSet = dependencies.fontFaceSet();
                if (!fontFaceSet)
                {
                    throw new Error(`font_face_set_unavailable:${locale}:${faceId}`);
                }

                const query = `${weight} 1em "${family}"`;
                const faces = await fontFaceSet.load(query, representativeText);
                if (faces.length === 0)
                {
                    throw new Error(`font_face_load_empty:${locale}:${faceId}`);
                }
                if (!fontFaceSet.check(query, representativeText))
                {
                    throw new Error(`font_face_glyph_unavailable:${locale}:${faceId}`);
                }
                preparedFaces.add(faceId);
            })().finally(() =>
            {
                pendingFaces.delete(faceId);
            });
            pendingFaces.set(faceId, pending);
        }
        await awaitWithAbort(pending, signal);
    };

    const prepareLocaleFonts = async (
        locale: SupportedLocale,
        weights: readonly LocaleFontWeight[],
        signal?: AbortSignal
    ): Promise<LocaleFontPreparationReceipt> =>
    {
        throwIfAborted(signal);
        const descriptor = getLocaleFontDescriptor(locale);
        const normalizedWeights = normalizeWeights(weights);
        const selected = normalizedWeights.map((weight) =>
        {
            const index = descriptor.weights.indexOf(weight);
            const faceId = descriptor.faceIds[index];
            if (!faceId)
            {
                throw new Error(`font_catalog_face_missing:${locale}:${weight}`);
            }
            return Object.freeze({ faceId, weight });
        });

        await prepareScript(descriptor.script, signal);
        await Promise.all(selected.map(({ faceId, weight }) => prepareFace(
            locale,
            descriptor.family,
            faceId,
            weight,
            descriptor.representativeText,
            signal
        )));
        throwIfAborted(signal);

        const receipt = Object.freeze({
            schema: FONT_PREPARATION_RECEIPT_SCHEMA,
            locale,
            script: descriptor.script,
            family: descriptor.family,
            faceIds: Object.freeze(selected.map(({ faceId }) => faceId)),
            weights: normalizedWeights,
            representativeText: descriptor.representativeText,
            catalogDigest: LOCALE_FONT_CATALOG_DIGEST,
            generation: ++receiptGeneration
        });
        receipts.set(locale, receipt);
        return receipt;
    };

    return Object.freeze({
        prepareLocaleFonts,
        peekPreparedLocaleFonts: (locale: SupportedLocale) => receipts.get(locale)
    });
}

export const fontPreparationPort = createFontPreparationPort();
export const prepareLocaleFonts = fontPreparationPort.prepareLocaleFonts;
export const peekPreparedLocaleFonts = fontPreparationPort.peekPreparedLocaleFonts;
