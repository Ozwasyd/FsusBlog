import { ENABLED_LOCALES, isSupportedLocale, type SupportedLocale } from './localeCatalog';
import {
    LOCALE_DOMAINS,
    isLocaleDomain,
    type LocaleDomain,
    type LocaleDomainArtifact,
    type LocaleDomainIdentity
} from './localeDomains';

type LocaleDomainModule = Readonly<Record<string, unknown>> & Readonly<{
    localeDomainIdentity?: LocaleDomainIdentity;
}>;
type LocaleDomainImporter = () => Promise<LocaleDomainModule>;

export type LocaleDomainLoader = Readonly<{
    locale: SupportedLocale;
    domain: LocaleDomain;
    exportName: string;
    schemaDigest: string;
    importModule: LocaleDomainImporter;
}>;

export type LocaleDomainLoaderRegistry = Readonly<
    Record<SupportedLocale, Readonly<Record<LocaleDomain, LocaleDomainLoader>>>
>;

interface InFlight {
    promise: Promise<LocaleDomainArtifact>;
    subscribers: number;
    cacheAllowed: boolean;
}

const EXPORT_NAMES: Readonly<Record<LocaleDomain, string>> = Object.freeze({
    common: 'common',
    public: 'publicMessages',
    article: 'article',
    auth: 'auth',
    identity: 'identity',
    layout: 'layout',
    messages: 'messages',
    security: 'security',
    admin: 'admin',
    errors: 'errors'
});

// These digests describe property names and leaf kinds, not translated values.
// The focused locale-domain contract test regenerates and checks this table.
export const LOCALE_DOMAIN_SCHEMA_DIGESTS: Readonly<Record<LocaleDomain, string>> = Object.freeze({
    common: 'fnv1a64:5e095c10692fa690',
    public: 'fnv1a64:4d3917b2cfcdec05',
    article: 'fnv1a64:f245ac00da8b2169',
    auth: 'fnv1a64:ab80b75ceb4d74f2',
    identity: 'fnv1a64:0c32c45b03b65a43',
    layout: 'fnv1a64:787733fa4d7dae24',
    messages: 'fnv1a64:91797ababdcdb013',
    security: 'fnv1a64:834e719c9d47690d',
    admin: 'fnv1a64:91f19fb7a7303f1f',
    errors: 'fnv1a64:69d72f2c2060118c'
});

function loadersFor(
    locale: SupportedLocale,
    imports: Readonly<Record<LocaleDomain, LocaleDomainImporter>>
): Readonly<Record<LocaleDomain, LocaleDomainLoader>>
{
    return Object.freeze(Object.fromEntries(LOCALE_DOMAINS.map((domain) => [
        domain,
        Object.freeze({
            locale,
            domain,
            exportName: EXPORT_NAMES[domain],
            schemaDigest: LOCALE_DOMAIN_SCHEMA_DIGESTS[domain],
            importModule: imports[domain]
        })
    ])) as Record<LocaleDomain, LocaleDomainLoader>);
}

export const LOCALE_DOMAIN_LOADERS: LocaleDomainLoaderRegistry = Object.freeze({
    'zh-CN': loadersFor('zh-CN', {
        common: () => import('./zh-CN/common'),
        public: () => import('./zh-CN/public'),
        article: () => import('./zh-CN/article'),
        auth: () => import('./zh-CN/auth'),
        identity: () => import('./zh-CN/identity'),
        layout: () => import('./zh-CN/layout'),
        messages: () => import('./zh-CN/messages'),
        security: () => import('./zh-CN/security'),
        admin: () => import('./zh-CN/admin'),
        errors: () => import('./zh-CN/errors')
    }),
    'en-US': loadersFor('en-US', {
        common: () => import('./en-US/common'),
        public: () => import('./en-US/public'),
        article: () => import('./en-US/article'),
        auth: () => import('./en-US/auth'),
        identity: () => import('./en-US/identity'),
        layout: () => import('./en-US/layout'),
        messages: () => import('./en-US/messages'),
        security: () => import('./en-US/security'),
        admin: () => import('./en-US/admin'),
        errors: () => import('./en-US/errors')
    }),
    'zh-Hant': loadersFor('zh-Hant', {
        common: () => import('./zh-Hant/common'),
        public: () => import('./zh-Hant/public'),
        article: () => import('./zh-Hant/article'),
        auth: () => import('./zh-Hant/auth'),
        identity: () => import('./zh-Hant/identity'),
        layout: () => import('./zh-Hant/layout'),
        messages: () => import('./zh-Hant/messages'),
        security: () => import('./zh-Hant/security'),
        admin: () => import('./zh-Hant/admin'),
        errors: () => import('./zh-Hant/errors')
    }),
    'ja-JP': loadersFor('ja-JP', {
        common: () => import('./ja-JP/common'),
        public: () => import('./ja-JP/public'),
        article: () => import('./ja-JP/article'),
        auth: () => import('./ja-JP/auth'),
        identity: () => import('./ja-JP/identity'),
        layout: () => import('./ja-JP/layout'),
        messages: () => import('./ja-JP/messages'),
        security: () => import('./ja-JP/security'),
        admin: () => import('./ja-JP/admin'),
        errors: () => import('./ja-JP/errors')
    }),
    'ko-KR': loadersFor('ko-KR', {
        common: () => import('./ko-KR/common'),
        public: () => import('./ko-KR/public'),
        article: () => import('./ko-KR/article'),
        auth: () => import('./ko-KR/auth'),
        identity: () => import('./ko-KR/identity'),
        layout: () => import('./ko-KR/layout'),
        messages: () => import('./ko-KR/messages'),
        security: () => import('./ko-KR/security'),
        admin: () => import('./ko-KR/admin'),
        errors: () => import('./ko-KR/errors')
    }),
    'es-419': loadersFor('es-419', {
        common: () => import('./es-419/common'),
        public: () => import('./es-419/public'),
        article: () => import('./es-419/article'),
        auth: () => import('./es-419/auth'),
        identity: () => import('./es-419/identity'),
        layout: () => import('./es-419/layout'),
        messages: () => import('./es-419/messages'),
        security: () => import('./es-419/security'),
        admin: () => import('./es-419/admin'),
        errors: () => import('./es-419/errors')
    }),
    'fr-FR': loadersFor('fr-FR', {
        common: () => import('./fr-FR/common'),
        public: () => import('./fr-FR/public'),
        article: () => import('./fr-FR/article'),
        auth: () => import('./fr-FR/auth'),
        identity: () => import('./fr-FR/identity'),
        layout: () => import('./fr-FR/layout'),
        messages: () => import('./fr-FR/messages'),
        security: () => import('./fr-FR/security'),
        admin: () => import('./fr-FR/admin'),
        errors: () => import('./fr-FR/errors')
    }),
    'de-DE': loadersFor('de-DE', {
        common: () => import('./de-DE/common'),
        public: () => import('./de-DE/public'),
        article: () => import('./de-DE/article'),
        auth: () => import('./de-DE/auth'),
        identity: () => import('./de-DE/identity'),
        layout: () => import('./de-DE/layout'),
        messages: () => import('./de-DE/messages'),
        security: () => import('./de-DE/security'),
        admin: () => import('./de-DE/admin'),
        errors: () => import('./de-DE/errors')
    }),
    'pt-BR': loadersFor('pt-BR', {
        common: () => import('./pt-BR/common'),
        public: () => import('./pt-BR/public'),
        article: () => import('./pt-BR/article'),
        auth: () => import('./pt-BR/auth'),
        identity: () => import('./pt-BR/identity'),
        layout: () => import('./pt-BR/layout'),
        messages: () => import('./pt-BR/messages'),
        security: () => import('./pt-BR/security'),
        admin: () => import('./pt-BR/admin'),
        errors: () => import('./pt-BR/errors')
    }),
    'ru-RU': loadersFor('ru-RU', {
        common: () => import('./ru-RU/common'),
        public: () => import('./ru-RU/public'),
        article: () => import('./ru-RU/article'),
        auth: () => import('./ru-RU/auth'),
        identity: () => import('./ru-RU/identity'),
        layout: () => import('./ru-RU/layout'),
        messages: () => import('./ru-RU/messages'),
        security: () => import('./ru-RU/security'),
        admin: () => import('./ru-RU/admin'),
        errors: () => import('./ru-RU/errors')
    })
});

function cacheKey(locale: SupportedLocale, domain: LocaleDomain): string
{
    return `${locale}\u0000${domain}`;
}

function abortError(): DOMException
{
    return new DOMException('Locale domain load aborted', 'AbortError');
}

function leafKind(value: unknown): string
{
    if (typeof value === 'string')
    {
        return 'string';
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return typeof value;
    }
    if (
        Reflect.get(value, 'kind') === 'plural'
    && typeof Reflect.get(value, 'forms') === 'object'
    && Reflect.get(value, 'forms') !== null
    )
    {
        return 'plural';
    }
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
        `${JSON.stringify(key)}:${leafKind((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function localeDomainSchemaDigest(value: unknown): string
{
    const input = leafKind(value);
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < input.length; index += 1)
    {
        hash ^= BigInt(input.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function validateRegistry(registry: LocaleDomainLoaderRegistry): void
{
    const expectedLocales = ENABLED_LOCALES.map(({ code }) => code).sort();
    const actualLocales = Object.keys(registry).sort();
    if (JSON.stringify(actualLocales) !== JSON.stringify(expectedLocales))
    {
        throw new Error('locale_domain_loader_locale_identity_drift');
    }
    for (const locale of expectedLocales)
    {
        const entries = registry[locale];
        const actualDomains = Object.keys(entries).sort();
        const expectedDomains = [...LOCALE_DOMAINS].sort();
        if (JSON.stringify(actualDomains) !== JSON.stringify(expectedDomains))
        {
            throw new Error(`locale_domain_loader_domain_identity_drift:${locale}`);
        }
        for (const domain of LOCALE_DOMAINS)
        {
            const entry = entries[domain];
            if (entry.locale !== locale || entry.domain !== domain || entry.exportName !== EXPORT_NAMES[domain])
            {
                throw new Error(`locale_domain_loader_entry_identity_drift:${locale}:${domain}`);
            }
        }
    }
}

export class LocaleDomainBundleStore
{
    private readonly artifacts = new Map<string, LocaleDomainArtifact>();
    private readonly inFlight = new Map<string, InFlight>();

    constructor(private readonly registry: LocaleDomainLoaderRegistry = LOCALE_DOMAIN_LOADERS)
    {
        validateRegistry(registry);
    }

    peekLocaleDomain<Domain extends LocaleDomain>(
        locale: SupportedLocale,
        domain: Domain
    ): LocaleDomainArtifact<Domain> | undefined
    {
        return this.artifacts.get(cacheKey(locale, domain)) as LocaleDomainArtifact<Domain> | undefined;
    }

    async loadLocaleDomain<Domain extends LocaleDomain>(
        locale: SupportedLocale,
        domain: Domain,
        signal?: AbortSignal
    ): Promise<LocaleDomainArtifact<Domain>>
    {
        if (!isSupportedLocale(locale))
        {
            throw new Error(`unsupported_locale:${String(locale)}`);
        }
        if (!isLocaleDomain(domain))
        {
            throw new Error(`unsupported_locale_domain:${String(domain)}`);
        }
        if (signal?.aborted)
        {
            throw abortError();
        }

        const key = cacheKey(locale, domain);
        const cached = this.artifacts.get(key);
        if (cached)
        {
            return cached as LocaleDomainArtifact<Domain>;
        }

        let flight = this.inFlight.get(key);
        if (!flight)
        {
            const loader = this.registry[locale][domain];
            flight = { promise: Promise.resolve(undefined as never), subscribers: 0, cacheAllowed: true };
            const currentFlight = flight;
            currentFlight.promise = loader.importModule().then((module) =>
            {
                const artifact = module[loader.exportName];
                const moduleKeys = Object.keys(module).sort();
                if (
                    artifact === undefined
          || JSON.stringify(moduleKeys) !== JSON.stringify([loader.exportName, 'localeDomainIdentity'].sort())
                )
                {
                    throw new Error(`locale_domain_export_identity_drift:${locale}:${domain}`);
                }
                const identity = module.localeDomainIdentity;
                if (identity?.locale !== locale || identity.domain !== domain)
                {
                    throw new Error(
                        `locale_domain_module_identity_drift:${locale}:${domain}:`
            + `${String(identity?.locale)}:${String(identity?.domain)}`
                    );
                }
                const digest = localeDomainSchemaDigest(artifact);
                if (digest !== loader.schemaDigest)
                {
                    throw new Error(`locale_domain_schema_drift:${locale}:${domain}:${digest}`);
                }
                if (currentFlight.cacheAllowed)
                {
                    this.artifacts.set(key, artifact as LocaleDomainArtifact);
                }
                return artifact as LocaleDomainArtifact;
            }).finally(() =>
            {
                if (this.inFlight.get(key) === currentFlight)
                {
                    this.inFlight.delete(key);
                }
            });
            this.inFlight.set(key, currentFlight);
            flight = currentFlight;
        }

        flight.subscribers += 1;
        return this.subscribe(key, flight, signal) as Promise<LocaleDomainArtifact<Domain>>;
    }

    async loadLocaleDomains(
        locale: SupportedLocale,
        domains: readonly LocaleDomain[],
        signal?: AbortSignal
    ): Promise<Readonly<Partial<Record<LocaleDomain, LocaleDomainArtifact>>>>
    {
        const uniqueDomains = [...new Set(domains)];
        const artifacts = await Promise.all(uniqueDomains.map((domain) =>
            this.loadLocaleDomain(locale, domain, signal)));
        return Object.freeze(Object.fromEntries(uniqueDomains.map((domain, index) =>
            [domain, artifacts[index]])) as Partial<Record<LocaleDomain, LocaleDomainArtifact>>);
    }

    clearForTests(): void
    {
        this.artifacts.clear();
        this.inFlight.clear();
    }

    private subscribe(
        key: string,
        flight: InFlight,
        signal?: AbortSignal
    ): Promise<LocaleDomainArtifact>
    {
        let settled = false;
        const detach = (): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            flight.subscribers -= 1;
            if (flight.subscribers === 0 && this.inFlight.get(key) === flight)
            {
                flight.cacheAllowed = false;
                this.inFlight.delete(key);
            }
        };

        if (!signal)
        {
            return flight.promise.finally(detach);
        }
        return new Promise((resolve, reject) =>
        {
            const onAbort = (): void =>
            {
                detach();
                reject(abortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            flight.promise.then(resolve, reject).finally(() =>
            {
                signal.removeEventListener('abort', onAbort);
                detach();
            });
        });
    }
}

export const localeDomainBundleStore = new LocaleDomainBundleStore();

export const loadLocaleDomain = localeDomainBundleStore.loadLocaleDomain.bind(localeDomainBundleStore);
export const loadLocaleDomains = localeDomainBundleStore.loadLocaleDomains.bind(localeDomainBundleStore);
export const peekLocaleDomain = localeDomainBundleStore.peekLocaleDomain.bind(localeDomainBundleStore);
