import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the repository source identity authority.
import { resolveSourceCommit, resolveWorktreeFingerprint } from '../../tools/fact-extractors/identity.mjs';
import {
    buildLocaleDomainArtifacts,
    checkLocaleDomainStatic,
    loadEnabledLocales
// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the existing typed artifact validator rather than creating another authority.
} from '../../tools/frontend/check-locale-domain-static.mjs';

import { createPublicShellFiniteInputOwner } from './public-shell-finite-input-owner.mjs';

export const publicShellLocaleMatrixSchema = 'fsusblog.public-shell-locale-matrix.v1';
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const localeDirectory = 'src/frontend/src/locales';
const matrixPath = 'tests/browser-contract/public-shell-locale-matrix.mjs';

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function canonical(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
}

export function publicShellLocaleContentDigest(value)
{
    return digest(JSON.stringify(canonical(value)));
}

/** Keep the required ja → de → ru race, then make this scene's target the latest selection. */
export function publicShellLocaleRapidTargets(descriptors, target)
{
    assert.ok(descriptors.some((item) => item.code === target), 'rapid target must belong to the enabled catalog');
    const targets = ['ja', 'de', 'ru'].map((alias) =>
    {
        const matches = descriptors.filter((item) => item.aliases.includes(alias));
        assert.equal(matches.length, 1, `rapid transition alias ${alias} must resolve exactly once`);
        return matches[0].code;
    });
    if (targets.at(-1) !== target)
    {
        targets.push(target);
    }
    return targets;
}

/** Load only the pure catalog projections and typed artifacts, never the app runtime. */
async function loadAuthorities(root)
{
    const refs = new Map();
    async function source(relativePath)
    {
        const bytes = await readFile(path.join(root, relativePath));
        refs.set(relativePath, { path: relativePath, digest: digest(bytes) });
        return bytes.toString('utf8');
    }
    const owner = await createPublicShellFiniteInputOwner(root);
    const { catalog, locales } = loadEnabledLocales(root);
    assert.equal(locales.length, 10, 'PublicShell requires exactly ten enabled locales');
    const structure = checkLocaleDomainStatic({ rootDir: root });
    assert.equal(structure.ok, true, JSON.stringify(structure.errors));
    const projection = await owner.load('localeCatalog');
    assert.deepEqual(projection.ENABLED_LOCALES, catalog.locales.filter((item) => item.status === 'enabled'));
    assert.equal(projection.DEFAULT_LOCALE, catalog.defaultCode);
    const routeDomains = await owner.load('routeDomains');
    const fonts = await owner.load('fonts');
    const selector = await owner.load('selector');
    const artifacts = new Map();
    for (const artifact of buildLocaleDomainArtifacts({ rootDir: root }))
    {
        const values = await owner.loadDomain(artifact.locale, artifact.domain);
        assert.deepEqual(values.localeDomainIdentity, { locale: artifact.locale, domain: artifact.domain });
        assert.ok(values[artifact.exportName], `missing typed export: ${artifact.relativeFile}`);
        artifacts.set(`${artifact.locale}/${artifact.domain}`, {
            values: values[artifact.exportName],
            ref: artifact.relativeFile
        });
    }
    for (const reference of owner.refs())
    {
        refs.set(reference.path, { path: reference.path, digest: reference.digest.slice('sha256:'.length) });
    }
    for (const relativePath of [
        'src/shared/Contracts/Localization/locale-catalog.json',
        `${localeDirectory}/keys.ts`,
        `${localeDirectory}/localeDomains.ts`,
        'tools/frontend/check-locale-domain-static.mjs',
        'tools/fact-extractors/identity.mjs',
        'tools/fact-extractors/lib/canonicalize.mjs',
        'tools/contracts/generate-locale-catalog.mjs',
        'src/frontend/src/bootstrap/fontPreparationPort.ts',
        'tests/browser-contract/contract.mjs',
        'tests/browser-contract/fixture.mjs',
        'docs/frontend/public-shell-ownership.md',
        matrixPath,
        'tests/browser-contract/public-shell-finite-input-owner.mjs',
        'src/backend/Infrastructure/PublicAot/LocaleResolver.cs',
        'src/backend/Infrastructure/PublicAot/LocalePreferenceCookieService.cs',
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs',
        'src/backend/Services/UserLocalePreferenceService.cs',
        'src/backend/Entities/UserLocalePreference.cs'
    ])
    {
        await source(relativePath);
    }
    for (const item of projection.ENABLED_LOCALES)
    {
        const font = fonts.getLocaleFontDescriptor(item.code);
        assert.equal(font.script, item.script, `wrong font script: ${item.code}`);
        await source(`src/frontend/src/assets/fonts/${font.assetFile}`);
    }
    return { catalog, projection, routeDomains, fonts, selector, artifacts, refs };
}

function copyReference(authorities, locale, key)
{
    const [domain, ...segments] = key.split('.');
    const artifact = authorities.artifacts.get(`${locale}/${domain}`);
    assert.ok(artifact, `unknown locale/domain: ${locale}/${domain}`);
    let value = artifact.values;
    for (const segment of segments)
    {
        assert.ok(value && Object.hasOwn(value, segment), `unknown typed key: ${key}`);
        value = value[segment];
    }
    assert.equal(typeof value, 'string', `expected ordinary typed string: ${key}`);
    return { key, artifactRef: artifact.ref, valueDigest: digest(value) };
}

function negotiationCases(descriptors, defaultCode, disabledDescriptors)
{
    const cases = [];
    for (const [index, item] of descriptors.entries())
    {
        const other = descriptors[(index + 1) % descriptors.length].code;
        const add = (kind, header, cookie, locale, source, matchedRange, preferencePreparation = null) => cases.push({
            id: `${item.code}/${kind}`, header, cookie, locale, source, matchedRange, preferencePreparation
        });
        add('exact', item.code, null, item.code, 'accept-language', item.code);
        for (const alias of item.aliases)
        {
            add(`alias/${alias}`, alias, null, item.code, 'accept-language', alias);
        }
        add('q-priority', `${other};q=0.4,${item.code};q=0.9`, null, item.code, 'accept-language', item.code);
        add('equal-q-order', `${item.code};q=0.8,${other};q=0.8`, null, item.code, 'accept-language', item.code);
        add('duplicate-invalid', `???;q=oops,${item.code};q=0.9,${item.code};q=0.4`, null, item.code, 'accept-language', item.code);
        add('cookie-over-header', other, item.code, item.code, 'explicit-cookie', item.code);
        add('invalid-cookie', item.code, 'unsupported-locale', item.code, 'accept-language', item.code);
        add('q-zero', `${item.code};q=0`, null, defaultCode, 'default', '');
        add('corrupt-cookie', item.code, '???', item.code, 'accept-language', item.code);
        for (const alias of item.aliases)
        {
            add(`alias-cookie/${alias}`, other, alias, other, 'accept-language', other);
        }
        for (const disabled of disabledDescriptors)
        {
            add(`disabled-header/${disabled.code}`, `${disabled.code},${item.code};q=0.5`, null,
                item.code, 'accept-language', item.code);
            add(`disabled-cookie/${disabled.code}`, item.code, disabled.code,
                item.code, 'accept-language', item.code);
        }
        // Login/refresh syncs only account-fixed. Account-auto preserves the incoming
        // device cookie; an explicit auto command instead clears both cookie variants.
        // These are preparation requirements, never evidence that an account was seeded.
        for (const deviceCookie of [null, other])
        {
            const deviceMode = deviceCookie === null ? 'auto' : 'fixed';
            add(`account-fixed/device-${deviceMode}`, other, item.code, item.code, 'explicit-cookie', item.code,
                { operation: 'login-refresh', accountMode: 'fixed', fixedLocale: item.code, incomingDeviceCookie: deviceCookie });
            add(`account-auto/device-${deviceMode}`, item.code, deviceCookie, deviceCookie ?? item.code,
                deviceCookie === null ? 'accept-language' : 'explicit-cookie', deviceCookie ?? item.code,
                { operation: 'login-refresh', accountMode: 'auto', fixedLocale: null, incomingDeviceCookie: deviceCookie });
        }
        add('device-explicit-auto', item.code, null, item.code, 'accept-language', item.code,
            { operation: 'explicit-auto', accountMode: null, fixedLocale: null, incomingDeviceCookie: other });

    }
    for (const [kind, header] of [['missing', null], ['unknown', 'zz-ZZ'], ['wildcard', '*'], ['invalid', '???;q=oops']])
    {
        cases.push({ id: `default/${kind}`, header, cookie: null,
            locale: kind === 'wildcard' ? descriptors[0].code : defaultCode,
            source: kind === 'wildcard' ? 'accept-language' : 'default',
            matchedRange: kind === 'wildcard' ? '*' : '', preferencePreparation: null });
    }
    return cases;
}

/** Produces a plan, not a browser observation or a qualification receipt. */
export async function createPublicShellLocaleMatrix(root = defaultRoot)
{
    root = await realpath(root);
    const sourceCommit = resolveSourceCommit(root);
    const worktreeFingerprint = resolveWorktreeFingerprint(root);
    const authorities = await loadAuthorities(root);
    const descriptors = authorities.projection.ENABLED_LOCALES;
    const disabledDescriptors = authorities.catalog.locales.filter((item) => item.status !== 'enabled');
    const cases = negotiationCases(descriptors, authorities.catalog.defaultCode, disabledDescriptors);
    const routes = ['Home', 'ArticleDetail', 'Archive', 'About', 'Privacy', 'Guidelines', 'Copyright', 'Filter'];
    const stages = [
        { issue: 2083, names: ['first-response'] },
        { issue: 2084, names: ['first-html', 'hydration-start', 'interactive-ready', 'selector-open'] },
        { issue: 2085, names: ['initial-network'] },
        { issue: 2086, names: ['preparing', 'commit', 'post-commit', 'spa-navigation', 'refresh', 'back-forward', 'latest-wins'] },
        { issue: 2087, names: ['domain-failure', 'font-failure', 'preference-failure', 'revision-conflict', 'artifact-invalid', 'superseded-failure', 'retry'] }
    ];
    const failureModes = {
        'domain-failure': ['timeout', 'non-2xx', 'invalid-content', 'invalid-schema', 'invalid-digest'],
        'font-failure': ['timeout', 'load-failure', 'wrong-face', 'wrong-script'],
        'preference-failure': ['non-2xx', 'network-failure', 'timeout', 'cancel'],
        'revision-conflict': ['conflict', 'stale-response'],
        'artifact-invalid': ['cross-locale', 'cross-domain', 'cross-version', 'content-digest'],
        'superseded-failure': ['late-resource', 'late-preference'],
        'retry': ['complete-preparation']
    };
    const scenes = [];
    for (const group of stages)
    {
        const selectedCases = group.issue === 2083 ? cases : cases.filter((item) => item.id.endsWith('/exact'));
        for (const negotiation of selectedCases)
        {
            for (const route of group.issue === 2083 ? routes : ['Home', 'ArticleDetail'])
            {
                for (const auth of negotiation.preferencePreparation?.accountMode
                    ? ['authenticated', 'admin'] : ['anonymous', 'authenticated', 'admin'])
                {
                    for (const viewport of [390, 1440])
                    {
                        for (const stage of group.names)
                        {
                            for (const failureMode of failureModes[stage] ?? [null])
                            {
                                const locale = negotiation.locale;
                                const descriptor = descriptors.find((item) => item.code === locale);
                                const sourceLocale = group.issue >= 2086
                                    ? descriptors.find((item) => item.script !== descriptor.script).code : locale;
                                const expectedUiLocale = stage === 'preparing' || (group.issue === 2087 && stage !== 'retry')
                                    ? sourceLocale : locale;
                                const visibleDescriptor = descriptors.find((item) => item.code === expectedUiLocale);
                                const domains = [...authorities.routeDomains.requiredLocaleDomainsForPublicPage(route)];
                                const authKey = auth === 'anonymous' ? 'login' : auth === 'admin' ? 'dashboard' : 'account';
                                const keys = [
                                    'public.shell.home', 'public.shell.archive', 'public.shell.about',
                                    'public.shell.search', 'public.shell.skipToMain', `public.shell.${authKey}`,
                                    'layout.siteHeader.fallbackTitle', 'layout.siteHeader.fallbackDescription'
                                ];
                                const expectedKeys = keys.map((key) => copyReference(authorities, expectedUiLocale, key));
                                for (const key of expectedKeys)
                                {
                                    assert.ok(domains.includes(key.key.split('.')[0]));
                                }
                                const id = `${group.issue}/${negotiation.id}/${route}/${auth}/${viewport}/${stage}${failureMode ? `/${failureMode}` : ''}`;
                                scenes.push({
                                    id, issue: group.issue, negotiationId: group.issue >= 2086 ? `${sourceLocale}/exact` : negotiation.id, locale,
                                    source: negotiation.source,
                                    expectedResolution: { source: { 'accept-language': 'AcceptLanguage', 'explicit-cookie': 'ExplicitCookie', default: 'Default' }[negotiation.source],
                                        matchedRange: negotiation.matchedRange },
                                    route, surface: 'PublicShell', authActionContext: auth,
                                    viewport: { width: viewport, height: 900 }, stage,
                                    transition: group.issue >= 2086 ? {
                    sourceLocale,
                    targetLocale: locale,
                    expectedUiLocale,
                    driver: 'selector-ui',
                    rapidTargets: stage === 'latest-wins' || stage === 'superseded-failure'
                        ? publicShellLocaleRapidTargets(descriptors, locale)
                        : [],
                    failureMode,
                    injectionBoundary: failureMode ? 'http-resource' : null
                } : null,
                                    expectedKeys, requiredDomains: domains,
                                    requiredFont: authorities.fonts.getLocaleFontDescriptor(locale),
                                    selectorItems: JSON.parse(JSON.stringify(authorities.selector.projectLocaleSelectorItems(expectedUiLocale))),
                                    document: { language: visibleDescriptor.documentLanguage, direction: visibleDescriptor.direction, intlLocale: visibleDescriptor.intlLocale, openGraphLocale: visibleDescriptor.openGraphLocale },
                                    networkPolicy: { domainSet: 'exact', localeSet: [locale], fontSet: 'exact', includeCacheAndPreload: true, businessDataReRequests: 0 },
                                    geometryRef: 'docs/frontend/public-shell-ownership.md',
                                    evidenceId: `public-shell-locale/${id}`
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    assert.equal(resolveSourceCommit(root), sourceCommit, 'source changed during matrix construction');
    assert.equal(resolveWorktreeFingerprint(root), worktreeFingerprint, 'worktree changed during matrix construction');
    const refs = [...authorities.refs.values()].sort((left, right) => left.path.localeCompare(right.path));
    const fontPlanEntries = descriptors.map((descriptor) =>
    {
        const font = authorities.fonts.getLocaleFontDescriptor(descriptor.code);
        const assetRef = authorities.refs.get(`${localeDirectory}/../assets/fonts/${font.assetFile}`)
            ?? authorities.refs.get(`src/frontend/src/assets/fonts/${font.assetFile}`);
        assert.ok(assetRef, `missing font asset authority: ${font.assetFile}`);
        return {
            ...JSON.parse(JSON.stringify(font)),
            assetRef: assetRef.path,
            assetDigest: assetRef.digest
        };
    });
    const fontPlanBody = {
        schema: 'fsusblog.public-shell-locale-font-plan.v1',
        catalogDigest: authorities.fonts.LOCALE_FONT_CATALOG_DIGEST,
        entries: fontPlanEntries
    };
    const fontPlan = { ...fontPlanBody, digest: publicShellLocaleContentDigest(fontPlanBody) };
    const value = {
        schema: publicShellLocaleMatrixSchema,
        evidenceKind: 'plan',
        runnerRef: 'tests/browser-contract/run.mjs',
        identity: {
            sourceCommit,
            worktree: root,
            worktreeFingerprint,
            sourceDigest: publicShellLocaleContentDigest(refs),
            catalogDigest: authorities.fonts.LOCALE_FONT_CATALOG_DIGEST,
            fontPlanDigest: fontPlan.digest,
            refs
        },
        defaultLocale: authorities.catalog.defaultCode,
        locales: descriptors,
        negotiationCases: cases,
        negotiationCoverage: { disabledLocales: disabledDescriptors.map((item) => item.code),
            disabledLocaleGate: disabledDescriptors.length === 0 ? 'no-disabled-entry-in-current-catalog' : 'planned',
            preferencePreparationGate: 'requires-verified-cookie-sync',
            resolutionObservationGate: 'requires-original-request-resolver-result' },
        fontPlan,
        scenes
    };
    return { ...value, contentDigest: publicShellLocaleContentDigest(value) };
}

/** Re-derive all expected fields from current sources; a recomputed input digest is insufficient. */
export async function validatePublicShellLocaleMatrix(candidate, root = defaultRoot)
{
    const expected = await createPublicShellLocaleMatrix(root);
    assert.equal(isDeepStrictEqual(candidate, expected), true,
        'PublicShell locale matrix does not match current authority');
    return candidate;
}

/** Resolve strings only after validating their artifact/key binding, without locale fallback. */
export async function resolvePublicShellLocaleCopy(candidate, sceneId, root = defaultRoot)
{
    await validatePublicShellLocaleMatrix(candidate, root);
    const scene = candidate.scenes.find((item) => item.id === sceneId);
    assert.ok(scene, `unknown PublicShell scene: ${sceneId}`);
    const authorities = await loadAuthorities(await realpath(root));
    return Object.fromEntries(scene.expectedKeys.map((reference) =>
    {
        const [domain, ...segments] = reference.key.split('.');
        const artifact = authorities.artifacts.get(`${scene.transition?.expectedUiLocale ?? scene.locale}/${domain}`);
        const value = segments.reduce((current, segment) => current[segment], artifact.values);
        assert.equal(digest(value), reference.valueDigest);
        return [reference.key, value];
    }));
}
